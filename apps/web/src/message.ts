import { Episode, EpisodeId, Voice, VoiceRef } from "@fama/contracts"
import { Dialog } from "@foldkit/ui"
import { Schema } from "effect"
import { File } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { ApiFailure, ApiToken, Connection } from "~/api"
import { PickerId } from "~/model"

export const PlayerShortcut = Schema.Literals(["Toggle", "Back", "Forward"])
export type PlayerShortcut = typeof PlayerShortcut.Type

export const Message = defineMessageUnion({
  // Library
  /** Library results carry the connection they were fetched for, so a late one from an old connection is dropped. */
  SucceededFetchEpisodes: { connection: Connection, episodes: Schema.Array(Episode) },
  FailedFetchEpisodes: { connection: Connection, failure: ApiFailure },
  SucceededFetchVoices: { voices: Schema.Array(Voice) },
  FailedFetchVoices: {},
  ClickedTryAgain: {},
  TickedPoll: {},
  BecameVisible: {},
  HidPage: {},

  // Add bar
  UpdatedAddText: { value: Schema.String },
  PressedEnterInAddText: {},
  SubmittedAddForm: {},
  ChangedFileInput: { files: Schema.Array(File.File) },
  ClickedRemoveFile: {},
  EnteredFileDrag: {},
  LeftFileDrag: {},
  DroppedFile: { file: File.File },
  SucceededCreateEpisode: { episode: Episode },
  FailedCreateEpisode: { failure: ApiFailure },
  CompletedMountFilePickerKeys: {},
  CompletedFocusAddText: {},

  // Menus
  ClickedPickerTrigger: { pickerId: PickerId },
  PressedPickerTriggerKey: { pickerId: PickerId, key: Schema.String },
  PressedPickerKey: { key: Schema.String },
  ClickedPickerItem: { pickerId: PickerId, index: Schema.Number },
  ClickedPickerBackdrop: {},
  CompletedFocusPicker: {},
  CompletedFocusPickerTrigger: {},
  CompletedScrollPickerItem: {},
  CompletedAnchorPicker: {},
  CompletedWaitBeforeResetTypeAhead: { keys: Schema.Number },

  // Library rows
  ClickedPlayEpisode: { episodeId: EpisodeId },
  ClickedRetry: { episodeId: EpisodeId },
  SucceededRetryEpisode: { episode: Episode },
  FailedRetryEpisode: { episodeId: EpisodeId, failure: ApiFailure },
  ClickedArmDelete: { episodeId: EpisodeId },
  ClickedConfirmDelete: { episodeId: EpisodeId },
  SucceededDeleteEpisode: { episodeId: EpisodeId },
  FailedDeleteEpisode: { episodeId: EpisodeId, failure: ApiFailure },
  CompletedWaitBeforeDisarmDelete: { episodeId: EpisodeId },
  CompletedFocusDeleteConfirm: {},

  // Settings
  ClickedSettings: {},
  GotSettingsDialogMessage: { message: Dialog.Message },
  /** Redacted from the input handler on, so DevTools history never holds the token. */
  UpdatedTokenDraft: { value: ApiToken },
  UpdatedOriginDraft: { value: Schema.String },
  SubmittedSettings: {},
  /** Another tab saved a token, server, Voice, Voice speed or Playback speed. Carries all of them, as stored now. */
  ChangedStoredSettings: {
    connection: Connection,
    maybeVoice: Schema.Option(VoiceRef),
    speed: Schema.Number,
    rate: Schema.Number,
  },
  /** Feed results carry the connection they were fetched for, so a late one from an old connection is dropped. */
  SucceededFetchFeed: { connection: Connection, url: Schema.String },
  FailedFetchFeed: { connection: Connection, failure: ApiFailure },
  ClickedCopyFeedUrl: {},
  SucceededCopyFeedUrl: {},
  FailedCopyFeedUrl: {},
  CompletedWaitBeforeResetCopied: { copy: Schema.Number },
  CompletedStoreSetting: {},

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
  CompletedLoadChapter: {},
  FailedPlayAudio: {},
  CompletedToggleAudio: {},
  CompletedSeekAudio: {},
  CompletedSetAudioRate: {},
  CompletedStopAudio: {},
  CompletedSavePosition: {},
  /** The position storage holds for an episode when it starts, so a pause in another tab is honored. */
  GotSavedPosition: { episodeId: EpisodeId, maybePositionMs: Schema.Option(Schema.Number) },
})
export type Message = typeof Message.Type
