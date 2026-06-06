# G2 Morse Code Decoder

An Even Realities G2 app that listens through the glasses microphone, automatically
finds the CW (Morse) tone pitch, decodes the timing into text, and shows it on the
display — including the dot/dash symbol being built live.

It decodes **audible** CW (a practice oscillator, speaker, or sidetone), not a
digital tap into a radio.

```
glasses mic ─PCM 16kHz─> pcm16ToFloat ─> ToneScanner (auto-finds pitch)
   ─per 10ms block─> threshold ─on/off─> debounce ─> MorseDecoder ─char─> display
```

## Quick start

Self-contained vite project — runs on its own:

```bash
npm install
npm run dev
npx @evenrealities/evenhub-simulator http://localhost:5173
```

Tap once to start listening; play CW in the 600–900 Hz range into the mic.

## Controls

- **Single tap** — start / stop listening
- **Double tap** — clear text and re-find the tone

## Files

| File | Role | SDK? |
| --- | --- | --- |
| `goertzel.ts` | Detects energy at one frequency (cheaper than an FFT). | No — pure math |
| `tone-scanner.ts` | A bank of Goertzels over 550–950 Hz; detects a tone by spectral peakiness, locks the pitch, smooths the readout. | No — pure math |
| `morse-table.ts` | Maps dot/dash strings to characters. | No — pure data |
| `morse-decoder.ts` | Tone on/off durations → dots, dashes, gaps, letters, with adaptive (clamped) speed and a live in-progress callback. | No — pure logic |
| `main.ts` | Glue: audio capture, pipeline, display, touch. | Yes — the only SDK file |

Keeping the DSP/decode logic SDK-free means it's unit-tested in plain Node
(`npx tsx src/decoder.test.ts`, `npx tsx src/tuning.test.ts`).

## Documentation

- **[USER-GUIDE.md](USER-GUIDE.md)** — using the app: controls, reading the display,
  getting good results, troubleshooting.
- **[DEV-GUIDE.md](DEV-GUIDE.md)** — architecture, build/run, testing, the verified
  SDK/event contract, tuning knobs, headless simulator automation.
- **[HANDOFF.md](HANDOFF.md)** — what's verified vs. assumed, and the prioritized
  open work.
- **[CLAUDE.md](CLAUDE.md)** — guidance for Claude Code working in this repo.

## Status

Working and verified in the evenhub simulator: touch handling, live decoding, fast
and stable tone lock, steady frequency readout, and a clamped WPM estimate. The
SDK/event contract and the tone/decoder tuning are simulator-verified; confirming
them on physical glasses is the main open step (see HANDOFF.md).
