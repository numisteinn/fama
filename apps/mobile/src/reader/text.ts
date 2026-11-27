import { type Chapter, type Segment, segmentIndexAt } from "@fama/contracts"

// The reader as data. Each chapter's text is in one of five states, and the screen is a function of them, the
// chapter list and the player's place. Nothing here touches React, the network or the native player.

/** One chapter's text. `key` names the timing file: a new file at the same path has a new key. */
export type ChapterText =
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Idle"; readonly key: string }
  | { readonly _tag: "Loading"; readonly key: string }
  | { readonly _tag: "Loaded"; readonly key: string; readonly segments: ReadonlyArray<Segment> }
  | { readonly _tag: "Failed"; readonly key: string }

export type ReaderText = { readonly episodeId: string; readonly chapters: ReadonlyArray<ChapterText> }

type Listed = { readonly id: string; readonly chapters: ReadonlyArray<Chapter> }

/** The timing file of a chapter, or null for a chapter made before timing files. */
export const timingKey = (chapter: Chapter): string | null =>
  chapter.timingUrl === null ? null : `${chapter.url}#${chapter.timingUrl}#${chapter.durationMs}`

/** The episode has text to read: the reader's entry point shows only then. */
export const hasText = (episode: Listed): boolean => episode.chapters.some((chapter) => chapter.timingUrl !== null)

/**
 * The text for the episode as the library lists it now. A chapter keeps its state while its timing file is the same,
 * so a job that adds chapters keeps the text already loaded. Another episode starts over.
 */
export const listed = (text: ReaderText | null, episode: Listed): ReaderText => {
  const before = text?.episodeId === episode.id ? text.chapters : []
  const chapters = episode.chapters.map((chapter, index): ChapterText => {
    const key = timingKey(chapter)
    const old = before[index]
    if (key === null) return old?._tag === "Absent" ? old : { _tag: "Absent" }
    return old && old._tag !== "Absent" && old.key === key ? old : { _tag: "Idle", key }
  })
  const same = text?.episodeId === episode.id && chapters.length === before.length && chapters.every((c, i) => c === before[i])
  return same ? text : { episodeId: episode.id, chapters }
}

export type TextEvent =
  | { readonly _tag: "Started"; readonly index: number; readonly key: string }
  | { readonly _tag: "Loaded"; readonly index: number; readonly key: string; readonly segments: ReadonlyArray<Segment> }
  | { readonly _tag: "Failed"; readonly index: number; readonly key: string }
  | { readonly _tag: "Retry"; readonly index: number }

/** One answer of a load. An answer for a timing file the chapter no longer has changes nothing. */
export const update = (text: ReaderText, event: TextEvent): ReaderText => {
  const current = text.chapters[event.index]
  if (!current || current._tag === "Absent") return text
  let next: ChapterText
  switch (event._tag) {
    case "Started":
      if (current._tag !== "Idle" || current.key !== event.key) return text
      next = { _tag: "Loading", key: event.key }
      break
    case "Loaded":
      if (current._tag !== "Loading" || current.key !== event.key) return text
      next = { _tag: "Loaded", key: event.key, segments: event.segments }
      break
    case "Failed":
      if (current._tag !== "Loading" || current.key !== event.key) return text
      next = { _tag: "Failed", key: event.key }
      break
    case "Retry":
      if (current._tag !== "Failed") return text
      next = { _tag: "Idle", key: current.key }
      break
  }
  return { ...text, chapters: text.chapters.map((chapter, index) => (index === event.index ? next : chapter)) }
}

/**
 * The chapters to load now, at most `limit` at a time: the playing chapter first, then the ones after it, then the
 * ones before. So the text the listener hears comes first.
 */
export const nextLoads = (text: ReaderText, playing: number, limit: number): ReadonlyArray<number> => {
  const busy = text.chapters.filter((chapter) => chapter._tag === "Loading").length
  const count = text.chapters.length
  const order = Array.from({ length: count }, (_, step) => (Math.max(0, Math.min(playing, count - 1)) + step) % count)
  return order.filter((index) => text.chapters[index]?._tag === "Idle").slice(0, Math.max(0, limit - busy))
}

// ROWS

/**
 * One row of the reader. A paragraph holds Segments `first` to `last` of its chapter. A chapter title is a heading;
 * when the voice reads the title, `segment` is that Segment, so the heading is marked and tappable too.
 */
export type Row =
  | { readonly _tag: "Heading"; readonly key: string; readonly chapter: number; readonly title: string; readonly segment: number | null }
  | { readonly _tag: "Paragraph"; readonly key: string; readonly chapter: number; readonly first: number; readonly last: number }
  | { readonly _tag: "Pending"; readonly key: string; readonly chapter: number }
  | { readonly _tag: "Failed"; readonly key: string; readonly chapter: number }

const same = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()

/** The rows of the text: each chapter's title, then its paragraphs, or a row that waits for them. */
export const rowsOf = (chapters: ReadonlyArray<Chapter>, text: ReaderText): ReadonlyArray<Row> => {
  const rows: Array<Row> = []
  chapters.forEach((chapter, index) => {
    const state = text.chapters[index]
    const segments = state?._tag === "Loaded" ? state.segments : []
    // The voice reads the chapter title as its own paragraph: that Segment is the heading.
    const spoken = segments[0] !== undefined && segments[0].endsParagraph && same(segments[0].text, chapter.title)
    rows.push({ _tag: "Heading", key: `h${index}`, chapter: index, title: chapter.title, segment: spoken ? 0 : null })
    if (state?._tag === "Idle" || state?._tag === "Loading") rows.push({ _tag: "Pending", key: `w${index}`, chapter: index })
    if (state?._tag === "Failed") rows.push({ _tag: "Failed", key: `f${index}`, chapter: index })
    let first = spoken ? 1 : 0
    segments.forEach((segment, at) => {
      if (at < first) return
      if (segment.endsParagraph || at === segments.length - 1) {
        rows.push({ _tag: "Paragraph", key: `p${index}.${first}`, chapter: index, first, last: at })
        first = at + 1
      }
    })
  })
  return rows
}

// THE PLACE

/** A Segment of a chapter. */
export type Mark = { readonly chapter: number; readonly segment: number }

/** Where each chapter starts on the episode timeline, in ms. The native player builds its timeline the same way. */
export const chapterStartMs = (chapters: ReadonlyArray<Chapter>, index: number): number =>
  chapters.slice(0, index).reduce((sum, chapter) => sum + chapter.durationMs, 0)

/**
 * The Segment the voice reads now. `index` is the chapter the native player plays, and `positionMs` its place on the
 * episode timeline. `segmentIndexAt` of the contract decides the Segment. `null` while the chapter's text is not
 * loaded, and before its first Segment starts.
 */
export const markAt = (
  chapters: ReadonlyArray<Chapter>,
  text: ReaderText,
  place: { readonly index: number; readonly positionMs: number },
): Mark | null => {
  const state = text.chapters[place.index]
  if (state?._tag !== "Loaded") return null
  // Whole ms: a seek to `start + startMs` comes back as a float a hair under it.
  const segment = segmentIndexAt(state.segments, Math.round(place.positionMs) - chapterStartMs(chapters, place.index))
  return segment === null ? null : { chapter: place.index, segment }
}

/** Where a tap on a Segment moves playback: its `startMs`, on the episode timeline. */
export const seekTargetMs = (chapters: ReadonlyArray<Chapter>, text: ReaderText, mark: Mark): number | null => {
  const state = text.chapters[mark.chapter]
  const segment = state?._tag === "Loaded" ? state.segments[mark.segment] : undefined
  return segment === undefined ? null : chapterStartMs(chapters, mark.chapter) + segment.startMs
}

/** The row that shows a Segment: its paragraph, or the heading of a spoken title. */
export const rowOf = (rows: ReadonlyArray<Row>, mark: Mark): number | null => {
  // Rows are in chapter order, and paragraphs of a chapter in Segment order: search for the last row at or before.
  const order = (row: Row) => row.chapter * 1e9 + (row._tag === "Paragraph" ? row.first : row._tag === "Heading" && row.segment !== null ? 0 : -1)
  const target = mark.chapter * 1e9 + mark.segment
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = (low + high) >> 1
    const candidate = rows[middle]
    if (candidate !== undefined && order(candidate) <= target) low = middle + 1
    else high = middle
  }
  const row = rows[low - 1]
  if (!row || row.chapter !== mark.chapter) return null
  if (row._tag === "Paragraph") return mark.segment <= row.last ? low - 1 : null
  return row._tag === "Heading" && row.segment === mark.segment ? low - 1 : null
}

/** The row to open the reader on: the marked Segment, else the title of the playing chapter. */
export const openingRow = (rows: ReadonlyArray<Row>, mark: Mark | null, playing: number): number => {
  const marked = mark ? rowOf(rows, mark) : null
  if (marked !== null) return marked
  const heading = rows.findIndex((row) => row._tag === "Heading" && row.chapter === playing)
  return Math.max(0, heading)
}

/** The text of a paragraph: its Segments, one space apart. */
export const paragraphText = (segments: ReadonlyArray<Segment>, first: number, last: number): string =>
  segments.slice(first, last + 1).map((segment) => segment.text).join(" ")

/**
 * The line of a laid-out paragraph where Segment `segment` starts. `lines` are the paragraph's lines in order, with
 * their text, as iOS laid them out. So the reader can keep a line in sight, not only the paragraph.
 */
export const lineOf = (
  segments: ReadonlyArray<Segment>,
  first: number,
  segment: number,
  lines: ReadonlyArray<{ readonly text: string }>,
): number => {
  const offset = segments.slice(first, segment).reduce((sum, s) => sum + s.text.length + 1, 0)
  let seen = 0
  for (const [index, line] of lines.entries()) {
    seen += line.text.length
    if (offset < seen) return index
  }
  return Math.max(0, lines.length - 1)
}
