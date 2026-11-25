import { Document, EpisodeId } from "@fama/contracts"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { ApiFailure } from "~/api"

export const NarrateAgainMessage = defineMessageUnion({
  ClickedEpisode: { episodeId: EpisodeId },
  ClickedBack: {},
  ClickedTryAgain: {},
  SucceededFetchDocument: { episodeId: EpisodeId, request: Schema.Number, document: Document },
  FailedFetchDocument: { episodeId: EpisodeId, request: Schema.Number, failure: ApiFailure },
  ClickedChapter: { index: Schema.Number },
  UpdatedChapterText: { index: Schema.Number, value: Schema.String },
  ChangedVoice: { value: Schema.String },
  ChangedSpeed: { value: Schema.String },
  ClickedNarrateText: {},
  ClickedChangeVoice: {},
  SucceededQueueNarration: { episodeId: EpisodeId },
  FailedQueueNarration: { episodeId: EpisodeId, failure: ApiFailure },
})
export type NarrateAgainMessage = typeof NarrateAgainMessage.Type
