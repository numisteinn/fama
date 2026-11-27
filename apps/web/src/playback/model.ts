import { type Episode, EpisodeId, EpisodeProgress } from "@fama/contracts"
import { UiSchema } from "@effect/ui"
import { Option, Schema } from "effect"

// CONSTANTS

/** Playback rates of the player. */
export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const
/** How often a playing episode's position is saved. */
export const SAVE_EVERY_MS = 5000
export const SKIP_BACK_MS = 15_000
export const SKIP_FORWARD_MS = 30_000

// MODELS

/**
 * A fact: what the audio element has. An episode plays as one timeline of its chapter files in order. `chapter` is
 * the file the element was told to load, and `offsetMs` the position inside it. Only `reconcile` in `player.ts`
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
 * Intent: what the listener asked for last, for the episode they listen to. The message handlers of `player.ts`
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

/**
 * A Play pressed while library requests were in flight. `awaiting` holds the numbers of those requests that have
 * not answered yet. It starts by the `awaitedAfter` rule of the contract, so it plays from the newer of this
 * device's and the server's progress, and not from a position another device left.
 */
export const PendingPlay = Schema.Struct({ episodeId: EpisodeId, awaiting: Schema.Array(Schema.Number) })
export type PendingPlay = typeof PendingPlay.Type

/** Keyboard and media shortcuts of the player. */
export const PlayerShortcut = Schema.Literals(["Toggle", "Back", "Forward"])
export type PlayerShortcut = typeof PlayerShortcut.Type

export const PlaybackState = Schema.Struct({
  playback: Playback,
  loadedChapterDurationMs: Schema.NullOr(Schema.Number),
  maybeListening: Schema.Option(Listening),
  playIntents: Schema.Number,
  maybePendingPlay: Schema.Option(PendingPlay),
  localProgress: Schema.Record(Schema.String, EpisodeProgress),
  stamping: Schema.Record(Schema.String, Schema.Number),
  isSaveDue: Schema.Boolean,
  lastSavedAtMs: Schema.Number,
})
export type PlaybackState = typeof PlaybackState.Type

/** The loaded playback and its episode, while the library still lists it. */
export const currentPlayback = (playback: Playback, episodes: ReadonlyArray<Episode>) => {
  if (playback._tag !== "Loaded") return Option.none()
  const episode = episodes.find((item) => item.id === playback.episodeId)
  return episode ? Option.some({ playback, episode }) : Option.none()
}

export const isPlayPending = (pending: PlaybackState["maybePendingPlay"], episodeId: EpisodeId): boolean =>
  Option.exists(pending, (play) => play.episodeId === episodeId)
