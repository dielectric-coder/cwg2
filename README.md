# G2 Morse Code Decoder

An Even Realities G2 app: listens through the glasses microphone, automatically
finds the CW tone pitch, decodes the Morse timing into text, and shows it on the
display — including the dot/dash symbol being built live.

## How it works (the pipeline)

```
glasses mic ─PCM 16kHz─> pcm16ToFloat ─samples─> ToneScanner (auto-finds pitch)
   ─per 10ms block─> threshold ─on/off─> MorseDecoder (timing) ─char─> display
```

## Files

| File | Role | SDK? |
| --- | --- | --- |
| `goertzel.ts` | Detects energy at ONE frequency. Cheaper than an FFT. | No — pure math |
| `tone-scanner.ts` | A BANK of Goertzels across 400–1000 Hz; auto-locks the CW pitch and interpolates between bins for sub-bin accuracy. | No — pure math |
| `morse-table.ts` | Maps dot/dash strings to characters. | No — pure data |
| `morse-decoder.ts` | The brain: tone on/off durations -> dots, dashes, gaps, letters, with adaptive speed and a live in-progress callback. | No — pure logic |
| `main.ts` | Glue: captures audio, runs the pipeline, draws to the glasses, handles touch. | Yes — the only SDK file |

Keeping the logic SDK-free means you can unit-test it in plain Node — which is
how this was verified: it decodes `HI BOB` and `SOS`, and auto-locks a 675 Hz
tone (a pitch that isn't one of the 50 Hz scan bins) via interpolation between
the 650/700 bins. See `decoder.test.ts` (`npx tsx decoder.test.ts`).

## What's new vs the first version

- **Automatic tone detection** — no more hand-set `TONE_FREQ`. The scanner runs
  detectors across 400–1000 Hz, locks onto whichever pitch is consistently
  loudest (only while real signal is present, so silence gaps don't reset it),
  and uses parabolic interpolation to read the true pitch between bins.
- **Live in-progress symbol** — the decoder fires `onProgress` as each dot/dash
  lands, so the display shows e.g. `> .-` before it resolves to a letter.

## Controls

- **Single press** — start / stop listening
- **Double press** — clear text and re-arm tone detection

## Setup

Drop all five `.ts` files into your `src/` folder (replacing the existing
`main.ts`), then:

```bash
npm run dev
npx evenhub-simulator http://localhost:5173
```

## Tuning

- Scan range / step in `main.ts` (`minFreq`, `maxFreq`, `stepFreq`) — wider or
  finer detection vs. more CPU. 50 Hz step over 400–1000 Hz is a good default.
- `lockStreak` in `tone-scanner.ts` — how many signal blocks must agree before
  locking a pitch (lower = faster lock, more jitter).
- Threshold fraction (`peakPower * 0.25`) in `main.ts` — lower for weak signals.
- `alpha` in `morse-decoder.ts` — how fast the WPM estimate adapts.

## Reality check

The mic hears **acoustic** sound, so this decodes audible CW — a practice
oscillator, a speaker, or a key's sidetone — not a digital tap into a radio's
audio path.

## Testing the logic without hardware

Synthesize a tone, run it through `ToneScanner` + `MorseDecoder`, and assert the
output in plain Node (`npx tsx your-test.ts`). All shipped logic was validated
this way under TypeScript strict mode.

## Possible next steps

- Separate noise-floor tracking for the on/off threshold (not just peak decay).
- Smoothing on the tone decision to reject single-block clicks.
- Show the last decoded letter alongside the live symbol.
- Per-source handling (decode only when the glasses, not the R1 ring, is tapped).
