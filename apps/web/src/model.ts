import { Document, Episode, EpisodeId, EpisodeProgress, type JobState, Voice, VoiceRef } from "@fama/contracts"
import { UiSchema } from "@effect/ui"
import { Option, Schema } from "effect"
import { ApiFailure, ApiToken, Connection } from "~/api"
import { BatchFile, hasAttached } from "~/batch"

// CONSTANTS

/** Playback rates of the player. */
export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const
/** Synthesis speeds of the add bar. */
export const SPEEDS = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.5] as const
export const POLL_MS = 2000
export const SAVE_EVERY_MS = 5000
export const SKIP_BACK_MS = 15_000
export const SKIP_FORWARD_MS = 30_000
export const DISARM_DELETE_MS = 3000

export const isWorking = (job: JobState) => job._tag === "Queued" || job._tag === "Running"

// MODEL

/**
 * Primary screen shown in `<main>`. Read-along (`maybeReaderEpisodeId`) is orthogonal so opening
 * the Reader while reviewing keeps `ReviewScreen` mounted and preserves unsaved edits.
 */
export const Screen = UiSchema.TaggedEnum({
  Library: {},
  Review: { episodeId: EpisodeId, openId: Schema.Number },
  NarrateAgain: { episodeId: EpisodeId, openId: Schema.Number },
})
export type Screen = typeof Screen.Type

export const ReviewSaveState = Schema.Struct({
  isSaving: Schema.Boolean,
  maybePendingDocument: Schema.Option(Document),
  maybeSavedDocument: Schema.Option(Document),
  maybeError: Schema.Option(Schema.String),
})
export type ReviewSaveState = typeof ReviewSaveState.Type

export const QueuedReviewVoice = Schema.Struct({
  voice: VoiceRef,
  speed: Schema.Number,
  origin: Schema.String,
})
export type QueuedReviewVoice = typeof QueuedReviewVoice.Type

export const ReviewVoiceState = Schema.Struct({
  request: Schema.Number,
  voice: VoiceRef,
  isSaving: Schema.Boolean,
  maybeQueued: Schema.Option(QueuedReviewVoice),
  maybeError: Schema.Option(Schema.String),
})
export type ReviewVoiceState = typeof ReviewVoiceState.Type

export const ReviewStartState = Schema.Struct({
  isStarting: Schema.Boolean,
  maybeError: Schema.Option(Schema.String),
})
export type ReviewStartState = typeof ReviewStartState.Type

export const NarrateAgainSubmitTarget = Schema.Literals(["text", "voice"])
export type NarrateAgainSubmitTarget = typeof NarrateAgainSubmitTarget.Type

export const NarrateAgainSubmitState = Schema.Struct({
  target: NarrateAgainSubmitTarget,
  isSubmitting: Schema.Boolean,
  maybeError: Schema.Option(Schema.String),
})
export type NarrateAgainSubmitState = typeof NarrateAgainSubmitState.Type

/**
 * What storage holds for an episode's progress when it starts. `NotSaved` has no local entry, as after the
 * user cleared site data: the server's progress decides. Only `Unreadable` storage falls back to the entry
 * this tab knows.
 */
export const StoredProgress = UiSchema.TaggedEnum({
  Saved: { progress: EpisodeProgress },
  NotSaved: {},
  Unreadable: {},
})
export type StoredProgress = typeof StoredProgress.Type

/**
 * A Play pressed while library requests were in flight. `awaiting` holds the numbers of those requests that have
 * not answered yet. It starts by the `awaitedAfter` rule of the contract, so it plays from the newer of this
 * device's and the server's progress, and not from a position another device left.
 */
export const PendingPlay = Schema.Struct({ episodeId: EpisodeId, awaiting: Schema.Array(Schema.Number) })
export type PendingPlay = typeof PendingPlay.Type

/**
 * A fact: what the audio element has. An episode plays as one timeline of its chapter files in order. `chapter` is
 * the file the element was told to load, and `offsetMs` the position inside it. Only `reconcile` in `update.ts`
 * tells the element anything, and it writes here what it told. The element's own events correct it.
 */
export const Playback = UiSchema.TaggedEnum({
  Stopped: {},
  Loaded: {
    episodeId: EpisodeId,
    chapter: Schema.Number,
    offsetMs: Schema.Number,
    url: Schema.String,
    isPlaying: Schema.Boolean,
    isWaiting: Schema.Boolean,
  },
})
export type Playback = typeof Playback.Type
export type LoadedPlayback = Extract<Playback, { _tag: "Loaded" }>

/**
 * Intent: what the listener asked for last, for the episode they listen to. The message handlers of `update.ts`
 * write it and send no audio Command. `reconcile` reads it, with the facts, and decides what the audio does.
 */
export const Listening = Schema.Struct({
  episodeId: EpisodeId,
  wantsPlay: Schema.Boolean,
  isPlayDue: Schema.Boolean,
  maybeSeekMs: Schema.Option(Schema.Number),
  maybeFollowedAt: Schema.Option(Schema.String),
})
export type Listening = typeof Listening.Type

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

  playback: Playback,
  loadedChapterDurationMs: Schema.NullOr(Schema.Number),
  maybeListening: Schema.Option(Listening),
  playIntents: Schema.Number,
  maybePendingPlay: Schema.Option(PendingPlay),
  rate: Schema.Number,
  localProgress: Schema.Record(Schema.String, EpisodeProgress),
  stamping: Schema.Record(Schema.String, Schema.Number),
  isSaveDue: Schema.Boolean,
  lastSavedAtMs: Schema.Number,
  maybeScrubMs: Schema.Option(Schema.Number),
})
export type AppModel = typeof AppModel.Type
export type Model = AppModel

// FLAGS / PROPS

/** Settings read from localStorage at boot. */
export const Flags = Schema.Struct({
  token: ApiToken,
  origin: Schema.String,
  voice: Schema.NullOr(VoiceRef),
  speed: Schema.Number,
  rate: Schema.Number,
  localProgress: Schema.Record(Schema.String, EpisodeProgress),
})
export type Flags = typeof Flags.Type

// DERIVED

export const episodes = (model: AppModel): ReadonlyArray<Episode> =>
  Option.getOrElse(model.maybeEpisodes, (): ReadonlyArray<Episode> => [])

/** The loaded playback and its episode, while that episode is in the library. */
export const current = (model: AppModel): Option.Option<{ playback: LoadedPlayback; episode: Episode }> => {
  const playback = model.playback
  if (playback._tag !== "Loaded") return Option.none()
  const episode = episodes(model).find((item) => item.id === playback.episodeId)
  return episode ? Option.some({ playback, episode }) : Option.none()
}

/** A Play of `episodeId` waits for the library. */
export const isPlayPending = (model: AppModel, episodeId: EpisodeId): boolean =>
  Option.exists(model.maybePendingPlay, (pending) => pending.episodeId === episodeId)

/** What the add bar will submit. */
export const Draft = UiSchema.TaggedEnum({
  Empty: {},
  Url: { url: Schema.String },
  Text: { text: Schema.String },
  Files: {},
})
export type Draft = typeof Draft.Type

export const toDraft = (model: AppModel): Draft => {
  if (model.batch.length > 0) return hasAttached(model.batch) ? Draft.Files() : Draft.Empty()
  const trimmed = model.addText.trim()
  if (!trimmed) return Draft.Empty()
  if (!/\s/.test(trimmed) && /^https?:\/\//i.test(trimmed) && URL.canParse(trimmed)) {
    return Draft.Url({ url: trimmed })
  }
  return Draft.Text({ text: trimmed })
}

const languageNames = new Intl.DisplayNames(undefined, { type: "language" })
export function languageName(code: string): string {
  try {
    return languageNames.of(code) ?? code
  } catch {
    return code
  }
}

/** Voices in menu order: by language name, then by name. */
export const sortedVoices = (voices: ReadonlyArray<Voice>): Array<Voice> =>
  [...voices].sort(
    (a, b) =>
      languageName(a.language).localeCompare(languageName(b.language)) || a.name.localeCompare(b.name),
  )

export const selectedVoice = (model: AppModel): Option.Option<Voice> =>
  Option.flatMap(model.maybeVoice, (id) =>
    Option.fromNullishOr(model.voices.find((voice) => voice.id === id)),
  )
