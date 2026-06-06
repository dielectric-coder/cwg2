/**
 * morse-decoder.ts
 * ----------------
 * The timing brain. It receives a stream of "tone on/off" booleans (one per
 * audio block, at a known block rate) and turns the DURATIONS of those
 * on/off periods into dots, dashes, and gaps — then into text.
 *
 * Morse is defined entirely by RATIOS relative to one unit (the "dot length"):
 *   - dot          = 1 unit ON
 *   - dash         = 3 units ON
 *   - intra-symbol = 1 unit OFF  (gap between dots/dashes in one letter)
 *   - inter-letter = 3 units OFF (gap between letters)
 *   - word gap     = 7 units OFF (gap between words)
 *
 * Because hand-sent Morse drifts in speed, we ADAPT the dot length over time
 * from the shortest "on" pulses we observe, rather than hardcoding a WPM.
 *
 * No SDK dependency — pure logic, testable in Node.
 */

import { decodeSymbol } from './morse-table'

export interface DecoderOptions {
  /** How many tone-detection blocks occur per second (set by the audio glue). */
  blocksPerSecond: number
  /** Initial guess at words-per-minute before adaptation kicks in. */
  initialWpm?: number
  /** Slowest speed the adaptive dot length is allowed to track (default 5). */
  minWpm?: number
  /** Fastest speed the adaptive dot length is allowed to track (default 50). */
  maxWpm?: number
  /** Called whenever a full character (or space) is decoded. */
  onChar: (char: string) => void
  /**
   * Called whenever the in-progress dot/dash buffer changes (a new element was
   * added, or the letter was just emitted and the buffer cleared). Lets the UI
   * show the symbol being built live, e.g. ".-" before it resolves to "A".
   */
  onProgress?: (partialSymbol: string) => void
}

export class MorseDecoder {
  private toneActive = false
  private runBlocks = 0 // length of the current on-or-off run, in blocks
  private currentSymbol = '' // dots/dashes accumulated for the current letter

  // Adaptive dot length, expressed in BLOCKS (not seconds), clamped to the
  // [maxWpm..minWpm] speed band so a burst of noisy short pulses can't slam the
  // estimate to an absurd speed.
  private dotBlocks: number
  private readonly minDotBlocks: number
  private readonly maxDotBlocks: number
  private readonly blocksPerSecond: number
  private readonly onChar: (char: string) => void
  private readonly onProgress?: (partialSymbol: string) => void

  // Tracks whether we've already emitted a word space for the current long gap.
  private pendingLetter = false

  constructor(opts: DecoderOptions) {
    this.blocksPerSecond = opts.blocksPerSecond
    this.onChar = opts.onChar
    this.onProgress = opts.onProgress
    // PARIS standard: dot length (seconds) = 1.2 / WPM. Faster WPM -> shorter dot.
    const wpm = opts.initialWpm ?? 15
    this.minDotBlocks = (1.2 / (opts.maxWpm ?? 50)) * this.blocksPerSecond
    this.maxDotBlocks = (1.2 / (opts.minWpm ?? 5)) * this.blocksPerSecond
    this.dotBlocks = this.clampDot(Math.round((1.2 / wpm) * this.blocksPerSecond))
  }

  private clampDot(blocks: number): number {
    return Math.min(this.maxDotBlocks, Math.max(this.minDotBlocks, blocks))
  }

  /**
   * Feed one block's tone state. Call this once per audio block, in order.
   * @param isTone true if a tone was detected in this block
   */
  pushBlock(isTone: boolean): void {
    if (isTone === this.toneActive) {
      this.runBlocks++
      return
    }
    // State just flipped — the run that ended describes one element/gap.
    this.finishRun(this.toneActive, this.runBlocks)
    this.toneActive = isTone
    this.runBlocks = 1
  }

  /** Call when audio stops, to flush any buffered letter. */
  flush(): void {
    if (this.toneActive) {
      this.finishRun(true, this.runBlocks)
      this.toneActive = false
      this.runBlocks = 0
    }
    this.emitLetter()
  }

  private finishRun(wasTone: boolean, lengthBlocks: number): void {
    if (lengthBlocks <= 0) return

    if (wasTone) {
      // An ON run: classify as dot or dash against the adaptive threshold.
      // Boundary at 2x dot length sits between "1 unit" and "3 units".
      const isDash = lengthBlocks >= this.dotBlocks * 2
      this.currentSymbol += isDash ? '-' : '.'
      this.pendingLetter = true
      this.adaptDotLength(lengthBlocks, isDash)
      this.onProgress?.(this.currentSymbol)
    } else {
      // An OFF run: classify the gap.
      // < 2 units  -> intra-letter gap, do nothing (same letter continues)
      // 2..5 units -> letter boundary
      // >= 5 units -> word boundary
      if (lengthBlocks >= this.dotBlocks * 2 && lengthBlocks < this.dotBlocks * 5) {
        this.emitLetter()
      } else if (lengthBlocks >= this.dotBlocks * 5) {
        this.emitLetter()
        if (this.pendingLetter === false) this.onChar(' ')
      }
    }
  }

  private emitLetter(): void {
    if (this.currentSymbol.length === 0) return
    this.onChar(decodeSymbol(this.currentSymbol))
    this.currentSymbol = ''
    this.pendingLetter = false
    this.onProgress?.('') // buffer cleared
  }

  /**
   * Nudge the adaptive dot length toward observed pulse lengths.
   * A dot's length is taken directly; a dash is divided by 3 to estimate the
   * underlying unit. Exponential smoothing keeps it stable but responsive.
   */
  private adaptDotLength(lengthBlocks: number, isDash: boolean): void {
    const estimate = isDash ? lengthBlocks / 3 : lengthBlocks
    const alpha = 0.2 // smoothing factor: higher = adapts faster, noisier
    this.dotBlocks = this.clampDot((1 - alpha) * this.dotBlocks + alpha * estimate)
  }

  /** Current estimated speed, handy for showing on the display. */
  get estimatedWpm(): number {
    const dotSeconds = this.dotBlocks / this.blocksPerSecond
    return Math.round(1.2 / dotSeconds)
  }
}
