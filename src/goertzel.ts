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
  private q0 = 0
  private q1 = 0
  private q2 = 0
  private sampleCount = 0

  /**
   * @param targetFreq  the tone frequency to detect, in Hz (e.g. 700)
   * @param sampleRate  audio sample rate, in Hz (16000 for the G2 mic)
   */
  constructor(
    private targetFreq: number,
    private sampleRate: number,
  ) {
    // Precompute the filter coefficient for the target frequency.
    const omega = (2 * Math.PI * targetFreq) / sampleRate
    this.coeff = 2 * Math.cos(omega)
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
    const real = this.q1 - this.q2 * Math.cos((2 * Math.PI * this.targetFreq) / this.sampleRate)
    const imag = this.q2 * Math.sin((2 * Math.PI * this.targetFreq) / this.sampleRate)
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
