/**
 * main.ts
 * -------
 * The glue layer — the only file that touches the Even Hub SDK.
 *
 * Pipeline:
 *   mic -> pcm16ToFloat -> ToneScanner (auto-finds CW pitch) -> threshold
 *       -> MorseDecoder (timing -> letters) -> display
 *
 * Display shows: status + auto-detected pitch, the decoded text, and the
 * in-progress dot/dash symbol live as it builds.
 *
 * Controls:
 *   - single press  -> start/stop listening
 *   - double press  -> clear text and re-arm tone detection
 */

import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

import { ToneScanner } from './tone-scanner'
import { MorseDecoder } from './morse-decoder'

// --- Audio constants (Device APIs: PCM 16kHz, s16le, mono) ---
const SAMPLE_RATE = 16000
const BLOCK_SAMPLES = 160 // 10 ms per block -> 100 blocks/sec
const blocksPerSecond = SAMPLE_RATE / BLOCK_SAMPLES

async function main() {
  const bridge = await waitForEvenAppBridge()

  let decodedText = ''
  let listening = false
  let partialSymbol = '' // the in-progress dot/dash buffer
  let lockedFreq: number | null = null
  let searchingFreq: number | null = null // live peak pitch shown before lock

  let pageCreated = false
  async function render() {
    const pitch = lockedFreq
      ? `${lockedFreq}Hz`
      : searchingFreq
        ? `~${searchingFreq}Hz locking...`
        : 'finding tone...'
    const status = listening
      ? `LISTENING  ${pitch}  ~${decoder.estimatedWpm}wpm`
      : 'PAUSED (press to start)'
    const body = decodedText.length ? decodedText : '(nothing yet)'
    const live = partialSymbol ? `\n\n> ${partialSymbol}` : ''
    const content = `${status}\n\n${body}${live}`

    // The startup page must be created exactly ONCE (SDK: createStartUpPageContainer
    // is the launch call; subsequent frames update text in place). Re-creating the
    // page every frame resets host/sim state — notably the *selected* event
    // container — so touch input silently stops landing on us.
    if (!pageCreated) {
      const container = new TextContainerProperty({
        xPosition: 0, yPosition: 0,
        width: 576, height: 288,
        borderWidth: 0, borderColor: 5, paddingLength: 4,
        containerID: 1, containerName: 'main',
        content,
        isEventCapture: 1,
      })
      await bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [container] }),
      )
      pageCreated = true
    } else {
      await bridge.textContainerUpgrade(
        new TextContainerUpgrade({ containerID: 1, containerName: 'main', content }),
      )
    }
  }

  // ---- Detection + decoding ----
  // Scan the band CW operators actually use (~600–900 Hz) with a little margin
  // for interpolation headroom. Excluding the low bins keeps the scanner from
  // false-locking onto low-frequency room rumble, and the 25 Hz step gives a
  // finer pitch readout than the old 50 Hz bins.
  const scanner = new ToneScanner({
    sampleRate: SAMPLE_RATE,
    minFreq: 550,
    maxFreq: 950,
    stepFreq: 25,
  })

  const decoder = new MorseDecoder({
    blocksPerSecond,
    initialWpm: 15,
    onChar: (c) => {
      decodedText += c
      if (decodedText.length > 120) decodedText = decodedText.slice(-120)
      void render()
    },
    onProgress: (p) => {
      partialSymbol = p
      void render()
    },
  })

  let peakPower = 1e-9
  let idleBlocks = 0 // consecutive blocks with no tone present (peakiness false)
  let sampleBuffer: number[] = []
  const onHistory: boolean[] = [] // last 3 raw on/off decisions, for debouncing
  // After this many blocks with no real tone, treat the transmission as paused:
  // flush the final letter and stop feeding, so post-transmission noise isn't
  // decoded. 2.5 s is well beyond any inter-word gap (a 5 wpm word gap is ~1.7 s).
  const MAX_IDLE_BLOCKS = blocksPerSecond * 2.5

  /** Clear per-session capture state so a fresh start never inherits stale data. */
  function resetCapture() {
    sampleBuffer = []
    onHistory.length = 0
    peakPower = 1e-9
    idleBlocks = 0
  }

  function processBlock() {
    for (const s of sampleBuffer) scanner.process(s)
    const res = scanner.finishBlock()
    sampleBuffer = []

    lockedFreq = res.lockedFreq
    // The on/off decision is amplitude-relative (clean element timing), but the
    // threshold reference is adapted ONLY from real tone blocks (hasSignal). A loud
    // non-tone transient (cough/tap) is not spectrally peaky, so it can't ratchet
    // peakPower up and then suppress real tones for seconds while it decays.
    if (res.hasSignal) {
      peakPower = Math.max(res.power, peakPower * 0.999)
      searchingFreq = res.peakFreq // live pitch readout while still searching
      idleBlocks = 0
    } else {
      peakPower *= 0.999
      idleBlocks++
    }
    const rawOn = res.power > peakPower * 0.25

    // Median-of-3 debounce: drop single-block glitches before the decoder times
    // them, so a stray on/off blip can't be mistaken for a very fast dot.
    onHistory.push(rawOn)
    if (onHistory.length > 3) onHistory.shift()
    const on = onHistory.filter(Boolean).length >= 2

    // Decode only once locked, and only while a tone has been present recently.
    // After a sustained absence of any tone (operator stopped) flush the final
    // letter once and stop feeding — otherwise post-transmission noise that crosses
    // the threshold would be timed as Morse forever (the lock never releases).
    if (res.lockedFreq !== null) {
      if (idleBlocks <= MAX_IDLE_BLOCKS) decoder.pushBlock(on)
      else if (idleBlocks === MAX_IDLE_BLOCKS + 1) decoder.flush()
    }
  }

  // When the app comes to the foreground the host emits a one-time event that is
  // byte-identical to a click (bare `sysEvent`, eventSource set, eventType
  // omitted). We can't tell it apart from a real tap, so we ignore bare
  // sysEvents during a short grace window after wiring up — long enough to swallow
  // the launch event, short enough that a real user tap (always seconds later)
  // still registers. Without this the app auto-starts itself on launch.
  const readyAt = Date.now()
  const STARTUP_GRACE_MS = 1200

  bridge.onEvenHubEvent((event: any) => {
    // Audio path
    if (event.audioEvent && listening) {
      const samples = pcm16ToFloat(event.audioEvent.audioPcm ?? event.audioEvent.data)
      for (const s of samples) {
        sampleBuffer.push(s)
        if (sampleBuffer.length >= BLOCK_SAMPLES) processBlock()
      }
      return
    }

    // Touch + lifecycle path. The host delivers a click as a bare `sysEvent`
    // (eventSource set, eventType omitted = proto default 0 = CLICK), scroll
    // up/down as `textEvent` (eventType 1/2), and double-click / exit as
    // `sysEvent` with eventType 3 / 5-7. Read eventType from whichever envelope
    // is present and normalize it.
    const item = event.sysEvent ?? event.textEvent
    if (!item) return
    const evt = OsEventTypeList.fromJson(item.eventType)

    // Ignore the launch foreground event (see STARTUP_GRACE_MS above).
    if (evt === undefined && event.sysEvent && Date.now() - readyAt < STARTUP_GRACE_MS) return

    switch (evt ?? OsEventTypeList.CLICK_EVENT) {
      case OsEventTypeList.CLICK_EVENT:
        void toggleListening()
        break
      case OsEventTypeList.DOUBLE_CLICK_EVENT:
        // Reset the engine first — flush() emits any pending letter via onChar,
        // so the buffers must be cleared AFTER it, or that letter lands back in
        // decodedText.
        decoder.flush()
        scanner.resetLock() // re-arm auto detection
        decodedText = ''
        partialSymbol = ''
        lockedFreq = null
        searchingFreq = null
        resetCapture()
        void render()
        break
      case OsEventTypeList.FOREGROUND_EXIT_EVENT:
      case OsEventTypeList.ABNORMAL_EXIT_EVENT:
      case OsEventTypeList.SYSTEM_EXIT_EVENT:
        void stopListening()
        break
      // SCROLL_TOP / SCROLL_BOTTOM / IMU: ignored
    }
  })

  async function toggleListening() {
    if (listening) await stopListening()
    else await startListening()
  }

  async function startListening() {
    resetCapture() // start each session from a clean slate (no stale buffers)
    listening = true
    await bridge.audioControl(true)
    await render()
  }

  async function stopListening() {
    listening = false
    await bridge.audioControl(false)
    decoder.flush()
    await render()
  }

  await render()
}

/** Convert signed-16-bit little-endian PCM bytes to floats in ~-1..1. */
function pcm16ToFloat(data: ArrayBuffer | Uint8Array | number[] | string): number[] {
  // Over the JSON bridge a Uint8Array may arrive as a number[] or a base64 string.
  const bytes =
    typeof data === 'string'
      ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
      : Array.isArray(data)
        ? Uint8Array.from(data)
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: number[] = []
  for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
    out.push(view.getInt16(i, true) / 32768)
  }
  return out
}

main()

