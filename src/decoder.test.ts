/**
 * decoder.test.ts
 * ---------------
 * SDK-free verification of the decode logic, the way HANDOFF.md prescribes:
 * synthesize a Morse stream and assert the decoded text in plain Node.
 *
 *   npx tsx decoder.test.ts
 *
 * Two layers are tested:
 *   1. MorseDecoder alone — feed tone on/off blocks, assert the timing logic.
 *   2. The full pipeline — synthesize sine-wave audio, run it through
 *      ToneScanner + threshold + MorseDecoder, assert the text AND the pitch lock.
 *
 * No test framework: tiny assert harness, non-zero exit on any failure.
 */

import { MorseDecoder } from './morse-decoder'
import { ToneScanner } from './tone-scanner'

// --- Same constants as main.ts ---
const SAMPLE_RATE = 16000
const BLOCK_SAMPLES = 160
const BLOCKS_PER_SECOND = SAMPLE_RATE / BLOCK_SAMPLES // 100

// "." dot = 1 unit on, "-" dash = 3 units on. Only the letters used in tests.
const CHAR_TO_MORSE: Record<string, string> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.',
  H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.',
  O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-',
  V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-',
  '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
}

/**
 * Turn text into a stream of per-block tone on/off booleans using standard
 * Morse ratios. `unit` is the dot length in blocks. Words are separated by a
 * single space in the input. No leading or trailing silence.
 */
function encodeBlocks(text: string, unit: number): boolean[] {
  const on = (n: number) => Array<boolean>(n).fill(true)
  const off = (n: number) => Array<boolean>(n).fill(false)
  const words = text.split(' ')
  const blocks: boolean[] = []

  words.forEach((word, wi) => {
    if (wi > 0) blocks.push(...off(7 * unit)) // word gap
    for (let ci = 0; ci < word.length; ci++) {
      if (ci > 0) blocks.push(...off(3 * unit)) // inter-letter gap
      const pattern = CHAR_TO_MORSE[word[ci]]
      if (!pattern) throw new Error(`no Morse for '${word[ci]}'`)
      pattern.split('').forEach((el, ei) => {
        if (ei > 0) blocks.push(...off(unit)) // intra-letter gap
        blocks.push(...on(el === '-' ? 3 * unit : unit))
      })
    }
  })
  return blocks
}

/** Run a boolean block stream straight through MorseDecoder. */
function decodeBlocks(blocks: boolean[]): string {
  let out = ''
  const decoder = new MorseDecoder({
    blocksPerSecond: BLOCKS_PER_SECOND,
    onChar: (c) => { out += c },
  })
  for (const b of blocks) decoder.pushBlock(b)
  decoder.flush()
  return out
}

/** Feed a block stream and report the decoder's estimated WPM after it settles. */
function estimatedWpmAfter(blocks: boolean[], initialWpm: number): number {
  const decoder = new MorseDecoder({ blocksPerSecond: BLOCKS_PER_SECOND, initialWpm, onChar: () => {} })
  for (const b of blocks) decoder.pushBlock(b)
  decoder.flush()
  return decoder.estimatedWpm
}

/** Feed a block stream and capture every onProgress value, in order. */
function progressLog(blocks: boolean[]): string[] {
  const log: string[] = []
  const decoder = new MorseDecoder({
    blocksPerSecond: BLOCKS_PER_SECOND,
    onChar: () => {},
    onProgress: (p) => log.push(p),
  })
  for (const b of blocks) decoder.pushBlock(b)
  decoder.flush()
  return log
}

/** Synthesize s16-range float audio: a sine at `freq` while tone is on, silence off. */
function synthAudio(blocks: boolean[], freq: number): number[] {
  const samples: number[] = []
  let n = 0
  for (const isOn of blocks) {
    for (let i = 0; i < BLOCK_SAMPLES; i++, n++) {
      samples.push(isOn ? 0.5 * Math.sin((2 * Math.PI * freq * n) / SAMPLE_RATE) : 0)
    }
  }
  return samples
}

/** Run synthesized audio through the exact pipeline main.ts uses. */
function decodeAudio(blocks: boolean[], freq: number): { text: string; lockedFreq: number | null } {
  const scanner = new ToneScanner({ sampleRate: SAMPLE_RATE, minFreq: 400, maxFreq: 1000, stepFreq: 50 })
  let out = ''
  const decoder = new MorseDecoder({ blocksPerSecond: BLOCKS_PER_SECOND, onChar: (c) => { out += c } })

  let peakPower = 1e-9
  let lockedFreq: number | null = null
  let buf: number[] = []
  const samples = synthAudio(blocks, freq)

  for (const s of samples) {
    buf.push(s)
    if (buf.length >= BLOCK_SAMPLES) {
      for (const x of buf) scanner.process(x)
      const res = scanner.finishBlock()
      buf = []
      peakPower = Math.max(res.power, peakPower * 0.999)
      decoder.pushBlock(res.power > peakPower * 0.25)
      lockedFreq = res.lockedFreq
    }
  }
  decoder.flush()
  return { text: out, lockedFreq }
}

/**
 * A headless stand-in for main.ts: the same scanner + decoder + threshold wiring
 * and the same user-visible state (decodedText / partialSymbol / lockedFreq), so
 * the double-press reset can be exercised without the SDK. The `doublePress`
 * body MUST mirror main.ts's DOUBLE_CLICK_EVENT handler — keep them in sync.
 */
function makeApp() {
  let decodedText = ''
  let partialSymbol = ''
  let lockedFreq: number | null = null

  const scanner = new ToneScanner({ sampleRate: SAMPLE_RATE, minFreq: 400, maxFreq: 1000, stepFreq: 50 })
  const decoder = new MorseDecoder({
    blocksPerSecond: BLOCKS_PER_SECOND,
    onChar: (c) => { decodedText += c },
    onProgress: (p) => { partialSymbol = p },
  })

  let peakPower = 1e-9
  let buf: number[] = []

  function feed(blocks: boolean[], freq: number): void {
    for (const s of synthAudio(blocks, freq)) {
      buf.push(s)
      if (buf.length >= BLOCK_SAMPLES) {
        for (const x of buf) scanner.process(x)
        const res = scanner.finishBlock()
        buf = []
        peakPower = Math.max(res.power, peakPower * 0.999)
        decoder.pushBlock(res.power > peakPower * 0.25)
        lockedFreq = res.lockedFreq
      }
    }
  }

  function doublePress(): void {
    // Mirrors main.ts DOUBLE_CLICK_EVENT: flush/reset the engine, THEN clear the
    // visible buffers (flush emits a pending letter via onChar, so clearing must
    // come last or that letter lands back in decodedText).
    decoder.flush()
    scanner.resetLock()
    decodedText = ''
    partialSymbol = ''
    lockedFreq = null
  }

  // Mirrors main.ts stopListening(): flush commits the in-progress final letter
  // to the text (and clears the live symbol via onProgress('')).
  function stop(): void { decoder.flush() }

  return { feed, doublePress, stop, get: () => ({ decodedText, partialSymbol, lockedFreq }) }
}

// --- Tiny assert harness ---
let failures = 0
function assertEqual(actual: unknown, expected: unknown, msg: string): void {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}` + (ok ? '' : `\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`))
}
function assertNear(actual: number | null, expected: number, tol: number, msg: string): void {
  const ok = actual !== null && Math.abs(actual - expected) <= tol
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}` + (ok ? '' : `\n      expected ${expected}±${tol}, got ${actual}`))
}

// --- Tests: MorseDecoder timing logic ---
const UNIT_15WPM = 8 // 1.2/15 s = 80 ms = 8 blocks at 100 blocks/s
assertEqual(decodeBlocks(encodeBlocks('HI BOB', UNIT_15WPM)), 'HI BOB', 'decodes "HI BOB" (word + letter gaps)')
assertEqual(decodeBlocks(encodeBlocks('SOS', UNIT_15WPM)), 'SOS', 'decodes "SOS"')
assertEqual(decodeBlocks(encodeBlocks('E', UNIT_15WPM)), 'E', 'single dot -> E, flushed at end')
assertEqual(decodeBlocks(encodeBlocks('T', UNIT_15WPM)), 'T', 'single dash -> T')
assertEqual(decodeBlocks(encodeBlocks('PARIS', UNIT_15WPM)), 'PARIS', 'mixed dots/dashes')
assertEqual(decodeBlocks(encodeBlocks('SOS HELP', UNIT_15WPM)), 'SOS HELP', 'two words')
assertEqual(decodeBlocks(encodeBlocks('73', UNIT_15WPM)), '73', 'digits decode')

// An unmapped element run decodes to "?", not a crash. Six dots is not in the
// table (five dots would be the digit "5").
const sixDots: boolean[] = []
for (let i = 0; i < 6; i++) {
  if (i > 0) sixDots.push(...Array(8).fill(false))
  sixDots.push(...Array(8).fill(true))
}
assertEqual(decodeBlocks(sixDots), '?', '6-dot run (unmapped) -> "?"')

// Adapts to a faster sender (5 blocks/unit ~= 24 wpm).
assertEqual(decodeBlocks(encodeBlocks('HI BOB', 5)), 'HI BOB', 'decodes at a different speed (adaptive dot length)')

// --- Tests: adaptive WPM estimate ---
// estimatedWpm = round(1.2 / (dotBlocks / blocksPerSecond)) = round(120 / dotBlocks).
// Before any input it reflects the seeded initialWpm; after input it tracks the
// actual sender, regardless of where it started.
assertEqual(estimatedWpmAfter([], 15), 15, 'WPM estimate seeds from initialWpm before any input')
// Sender at 8 blocks/unit -> 15 wpm; from a 15 wpm seed it should hold ~15.
assertNear(estimatedWpmAfter(encodeBlocks('PARIS PARIS', 8), 15), 15, 1, 'WPM estimate holds ~15 for a 15 wpm sender')
// Sender at 5 blocks/unit -> 24 wpm; seeded slow at 10 wpm, it must adapt UP.
assertNear(estimatedWpmAfter(encodeBlocks('PARIS PARIS', 5), 10), 24, 2, 'WPM estimate adapts up to ~24 for a fast sender')
// Sender at 12 blocks/unit -> 10 wpm; seeded fast at 25 wpm, it must adapt DOWN.
assertNear(estimatedWpmAfter(encodeBlocks('PARIS PARIS', 12), 25), 10, 2, 'WPM estimate adapts down to ~10 for a slow sender')

// --- Tests: live onProgress buffer ---
// Each landed element fires with the symbol-so-far; emitting the letter fires "".
assertEqual(JSON.stringify(progressLog(encodeBlocks('S', UNIT_15WPM))),
  JSON.stringify(['.', '..', '...', '']), 'onProgress builds "." -> ".." -> "..." then clears for "S"')
assertEqual(JSON.stringify(progressLog(encodeBlocks('A', UNIT_15WPM))),
  JSON.stringify(['.', '.-', '']), 'onProgress shows dot then dash for "A" (".-")')
// Across letters the buffer must clear ("") before the next one starts.
assertEqual(JSON.stringify(progressLog(encodeBlocks('HI', UNIT_15WPM))),
  JSON.stringify(['.', '..', '...', '....', '', '.', '..', '']),
  'onProgress clears between letters in "HI"')

// --- Tests: full audio pipeline (HANDOFF's headline claims) ---
const r675 = decodeAudio(encodeBlocks('HI BOB', UNIT_15WPM), 675)
assertEqual(r675.text, 'HI BOB', 'pipeline decodes "HI BOB" from synthesized 675 Hz audio')
assertNear(r675.lockedFreq, 675, 30, 'auto-locks ~675 Hz via parabolic interpolation (off-bin pitch)')

const r600 = decodeAudio(encodeBlocks('SOS', UNIT_15WPM), 600)
assertEqual(r600.text, 'SOS', 'pipeline decodes "SOS" from synthesized 600 Hz audio (on a scan bin)')
assertNear(r600.lockedFreq, 600, 30, 'auto-locks ~600 Hz')

// --- Tests: stopListening flushes the in-progress letter ---
// main.ts stopListening() calls decoder.flush(). Unlike double-press (which then
// clears), here the partially-sent FINAL letter must be committed to the text —
// not lost — and the live symbol cleared.
{
  const app = makeApp()
  app.feed(encodeBlocks('SOS', UNIT_15WPM), 600) // ends mid-third-letter, no trailing gap
  const before = app.get()
  assertEqual(before.decodedText, 'SO', 'precondition: final letter still pending before stop')
  assertEqual(before.partialSymbol, '..', 'precondition: in-progress symbol shown before stop')

  app.stop()
  const after = app.get()
  assertEqual(after.decodedText, 'SOS', 'stopListening flushes the pending letter into the text')
  assertEqual(after.partialSymbol, '', 'stopListening clears the in-progress symbol')
}

// --- Tests: double-press reset (clear + re-arm) ---
// Send "SOS" at 675 Hz, stopping mid-third-letter so there is a pending letter,
// in-progress symbol, and a locked pitch — exactly the state a double-press must
// wipe. Then double-press and assert everything is cleared and detection re-arms.
{
  const app = makeApp()
  app.feed(encodeBlocks('SOS', UNIT_15WPM), 675)
  const before = app.get()
  assertNear(before.lockedFreq, 675, 30, 'precondition: pitch is locked before double-press')

  app.doublePress()
  const after = app.get()
  assertEqual(after.decodedText, '', 'double-press clears the decoded text (no stray flushed letter)')
  assertEqual(after.partialSymbol, '', 'double-press clears the in-progress symbol')
  assertEqual(after.lockedFreq, null, 'double-press drops the pitch lock (re-arms detection)')

  // After the reset the engine must work from a clean slate: re-lock on a new
  // tone and decode without contamination from the pre-press input.
  app.feed(encodeBlocks('OK', UNIT_15WPM), 820)
  app.stop()
  const fresh = app.get()
  assertEqual(fresh.decodedText, 'OK', 'decoding resumes cleanly after double-press')
  assertNear(fresh.lockedFreq, 820, 30, 're-locks on the new tone after double-press')
}

// --- Tests: double-press re-arms during silence ---
// Lock a pitch, let the signal go silent, then double-press while silent. The
// lock must drop even with no tone present, and a later DIFFERENT tone must lock
// fresh — proving the scanner isn't left pinned to the old pitch.
{
  const app = makeApp()
  app.feed(Array(20).fill(true), 600) // steady tone -> lock ~600
  assertNear(app.get().lockedFreq, 600, 30, 'precondition: locked ~600 on the first tone')

  app.feed(Array(15).fill(false), 0) // signal stops; lock persists through silence
  assertNear(app.get().lockedFreq, 600, 30, 'lock survives a silent gap (not reset by silence alone)')

  app.doublePress() // re-arm while silent
  assertEqual(app.get().lockedFreq, null, 'double-press during silence drops the lock')

  app.feed(Array(20).fill(true), 850) // a new, different tone arrives
  assertNear(app.get().lockedFreq, 850, 30, 're-locks on the new pitch after a silent re-arm')
}

// --- Tests: word-gap spacing (no stray leading/empty-content space) ---
// A word gap (>=5 units OFF) must emit a space only when a letter actually
// precedes it — never a leading space, never a doubled space.
{
  const decodeRuns = (runs: Array<[boolean, number]>): string => {
    let out = ''
    const d = new MorseDecoder({ blocksPerSecond: BLOCKS_PER_SECOND, initialWpm: 15, onChar: (c) => (out += c) })
    for (const [on, n] of runs) for (let i = 0; i < n; i++) d.pushBlock(on)
    d.flush()
    return out
  }
  const U = UNIT_15WPM
  assertEqual(decodeRuns([[false, 7 * U], [true, U]]), 'E',
    'a word gap before any letter does NOT emit a leading space')
  assertEqual(decodeRuns([[true, U], [false, 7 * U], [true, U]]), 'E E',
    'a word gap between letters emits exactly one space')
  assertEqual(decodeRuns([[true, U], [false, 3 * U], [true, U]]), 'EE',
    'a letter gap emits no space')
}

// --- Summary ---
console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
