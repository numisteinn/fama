import { Document, EpisodeId } from "@fama/contracts"
import { Option, Schema } from "effect"
import { defineTaggedUnion } from "foldkit/schema"
import { Samples } from "~/review/samples"

/** One chapter in the Review editor, aligned by `index` with `loaded.chapters`. */
export const ReviewChapter = Schema.Struct({
  index: Schema.Number,
  title: Schema.String,
  text: Schema.String,
  isKept: Schema.Boolean,
})
export type ReviewChapter = typeof ReviewChapter.Type

/** State of `PUT /api/episodes/:id/document`. */
export const SaveState = defineTaggedUnion({
  Idle: {},
  Saving: {},
  Saved: {},
  Failed: { message: Schema.String },
})
export type SaveState = typeof SaveState.Type

/** State of `POST /api/episodes/:id/start`. */
export const StartState = defineTaggedUnion({
  Idle: {},
  Starting: {},
  Failed: { message: Schema.String },
})
export type StartState = typeof StartState.Type

/** Whether Review shows, and what state the Document is in. */
export const ReviewView = defineTaggedUnion({
  Closed: {},
  Loading: { episodeId: EpisodeId, request: Schema.Number },
  LoadFailed: { episodeId: EpisodeId, message: Schema.String },
  Editing: {
    episodeId: EpisodeId,
    /** The Document as loaded from the API, or as last saved. */
    loaded: Document,
    title: Schema.String,
    chapters: Schema.Array(ReviewChapter),
    /** At most one chapter has its text editor open, so large books stay fast. */
    maybeExpandedIndex: Schema.Option(Schema.Number),
    /** Lines that repeat across kept chapters, ready to remove in one click. */
    repeatedLines: Schema.Array(Schema.String),
    samples: Samples,
    save: SaveState,
    start: StartState,
  },
})
export type ReviewView = typeof ReviewView.Type
export type EditingReview = Extract<ReviewView, { _tag: "Editing" }>

export const Review = Schema.Struct({
  view: ReviewView,
  /** Counts Document fetch requests so stale responses are dropped. */
  requests: Schema.Number,
})
export type Review = typeof Review.Type

export const initReview: Review = { view: ReviewView.Closed(), requests: 0 }

export const chapterPanelId = (index: number): string => `review-chapter-panel-${index}`

export const keptCount = (editing: EditingReview): number =>
  editing.chapters.reduce((count, chapter) => (chapter.isKept ? count + 1 : count), 0)

/** Whether the edited title or any chapter title/text differs from `loaded`. */
export const isDirty = (editing: EditingReview): boolean =>
  editing.title !== editing.loaded.title ||
  editing.chapters.length !== editing.loaded.chapters.length ||
  editing.chapters.some((chapter, index) => {
    const original = editing.loaded.chapters[index]
    return !original || chapter.title !== original.title || chapter.text !== original.text
  })

/** Full edited Document (all chapters, including unticked ones) for saving while staying in Review. */
export const toFullDocument = (editing: EditingReview): Option.Option<Document> => {
  const [first, ...rest] = editing.chapters.map(({ title, text }) => ({ title, text }))
  if (!first) return Option.none()
  return Option.some({
    title: editing.title,
    author: editing.loaded.author,
    language: editing.loaded.language,
    chapters: [first, ...rest],
  })
}

/** Edited Document with only the kept chapters in playback order, for `POST /api/episodes/:id/start`. */
export const toStartDocument = (editing: EditingReview): Option.Option<Document> => {
  const [first, ...rest] = editing.chapters
    .filter((chapter) => chapter.isKept)
    .map(({ title, text }) => ({ title, text }))
  if (!first) return Option.none()
  return Option.some({
    title: editing.title,
    author: editing.loaded.author,
    language: editing.loaded.language,
    chapters: [first, ...rest],
  })
}

const MAX_REPEATED_LINE_LENGTH = 160
const MAX_REPEATED_LINES = 3

/**
 * Finds trimmed non-empty lines that repeat across most kept chapters (common PDF running headers/footers).
 * Kept in state and recomputed on load, keep-toggle, removal, and chapter collapse so typing stays O(1).
 */
export const detectRepeatedLines = (chapters: ReadonlyArray<ReviewChapter>): Array<string> => {
  const kept = chapters.filter((chapter) => chapter.isKept)
  if (kept.length < 2) return []
  const threshold = Math.max(2, Math.ceil(kept.length * 0.6))
  const counts = new Map<string, number>()
  for (const chapter of kept) {
    const seen = new Set<string>()
    for (const raw of chapter.text.split(/\r?\n/)) {
      const line = raw.trim()
      if (line.length === 0 || line.length > MAX_REPEATED_LINE_LENGTH || seen.has(line)) continue
      seen.add(line)
      counts.set(line, (counts.get(line) ?? 0) + 1)
    }
  }
  const matches: Array<readonly [string, number]> = []
  for (const [line, count] of counts) {
    if (count >= threshold) matches.push([line, count])
  }
  matches.sort((a, b) => b[1] - a[1])
  return matches.slice(0, MAX_REPEATED_LINES).map(([line]) => line)
}

/** Removes every line matching `target` (after trimming) and collapses leftover blank-line gaps. */
export const removeLineFromText = (text: string, target: string): string =>
  text
    .split(/\r?\n/)
    .filter((raw) => raw.trim() !== target)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

export const removeRepeatedLine = (
  chapters: ReadonlyArray<ReviewChapter>,
  target: string,
): Array<ReviewChapter> =>
  chapters.map((chapter) => ({ ...chapter, text: removeLineFromText(chapter.text, target) }))

/** Label of the Start button: reflects kept chapter count directly without helper text. */
export const startButtonLabel = (kept: number, total: number, isStarting: boolean): string => {
  if (isStarting) return "Starting…"
  if (kept === 0) return "Start · 0 chapters"
  if (kept === total) return kept === 1 ? "Start · 1 chapter" : `Start · ${kept} chapters`
  return `Start · ${kept} of ${total} chapters`
}
