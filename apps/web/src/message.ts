import { Episode, EpisodeId, EpisodeProgress, Voice, VoiceRef } from "@fama/contracts"
import { Dialog } from "@foldkit/ui"
import { Schema } from "effect"
import { File } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { ApiFailure, ApiToken, Connection } from "~/api"
import { PickerId, StoredProgress } from "~/model"
import { ReaderMessage } from "~/reader/message"
import { NarrateAgainMessage } from "~/review/narrateAgainMessage"
import { ReviewMessage } from "~/review/message"

export const PlayerShortcut = Schema.Literals(["Toggle", "Back", "Forward"])
export type PlayerShortcut = typeof PlayerShortcut.Type

export const Message = defineMessageUnion({
  // Library
  /** Library results carry the connection generation they were fetched for, so a late one from an old connection is dropped. */
  SucceededFetchEpisodes: { generation: Schema.Number, request: Schema.Number, episodes: Schema.Array(Episode) },
  FailedFetchEpisodes: { generation: Schema.Number, request: Schema.Number, failure: ApiFailure },
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
  ToggledAddReview: {},
  ChangedFileInput: { files: Schema.Array(File.File) },
  ClickedRemoveFile: { key: Schema.Number },
  ClickedRetryFile: { key: Schema.Number },
  EnteredFileDrag: {},
  LeftFileDrag: {},
  /** The files of a drop, with the files of each dropped folder. */
  DroppedFiles: { files: Schema.Array(File.File) },
  SucceededCreateEpisode: { episode: Episode },
  FailedCreateEpisode: { failure: ApiFailure },
  SucceededUploadFile: { key: Schema.Number, episode: Episode },
  FailedUploadFile: { key: Schema.Number, failure: ApiFailure },
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

  // Narrate again
  GotNarrateAgainMessage: { message: NarrateAgainMessage },

  // Reader
  GotReaderMessage: { message: ReaderMessage },

  // Review
  GotReviewMessage: { message: ReviewMessage },

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
  /** Feed results carry the number of their request. Only the latest request's result shows. */
  SucceededFetchFeed: { request: Schema.Number, url: Schema.String },
  FailedFetchFeed: { request: Schema.Number, failure: ApiFailure },
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
  /** The browser refused to play: no user gesture, or a file it cannot play. */
  FailedPlayAudio: {},
  CompletedPlayAudio: {},
  CompletedPauseAudio: {},
  CompletedSeekAudio: {},
  CompletedSetAudioRate: {},
  CompletedStopAudio: {},
  /**
   * The progress storage holds for an episode when it starts, so a pause in another tab is honored.
   * `intent` is the playback action that started it.
   */
  GotStoredProgress: { episodeId: EpisodeId, intent: Schema.Number, stored: StoredProgress },

  // Progress sync
  /** A listener's action stamped and stored this progress on the device. */
  SavedProgress: { episodeId: EpisodeId, progress: EpisodeProgress },
  /** The server answered a push with what it stores now, `sent` or a newer entry. */
  SucceededPushProgress: { episodeId: EpisodeId, sent: EpisodeProgress, stored: EpisodeProgress },
  /** The push did not arrive. The local entry stays newer, so the next library load sends it again. */
  FailedPushProgress: { episodeId: EpisodeId },
  CompletedStoreProgress: {},
})
export type Message = typeof Message.Type
