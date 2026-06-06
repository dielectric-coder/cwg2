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
 * Build a synthesized sample stream: per-sample tone keying + additive noise.
 * `noise`: 'white' (broadband) or 'brown' (low-frequency-dominated, like a real
 * room/mic). `snrDb`: tone level above the noise. Options can prepend a loud
 * non-tone transient and/or append trailing noise with no tone.
 */
function buildSamples(
  text: string, wpm: number, freq: number, snrDb: number, noise: 'white' | 'brown', seed: number,
  opts: { leadingTransientBlocks?: number; trailingNoiseBlocks?: number } = {},
): number[] {
  const key = keySamples(text, wpm)
  const rng = makeRng(seed)
  const NOISE_AMP = 0.004
  const toneAmp = NOISE_AMP * Math.pow(10, snrDb / 20)
  let brown = 0
  const noiseSample = (): number => {
    if (noise === 'brown') {
      brown += (rng() * 2 - 1) * 0.05
      brown *= 0.985 // leaky integrator -> low-frequency-dominated
      return brown * 8 * NOISE_AMP
    }
    return (rng() * 2 - 1) * NOISE_AMP
  }
  const out: number[] = []
  // A loud BROADBAND transient (e.g. a cough/tap) — high amplitude, no tone.
  const lead = (opts.leadingTransientBlocks ?? 0) * BLOCK_SAMPLES
  for (let i = 0; i < lead; i++) out.push((rng() * 2 - 1) * toneAmp * 8)
  for (let n = 0; n < key.length; n++) {
    const tone = key[n] ? toneAmp * Math.sin((2 * Math.PI * freq * n) / SAMPLE_RATE) : 0
    out.push(tone + noiseSample())
  }
  const trail = (opts.trailingNoiseBlocks ?? 0) * BLOCK_SAMPLES
  for (let i = 0; i < trail; i++) out.push(noiseSample())
  return out
}

/** Run the full main.ts capture pipeline over a sample stream and report outcome. */
function decodeStream(samples: number[]): Outcome {
  const scanner = new ToneScanner({ sampleRate: SAMPLE_RATE, minFreq: 550, maxFreq: 950, stepFreq: 25 })
  let decoded = ''
  const decoder = new MorseDecoder({
    blocksPerSecond: BLOCKS_PER_SECOND,
    initialWpm: 15,
    onChar: (c) => (decoded += c),
  })
  let block = 0, lockBlock = -1, lockFreq: number | null = null, maxWpm = 0
  let peakPower = 1e-9, idleBlocks = 0
  const MAX_IDLE_BLOCKS = BLOCKS_PER_SECOND * 2.5
  const onHistory: boolean[] = []
  const buf: number[] = []
  for (let i = 0; i < samples.length; i++) {
    buf.push(samples[i])
    if (buf.length >= BLOCK_SAMPLES) {
      for (const s of buf) scanner.process(s)
      const res = scanner.finishBlock()
      buf.length = 0
      // Mirror main.ts: amplitude on/off with hasSignal-gated threshold + idle gate.
      if (res.hasSignal) { peakPower = Math.max(res.power, peakPower * 0.999); idleBlocks = 0 }
      else { peakPower *= 0.999; idleBlocks++ }
      const rawOn = res.power > peakPower * 0.25
      onHistory.push(rawOn)
      if (onHistory.length > 3) onHistory.shift()
      const on = onHistory.filter(Boolean).length >= 2
      if (res.lockedFreq !== null) {
        if (lockBlock < 0) { lockBlock = block; lockFreq = res.lockedFreq }
        if (idleBlocks <= MAX_IDLE_BLOCKS) {
          decoder.pushBlock(on)
          maxWpm = Math.max(maxWpm, decoder.estimatedWpm)
        } else if (idleBlocks === MAX_IDLE_BLOCKS + 1) {
          decoder.flush()
        }
      }
      block++
    }
  }
  return {
    lockSeconds: lockBlock < 0 ? null : lockBlock / BLOCKS_PER_SECOND,
    lockFreq, maxWpm, finalWpm: decoder.estimatedWpm, decoded,
  }
}

function runPipeline(text: string, wpm: number, freq: number, snrDb: number, noise: 'white' | 'brown', seed: number): Outcome {
  return decodeStream(buildSamples(text, wpm, freq, snrDb, noise, seed))
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

// --- #1: a loud non-tone transient must not suppress decoding ---
// On/off is now level-independent (spectral peakiness), so a loud broadband burst
// (cough/tap, 8x the tone amplitude) is not peaky -> reads OFF, neither inflating a
// threshold nor being decoded. The old amplitude threshold would have pinned its
// reference high and dropped the real tone for seconds.
console.log('\n# Robustness')
{
  const base = runPipeline(TEXT, WPM, FREQ, 12, 'brown', 999)
  const withTransient = decodeStream(
    buildSamples(TEXT, WPM, FREQ, 12, 'brown', 999, { leadingTransientBlocks: 40 }),
  )
  console.log(`-- leading transient: lock=${withTransient.lockSeconds}s decoded="${withTransient.decoded.trim()}"`)
  assert(withTransient.lockSeconds !== null && withTransient.lockSeconds < 3,
    'still locks within 3s after a loud non-tone transient', `got ${withTransient.lockSeconds}s`)
  assert(withTransient.decoded.includes('PARIS'),
    'decodes despite a loud leading transient (level-independent on/off)', `got "${withTransient.decoded.trim()}"`)
  assert(base.decoded.includes('PARIS'), 'baseline (no transient) decodes PARIS', `got "${base.decoded.trim()}"`)
}

// --- #2: post-lock noise must not be decoded into spurious characters ---
// After ~2.5s with no tone the idle gate flushes and stops feeding the decoder, so
// extra noise beyond that point adds nothing. Both tails run past the idle point;
// the longer one (6s) must produce exactly the same text as the shorter (3s). The
// old sticky-lock gate kept feeding every block and decoded the noise forever.
{
  const seed = 4242
  const tail3s = decodeStream(buildSamples(TEXT, WPM, FREQ, 12, 'brown', seed, { trailingNoiseBlocks: 300 }))
  const tail6s = decodeStream(buildSamples(TEXT, WPM, FREQ, 12, 'brown', seed, { trailingNoiseBlocks: 600 }))
  console.log(`-- trailing noise: 3s="${tail3s.decoded.trim()}" 6s="${tail6s.decoded.trim()}"`)
  assert(tail6s.decoded === tail3s.decoded,
    'noise past the idle point adds no spurious characters',
    `3s=${JSON.stringify(tail3s.decoded)} 6s=${JSON.stringify(tail6s.decoded)}`)
}

console.log(`\n${failures === 0 ? 'ALL TUNING TESTS PASSED' : `${failures} TUNING TEST(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
