import { segmentIndexAt } from "@fama/contracts"
import { Effect, Option, Queue, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import { AudioPlayer } from "~/audio"
import { Message } from "~/message"
import { type Model, current } from "~/model"
import { MARK_SELECTOR, isInSight } from "~/reader/command"
import { ReaderMessage } from "~/reader/message"
import { chapterText } from "~/reader/model"

/** Focused controls keep their own keys. */
const INTERACTIVE = "input, textarea, select, [contenteditable], button, a, [role=slider], [role^=menuitem], [role=menu]"
const SCROLL_KEYS = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]
/** A scroll with no new scroll event for this long has come to rest. */
const SETTLE_MS = 150

/** The start of each Segment of the chapter that plays, while the reader shows it and the audio plays. */
const playingStarts = (model: Model): ReadonlyArray<number> => {
  const view = model.reader.view
  if (view._tag !== "Open") return []
  return Option.match(current(model), {
    onNone: () => [],
    onSome: ({ playback, episode }) => {
      const chapter = episode.chapters[playback.chapter]
      if (episode.id !== view.episodeId || !playback.isPlaying || !chapter) return []
      const text = chapterText(model.reader, chapter)
      return text._tag === "Loaded" ? text.segments.map((segment) => segment.startMs) : []
    },
  })
}

export const readerSubscriptions = Subscription.make<Model, Message, AudioPlayer>()((entry) => ({
  /**
   * The mark follows the audio element. Its `timeupdate` event comes only every 250 ms or so, which would put the mark
   * on a new sentence up to a quarter second late. So while the reader shows the text that plays, each animation frame
   * reads the element's position, and when it is in another Segment, says so with the same Message as `timeupdate`.
   */
  readAlong: entry(
    { starts: Schema.Array(Schema.Number) },
    {
      modelToDependencies: (model) => ({ starts: playingStarts(model) }),
      dependenciesToStream: ({ starts }) =>
        starts.length === 0
          ? Stream.empty
          : Stream.unwrap(
              Effect.gen(function* () {
                const audio = yield* AudioPlayer
                return Stream.callback<Message>((queue) =>
                  Effect.acquireRelease(
                    Effect.sync(() => {
                      const segments = starts.map((startMs) => ({ startMs }))
                      let shown: number | null | undefined
                      let frame = 0
                      const read = () => {
                        const offsetMs = audio.currentTime * 1000
                        const index = segmentIndexAt(segments, offsetMs)
                        if (index !== shown) {
                          shown = index
                          Queue.offerUnsafe(queue, Message.UpdatedAudioTime({ offsetMs, atMs: Date.now() }))
                        }
                        frame = requestAnimationFrame(read)
                      }
                      frame = requestAnimationFrame(read)
                      return () => cancelAnimationFrame(frame)
                    }),
                    (stop) => Effect.sync(stop),
                  ).pipe(Effect.flatMap(() => Effect.never)),
                )
              }),
            ),
    },
  ),

  /**
   * A scroll by hand: the wheel, a touch, a scroll key, or the scrollbar. The reader's own scrolls come from none of
   * these. When such a scroll comes to rest, it says whether the mark is still on screen.
   */
  scrollByHand: entry(
    { isOpen: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ isOpen: model.reader.view._tag === "Open" }),
      dependenciesToStream: ({ isOpen }) =>
        !isOpen
          ? Stream.empty
          : Stream.callback<Message>((queue) =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  let isByHand = false
                  let timer: ReturnType<typeof setTimeout> | undefined
                  const byHand = () => {
                    isByHand = true
                  }
                  const onKey = (event: KeyboardEvent) => {
                    const target = event.target instanceof Element ? event.target : null
                    if (SCROLL_KEYS.includes(event.key) && !target?.closest(INTERACTIVE)) byHand()
                  }
                  const onPointer = (event: PointerEvent) => {
                    if (event.target === document.documentElement) byHand()
                  }
                  let suspended = false
                  const onScroll = () => {
                    if (!isByHand) return
                    const current = document.querySelector(MARK_SELECTOR)
                    if (!suspended && (!current || !isInSight(current))) {
                      suspended = true
                      Queue.offerUnsafe(queue, Message.GotReaderMessage({
                        message: ReaderMessage.SettledScrollByHand({ isMarkInView: false }),
                      }))
                    }
                    clearTimeout(timer)
                    timer = setTimeout(() => {
                      suspended = false
                      isByHand = false
                      const mark = document.querySelector(MARK_SELECTOR)
                      const message = ReaderMessage.SettledScrollByHand({ isMarkInView: mark !== null && isInSight(mark) })
                      Queue.offerUnsafe(queue, Message.GotReaderMessage({ message }))
                    }, SETTLE_MS)
                  }
                  const listeners = [
                    ["wheel", byHand],
                    ["touchmove", byHand],
                    ["keydown", onKey],
                    ["pointerdown", onPointer],
                    ["scroll", onScroll],
                  ] as const
                  for (const [type, listener] of listeners) {
                    window.addEventListener(type, listener as EventListener, { passive: true })
                  }
                  return () => {
                    clearTimeout(timer)
                    for (const [type, listener] of listeners) window.removeEventListener(type, listener as EventListener)
                  }
                }),
                (stop) => Effect.sync(stop),
              ).pipe(Effect.flatMap(() => Effect.never)),
            ),
    },
  ),
}))
