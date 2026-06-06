# Developer Guide — G2 CW Decoder

How the app is built, how to run and test it, and the contracts to respect when
changing it. For end-user instructions see [USER-GUIDE.md](USER-GUIDE.md); for the
verified-vs-assumed status and open work see [HANDOFF.md](HANDOFF.md).

## Quick start

This directory is a **self-contained** vite project (it has its own
`package.json`, `index.html`, and dev tooling — you do **not** copy the files into
another scaffold).

```bash
npm install
npm run dev                                  # vite dev server (prints the port, usually :5173)
npx @evenrealities/evenhub-simulator http://localhost:5173   # open the glasses simulator
npm run build                                # tsc + vite production build
```

To run on real glasses, serve the dev/build and load it via the evenhub CLI / QR
flow (see the SDK docs linked in HANDOFF.md).

## Architecture

```
glasses mic ─PCM 16kHz s16le─> pcm16ToFloat ─samples─> ToneScanner (auto-finds pitch)
   ─per 10ms block─> threshold ─on/off─> debounce ─> MorseDecoder (timing) ─char─> display
```

| File | Role | Imports SDK? |
| --- | --- | --- |
| `src/goertzel.ts` | Single-frequency energy detector (cheaper than an FFT). | No |
| `src/tone-scanner.ts` | Bank of Goertzels over the CW band; detects a tone by spectral peakiness, locks the pitch, interpolates between bins, smooths the locked value. | No |
| `src/morse-table.ts` | Dot/dash string → character lookup. | No |
| `src/morse-decoder.ts` | Timing brain: on/off durations → dots/dashes/gaps/letters, adaptive + clamped WPM, live `onProgress`. | No |
| `src/main.ts` | Glue: audio capture, pipeline wiring, display, touch/lifecycle. | **Yes — only this one** |

### The one rule that shapes everything

**Only `main.ts` may import `@evenrealities/even_hub_sdk`.** All DSP and decode
logic is deliberately SDK-free so it can be unit-tested in plain Node without
hardware. Preserve this separation when adding features — it is the project's main
source of leverage and is how every shipped feature was verified.

### Cross-file contracts worth knowing before editing

- **Block rate is the shared clock.** `main.ts` batches samples into 160-sample
  blocks (10 ms at 16 kHz → 100 blocks/sec) and passes `blocksPerSecond` into
  `MorseDecoder`, which measures all Morse timing in *blocks*, not seconds.
  Changing `BLOCK_SAMPLES` changes the decoder's time resolution **and** the tone
  scanner's frequency resolution (~SR/BLOCK ≈ 100 Hz).
- **`Goertzel.power()` and `ToneScanner.finishBlock()` reset detector state** for
  the next block. Call each exactly once per block.
- **Decoder threshold is amplitude-relative**, not absolute: `peakPower * 0.25`
  with a slow peak decay (`peakPower * 0.999`) in `main.ts`.
- **Dot/dash and gap boundaries** live in `morse-decoder.ts`: an ON run
  ≥ `2×dotBlocks` is a dash; an OFF run of `2..5` units is a letter gap, `≥5` units
  a word gap. Dot length adapts via exponential smoothing (`alpha`) and is clamped
  to a `minWpm..maxWpm` band.

## Signal-processing details

- **Scan band:** `main.ts` runs the scanner over **550–950 Hz at 25 Hz** (centred
  on the 600–900 Hz operators actually use). Excluding the low bins stops the
  scanner from false-locking onto low-frequency room rumble (verified — a wide
  400–1000 Hz band locked onto 400 Hz under modelled brown noise).
- **Signal detection is by spectral peakiness, not a noise floor.** A tone
  concentrates energy in one bin (plus leakage into neighbours); broadband noise
  spreads across bins. `tone-scanner.ts` flags a block as carrying signal when
  `bestPower > median(binPowers) * signalPeakRatio`. This is level-independent, so
  it works the instant audio starts — no multi-second floor convergence.
- **Lock:** the same bin (±1) must win `lockStreak` consecutive signal-bearing
  blocks. Silent blocks don't count and don't reset the streak (Morse is mostly
  silence), so the streak accumulates across elements.
- **Frequency readout is smoothed.** Once locked, the displayed pitch is an EWMA of
  the per-block interpolated peak; without it a steady tone flickers across tens of
  Hz. Note the absolute accuracy is limited to ~±25–50 Hz by the 100 Hz block
  resolution (a time-vs-frequency trade-off with Morse timing).

## Decoder details

- Morse is all ratios to one **unit** (the dot length): dot = 1 on, dash = 3 on,
  intra-symbol gap = 1 off, letter gap = 3 off, word gap = 7 off.
- The unit (`dotBlocks`) adapts from observed pulses via EWMA (`alpha`) and is
  **clamped to a 5–50 WPM band** so a burst of noisy short pulses can't slam the
  estimate to an absurd speed.
- `main.ts` only feeds the decoder **once the pitch is locked**, and runs a
  **median-of-3 debounce** on the on/off decision first, so pre-lock noise and
  single-block glitches don't corrupt the timing (this killed a ~75 WPM startup
  spike).

## The SDK / host event contract (verified against the simulator)

These were originally guesses from the docs; all are now confirmed by driving the
simulator. See HANDOFF.md for the full table.

- **Touch:** a click arrives as a bare `event.sysEvent` (eventSource set, eventType
  omitted — proto default 0 = CLICK); double-click is `sysEvent` eventType 3;
  scroll up/down are `event.textEvent` eventType 1/2. The handler reads eventType
  from `sysEvent ?? textEvent`, normalizes via `OsEventTypeList.fromJson`, and
  treats missing/0 as a click.
- **Launch event:** entering the foreground emits an event *byte-identical to a
  click*. `main.ts` ignores bare sysEvents during a `STARTUP_GRACE_MS` window so
  the app doesn't auto-start.
- **Rendering:** call `createStartUpPageContainer` **once**, then
  `bridge.textContainerUpgrade({containerID, containerName, content})` for every
  update. Re-creating the page each frame resets host state and is heavy.
- **Audio:** read `event.audioEvent.audioPcm` (s16le PCM; arrives as `number[]` or
  base64 over the JSON bridge), **not** `.data`. The sim sends 100 ms/event
  (3200 bytes, 1600 samples @ 16 kHz).

## Testing

The DSP/decode logic is SDK-free, so it's tested in plain Node — **write or extend
a test before changing `tone-scanner.ts` or `morse-decoder.ts`.**

```bash
npx tsx src/decoder.test.ts   # decode correctness, lock, onProgress, flush, double-press reset
npx tsx src/tuning.test.ts    # lock speed + WPM convergence over modelled white/brown noise
```

Both use a tiny assert harness (no framework) and exit non-zero on failure. The
pattern: synthesize a sine-wave Morse stream (optionally add modelled noise), run
it through `ToneScanner` + `MorseDecoder`, and assert the output. This is how every
shipped feature was validated and how real bugs were caught (e.g. the lock
resetting during silence, the WPM overshoot, the frequency jitter).

### Driving the simulator headlessly

Launch with an automation port and you can script input, read the webview console,
and grab screenshots — invaluable for verifying touch/audio without clicking by
hand:

```bash
npx @evenrealities/evenhub-simulator http://localhost:5173 --automation-port 9898
curl -s -X POST http://127.0.0.1:9898/api/input \
  -H 'Content-Type: application/json' -d '{"action":"click"}'   # also: double_click | up | down
curl -s http://127.0.0.1:9898/api/console                       # captured console.* + errors
curl -s http://127.0.0.1:9898/api/screenshot/glasses -o out.png # 576x288 framebuffer
```

The `Content-Type: application/json` header is required or the body is ignored.
`/api/input` targets the active container directly (it bypasses the GUI's
container-selection step). With `RUST_LOG=info`, the simulator also logs every
`CreateStartUpPageContainer` / `TextContainerUpgrade` with its content — handy for
asserting what the glasses display shows.

## Tuning knobs (where they live)

| Knob | Location | Effect |
| --- | --- | --- |
| Scan range / step | `main.ts` → `ToneScanner({ minFreq: 550, maxFreq: 950, stepFreq: 25 })` | Detection band & pitch resolution vs. CPU |
| `signalPeakRatio` | `tone-scanner.ts` | Peak/median ratio to call a block "signal" |
| `lockStreak` | `tone-scanner.ts` | Signal blocks of agreement before locking |
| Locked-freq smoothing | `tone-scanner.ts` (EWMA `0.9/0.1`) | Steadiness of the pitch readout |
| Decode threshold + debounce | `main.ts` → `peakPower * 0.25`, median-of-3 | On/off sensitivity & glitch rejection |
| `minWpm` / `maxWpm` / `alpha` | `morse-decoder.ts` | WPM clamp band & adaptation rate |
| `STARTUP_GRACE_MS` | `main.ts` | Window that ignores the launch tap event |

## Gotchas

- Don't import the SDK outside `main.ts` (breaks Node testing).
- `Goertzel.power()` / `finishBlock()` mutate state — once per block only.
- The simulator's GUI routes Up/Down/Click/Double-Click only to a *selected*
  container; the automation API does not. A blank webview screenshot is normal —
  the app renders to the glasses framebuffer, not the web DOM.
- Frequency accuracy is bounded by block size; for tighter pitch you'd need a
  longer integration window (see HANDOFF open steps).
