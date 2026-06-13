# User Guide — G2 CW Decoder

**Version:** 0.9.9

This app turns your Even Realities G2 glasses into a **Morse code (CW) reader**. It
listens through the glasses microphone, automatically finds the tone's pitch,
decodes the dots and dashes, and shows the text on the display as it arrives —
including the dot/dash symbol currently being built.

It decodes **audible** CW: a practice oscillator, a speaker, a radio's sidetone —
any Morse you can hear in the room. It is not wired into a radio's audio.

## What you need

- Even Realities G2 glasses **or** the evenhub simulator on your computer.
- A source of audible CW in the 600–900 Hz range (most operators' tone).

## Running it

**In the simulator** (uses your computer's default microphone):

```bash
npm run dev
npx @evenrealities/evenhub-simulator http://localhost:5173
```

A glasses display window opens. Play CW into your microphone to see it decode.

**On glasses:** load the app through the evenhub CLI / QR flow, put them on, and
point your ear (the mic) toward the CW source.

## Controls

| Gesture | Action |
| --- | --- |
| **Tap** | Start / stop listening |
| **Swipe** | Clear the text and re-find the tone |
| **Double tap** | Exit (a confirmation dialog appears) |

The app starts **paused**. Tap once to begin listening.

## Reading the display

```
LISTENING  794Hz  ~25wpm        ← status: listening, detected pitch, estimated speed
                                   (or "PAUSED", or "~794Hz locking..." while finding the tone)
CQ CQ DE W1AW                    ← decoded text (scrolls as more arrives)
> -.-                            ← the symbol being built right now, before it resolves to a letter
```

- **Pitch (Hz)** — the tone frequency it locked onto. While searching it shows
  `finding tone...`, then `~NNNHz locking...`, then the locked value.
- **WPM** — estimated sending speed; it adapts to the operator.
- **`>` line** — the live dot/dash buffer for the current letter.

## Getting the best results

- **Use a 600–900 Hz tone.** The app only searches that band. A tone far outside it
  won't be found.
- **Make it clearly audible.** A weak, distant tone (low microphone level) decodes
  poorly and the pitch reading drifts. Move closer to the source or raise the
  volume.
- **Reduce background noise.** Fans, HVAC, and music make it harder to lock and
  decode. The decoder is tuned for low-frequency room noise, but quieter is better.
- **Steady sending decodes best.** Clean, consistent timing (a keyer or a recording)
  is far easier than fast or erratic hand-sending.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Tap does nothing | It starts paused — tap once to start. In the **simulator GUI** you may need to select/click the glasses display area so it receives taps. |
| Stuck on "finding tone..." | No tone in 600–900 Hz reaching the mic. Check the source is playing and audible, in band, and the mic isn't muted. |
| Pitch reads a bit low/high vs. what you expect | Normal within ~±25–50 Hz — the pitch readout has limited resolution, and a weak signal or your audio setup can shift it. Raise the level for a closer reading. |
| Speed wobbles by ±1 WPM | Expected. The estimate is quantized to the 10 ms timing grid; 25 WPM may read 24–26. |
| Garbled letters at the very start | The first letter or two while it locks onto the tone can be wrong. It settles quickly; swipe to clear and resync. |
| Wrong/extra characters | Usually noise or uneven timing. Improve the signal level, reduce noise, or feed steadier CW. |

## Known limitations

- **Acoustic only** — it decodes sound in the air, not a digital tap into a rig.
- **Pitch accuracy ~±25–50 Hz** — a deliberate trade-off that keeps Morse timing
  sharp.
- **600–900 Hz band** — tones outside this range aren't detected.

For how it works internally and how to change it, see
[DEV-GUIDE.md](DEV-GUIDE.md).
