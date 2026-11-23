import { Episode, EpisodeId, EpisodeProgress, type JobState, Voice, VoiceRef } from "@fama/contracts"
import { Dialog } from "@foldkit/ui"
import { Option, Schema } from "effect"
import { File } from "foldkit"
import { defineTaggedUnion } from "foldkit/schema"
import { ApiFailure, ApiToken, Connection } from "~/api"
import { formatRate } from "~/lib/format"

// CONSTANTS

/** Playback rates of the player. */
export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const
/** Synthesis speeds of the add bar. */
export const SPEEDS = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.5] as const
/** File types the add bar takes. */
export const ACCEPT = ".pdf,.epub,.txt,.md,.markdown,.html,.htm"
export const POLL_MS = 2000
export const SAVE_EVERY_MS = 5000
export const SKIP_BACK_MS = 15_000
export const SKIP_FORWARD_MS = 30_000
export const DISARM_DELETE_MS = 3000
export const RESET_COPIED_MS = 1500
/** Type-ahead keys closer together than this make one prefix, as in base-ui. */
export const RESET_TYPE_AHEAD_MS = 750

export const isWorking = (job: JobState) => job._tag === "Queued" || job._tag === "Running"

// MODEL

/** The four single-choice menus. */
export const PickerId = Schema.Literals(["Voice", "VoiceSpeed", "PlaybackSpeed", "Chapters"])
export type PickerId = typeof PickerId.Type

/**
 * At most one menu is open. `maybeActiveIndex` is the highlighted item. `typedText` is the type-ahead so far,
 * and `typeAheadFrom` the index it searches after, as base-ui's `prevIndexRef`.
 */
export const Picker = defineTaggedUnion({
  Closed: {},
  Open: {
    pickerId: PickerId,
    maybeActiveIndex: Schema.Option(Schema.Number),
    typedText: Schema.String,
    typeAheadFrom: Schema.Number,
  },
})
export type Picker = typeof Picker.Type

/**
 * What storage holds for an episode's progress when it starts. `NotSaved` has no local entry, as after the
 * user cleared site data: the server's progress decides. Only `Unreadable` storage falls back to the entry
 * this tab knows.
 */
export const StoredProgress = defineTaggedUnion({
  Saved: { progress: EpisodeProgress },
  NotSaved: {},
  Unreadable: {},
})
export type StoredProgress = typeof StoredProgress.Type

/**
 * A Play pressed while library requests were in flight. `awaiting` holds the numbers of those requests that have
 * not answered yet. It starts by the `awaitedAfter` rule of the contract, so it plays from the newer of this
 * device's and the server's progress, and not from a position another device left. It holds the episode's id and
 * no Episode: the episode it plays is the one the library lists when it starts.
 */
export const PendingPlay = Schema.Struct({ episodeId: EpisodeId, awaiting: Schema.Array(Schema.Number) })
export type PendingPlay = typeof PendingPlay.Type

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
  /**
   * Goes up on every connection change: a token or server saved here or in another tab. Library
   * responses carry the generation they were fetched for; a response from an older one is dropped.
   */
  connectionGeneration: Schema.Number,
  /** Counts library requests. Each request carries its number, and its answer brings the number back. */
  libraryRequests: Schema.Number,
  /** The numbers of the library requests sent and not answered yet. */
  libraryRequestsInFlight: Schema.Array(Schema.Number),
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
  /** Counts type-ahead keys. A reset timer clears the typed text only for the latest key. */
  typeAheadKeys: Schema.Number,

  settingsDialog: Dialog.Model,
  settingsDraft: Connection,
  feed: Feed,
  /** Counts feed requests. Each Settings open and each connection change makes a new one; only the latest result shows. */
  feedRequests: Schema.Number,
  isFeedUrlCopied: Schema.Boolean,
  /** Counts the copies that showed Copied. A reset timer clears Copied only for its own copy. */
  feedUrlCopies: Schema.Number,

  playback: Playback,
  /**
   * Counts the user's playback actions: Play, Pause, skip, seek, chapter. A start reads storage first;
   * its result plays only if no later action came, so it is still the latest intent.
   */
  playIntents: Schema.Number,
  /** `Some` while a Play waits for the library. The next playback action of the user replaces it. */
  maybePendingPlay: Schema.Option(PendingPlay),
  rate: Schema.Number,
  /**
   * The device's progress by episode id, as this tab knows it: read from `fama.progress.<id>` at boot, then
   * each save of this tab and each server entry it adopted. Library loads merge it with the server's; a start
   * reads storage itself and falls back to this only when storage cannot be read.
   */
  localProgress: Schema.Record(Schema.String, EpisodeProgress),
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
  localProgress: Schema.Record(Schema.String, EpisodeProgress),
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

/** A Play of `episodeId` waits for the library. */
export const isPlayPending = (model: Model, episodeId: EpisodeId): boolean =>
  Option.exists(model.maybePendingPlay, (pending) => pending.episodeId === episodeId)

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

// MENUS

/** One menu item as it shows. `number` leads a chapter; `group` starts a new group with this heading. */
export interface PickerItem {
  readonly name: string
  readonly number?: number
  readonly group?: string
}

/** The text an item shows and its accessible name: `2 Evening` for a chapter. Type-ahead matches it. */
export const pickerItemText = (item: PickerItem): string =>
  item.number === undefined ? item.name : `${item.number} ${item.name}`

/** The items of a menu, in order. The view shows them and type-ahead searches them, so the two cannot differ. */
export const pickerItems = (model: Model, pickerId: PickerId): ReadonlyArray<PickerItem> => {
  switch (pickerId) {
    case "Voice": {
      const voices = sortedVoices(model.voices)
      return [
        { name: "Auto" },
        ...voices.map((voice, index) => {
          const language = languageName(voice.language)
          const previous = index === 0 ? undefined : languageName(voices[index - 1]!.language)
          return language === previous ? { name: voice.name } : { name: voice.name, group: language }
        }),
      ]
    }
    case "VoiceSpeed":
      return SPEEDS.map((speed) => ({ name: formatRate(speed) }))
    case "PlaybackSpeed":
      return RATES.map((rate) => ({ name: formatRate(rate) }))
    case "Chapters":
      return Option.match(current(model), {
        onNone: () => [],
        onSome: ({ episode }) => episode.chapters.map((chapter) => ({ name: chapter.title, number: chapter.index + 1 })),
      })
  }
}
