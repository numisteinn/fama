import { Schema } from "effect"

/** A whole number of milliseconds, 0 or more. */
const Millis = Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)))

/**
 * The text of one synthesis call, and where it is in the chapter audio. `text` is as the Document has it
 * ("3 bækur"), not as the engine reads it. Times are from the start of the chapter. `startMs` is where the voice
 * starts the text. `endMs` is where the audio of the call ends: the voice has stopped by then. The pause between two
 * Segments is on the timeline, and belongs to neither.
 */
export const Segment = Schema.Struct({
  text: Schema.String,
  startMs: Millis,
  endMs: Millis,
  /** The last Segment of its paragraph. The spoken title is a paragraph too. */
  endsParagraph: Schema.Boolean,
})
export interface Segment extends Schema.Schema.Type<typeof Segment> {}

const inOrder = (segments: ReadonlyArray<Segment>) =>
  segments.every(
    (segment, index) => segment.startMs <= segment.endMs && (index === 0 || segments[index - 1]!.endMs <= segment.startMs),
  )

/** The timing file of one chapter: its Segments in the order the voice reads them. No two overlap. */
export const Timing = Schema.Struct({
  segments: Schema.Array(Segment).pipe(
    Schema.check(Schema.makeFilter(inOrder, { expected: "Segments in order that do not overlap" })),
  ),
})
export interface Timing extends Schema.Schema.Type<typeof Timing> {}

/**
 * The Segment the voice reads at `positionMs` of the chapter audio: the index of the last Segment whose `startMs`
 * is at or before the position. The pause after a Segment still belongs to it, so the mark does not flicker between
 * sentences. `null` before the first Segment starts. The one rule the readers share.
 */
export const segmentIndexAt = (
  segments: ReadonlyArray<{ readonly startMs: number }>,
  positionMs: number,
): number | null => {
  let low = 0
  let high = segments.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (segments[middle]!.startMs <= positionMs) low = middle + 1
    else high = middle
  }
  return low === 0 ? null : low - 1
}
