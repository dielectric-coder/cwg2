/**
 * goertzel.ts
 * ------------
 * A Goertzel filter: a cheap way to measure how much energy a signal contains
 * at ONE specific frequency. For Morse we only care about a single CW tone
 * (e.g. 700 Hz), so this is far lighter than a full FFT.
 *
 * You feed it a block of audio samples and it returns the power at the target
 * frequency. Compare that power to a threshold to decide "tone on" / "tone off".
 *
 * This file has NO dependency on the glasses SDK — it's plain math, so you can
 * test it in plain Node.
 */

export class Goertzel {
  private coeff: number
  private cosOmega: number
  private sinOmega: number
  private q0 = 0
  private q1 = 0
  private q2 = 0
  private sampleCount = 0

  /**
   * @param targetFreq  the tone frequency to detect, in Hz (e.g. 700)
   * @param sampleRate  audio sample rate, in Hz (16000 for the G2 mic)
   */
  constructor(targetFreq: number, sampleRate: number) {
    // Precompute the filter coefficient and the cos/sin of the target frequency
    // once — these never change, so power() reuses them instead of recomputing a
    // cos and a sin on every call (this runs once per bin per block, ~1.7k/sec).
    const omega = (2 * Math.PI * targetFreq) / sampleRate
    this.cosOmega = Math.cos(omega)
    this.sinOmega = Math.sin(omega)
    this.coeff = 2 * this.cosOmega
  }

  /** Feed one audio sample (a number, normalized roughly to -1..1). */
  process(sample: number): void {
    this.q0 = this.coeff * this.q1 - this.q2 + sample
    this.q2 = this.q1
    this.q1 = this.q0
    this.sampleCount++
  }

  /**
   * Return the power at the target frequency for everything fed since the last
   * reset, then reset internal state for the next block.
   * Normalized by sample count so block length doesn't change the scale.
   */
  power(): number {
    const real = this.q1 - this.q2 * this.cosOmega
    const imag = this.q2 * this.sinOmega
    const mag = real * real + imag * imag
    const n = this.sampleCount || 1
    this.reset()
    return mag / (n * n)
  }

  private reset(): void {
    this.q0 = 0
    this.q1 = 0
    this.q2 = 0
    this.sampleCount = 0
  }
}
