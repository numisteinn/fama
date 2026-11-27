import { ChangeVoice, Document, Episode, EpisodeId, EpisodeProgress, Voice, VoiceRef } from "@fama/contracts"
import { UiSchema } from "@effect/ui"
import { Schema } from "effect"
import { ApiFailure, Connection } from "~/core/api"
import { StoredProgress } from "~/core/flags"
import { NarrateAgainSubmitTarget } from "~/narrate-again/model"
import { PlayerShortcut } from "~/playback/model"

export const AppMessage = UiSchema.TaggedEnum({
  // Library
  SucceededFetchEpisodes: {
    generation: Schema.Number,
    request: Schema.Number,
    episodes: Schema.Array(Episode),
  },
  FailedFetchEpisodes: { generation: Schema.Number, request: Schema.Number, failure: ApiFailure },
  SucceededFetchVoices: { generation: Schema.Number, voices: Schema.Array(Voice) },
  FailedFetchVoices: {},
  ClickedTryAgain: {},
  TickedPoll: {},
  BecameVisible: {},
  HidPage: {},

  // Add bar
  UpdatedAddText: { value: Schema.String },
  PressedEnterInAddText: {},
  SubmittedAddForm: {},
  ToggledAddReview: { checked: Schema.Boolean },
  ChangedFileInput: { files: Schema.Array(Schema.instanceOf(File)) },
  ClickedRemoveFile: { key: Schema.Number },
  ClickedRetryFile: { key: Schema.Number },
  EnteredFileDrag: {},
  LeftFileDrag: {},
  DroppedFiles: { files: Schema.Array(Schema.instanceOf(File)) },
  SucceededCreateEpisode: { episode: Episode },
  FailedCreateEpisode: { failure: ApiFailure },
  SucceededUploadFile: { key: Schema.Number, episode: Episode },
  FailedUploadFile: { key: Schema.Number, failure: ApiFailure },

  // Pickers (child events from `Picker`)
  PickedVoice: { value: Schema.String },
  PickedVoiceSpeed: { value: Schema.String },
  PickedPlaybackSpeed: { value: Schema.String },
  PickedChapter: { value: Schema.String },

  // Library rows
  ClickedPlayEpisode: { episodeId: EpisodeId },
  ClickedOpenReview: { episodeId: EpisodeId },
  ClickedOpenNarrateAgain: { episodeId: EpisodeId },
  ClickedRetry: { episodeId: EpisodeId },
  SucceededRetryEpisode: { episode: Episode },
  FailedRetryEpisode: { episodeId: EpisodeId, failure: ApiFailure },
  ClickedArmDelete: { episodeId: EpisodeId },
  ClickedConfirmDelete: { episodeId: EpisodeId },
  SucceededDeleteEpisode: { episodeId: EpisodeId },
  FailedDeleteEpisode: { episodeId: EpisodeId, failure: ApiFailure },
  CompletedWaitBeforeDisarmDelete: { episodeId: EpisodeId },

  // Sub-screen child events & app-scoped episode lifecycle writes (Review, NarrateAgain, Reader)
  ClosedSubScreen: {},
  SubmittedSaveReview: { episodeId: EpisodeId, document: Document },
  SucceededSaveReview: { episodeId: EpisodeId, document: Document },
  FailedSaveReview: { episodeId: EpisodeId, failure: ApiFailure },
  SubmittedStartReview: {
    episodeId: EpisodeId,
    document: Document,
    voice: Schema.optionalKey(VoiceRef),
  },
  SucceededStartReview: { episode: Episode },
  FailedStartReview: { episodeId: EpisodeId, failure: ApiFailure },
  ClearedReviewError: { episodeId: EpisodeId },
  RequestedChangeReviewVoice: { episodeId: EpisodeId, voice: VoiceRef, speed: Schema.Number },
  SucceededChangeReviewVoice: {
    episodeId: EpisodeId,
    origin: Schema.String,
    request: Schema.Number,
    voice: VoiceRef,
    speed: Schema.Number,
  },
  FailedChangeReviewVoice: { episodeId: EpisodeId, request: Schema.Number, voice: VoiceRef, failure: ApiFailure },
  RequestedPauseMainPlayback: {},
  SubmittedNarrateAgainText: { episodeId: EpisodeId, document: Document },
  SubmittedNarrateAgainVoice: { episodeId: EpisodeId, input: ChangeVoice },
  SucceededNarrateAgain: { episodeId: EpisodeId },
  FailedNarrateAgain: { episodeId: EpisodeId, target: NarrateAgainSubmitTarget, failure: ApiFailure },
  ClearedNarrateAgainError: { episodeId: EpisodeId, target: NarrateAgainSubmitTarget },
  ClickedToggleReader: {},
  RequestedPlayFromReader: { positionMs: Schema.Number },

  // Settings (child events from `SettingsDialog`)
  RequestedOpenSettings: {},
  RequestedCloseSettings: {},
  SavedSettings: { connection: Connection },
  ChangedStoredSettings: {
    connection: Connection,
    maybeVoice: Schema.Option(VoiceRef),
    speed: Schema.Number,
    rate: Schema.Number,
  },

  // Player controls
  ClickedPlayPause: {},
  ClickedSkip: { deltaMs: Schema.Number },
  UpdatedScrub: { value: Schema.String },
  CommittedScrub: { value: Schema.String },
  PressedPlayerShortcut: { shortcut: PlayerShortcut },
  PressedMediaPlay: {},
  PressedMediaPause: {},
  PressedMediaSkip: { deltaMs: Schema.Number },
  PressedMediaSeekTo: { positionMs: Schema.Number },
  PressedMediaPreviousTrack: {},
  PressedMediaNextTrack: {},

  // Audio element
  UpdatedAudioTime: { offsetMs: Schema.Number, atMs: Schema.Number },
  StartedAudio: {},
  PausedAudio: {},
  EndedChapter: {},
  FailedPlayAudio: {},
  GotStoredProgress: { episodeId: EpisodeId, intent: Schema.Number, stored: StoredProgress },

  // Progress sync
  SavedProgress: { episodeId: EpisodeId, progress: EpisodeProgress },
  SucceededPushProgress: {
    episodeId: EpisodeId,
    sent: EpisodeProgress,
    stored: EpisodeProgress,
  },
  FailedPushProgress: { episodeId: EpisodeId },
})
export type AppMessage = typeof AppMessage.Type
export { AppMessage as Message }
