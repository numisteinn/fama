import { Option, Record } from "effect"
import type { HttpClient } from "effect/http"
import type { Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import type { Message } from "~/message"
import { type Model, current } from "~/model"
import { FetchTiming, ReadSelection, ScrollToMark } from "~/reader/command"
import { ReaderMessage } from "~/reader/message"
import {
  ChapterText,
  type Mark,
  type Reader,
  ReaderView,
  chapterText,
  hasText,
  isSameMark,
  markAt,
  segmentId,
} from "~/reader/model"
import { chapterStartMs } from "~/timeline"

/** The listener clicked a Segment: playback goes on from its start, at `positionMs` of the episode timeline. */
export interface PlayFrom {
  readonly positionMs: number
}

type Return = Update.Return<Model, Message, HttpClient.HttpClient>
type ReturnWithPlay = Update.ReturnWithOutMessage<Model, Message, PlayFrom, HttpClient.HttpClient>
type OpenView = Extract<ReaderView, { _tag: "Open" }>

const withReader = (model: Model, toReader: (reader: Reader) => Reader): Model =>
  modifyFields(model, { reader: toReader })

const withOpen = (model: Model, toOpen: (open: OpenView) => OpenView): Model =>
  withReader(model, (reader) =>
    reader.view._tag === "Open" ? { ...reader, view: ReaderView.Open(toOpen(reader.view)) } : reader,
  )

const setText = (model: Model, url: string, text: ChapterText): Model =>
  withReader(model, (reader) => ({ ...reader, timings: Record.set(reader.timings, url, text) }))

/** The mark where the audio is now. */
const currentMark = (model: Model): Option.Option<Mark> =>
  Option.flatMap(current(model), ({ playback, episode }) =>
    markAt(model.reader, episode, playback.chapter, playback.offsetMs),
  )

/** Opens the reader for the playing episode, or closes it. A chapter whose file failed loads again on open. */
const toggle = (model: Model): Model => {
  if (model.reader.view._tag === "Open") return withReader(model, (reader) => ({ ...reader, view: ReaderView.Closed() }))
  return Option.match(current(model), {
    onNone: () => model,
    onSome: ({ episode }) =>
      hasText(episode)
        ? withReader(model, (reader) => ({
            view: ReaderView.Open({ episodeId: episode.id, isFollowing: true, maybeShownMark: Option.none() }),
            timings: Record.filter(reader.timings, (text) => text._tag !== "Failed"),
          }))
        : model,
  })
}

/** Playback goes on from the start of a Segment. The clicked Segment is in sight, so the view follows again. */
const playFrom = (model: Model, mark: Mark): ReturnWithPlay =>
  Option.match(current(model), {
    onNone: () => ({ model }),
    onSome: ({ episode }) => {
      const file = episode.chapters[mark.chapter]
      const text = file ? chapterText(model.reader, file) : ChapterText.NotThere()
      const segment = text._tag === "Loaded" ? text.segments[mark.segment] : undefined
      if (!segment) return { model }
      return {
        model: withOpen(model, (open) => ({ ...open, isFollowing: true, maybeShownMark: Option.some(mark) })),
        outMessage: { positionMs: chapterStartMs(episode.chapters, mark.chapter) + segment.startMs },
      }
    },
  })

export const update = (model: Model, message: ReaderMessage): ReturnWithPlay =>
  ReaderMessage.match<ReturnWithPlay>(message, {
    ClickedText: () => ({ model: toggle(model) }),
    ClickedSegment: ({ chapter, segment }) => ({ model, commands: [ReadSelection({ chapter, segment })] }),
    GotSelectionOnClick: ({ chapter, segment, isSelecting }) =>
      isSelecting ? { model } : playFrom(model, { chapter, segment }),
    ClickedFollow: () => ({
      model: withOpen(model, (open) => ({ ...open, isFollowing: true, maybeShownMark: Option.none() })),
    }),
    SettledScrollByHand: ({ isMarkInView }) => ({
      model: withOpen(model, (open) => ({ ...open, isFollowing: isMarkInView, maybeShownMark: isMarkInView ? currentMark(model) : Option.none() })),
    }),
    SucceededFetchTiming: ({ url, timing }) => ({
      model: setText(model, url, ChapterText.Loaded({ segments: timing.segments })),
    }),
    FailedFetchTiming: ({ url }) => ({ model: setText(model, url, ChapterText.Failed()) }),
    CompletedScrollToMark: () => ({ model }),
  })

/**
 * Runs after every Message, like `reconcile` of the player. The reader closes when its episode no longer plays. It
 * loads the timing file of each listed chapter it does not have, so the text of a chapter the job adds appears when
 * the library lists it. While it follows, it puts each new mark in sight.
 */
export const reconcile = (model: Model): Return => {
  const view = model.reader.view
  if (view._tag === "Closed") return { model }
  const maybeLoaded = Option.filter(current(model), ({ episode }) => episode.id === view.episodeId && hasText(episode))
  if (Option.isNone(maybeLoaded)) return { model: withReader(model, (reader) => ({ ...reader, view: ReaderView.Closed() })) }
  const { episode } = maybeLoaded.value

  const missing = episode.chapters.flatMap((chapter) =>
    chapter.timingUrl !== null && chapterText(model.reader, chapter)._tag === "NotLoaded" ? [chapter.timingUrl] : [],
  )
  const loading = missing.reduce((next, url) => setText(next, url, ChapterText.Loading()), model)
  const loads = missing.map((url) => FetchTiming({ origin: model.connection.origin, url }))

  const maybeMark = currentMark(loading)
  const isDue =
    view.isFollowing &&
    Option.isSome(maybeMark) &&
    !Option.exists(view.maybeShownMark, (shown) => isSameMark(shown, maybeMark.value))
  if (!isDue || Option.isNone(maybeMark)) return { model: loading, commands: loads }
  const mark = maybeMark.value
  return {
    model: withOpen(loading, (open) => ({ ...open, maybeShownMark: Option.some(mark) })),
    commands: [...loads, ScrollToMark({ id: segmentId(mark), isInstant: Option.isNone(view.maybeShownMark) })],
  }
}
