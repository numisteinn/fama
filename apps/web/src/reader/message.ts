import { Timing } from "@fama/contracts"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"

export const ReaderMessage = defineMessageUnion({
  /** The Text button of the player bar: opens the reader for the playing episode, or closes it. */
  ClickedText: {},
  ClickedSegment: { chapter: Schema.Number, segment: Schema.Number },
  /** Whether text was selected when the click on a Segment landed. A click that ends a selection does not seek. */
  GotSelectionOnClick: { chapter: Schema.Number, segment: Schema.Number, isSelecting: Schema.Boolean },
  ClickedFollow: {},
  /** A scroll by hand came to rest. `isMarkInView`: the marked Segment is on screen now. */
  SettledScrollByHand: { isMarkInView: Schema.Boolean },
  SucceededFetchTiming: { url: Schema.String, timing: Timing },
  FailedFetchTiming: { url: Schema.String },
  CompletedScrollToMark: {},
})
export type ReaderMessage = typeof ReaderMessage.Type
