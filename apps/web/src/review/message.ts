import { Document, Episode, EpisodeId } from "@fama/contracts"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { ApiFailure } from "~/api"
import { SamplesMessage } from "~/review/samples"

export const ReviewMessage = defineMessageUnion({
  ClickedEpisode: { episodeId: EpisodeId },
  ClickedBack: {},
  ClickedTryAgain: {},
  GotSamplesMessage: { message: SamplesMessage },
  SucceededFetchDocument: { episodeId: EpisodeId, request: Schema.Number, document: Document },
  FailedFetchDocument: { episodeId: EpisodeId, request: Schema.Number, failure: ApiFailure },
  UpdatedTitle: { value: Schema.String },
  ToggledChapter: { index: Schema.Number },
  ClickedChapter: { index: Schema.Number },
  UpdatedChapterTitle: { index: Schema.Number, value: Schema.String },
  UpdatedChapterText: { index: Schema.Number, value: Schema.String },
  ClickedRemoveRepeatedLine: { line: Schema.String },
  ClickedSave: {},
  SucceededSaveDocument: { episodeId: EpisodeId, document: Document },
  FailedSaveDocument: { episodeId: EpisodeId, failure: ApiFailure },
  ClickedStart: {},
  SucceededStartReview: { episode: Episode },
  FailedStartReview: { episodeId: EpisodeId, failure: ApiFailure },
})
export type ReviewMessage = typeof ReviewMessage.Type
