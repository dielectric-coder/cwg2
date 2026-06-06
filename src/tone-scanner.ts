/**
 * tone-scanner.ts
 * ---------------
 * Automatic CW tone-frequency detection.
 *
 * Instead of one Goertzel fixed at 700 Hz, we run a BANK of detectors across a
 * range of candidate frequencies. Per block, each reports its power. We use the
 * strongest bin's power as the "tone" signal, and — when a bin is consistently
 * the loudest over several blocks — we LOCK onto it as the detected CW pitch.
 *
 * This means the user never has to hand-set TONE_FREQ: point it at any CW in the
 * scan range and it finds the pitch.
 *
 * Pure math — no SDK dependency, testable in Node.
 */

import { Goertzel } from './goertzel'

export interface ToneScannerOptions {
  sampleRate: number
  /** Lowest candidate CW frequency, Hz. */
  minFreq?: number
  /** Highest candidate CW frequency, Hz. */
  maxFreq?: number
  /** Spacing between candidate bins, Hz. Smaller = finer but more CPU. */
  stepFreq?: number
}

export interface ScanResult {
  /** Power at the currently strongest bin. */
  power: number
  /** Frequency of the strongest bin this block, Hz. */
  peakFreq: number
  /** The locked-on CW frequency once stable, or null while still searching. */
  lockedFreq: number | null
  /**
   * Whether this block carries a tone (the strongest bin clearly dominates the
   * others). Level-independent — use this as the on/off decision, since it
   * rejects broadband noise that an amplitude threshold would mistake for a tone.
   */
  hasSignal: boolean
}

export class ToneScanner {
  private detectors: Goertzel[]
  private freqs: number[]
  private lockedFreq: number | null = null
  // Per-block scratch buffers, allocated once and reused so finishBlock does no
  // per-block heap allocation (it runs 100x/sec).
  private powers: number[]
  private medianScratch: number[]

  // Lock logic: count how many consecutive signal-bearing blocks the same bin
  // (or an adjacent one) has dominated.
  private lastWinner = -1
  private winnerStreak = 0
  private readonly lockStreak = 12 // signal blocks of agreement before lock
  // A block counts as carrying signal when its strongest bin is at least this
  // many times the median bin power (see finishBlock).
  private readonly signalPeakRatio = 6

  constructor(opts: ToneScannerOptions) {
    const min = opts.minFreq ?? 400
    const max = opts.maxFreq ?? 1000
    const step = opts.stepFreq ?? 50
    this.freqs = []
    for (let f = min; f <= max; f += step) this.freqs.push(f)
    this.detectors = this.freqs.map((f) => new Goertzel(f, opts.sampleRate))
    this.powers = new Array(this.detectors.length)
    this.medianScratch = new Array(this.detectors.length)
  }

  /** Feed one audio sample to every detector. */
  process(sample: number): void {
    for (const d of this.detectors) d.process(sample)
  }

  /**
   * End the current block: read all bins, find the strongest, update lock state.
   * Calling this resets every detector for the next block.
   */
  finishBlock(): ScanResult {
    let bestIdx = 0
    let bestPower = -Infinity
    const powers = this.powers // reused buffer, refilled each block
    for (let i = 0; i < this.detectors.length; i++) {
      const p = this.detectors[i].power() // note: power() resets the detector
      powers[i] = p
      if (p > bestPower) {
        bestPower = p
        bestIdx = i
      }
    }

    // Parabolic interpolation between the peak bin and its neighbors gives a
    // sub-bin frequency estimate, so a 650 Hz tone between 600/700 bins reads
    // as ~650 rather than snapping to one side.
    const peakFreq = this.interpolatePeak(bestIdx, powers)

    // Decide whether this block carries a tone by spectral PEAKINESS, not by an
    // absolute or slowly-converging noise floor. A CW tone concentrates energy in
    // one bin (plus a little leakage into its neighbours); broadband room noise —
    // including low-frequency rumble — spreads energy across all bins. Comparing
    // the strongest bin to the MEDIAN bin power is level-independent, so detection
    // works the instant audio starts (no multi-second floor convergence) and the
    // lock can only build on genuinely tone-like blocks.
    const scratch = this.medianScratch // reused buffer — no per-block allocation
    for (let i = 0; i < powers.length; i++) scratch[i] = powers[i]
    scratch.sort((a, b) => a - b)
    const median = scratch[scratch.length >> 1]
    const hasSignal = bestPower > median * this.signalPeakRatio

    if (hasSignal) {
      if (this.lastWinner >= 0 && Math.abs(bestIdx - this.lastWinner) <= 1) {
        this.winnerStreak++
        this.lastWinner = bestIdx // drift toward current strongest bin
      } else {
        this.lastWinner = bestIdx
        this.winnerStreak = 1
      }
      if (this.winnerStreak >= this.lockStreak) {
        // SMOOTH the locked frequency instead of overwriting it with each block's
        // raw (noisy) estimate. A stable tone still jitters block-to-block —
        // partial on/off blocks at element edges and noise perturb the parabolic
        // interpolation — so without smoothing the display flickers across tens of
        // Hz. An EWMA converges to the true pitch and holds it steady.
        this.lockedFreq =
          this.lockedFreq === null
            ? Math.round(peakFreq)
            : Math.round(this.lockedFreq * 0.9 + peakFreq * 0.1)
      }
    }

    return {
      power: bestPower,
      peakFreq: Math.round(peakFreq),
      lockedFreq: this.lockedFreq,
      hasSignal,
    }
  }

  /**
   * Estimate the true peak frequency by fitting a parabola through the strongest
   * bin and its two neighbors. Falls back to the bin center at the edges.
   */
  private interpolatePeak(idx: number, powers: number[]): number {
    if (idx <= 0 || idx >= powers.length - 1) return this.freqs[idx]
    const a = powers[idx - 1]
    const b = powers[idx]
    const c = powers[idx + 1]
    const denom = a - 2 * b + c
    if (denom === 0) return this.freqs[idx]
    const offset = (0.5 * (a - c)) / denom // in bins, -0.5..0.5
    const step = this.freqs[1] - this.freqs[0]
    return this.freqs[idx] + offset * step
  }

  /** Forget the current lock (e.g. when the user clears or signal drops). */
  resetLock(): void {
    this.lockedFreq = null
    this.lastWinner = -1
    this.winnerStreak = 0
  }
}
