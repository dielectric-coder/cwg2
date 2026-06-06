# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A CW (Morse code) decoder app for Even Realities G2 smart glasses. It listens
through the glasses mic, auto-detects the CW tone pitch, decodes Morse timing
into text, and renders it on the display (including the in-progress dot/dash
symbol live as it builds).

This directory is **just the source modules** — five `.ts` files, no
`package.json`/`tsconfig.json`/build of its own. They are meant to be dropped
into a G2 app scaffold's `src/` folder (replacing the scaffold's `main.ts`). The
sibling `../demo-app-g2` is an example of such a scaffold (vite + `evenhub` CLI +
`@evenrealities/even_hub_sdk`).

Read `HANDOFF.md` first — it records what is verified vs. assumed and the
prioritized open work. `README.md` covers tuning knobs and controls.

## Architecture

```
glasses mic ─PCM 16kHz s16le─> pcm16ToFloat ─samples─> ToneScanner (auto-finds pitch)
   ─per 10ms block─> threshold ─on/off─> MorseDecoder (timing) ─char─> display
```

| File | Role | Imports SDK? |
| --- | --- | --- |
| `goertzel.ts` | Single-frequency energy detector (cheaper than an FFT). | No |
| `tone-scanner.ts` | Bank of Goertzels over 400–1000 Hz; auto-locks the pitch, parabolic-interpolates between bins for sub-bin accuracy. | No |
| `morse-table.ts` | Dot/dash string → character lookup. | No |
| `morse-decoder.ts` | Timing brain: on/off durations → dots/dashes/gaps/letters, adaptive WPM, live `onProgress`. | No |
| `main.ts` | Glue: audio capture, pipeline wiring, display, touch/lifecycle. | **Yes — only this one** |

### The one rule that shapes everything

**Only `main.ts` may import `@evenrealities/even_hub_sdk`.** All DSP and decode
logic is deliberately SDK-free so it can be unit-tested in plain Node without
hardware. Preserve this separation when adding features — it is the project's
main source of leverage and is how every shipped feature was verified.

### Cross-file contracts worth knowing before editing

- **Block rate is the shared clock.** `main.ts` batches samples into 160-sample
  blocks (10 ms at 16 kHz → 100 blocks/sec) and passes `blocksPerSecond` into
  `MorseDecoder`. The decoder measures all Morse timing in *blocks*, not seconds.
  Changing `BLOCK_SAMPLES` changes the decoder's time resolution.
- **`Goertzel.power()` and `ToneScanner.finishBlock()` have reset side-effects** —
  each resets detector state for the next block. Call them exactly once per block.
- **Threshold is amplitude-relative**, not absolute: `peakPower * 0.25` with a
  slow peak decay (`peakPower * 0.999`) in `main.ts`. The scanner separately
  tracks a noise floor so the lock only updates while real signal is present
  (Morse is mostly silence — silent blocks must not reset the lock).
- **Dot/dash and gap boundaries** live in `morse-decoder.ts`: ON run ≥ `2×dotBlocks`
  is a dash; OFF run of `2..5` units is a letter gap, `≥5` units a word gap. Dot
  length adapts via exponential smoothing (`alpha`) from observed pulses.

## Commands

There is no build here. Run everything from the host scaffold after copying the
five files into its `src/`. Using `../demo-app-g2`'s scripts as the reference:

```bash
npm run dev                              # vite dev server on :5173
npx @evenrealities/evenhub-simulator http://localhost:5173   # or: npm run qr to scan onto real glasses
```

### Testing the decode logic (do this before changing decode logic)

Because the logic is SDK-free, synthesize a sine-wave Morse stream, run it
through `ToneScanner` + `MorseDecoder`, and assert the output string in Node:

```bash
npx tsx your-test.ts
```

This is how `HI BOB`/`SOS` decoding, the 650 Hz interpolated lock, and adaptive
WPM were all validated, and it caught a real bug (the tone lock resetting during
Morse silence gaps). Write a test before touching `morse-decoder.ts` or
`tone-scanner.ts`.

## Unverified assumptions (check on real hardware before trusting)

These are taken from SDK docs, not confirmed against a device — see `HANDOFF.md`
for the full list:

- **Audio payload shape.** `pcm16ToFloat` in `main.ts` assumes
  `event.audioEvent.data` is a byte buffer of s16le PCM (it reads byte pairs). If
  the SDK hands back an `Int16Array` directly, this conversion needs adjusting.
  Verify against the SDK's `.d.ts` in the scaffold's `node_modules` first.
- **Event field names** (`textEvent`, `sysEvent`, `audioEvent`, `OsEventTypeList`
  members) are from docs — confirm against the actual SDK types.
