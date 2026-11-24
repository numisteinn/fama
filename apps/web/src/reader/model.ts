import { type Chapter, type Episode, EpisodeId, Segment, segmentIndexAt } from "@fama/contracts"
import { Option, Schema } from "effect"
import { defineTaggedUnion } from "foldkit/schema"

/**
 * The text of one chapter, as the tab has it. `NotThere`: the chapter has no timing file (`timingUrl` is `null`),
 * so it shows no text. A timing file of a listed chapter never changes, so a `Loaded` one is kept for the session.
 */
export const ChapterText = defineTaggedUnion({
  NotThere: {},
  NotLoaded: {},
  Loading: {},
  Loaded: { segments: Schema.Array(Segment) },
  Failed: {},
})
export type ChapterText = typeof ChapterText.Type

/** A place in the text: Segment `segment` of chapter `chapter`. */
export const Mark = Schema.Struct({ chapter: Schema.Number, segment: Schema.Number })
export type Mark = typeof Mark.Type

/** Whether the reader shows, and for which episode. */
export const ReaderView = defineTaggedUnion({
  Closed: {},
  Open: {
    episodeId: EpisodeId,
    /**
     * The view keeps the mark in sight. A scroll by hand that leaves the mark out of sight turns this off, and a
     * scroll by hand back to the mark turns it on again.
     */
    isFollowing: Schema.Boolean,
    /** The mark the view last put in sight. `None`: the next mark is put in sight at once, with no animation. */
    maybeShownMark: Schema.Option(Mark),
  },
})
export type ReaderView = typeof ReaderView.Type

export const Reader = Schema.Struct({
  view: ReaderView,
  /** The text of each chapter whose timing file was asked for, by its `timingUrl`. */
  timings: Schema.Record(Schema.String, ChapterText),
})
export type Reader = typeof Reader.Type

export const initReader: Reader = { view: ReaderView.Closed(), timings: {} }

/** An episode with at least one timing file. Only such an episode has a reader. */
export const hasText = (episode: Episode): boolean => episode.chapters.some((chapter) => chapter.timingUrl !== null)

export const chapterText = (reader: Reader, chapter: Chapter): ChapterText =>
  chapter.timingUrl === null ? ChapterText.NotThere() : (reader.timings[chapter.timingUrl] ?? ChapterText.NotLoaded())

/** The Segment the voice reads at `offsetMs` of chapter `chapter`, by `segmentIndexAt` of the contract. */
export const markAt = (reader: Reader, episode: Episode, chapter: number, offsetMs: number): Option.Option<Mark> => {
  const file = episode.chapters[chapter]
  if (!file) return Option.none()
  const text = chapterText(reader, file)
  if (text._tag !== "Loaded") return Option.none()
  return Option.map(Option.fromNullishOr(segmentIndexAt(text.segments, offsetMs)), (segment) => ({ chapter, segment }))
}

export const isSameMark = (a: Mark, b: Mark): boolean => a.chapter === b.chapter && a.segment === b.segment

/** The element id of a Segment in the reader. */
export const segmentId = (mark: Mark): string => `segment-${mark.chapter}-${mark.segment}`
