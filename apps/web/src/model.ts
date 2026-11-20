import { Episode, EpisodeId, type JobState, Voice, VoiceRef } from "@fama/contracts"
import { Dialog } from "@foldkit/ui"
import { Option, Schema } from "effect"
import { File } from "foldkit"
import { defineTaggedUnion } from "foldkit/schema"
import { ApiFailure, ApiToken, Connection } from "~/api"

// CONSTANTS

/** Playback rates of the player. */
export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const
/** Synthesis speeds of the add bar. */
export const SPEEDS = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.5] as const
/** File types the add bar takes. */
export const ACCEPT = ".pdf,.epub,.txt,.md,.markdown,.html,.htm"
export const POLL_MS = 2000
export const SAVE_EVERY_MS = 5000
/** Closer than this to the end counts as finished, so the next start is from the top. */
export const FINISHED_MARGIN_MS = 3000
export const SKIP_BACK_MS = 15_000
export const SKIP_FORWARD_MS = 30_000
export const DISARM_DELETE_MS = 3000
export const RESET_COPIED_MS = 1500

export const isWorking = (job: JobState) => job._tag === "Queued" || job._tag === "Running"

// MODEL

/** The four single-choice menus. */
export const PickerId = Schema.Literals(["Voice", "VoiceSpeed", "PlaybackSpeed", "Chapters"])
export type PickerId = typeof PickerId.Type

/** At most one menu is open. `maybeActiveIndex` is the highlighted item. */
export const Picker = defineTaggedUnion({
  Closed: {},
  Open: { pickerId: PickerId, maybeActiveIndex: Schema.Option(Schema.Number) },
})
export type Picker = typeof Picker.Type

/** The private podcast feed URL in Settings. */
export const Feed = defineTaggedUnion({
  Loading: {},
  Ready: { url: Schema.String },
  Failed: { message: Schema.String },
})
export type Feed = typeof Feed.Type

/**
 * The loaded episode. An episode plays as one timeline of its chapter files in order.
 * `offsetMs` is the position inside the current chapter file.
 */
export const Playback = defineTaggedUnion({
  Stopped: {},
  Loaded: {
    episodeId: EpisodeId,
    chapter: Schema.Number,
    offsetMs: Schema.Number,
    isPlaying: Schema.Boolean,
    /** The current chapter ended and the next one is still rendering. */
    isWaiting: Schema.Boolean,
    /** The last chapter played to its end. */
    isEnded: Schema.Boolean,
  },
})
export type Playback = typeof Playback.Type
export type LoadedPlayback = Extract<Playback, { _tag: "Loaded" }>

export const Model = Schema.Struct({
  connection: Connection,
  /** `None` until the first load finishes. */
  maybeEpisodes: Schema.Option(Schema.Array(Episode)),
  maybeLibraryFailure: Schema.Option(ApiFailure),
  voices: Schema.Array(Voice),

  addText: Schema.String,
  maybeAttachedFile: Schema.Option(File.File),
  isAdding: Schema.Boolean,
  maybeAddError: Schema.Option(Schema.String),
  /** `None` is Auto. */
  maybeVoice: Schema.Option(VoiceRef),
  speed: Schema.Number,
  /** Depth of file drags over the window. Above 0 shows the drop overlay. */
  fileDragDepth: Schema.Number,

  /** Rows whose Delete button is armed. */
  armedDeletes: Schema.Array(EpisodeId),
  /** Retry or Delete failures, by episode id. */
  rowErrors: Schema.Record(Schema.String, Schema.String),

  picker: Picker,

  settingsDialog: Dialog.Model,
  settingsDraft: Connection,
  feed: Feed,
  isFeedUrlCopied: Schema.Boolean,
  /** Counts the copies that showed Copied. A reset timer clears Copied only for its own copy. */
  feedUrlCopies: Schema.Number,

  playback: Playback,
  rate: Schema.Number,
  /** Position on the whole timeline, by episode id. Mirrors `fama.position.<id>`. */
  savedPositions: Schema.Record(Schema.String, Schema.Number),
  lastSavedAtMs: Schema.Number,
  /** Slider value while the user drags it. */
  maybeScrubMs: Schema.Option(Schema.Number),
})
export type Model = typeof Model.Type

// FLAGS

/** Settings read from localStorage at boot. */
export const Flags = Schema.Struct({
  token: ApiToken,
  origin: Schema.String,
  voice: Schema.NullOr(VoiceRef),
  speed: Schema.Number,
  rate: Schema.Number,
  savedPositions: Schema.Record(Schema.String, Schema.Number),
})
export type Flags = typeof Flags.Type

// DERIVED

export const episodes = (model: Model): ReadonlyArray<Episode> =>
  Option.getOrElse(model.maybeEpisodes, (): ReadonlyArray<Episode> => [])

/** The loaded playback and its episode, while that episode is in the library. */
export const current = (model: Model): Option.Option<{ playback: LoadedPlayback; episode: Episode }> => {
  const playback = model.playback
  if (playback._tag !== "Loaded") return Option.none()
  const episode = episodes(model).find((item) => item.id === playback.episodeId)
  return episode ? Option.some({ playback, episode }) : Option.none()
}

/** What the add bar will submit. */
export const Draft = defineTaggedUnion({
  Empty: {},
  Url: { url: Schema.String },
  Text: { text: Schema.String },
  File: { file: File.File },
})
export type Draft = typeof Draft.Type

export const toDraft = (model: Model): Draft => {
  if (Option.isSome(model.maybeAttachedFile)) return Draft.File({ file: model.maybeAttachedFile.value })
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

export const selectedVoice = (model: Model): Option.Option<Voice> =>
  Option.flatMap(model.maybeVoice, (id) => Option.fromNullishOr(model.voices.find((voice) => voice.id === id)))
