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

import { CwPipeline } from './pipeline'

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
    // 'PAUSED' centered in the container's 568px inner width (576 − 2×4 padding):
    // 50 leading spaces ≈ (568 − 69) / 2 / 5, where 69px is the rendered width of
    // 'PAUSED' and 5px a space, per @evenrealities/pretext font metrics. LISTENING
    // stays left-aligned — its live pitch/wpm readout changes width and would
    // jitter horizontally if centered.
    const status = listening
      ? `LISTENING  ${pitch}  ~${pipeline.estimatedWpm}wpm`
      : `${' '.repeat(50)}PAUSED`
    const body = decodedText.length ? decodedText : '(nothing yet)'
    const live = partialSymbol ? `\n\n> ${partialSymbol}` : ''
    return `${status}\n\n${body}${live}`
  }

  async function render() {
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
      // SCROLL_TOP / SCROLL_BOTTOM / IMU: ignored
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
