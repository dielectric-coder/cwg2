/**
 * pipeline.ts
 * -----------
 * The SDK-free capture pipeline: raw audio samples -> ToneScanner -> on/off
 * decision -> MorseDecoder. This is the single source of truth for how blocks are
 * processed, so `main.ts` (the device) and the Node tests run identical logic
 * instead of each re-implementing (and drifting from) the block loop.
 *
 *   samples -> [batch into 160-sample blocks] -> scanner.finishBlock()
 *           -> hasSignal-gated amplitude threshold -> median-of-3 debounce
 *           -> idle gate -> decoder.pushBlock() -> onChar / onProgress
 *
 * No SDK dependency — plain DSP/logic, testable in Node.
 */

import { ToneScanner } from './tone-scanner'
import { MorseDecoder } from './morse-decoder'

// --- Audio constants (Device APIs: PCM 16kHz, s16le, mono) ---
export const SAMPLE_RATE = 16000
export const BLOCK_SAMPLES = 160 // 10 ms per block -> 100 blocks/sec
export const BLOCKS_PER_SECOND = SAMPLE_RATE / BLOCK_SAMPLES // 100

export interface CwPipelineOptions {
  /** Called when a full character (or space) is decoded. */
  onChar: (char: string) => void
  /** Called when the in-progress dot/dash buffer changes. */
  onProgress?: (partialSymbol: string) => void
  initialWpm?: number
  minWpm?: number
  maxWpm?: number
  /** Scan band (defaults to the CW range 550–950 Hz @ 25 Hz). */
  minFreq?: number
  maxFreq?: number
  stepFreq?: number
}

export class CwPipeline {
  /** The locked CW pitch in Hz, or null while still searching. */
  lockedFreq: number | null = null
  /** Live peak pitch shown while searching (before lock), or null. */
  searchingFreq: number | null = null

  private readonly scanner: ToneScanner
  private readonly decoder: MorseDecoder
  // After this many blocks with no real tone, treat the transmission as paused:
  // flush the final letter and stop feeding, so post-transmission noise isn't
  // decoded. 2.5 s is well beyond any inter-word gap (a 5 wpm word gap is ~1.7 s).
  private readonly maxIdleBlocks = BLOCKS_PER_SECOND * 2.5

  private peakPower = 1e-9
  private idleBlocks = 0 // consecutive blocks with no tone present (peakiness false)
  private sampleBuffer: number[] = []
  private readonly onHistory: boolean[] = [] // last 3 raw on/off decisions

  constructor(opts: CwPipelineOptions) {
    // The scan band excludes low bins so the scanner can't false-lock onto
    // low-frequency room rumble; 25 Hz step gives a finer pitch readout.
    this.scanner = new ToneScanner({
      sampleRate: SAMPLE_RATE,
      minFreq: opts.minFreq ?? 550,
      maxFreq: opts.maxFreq ?? 950,
      stepFreq: opts.stepFreq ?? 25,
    })
    this.decoder = new MorseDecoder({
      blocksPerSecond: BLOCKS_PER_SECOND,
      initialWpm: opts.initialWpm ?? 15,
      minWpm: opts.minWpm,
      maxWpm: opts.maxWpm,
      onChar: opts.onChar,
      onProgress: opts.onProgress,
    })
  }

  /** Current estimated sending speed, for display. */
  get estimatedWpm(): number {
    return this.decoder.estimatedWpm
  }

  /** Feed raw audio samples (floats ~ -1..1). Drives the decode callbacks. */
  pushSamples(samples: ArrayLike<number>): void {
    for (let i = 0; i < samples.length; i++) {
      this.sampleBuffer.push(samples[i])
      if (this.sampleBuffer.length >= BLOCK_SAMPLES) this.processBlock()
    }
  }

  private processBlock(): void {
    for (const s of this.sampleBuffer) this.scanner.process(s)
    const res = this.scanner.finishBlock()
    this.sampleBuffer.length = 0 // reuse the array — avoids GC churn at 100 blocks/sec

    this.lockedFreq = res.lockedFreq
    // The on/off decision is amplitude-relative (clean element timing), but the
    // threshold reference is adapted ONLY from real tone blocks (hasSignal). A loud
    // non-tone transient (cough/tap) is not spectrally peaky, so it can't ratchet
    // peakPower up and then suppress real tones for seconds while it decays.
    if (res.hasSignal) {
      this.peakPower = Math.max(res.power, this.peakPower * 0.999)
      this.searchingFreq = res.peakFreq
      this.idleBlocks = 0
    } else {
      this.peakPower *= 0.999
      this.idleBlocks++
    }
    const rawOn = res.power > this.peakPower * 0.25

    // Median-of-3 debounce: drop single-block glitches before the decoder times
    // them, so a stray on/off blip can't be mistaken for a very fast dot.
    this.onHistory.push(rawOn)
    if (this.onHistory.length > 3) this.onHistory.shift()
    const on = this.onHistory.filter(Boolean).length >= 2

    // Decode only once locked, and only while a tone has been present recently.
    // After a sustained absence of any tone (operator stopped) flush the final
    // letter once and stop feeding — otherwise post-transmission noise that crosses
    // the threshold would be timed as Morse forever (the lock never releases).
    if (res.lockedFreq !== null) {
      if (this.idleBlocks <= this.maxIdleBlocks) this.decoder.pushBlock(on)
      else if (this.idleBlocks === this.maxIdleBlocks + 1) this.decoder.flush()
    }
  }

  /** Clear per-session capture state so a fresh start never inherits stale data. */
  resetCapture(): void {
    this.sampleBuffer = []
    this.onHistory.length = 0
    this.peakPower = 1e-9
    this.idleBlocks = 0
    this.searchingFreq = null
  }

  /** Flush any pending letter into the output (call when listening stops). */
  flush(): void {
    this.decoder.flush()
  }

  /**
   * Full re-arm (double-press): flush the pending letter (emitted via onChar),
   * drop the pitch lock, and clear capture state. The caller is responsible for
   * clearing its own decoded-text buffer AFTER this returns.
   */
  reArm(): void {
    this.decoder.flush() // emits any pending letter via onChar first
    this.scanner.resetLock()
    this.lockedFreq = null
    this.resetCapture()
  }
}
