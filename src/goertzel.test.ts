/**
 * goertzel.test.ts
 * ----------------
 * SDK-free checks for the Goertzel single-frequency detector.
 *
 *   npx tsx goertzel.test.ts
 *
 * Guards the precomputed-trig optimization: power() must still concentrate
 * energy at the target frequency and reset its state each block.
 */

import { Goertzel } from './goertzel'

const SR = 16000

/** Feed `samples` of a pure `toneFreq` sine to a detector tuned to `binFreq`. */
function tonePower(toneFreq: number, binFreq: number, samples = 800): number {
  const g = new Goertzel(binFreq, SR)
  for (let n = 0; n < samples; n++) g.process(Math.sin((2 * Math.PI * toneFreq * n) / SR))
  return g.power()
}

let failures = 0
function assert(cond: boolean, msg: string, detail = ''): void {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}` + (cond ? '' : `\n      ${detail}`))
}

// On-frequency energy must vastly exceed off-frequency energy.
{
  const onTone = tonePower(800, 800)
  const offLow = tonePower(800, 600)
  const offHigh = tonePower(800, 1000)
  assert(onTone > offLow * 50 && onTone > offHigh * 50,
    'detector at the tone frequency reads far more power than off-tone bins',
    `on=${onTone.toExponential(2)} offLow=${offLow.toExponential(2)} offHigh=${offHigh.toExponential(2)}`)
}

// The detector tracks its OWN target: a 700 Hz tone peaks the 700 bin, not 800.
{
  const at700 = tonePower(700, 700)
  const at800 = tonePower(700, 800)
  assert(at700 > at800 * 10, 'a 700 Hz tone is strongest in the 700 Hz bin',
    `700bin=${at700.toExponential(2)} 800bin=${at800.toExponential(2)}`)
}

// Magnitude is normalized by sample count, so block length doesn't change scale.
{
  const short = tonePower(800, 800, 400)
  const long = tonePower(800, 800, 1600)
  assert(Math.abs(short - long) / long < 0.05,
    'power() is normalized — similar value for 400 vs 1600 samples',
    `short=${short.toExponential(3)} long=${long.toExponential(3)}`)
}

// power() resets state: a call with no samples since the last reset reads ~0.
{
  const g = new Goertzel(800, SR)
  for (let n = 0; n < 800; n++) g.process(Math.sin((2 * Math.PI * 800 * n) / SR))
  g.power() // consumes and resets
  const after = g.power() // nothing fed since the reset
  assert(after < 1e-9, 'power() resets detector state for the next block', `got ${after}`)
}

console.log(`\n${failures === 0 ? 'ALL GOERTZEL TESTS PASSED' : `${failures} GOERTZEL TEST(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
