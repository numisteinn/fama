import { Document, Episode, EpisodeId, type JobState, Voice, VoiceRef } from "@fama/contracts"
import { UiSchema } from "@effect/ui"
import { Option, Schema } from "effect"
import { ApiFailure, Connection } from "~/core/api"
import { BatchFile, hasAttached } from "~/core/batch"
import { NarrateAgainSubmitTarget } from "~/narrate-again/model"
import { PlaybackState, currentPlayback } from "~/playback/model"

export const isWorking = (job: JobState) => job._tag === "Queued" || job._tag === "Running"

/**
 * Primary screen shown in `<main>`. Read-along (`maybeReaderEpisodeId`) is orthogonal so opening
 * the Reader while reviewing keeps `ReviewScreen` mounted and preserves unsaved edits.
 */
export const Screen = UiSchema.TaggedEnum({
  Library: {},
  Review: { episodeId: EpisodeId, openId: Schema.Number },
  NarrateAgain: { episodeId: EpisodeId, openId: Schema.Number },
})

const ReviewSaveState = Schema.Struct({
  isSaving: Schema.Boolean,
  maybePendingDocument: Schema.Option(Document),
  maybeSavedDocument: Schema.Option(Document),
  maybeError: Schema.Option(Schema.String),
})

const QueuedReviewVoice = Schema.Struct({
  voice: VoiceRef,
  speed: Schema.Number,
  origin: Schema.String,
})

const ReviewVoiceState = Schema.Struct({
  request: Schema.Number,
  voice: VoiceRef,
  isSaving: Schema.Boolean,
  maybeQueued: Schema.Option(QueuedReviewVoice),
  maybeError: Schema.Option(Schema.String),
})

const ReviewStartState = Schema.Struct({
  isStarting: Schema.Boolean,
  maybeError: Schema.Option(Schema.String),
})

const NarrateAgainSubmitState = Schema.Struct({
  target: NarrateAgainSubmitTarget,
  isSubmitting: Schema.Boolean,
  maybeError: Schema.Option(Schema.String),
})

export const AppModel = Schema.Struct({
  connection: Connection,
  connectionGeneration: Schema.Number,
  libraryRequests: Schema.Number,
  libraryRequestsInFlight: Schema.Array(Schema.Number),
  maybeEpisodes: Schema.Option(Schema.Array(Episode)),
  maybeLibraryFailure: Schema.Option(ApiFailure),
  voices: Schema.Array(Voice),

  addText: Schema.String,
  batch: Schema.Array(BatchFile),
  batchKeys: Schema.Number,
  isAdding: Schema.Boolean,
  maybeAddError: Schema.Option(Schema.String),
  maybeVoice: Schema.Option(VoiceRef),
  speed: Schema.Number,
  isReviewOn: Schema.Boolean,
  fileDragDepth: Schema.Number,

  armedDeletes: Schema.Array(EpisodeId),
  rowErrors: Schema.Record(Schema.String, Schema.String),

  isSettingsOpen: Schema.Boolean,
  settingsOpens: Schema.Number,
  screen: Screen,
  screenOpens: Schema.Number,
  maybeReaderEpisodeId: Schema.Option(EpisodeId),
  reviewSaves: Schema.Record(Schema.String, ReviewSaveState),
  reviewVoices: Schema.Record(Schema.String, ReviewVoiceState),
  reviewVoiceRequests: Schema.Number,
  reviewStarts: Schema.Record(Schema.String, ReviewStartState),
  narrateAgainSubmits: Schema.Record(Schema.String, NarrateAgainSubmitState),

  ...PlaybackState.fields,
  rate: Schema.Number,
  maybeScrubMs: Schema.Option(Schema.Number),
})
export type AppModel = typeof AppModel.Type

// DERIVED

export const episodes = (model: AppModel): ReadonlyArray<Episode> =>
  Option.getOrElse(model.maybeEpisodes, (): ReadonlyArray<Episode> => [])

export const current = (model: AppModel) => currentPlayback(model.playback, episodes(model))

/** What the add bar will submit. */
const Draft = UiSchema.TaggedEnum({
  Empty: {},
  Url: { url: Schema.String },
  Text: { text: Schema.String },
  Files: {},
})

export const toDraft = (model: AppModel): typeof Draft.Type => {
  if (model.batch.length > 0) return hasAttached(model.batch) ? Draft.Files() : Draft.Empty()
  const trimmed = model.addText.trim()
  if (!trimmed) return Draft.Empty()
  if (!/\s/.test(trimmed) && /^https?:\/\//i.test(trimmed) && URL.canParse(trimmed)) {
    return Draft.Url({ url: trimmed })
  }
  return Draft.Text({ text: trimmed })
}
