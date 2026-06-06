# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A CW (Morse code) decoder app for Even Realities G2 smart glasses. It listens
through the glasses mic, auto-detects the CW tone pitch, decodes Morse timing
into text, and renders it on the display (including the in-progress dot/dash
symbol live as it builds).

This directory is a **self-contained vite project** (its own `package.json`,
`index.html`, and dev tooling — `@evenrealities/even_hub_sdk` plus the evenhub CLI
and simulator). It runs on its own; nothing is copied into another scaffold.

Docs:
- `HANDOFF.md` — verified-vs-assumed status and prioritized open work. **Read first.**
- `DEV-GUIDE.md` — architecture, build/run, testing, the verified SDK contract, tuning.
- `USER-GUIDE.md` — end-user instructions (controls, reading the display, troubleshooting).
- `README.md` — short project overview.

## Architecture

```
glasses mic ─PCM 16kHz s16le─> pcm16ToFloat ─samples─> ToneScanner (auto-finds pitch)
   ─per 10ms block─> threshold ─on/off─> MorseDecoder (timing) ─char─> display
```

| File | Role | Imports SDK? |
| --- | --- | --- |
| `goertzel.ts` | Single-frequency energy detector (cheaper than an FFT). | No |
| `tone-scanner.ts` | Bank of Goertzels over the CW band (550–950 Hz); detects a tone by spectral peakiness, auto-locks the pitch, interpolates between bins, smooths the locked value. | No |
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
- **Decode threshold is amplitude-relative**, not absolute: `peakPower * 0.25` with
  a slow peak decay (`peakPower * 0.999`) in `main.ts`, plus a median-of-3 debounce.
  `main.ts` only feeds the decoder **once the pitch is locked**.
- **Tone detection uses spectral peakiness, not a noise floor.** The scanner flags
  a block as signal when `bestPower > median(binPowers) * signalPeakRatio` — a tone
  is one peaky bin, noise is spread across bins. Level-independent; silent blocks
  don't reset the lock (Morse is mostly silence). The locked frequency is EWMA-
  smoothed for a steady readout.
- **Dot/dash and gap boundaries** live in `morse-decoder.ts`: ON run ≥ `2×dotBlocks`
  is a dash; OFF run of `2..5` units is a letter gap, `≥5` units a word gap. Dot
  length adapts via exponential smoothing (`alpha`) from observed pulses and is
  clamped to a `minWpm..maxWpm` band.

## Commands

Self-contained — run from this directory:

```bash
npm install
npm run dev                                  # vite dev server (prints port, usually :5173)
npx @evenrealities/evenhub-simulator http://localhost:5173   # glasses simulator
npm run build                                # tsc + vite production build
```

### Testing the decode logic (do this before changing decode logic)

Because the logic is SDK-free, synthesize a sine-wave Morse stream, run it
through `ToneScanner` + `MorseDecoder`, and assert the output in Node:

```bash
npx tsx src/decoder.test.ts   # decode correctness, lock, onProgress, flush, double-press reset
npx tsx src/tuning.test.ts    # lock speed + WPM convergence over modelled white/brown noise
```

This is how decoding, the interpolated lock, adaptive WPM, fast/stable locking, and
the WPM-overshoot fix were all validated, and it caught real bugs (the lock
resetting during silence; the frequency jitter). **Write or extend a test before
touching `morse-decoder.ts` or `tone-scanner.ts`.** The simulator also exposes an
automation API (`--automation-port`) for headless input/console/screenshot — see
`DEV-GUIDE.md`.

## SDK / host contract (verified against the simulator)

These were once guesses from the docs; all are now confirmed (see `HANDOFF.md` for
the full table). Key points: a **click arrives on `event.sysEvent`** (eventType
omitted = CLICK), not `textEvent`; the **foreground/launch event is click-shaped**
and is filtered by a startup grace window; render with **`createStartUpPageContainer`
once then `textContainerUpgrade`**; audio is **`event.audioEvent.audioPcm`** (not
`.data`). Still unverified: behaviour on **physical glasses** (all of the above is
simulator-confirmed only).
