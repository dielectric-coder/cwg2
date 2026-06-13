/**
 * main.ts
 * -------
 * The glue layer — the only file that touches the Even Hub SDK.
 *
 *   mic -> pcm16ToFloat -> CwPipeline (tone detect + decode) -> display
 *
 * All DSP/decode logic lives in the SDK-free CwPipeline (pipeline.ts); this file
 * only does audio capture, display, and touch/lifecycle handling.
 *
 * Controls:
 *   - tap         -> start/stop listening
 *   - swipe       -> clear text and re-arm tone detection
 *   - double-tap  -> exit (system confirmation dialog)
 */

import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

import { CwPipeline } from './pipeline'

// TextContainerProperty has no text-alignment field, so we center the status line
// by left-padding it with spaces sized to the proportional glasses font.
//
// CHAR_WIDTH is the pixel advance of every glyph the status line can contain
// (digits, the words LISTENING/PAUSED, the pitch/wpm readouts and their
// punctuation), measured once against the firmware LVGL font with
// @evenrealities/pretext's getTextWidth. We bake the table rather than import
// pretext at runtime so the bundle stays ~35KB instead of ~67KB.
// KERNING_PER_GAP corrects the small per-pair overlap that a naive per-char sum
// misses; the result matches pretext to within one space (5px) across the whole
// status-string range. If the status text gains new characters, add their widths
// here (getTextWidth('<char>')).
const CHAR_WIDTH: Record<string, number> = {
  ' ': 5, '~': 16, '.': 5,
  '0': 12, '1': 8, '2': 12, '3': 12, '4': 13, '5': 12, '6': 12, '7': 13, '8': 12, '9': 12,
  L: 10, I: 6, S: 12, T: 12, E: 11, N: 12, G: 12, H: 12, P: 12, A: 14, U: 12, D: 12,
  z: 10, l: 4, o: 11, c: 11, k: 10, i: 4, n: 11, g: 11, f: 10, d: 11, t: 8, e: 11,
  w: 16, p: 11, m: 16,
}
const INNER_WIDTH = 576 - 2 * 4 // container width minus paddingLength on both sides
const SPACE_WIDTH = CHAR_WIDTH[' ']
const KERNING_PER_GAP = 0.4
function centerLine(text: string): string {
  let width = -KERNING_PER_GAP * Math.max(0, text.length - 1)
  for (const ch of text) width += CHAR_WIDTH[ch] ?? SPACE_WIDTH
  const lead = Math.max(0, Math.round((INNER_WIDTH - width) / 2 / SPACE_WIDTH))
  return ' '.repeat(lead) + text
}

async function main() {
  const bridge = await waitForEvenAppBridge()

  let decodedText = ''
  let listening = false
  let partialSymbol = '' // the in-progress dot/dash buffer

  const pipeline = new CwPipeline({
    onChar: (c) => {
      decodedText += c
      if (decodedText.length > 120) decodedText = decodedText.slice(-120)
      scheduleRender()
    },
    onProgress: (p) => {
      partialSymbol = p
      scheduleRender()
    },
  })

  // ---- Display (the only SDK-coupled rendering) ----
  let pageCreated = false
  let lastContent: string | null = null
  let renderDirty = false
  let rendering = false

  function buildContent(): string {
    const pitch = pipeline.lockedFreq
      ? `${pipeline.lockedFreq}Hz`
      : pipeline.searchingFreq
        ? `~${pipeline.searchingFreq}Hz locking...`
        : 'finding tone...'
    // Status line is centered in both states. The LISTENING readout shifts
    // slightly as the pitch/wpm digits change width — that's inherent to centering
    // a variable-width line.
    const status = listening
      ? centerLine(`LISTENING  ${pitch}  ~${pipeline.estimatedWpm}wpm`)
      : centerLine('PAUSED')
    const body = decodedText.length ? decodedText : '(nothing yet)'
    // The in-progress dot/dash line starts in the same column as the centered
    // status text (its leading-space count), so it sits directly under the first
    // letter of PAUSED/LISTENING and shifts with it.
    const statusIndent = ' '.repeat(status.length - status.trimStart().length)
    const live = partialSymbol ? `\n\n${statusIndent}${partialSymbol}` : ''
    return `${status}\n\n${body}${live}`
  }

  // ---- Phone-side WebView mirror ----
  // The decode UI lives on the glasses; the phone WebView that hosts the plugin
  // must not be blank (Even Hub design requirement), so we mirror the live state
  // into the static page from index.html.
  const phoneState = document.getElementById('phone-state')
  const phoneMeta = document.getElementById('phone-meta')
  const phoneDecoded = document.getElementById('phone-decoded')
  function updatePhone(): void {
    if (phoneState) phoneState.textContent = listening ? 'Listening' : 'Paused'
    if (phoneMeta) {
      phoneMeta.textContent = listening
        ? pipeline.lockedFreq
          ? `${pipeline.lockedFreq} Hz · ${pipeline.estimatedWpm} WPM`
          : pipeline.searchingFreq
            ? `~${pipeline.searchingFreq} Hz · locking…`
            : 'Finding tone…'
        : 'Tap the glasses touchpad to start listening.'
    }
    if (phoneDecoded) {
      phoneDecoded.textContent = decodedText
      if (partialSymbol) {
        const live = document.createElement('span')
        live.className = 'live'
        live.textContent = (decodedText ? '  ' : '') + partialSymbol
        phoneDecoded.appendChild(live)
      }
    }
  }

  async function render() {
    updatePhone() // cheap DOM sync; keep the phone page reflecting the latest state
    const content = buildContent()
    if (content === lastContent) return // skip redundant frames — no bridge round-trip
    lastContent = content

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

  // Coalesce renders. The decode callbacks fire many times while processing one
  // audio event (10 blocks/event, multiple element transitions). Deferring to a
  // microtask collapses the whole burst into a single render of the final state,
  // and render() skips frames whose content is unchanged — so the display bridge
  // isn't flooded with redundant round-trips.
  function scheduleRender(): void {
    renderDirty = true
    if (rendering) return
    rendering = true
    queueMicrotask(flushRenders)
  }
  async function flushRenders(): Promise<void> {
    try {
      let passes = 0
      while (renderDirty && ++passes <= 5) {
        renderDirty = false
        await render()
      }
    } finally {
      rendering = false
    }
  }

  // ---- Touch + lifecycle events ----
  // When the app comes to the foreground the host emits a one-time event that is
  // byte-identical to a click (bare `sysEvent`, eventSource set, eventType
  // omitted). We can't tell it apart from a real tap, so we ignore bare sysEvents
  // during a short grace window after wiring up — long enough to swallow the launch
  // event, short enough that a real user tap (always seconds later) still registers.
  const readyAt = Date.now()
  const STARTUP_GRACE_MS = 1200

  bridge.onEvenHubEvent((event: any) => {
    // Audio path. Payload field is audioEvent.audioPcm (s16le PCM as number[] or
    // base64 over the JSON bridge), not .data.
    if (event.audioEvent && listening) {
      const raw = event.audioEvent.audioPcm ?? event.audioEvent.data
      if (raw == null) return // guard: SDK may send an audioEvent with neither field
      pipeline.pushSamples(pcm16ToFloat(raw))
      return
    }

    // Touch + lifecycle. The host delivers a click as a bare `sysEvent` (eventType
    // omitted = proto default 0 = CLICK), scroll up/down as `textEvent` (1/2), and
    // double-click / exit as `sysEvent` with eventType 3 / 5-7. Read eventType from
    // whichever envelope is present and normalize it.
    const item = event.sysEvent ?? event.textEvent
    if (!item) return
    const evt = item.eventType != null
      ? OsEventTypeList.fromJson(item.eventType)
      : undefined

    // Ignore the launch foreground event (see STARTUP_GRACE_MS above).
    if (evt === undefined && event.sysEvent && Date.now() - readyAt < STARTUP_GRACE_MS) return

    switch (evt ?? OsEventTypeList.CLICK_EVENT) {
      case OsEventTypeList.CLICK_EVENT:
        void toggleListening().catch((e) => console.error('toggle failed', e))
        break
      case OsEventTypeList.DOUBLE_CLICK_EVENT:
        // Even Hub convention: double-tap requests app exit. shutDownPageContainer(1)
        // pops the system exit-confirmation dialog; if the user confirms, the host
        // fires FOREGROUND_EXIT / SYSTEM_EXIT below and the actual teardown runs there.
        void bridge.shutDownPageContainer(1).catch((e) => console.error('exit request failed', e))
        break
      case OsEventTypeList.SCROLL_TOP_EVENT:
      case OsEventTypeList.SCROLL_BOTTOM_EVENT:
        // Swipe (either direction) clears the text and re-arms tone detection.
        // reArm() flushes the pending letter (via onChar) then drops the lock and
        // capture state; clear our text buffers AFTER, so the flushed letter that
        // just landed in decodedText is wiped too.
        pipeline.reArm()
        decodedText = ''
        partialSymbol = ''
        scheduleRender()
        break
      case OsEventTypeList.FOREGROUND_EXIT_EVENT:
      case OsEventTypeList.ABNORMAL_EXIT_EVENT:
      case OsEventTypeList.SYSTEM_EXIT_EVENT:
        void stopListening().catch((e) => console.error('exit cleanup failed', e))
        break
      // IMU: ignored
    }
  })

  async function toggleListening() {
    if (listening) await stopListening()
    else await startListening()
  }

  async function startListening() {
    pipeline.resetCapture() // start each session from a clean slate (no stale state)
    try {
      await bridge.audioControl(true)
      listening = true
    } catch (e) {
      console.error('failed to start audio', e)
      return
    }
    scheduleRender()
  }

  async function stopListening() {
    listening = false
    try {
      await bridge.audioControl(false)
    } catch (e) {
      console.error('failed to stop audio', e)
    }
    pipeline.flush()
    scheduleRender()
  }

  await render() // initial paint creates the page
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
