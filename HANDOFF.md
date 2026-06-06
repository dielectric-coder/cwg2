# HANDOFF — G2 Morse Code Decoder

A briefing for continuing this project in Claude Code. Read this first; it
captures the architecture, what's verified vs. assumed, and the open work.

## What this app does

Listens through the Even Realities G2 microphone, auto-detects the CW tone
pitch, decodes Morse timing into text, and shows it on the glasses display —
including the dot/dash symbol being built live.

## Architecture

```
glasses mic ─PCM 16kHz─> pcm16ToFloat ─samples─> ToneScanner (auto-finds pitch)
   ─per 10ms block─> threshold ─on/off─> MorseDecoder (timing) ─char─> display
```

### Files

| File | Role | Touches SDK? |
| --- | --- | --- |
| `goertzel.ts` | Single-frequency energy detector (cheaper than an FFT). | No |
| `tone-scanner.ts` | Bank of Goertzels over 400–1000 Hz; auto-locks the pitch, interpolates between bins. | No |
| `morse-table.ts` | Dot/dash string -> character lookup. | No |
| `morse-decoder.ts` | Timing brain: durations -> dots/dashes/gaps/letters, adaptive WPM, live `onProgress`. | No |
| `main.ts` | Glue: audio capture, pipeline wiring, display, touch/lifecycle. | **Yes — only this one** |

**Design principle:** all DSP/decode logic is SDK-free so it can be unit-tested
in plain Node. Preserve this separation — it's what makes the project testable
without hardware. Only `main.ts` should ever import `@evenrealities/even_hub_sdk`.

## How to run

This directory is now a self-contained scaffold (`package.json` + vite + the
evenhub CLI/simulator as devDeps), so it runs on its own — no copying into a
sibling app needed:

```bash
npm run dev                                   # vite (uses :5173, or next free port)
npx evenhub-simulator http://localhost:5173   # point at whatever port vite prints
```

Controls: single press = start/stop, double press = clear text + re-arm tone detection.

### Driving the simulator headlessly (handy for verifying touch/audio)

Launch with an automation port and script input + read the webview console:

```bash
npx evenhub-simulator http://localhost:5173 --automation-port 9898
curl -s -X POST http://127.0.0.1:9898/api/input \
  -H 'Content-Type: application/json' -d '{"action":"click"}'   # also: double_click | up | down
curl -s http://127.0.0.1:9898/api/console                       # captured console.* + errors
curl -s http://127.0.0.1:9898/api/screenshot/glasses -o out.png # 576x288 framebuffer
```

The `Content-Type: application/json` header is required or the body is ignored.
This is exactly how the event/audio contract below was verified.

## How to test the logic (do this — it's the main leverage)

Because the logic is SDK-free, synthesize a tone and assert the decode in Node:

```bash
npx tsx your-test.ts   # build a sine-wave Morse stream, run it through
                       # ToneScanner + MorseDecoder, assert the output string
```

This caught a real bug during development (the tone lock resetting during Morse
silence gaps). Write a test before changing decode logic.

## VERIFIED (tested, working)

- Decodes `HI BOB` at 15 WPM and `SOS` at 18 WPM from synthesized audio.
- Auto-locks a 675 Hz tone — a pitch that is NOT one of the 50 Hz scan bins —
  via parabolic interpolation between the 650/700 bins.
- Adaptive WPM estimate tracks correctly — `decoder.test.ts` asserts it seeds
  from `initialWpm`, holds for a matched sender, and adapts both up (~24 wpm) and
  down (~10 wpm) from a mismatched seed.
- Live `onProgress` buffer builds elements in order (`.` `..` `...` ...) and
  clears (`""`) when each letter resolves — `decoder.test.ts` asserts the exact
  emission sequence, including the clear between letters.
- Stop-listening flushes the in-progress final letter — `decoder.flush()` commits
  the partially-sent letter into the decoded text (keeps it, doesn't drop it) and
  clears the live symbol. `decoder.test.ts` asserts this via the headless mirror,
  and contrasts it with double-press (which flushes then clears).
- Double-press reset clears the decoded text, the in-progress symbol, and the
  pitch lock, then re-arms detection (re-locks on a new tone and decodes cleanly)
  — `decoder.test.ts` exercises this via a headless mirror of main.ts. This test
  caught a real bug: the handler cleared the buffers *before* `decoder.flush()`,
  so a pending letter was re-emitted into the just-cleared text (now fixed by
  flushing/resetting before clearing).
- Pitch lock survives silent gaps but a double-press re-arms it — `decoder.test.ts`
  locks a tone, confirms the lock persists through silence (only an explicit
  double-press, not silence, clears it), then confirms a later DIFFERENT tone
  locks fresh rather than staying pinned to the old pitch.
- All four logic files typecheck clean under TypeScript strict mode.

### Event & audio I/O contract (verified against the evenhub simulator v0.7.3)

Confirmed live by driving the simulator's automation API (`--automation-port`,
`POST /api/input`, `GET /api/console`) and inspecting the actual events the app
received. This replaces the old guesses about field names — the code in
`main.ts` now matches what the host really sends:

- **Touch events arrive in two different envelopes, keyed by `eventType`
  (`OsEventTypeList`):**

  | Action | Envelope | `eventType` |
  | --- | --- | --- |
  | single click | `event.sysEvent` | **omitted** (proto default `0` = `CLICK_EVENT` is stripped on the wire) |
  | double click | `event.sysEvent` | `3` (`DOUBLE_CLICK_EVENT`) |
  | scroll up | `event.textEvent` | `1` (`SCROLL_TOP_EVENT`) |
  | scroll down | `event.textEvent` | `2` (`SCROLL_BOTTOM_EVENT`) |

  Clicks/double-clicks come on `sysEvent` (with `eventSource: 1`,
  `TOUCH_EVENT_FROM_GLASSES_R`), **not** `textEvent`. The handler reads
  `eventType` from `sysEvent ?? textEvent`, normalizes via
  `OsEventTypeList.fromJson`, and treats a missing/`0` type as a click. The
  earlier code only inspected `textEvent`, so every click was silently dropped
  and the app appeared frozen on "PAUSED".
- **A launch event mimics a click — must be filtered.** When the app enters the
  foreground the host emits a one-time event that is *byte-identical* to a click
  (bare `sysEvent`, `eventSource: 1`, `eventType` omitted). There is no field that
  distinguishes it from a real tap, so `main.ts` ignores bare `sysEvent`s during a
  short **startup grace window** (`STARTUP_GRACE_MS = 1200`). Without it the app
  toggles itself into `LISTENING` on launch. A real user tap (always seconds
  later) still registers. Verified: with the guard, the app sits at `PAUSED` on
  launch and through a 10 s idle window; clicks toggle cleanly thereafter.
- **Rendering: create the page ONCE, then update text in place.** The SDK marks
  `createStartUpPageContainer` as the launch-only call ("afterwards use
  `rebuildPageContainer`"); `bridge.textContainerUpgrade({containerID, containerName,
  content})` updates a container's text. `main.ts` now creates the page once
  (`pageCreated` flag) and upgrades every frame after. The previous code re-created
  the whole page on *every* `onProgress`/`onChar` tick, which re-issues the startup
  command continuously — heavy, and it resets host/sim state (it was the leading
  suspect for dropped touch input before the launch-event cause was found).
- **Only one container per page can capture events** (`isEventCapture: 1`, per the
  docs). Our single text container sets it. NOTE: in the simulator *GUI* you must
  select that container before the on-screen Up/Down/Click/Double-Click controls
  route to it; the automation API (`POST /api/input`) targets the active container
  directly, so it bypasses that manual step.
- **Audio payload:** the field is `event.audioEvent.audioPcm` (s16le PCM), **not**
  `.data`. Over the JSON bridge a `Uint8Array` arrives as a `number[]` (and may be
  base64 in other hosts), so `pcm16ToFloat` accepts bytes / `number[]` / base64.
  The simulator sends 100 ms per event (3200 bytes, 1600 samples @ 16 kHz).
- **Lifecycle:** `sysEvent` also carries `FOREGROUND_EXIT_EVENT (5)` /
  `ABNORMAL_EXIT_EVENT (6)` / `SYSTEM_EXIT_EVENT (7)`, which stop listening.
- **Docs vs. simulator mismatch:** the Input & Events guide says text containers
  receive clicks on `textEvent`; the simulator actually delivers click/double-click
  on `sysEvent` (scroll on `textEvent`). The handler reads `sysEvent ?? textEvent`
  so it works either way — re-confirm on hardware.
- **End-to-end:** with the above wired, a click flips to `LISTENING`, the tone
  auto-locks (~760–790 Hz observed), and live audio decodes to text in the sim.

> Caveat: verified against the **simulator**, not physical glasses. Real
> hardware *should* match (the simulator mirrors the SDK `.d.ts`), but re-confirm
> the `eventSource` value and audio cadence on a device when one is available.

## NOT VERIFIED / ASSUMPTIONS (check these on real hardware)

1. **Synthetic only.** Testing uses synthetic tones plus modelled white/brown
   noise (`tuning.test.ts`). Real acoustic CW over the air — fading, impure tone,
   room reverberation, AGC pumping — is still untested and will be messier.
2. **Acoustic, not digital.** The mic hears sound in the air — this decodes a
   practice oscillator / speaker / sidetone, NOT a digital tap into a rig.

## DONE — lock & WPM tuning (verified in `tuning.test.ts`)

Driven by a `tuning.test.ts` synth (brown/white noise, 5–20 dB SNR). Lock dropped
from a reported ~20 s to ~0.9 s, with no WPM overshoot:

- **Narrowed scan to 550–950 Hz @ 25 Hz** (`main.ts`). The old 400–1000 Hz band
  false-locked onto low-frequency room rumble under brown noise; excluding the low
  bins fixes that and the finer step tightens the pitch readout.
- **Spectral-peakiness signal detection** (`tone-scanner.ts`) replaced the temporal
  noise floor. A tone concentrates energy in one bin vs. broadband noise spread
  across bins, so `bestPower > median(binPowers) * signalPeakRatio` is
  level-independent and needs **no multi-second floor convergence** — that
  convergence was the suspected cause of the long "finding tone" delay.
- **WPM overshoot fixed**: decode only once locked + median-of-3 on/off debounce
  (`main.ts`), and the adaptive dot length is clamped to a 5–50 WPM band
  (`morse-decoder.ts`). The estimate no longer spikes to ~75 before settling.
- **Live pitch readout** while searching (`~753Hz locking...`) instead of a blank
  "finding tone...".

## OPEN NEXT STEPS (rough priority order)

1. **Re-confirm on real hardware**: the event/audio contract (sim-verified) AND the
   lock/WPM tuning (synth-verified) against a live signal — especially whether the
   ~20 s delay you saw was the floor or just the recording's spoken preamble.
2. **Tighter pitch accuracy** — a separate longer-window frequency estimator just
   for the display (e.g. integrate ~50 ms for pitch while keeping the 10 ms blocks
   for timing). The 10 ms blocks give only ~100 Hz Goertzel resolution, so the
   displayed pitch is good to ~±25–50 Hz; on a known 800 Hz source over the
   acoustic path it read a stable ~754 Hz. A longer window would narrow that.
3. **Steadier WPM display** — light smoothing/rounding so it reads a flat "25"
   instead of wobbling 24–26. The wobble is inherent ±1 quantization (a 25 WPM dot
   is 4.8 blocks, measured as whole 10 ms blocks), so this is display polish only.
4. **Show last decoded letter** next to the live symbol on the display.
5. **Per-source input** — decode-control on glasses tap vs. R1 ring tap.
6. **Tune `lockStreak` / `signalPeakRatio` / scan band** once tested on real signals.
7. **Investigate the 800→750 Hz shift** — check whether it's playback/PipeWire/sim
   resampling (ratio ~0.9375) vs. acoustic coloring, by feeding a known reference
   tone and comparing the captured pitch.

## Tuning knobs (where they live)

- Scan range/step: `main.ts` -> `ToneScanner({ minFreq: 550, maxFreq: 950, stepFreq: 25 })`
- Signal-vs-noise sensitivity: `tone-scanner.ts` -> `signalPeakRatio` (peak/median)
- Lock speed: `tone-scanner.ts` -> `lockStreak`
- On/off threshold + glitch debounce: `main.ts` -> `peakPower * 0.25`, median-of-3
- WPM band + adaptation rate: `morse-decoder.ts` -> `minWpm`/`maxWpm`, `alpha`
- Startup tap grace: `main.ts` -> `STARTUP_GRACE_MS`

## Useful references

- SDK skills for Claude Code: https://hub.evenrealities.com/docs/AI-tooling/claude%20code/skill-catalog
- Device APIs (audio format, events): https://hub.evenrealities.com/docs/guides/device-apis
- Input & Events: https://hub.evenrealities.com/docs/guides/input-events
- SDK package (authoritative types in its .d.ts): https://www.npmjs.com/package/@evenrealities/even_hub_sdk

## First thing to tell Claude Code

> "Read HANDOFF.md and README.md. The decode logic is SDK-free and tested in
> Node (`decoder.test.ts`, `tuning.test.ts`) — keep it that way; add/extend a test
> before changing `tone-scanner.ts` or `morse-decoder.ts`. The event/audio contract
> and lock/WPM tuning are verified against the simulator only — next real step is
> confirming them on physical glasses with a live signal."
