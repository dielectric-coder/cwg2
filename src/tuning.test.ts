/**
 * tuning.test.ts
 * --------------
 * SDK-free verification of the tone-lock and WPM-convergence tuning, the way
 * HANDOFF.md prescribes: synthesize a realistic noisy CW stream and assert
 * behaviour in plain Node.
 *
 *   npx tsx tuning.test.ts
 *
 * What it guards (the three things that were wrong before tuning):
 *   1. Lock is FAST. The old near-zero noise-floor seed took ~20 s to settle;
 *      it must now lock within a couple of seconds.
 *   2. Lock is CORRECT under low-frequency room noise. The old wide 400–1000 Hz
 *      band false-locked onto brown-noise rumble; the narrowed band must lock on
 *      the real tone.
 *   3. WPM does NOT spike. The estimate must converge to the true speed without
 *      the transient ~75 WPM overshoot.
 *
 * The pipeline here mirrors main.ts: ToneScanner -> amplitude threshold ->
 * median-of-3 debounce -> (only once locked) MorseDecoder.
 *
 * No test framework: tiny assert harness, non-zero exit on any failure.
 */

import { MorseDecoder } from './morse-decoder'
import { ToneScanner } from './tone-scanner'

const SAMPLE_RATE = 16000
const BLOCK_SAMPLES = 160
const BLOCKS_PER_SECOND = SAMPLE_RATE / BLOCK_SAMPLES // 100

const MORSE: Record<string, string> = {
  P: '.--.', A: '.-', R: '.-.', I: '..', S: '...', O: '---', N: '-.', T: '-',
}

/** Deterministic PRNG so tests are reproducible (no Math.random flakiness). */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff // 0..1
  }
}

/** Per-sample tone-on/off keying of `text` at `wpm`, with leading silence. */
function keySamples(text: string, wpm: number): Uint8Array {
  const unitSamp = Math.round((1.2 / wpm) * SAMPLE_RATE)
  const out: number[] = []
  const push = (units: number, val: number) => {
    for (let i = 0; i < units * unitSamp; i++) out.push(val)
  }
  push(15, 0) // leading silence (mic is open before the tone starts)
  for (const ch of text) {
    if (ch === ' ') {
      push(7, 0)
      continue
    }
    const sym = MORSE[ch]
    for (let k = 0; k < sym.length; k++) {
      push(sym[k] === '-' ? 3 : 1, 1)
      if (k < sym.length - 1) push(1, 0)
    }
    push(3, 0) // letter gap
  }
  return Uint8Array.from(out)
}

interface Outcome {
  lockSeconds: number | null
  lockFreq: number | null
  maxWpm: number
  finalWpm: number
  decoded: string
}

/**
 * Run the full main.ts pipeline over a synthesized stream.
 * `noise`: 'white' (broadband) or 'brown' (low-frequency-dominated, like a real
 * room/mic). `snrDb`: tone level above the noise.
 */
function runPipeline(text: string, wpm: number, freq: number, snrDb: number, noise: 'white' | 'brown', seed: number): Outcome {
  const key = keySamples(text, wpm)
  const rng = makeRng(seed)
  const NOISE_AMP = 0.004
  const toneAmp = NOISE_AMP * Math.pow(10, snrDb / 20)

  const scanner = new ToneScanner({ sampleRate: SAMPLE_RATE, minFreq: 550, maxFreq: 950, stepFreq: 25 })
  let decoded = ''
  const decoder = new MorseDecoder({
    blocksPerSecond: BLOCKS_PER_SECOND,
    initialWpm: 15,
    onChar: (c) => (decoded += c),
  })

  let brown = 0
  let peakPower = 1e-9
  let block = 0
  let lockBlock = -1
  let lockFreq: number | null = null
  let maxWpm = 0
  const onHistory: boolean[] = []
  const buf: number[] = []

  for (let n = 0; n < key.length; n++) {
    const tone = key[n] ? toneAmp * Math.sin((2 * Math.PI * freq * n) / SAMPLE_RATE) : 0
    let noiseSample: number
    if (noise === 'brown') {
      brown += (rng() * 2 - 1) * 0.05
      brown *= 0.985 // leaky integrator -> low-frequency-dominated
      noiseSample = brown * 8 * NOISE_AMP
    } else {
      noiseSample = (rng() * 2 - 1) * NOISE_AMP
    }
    buf.push(tone + noiseSample)

    if (buf.length >= BLOCK_SAMPLES) {
      for (const s of buf) scanner.process(s)
      const res = scanner.finishBlock()
      buf.length = 0

      peakPower = Math.max(res.power, peakPower * 0.999)
      const rawOn = res.power > peakPower * 0.25
      onHistory.push(rawOn)
      if (onHistory.length > 3) onHistory.shift()
      const on = onHistory.filter(Boolean).length >= 2

      if (res.lockedFreq !== null) {
        if (lockBlock < 0) {
          lockBlock = block
          lockFreq = res.lockedFreq
        }
        decoder.pushBlock(on)
        maxWpm = Math.max(maxWpm, decoder.estimatedWpm)
      }
      block++
    }
  }

  return {
    lockSeconds: lockBlock < 0 ? null : lockBlock / BLOCKS_PER_SECOND,
    lockFreq,
    maxWpm,
    finalWpm: decoder.estimatedWpm,
    decoded,
  }
}

// --- tiny assert harness (matches decoder.test.ts) ---
let failures = 0
function assert(cond: boolean, msg: string, detail = ''): void {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}` + (cond ? '' : `\n      ${detail}`))
}

// --- Tests ---
const TEXT = 'PARIS PARIS PARIS PARIS PARIS PARIS'
const FREQ = 794
const WPM = 25

console.log('# Tone lock + WPM convergence (25 WPM @ 794 Hz)\n')

for (const noise of ['white', 'brown'] as const) {
  for (const snr of [20, 8, 5]) {
    const r = runPipeline(TEXT, WPM, FREQ, snr, noise, 12345 + snr)
    const tag = `${noise} noise, ${snr} dB SNR`
    console.log(
      `-- ${tag}: lock=${r.lockSeconds === null ? 'NEVER' : r.lockSeconds.toFixed(1) + 's'} ` +
        `freq=${r.lockFreq} maxWpm=${r.maxWpm} finalWpm=${r.finalWpm} decoded="${r.decoded.trim()}"`,
    )

    assert(r.lockSeconds !== null && r.lockSeconds < 3, `${tag}: locks within 3 s`, `got ${r.lockSeconds}s`)
    assert(r.lockFreq !== null && Math.abs(r.lockFreq - FREQ) <= 30, `${tag}: locks on the tone (~794 Hz)`, `got ${r.lockFreq}Hz`)
    assert(r.maxWpm <= 55, `${tag}: WPM never spikes above 55`, `peaked at ${r.maxWpm}`)
    assert(Math.abs(r.finalWpm - WPM) <= 4, `${tag}: settles near ${WPM} WPM`, `got ${r.finalWpm}`)
    assert(r.decoded.includes('PARIS'), `${tag}: decodes PARIS`, `got "${r.decoded.trim()}"`)
  }
}

console.log(`\n${failures === 0 ? 'ALL TUNING TESTS PASSED' : `${failures} TUNING TEST(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
