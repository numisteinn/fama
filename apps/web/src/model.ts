import { Episode, EpisodeId, EpisodeProgress, type JobState, Voice, VoiceRef } from "@fama/contracts"
import { Dialog } from "@foldkit/ui"
import { Option, Schema } from "effect"
import { defineTaggedUnion } from "foldkit/schema"
import { ApiFailure, ApiToken, Connection } from "~/api"
import { BatchFile, hasAttached } from "~/batch"
import { formatRate } from "~/lib/format"
import { NarrateAgain } from "~/review/narrateAgainModel"
import { Reader } from "~/reader/model"
import { Review } from "~/review/model"

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
 * A fact: what the audio element has. An episode plays as one timeline of its chapter files in order. `chapter` is
 * the file the element was told to load, and `offsetMs` the position inside it. Only `reconcile` in `update.ts`
 * tells the element anything, and it writes here what it told. The element's own events correct it.
 *
 * It holds no "ended" state. Whether the position is the end of the episode depends on the chapters and the job
 * the library lists, and those change. `playStart` of the contract decides it when a Play acts.
 */
export const Playback = defineTaggedUnion({
  Stopped: {},
  Loaded: {
    episodeId: EpisodeId,
    chapter: Schema.Number,
    offsetMs: Schema.Number,
    /** The media URL the element was told to load. A replacement URL loads again at the same place. */
    url: Schema.String,
    /** The element plays: it was told to, or it said so. */
    isPlaying: Schema.Boolean,
    /** A Play is on at the end of the chapters made so far: it goes on when the next chapter is listed. */
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
  /** Play or Pause was the last ask that acted. A Play that waits for the library has not acted: `maybePendingPlay`. */
  wantsPlay: Schema.Boolean,
  /** The Play has no place yet. `reconcile` places it by `playStart` of the contract, once. */
  isPlayDue: Schema.Boolean,
  /** A place on the episode timeline the listener asked for. `reconcile` moves the audio there and saves it, once. */
  maybeSeekMs: Schema.Option(Schema.Number),
  /**
   * The `updatedAt` of the device's entry that the player's place already follows. A device entry with another
   * stamp is news from another device: a player whose audio does not play moves there.
   */
  maybeFollowedAt: Schema.Option(Schema.String),
})
export type Listening = typeof Listening.Type

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
  /** Files of the add bar, in the order the user added them. */
  batch: Schema.Array(BatchFile),
  /** Counts attached files. Each file's key is its number. */
  batchKeys: Schema.Number,
  /** A link or text is being added. */
  isAdding: Schema.Boolean,
  maybeAddError: Schema.Option(Schema.String),
  /** `None` is Auto. */
  maybeVoice: Schema.Option(VoiceRef),
  speed: Schema.Number,
  /** Stop in Review after extraction for sources added now. Off by default. */
  isReviewOn: Schema.Boolean,
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

  /** Narrate-again edits of a Ready or Failed episode. */
  narrateAgain: NarrateAgain,
  /** Fact: what the audio element has. */
  playback: Playback,
  /** The text of the episode that plays, and whether it shows. */
  reader: Reader,
  /** Review of an episode waiting before narration. */
  review: Review,
  /** Intent: the episode the listener plays or paused. `None`: nothing is loaded. */
  maybeListening: Schema.Option(Listening),
  /**
   * Counts the user's playback actions: Play, Pause, skip, seek, chapter. A start reads storage first;
   * its result plays only if no later action came, so it is still the latest intent.
   */
  playIntents: Schema.Number,
  /** Intent: `Some` while a Play waits for the library. The next playback action of the user replaces it. */
  maybePendingPlay: Schema.Option(PendingPlay),
  rate: Schema.Number,
  /**
   * Fact: the device's progress by episode id, as this tab knows it: read from `fama.progress.<id>` at boot, then
   * each save of this tab and each server entry it adopted. Library loads merge it with the server's; a start
   * reads storage itself and falls back to this only when storage cannot be read.
   */
  localProgress: Schema.Record(Schema.String, EpisodeProgress),
  /**
   * Fact: positions a `SaveProgress` Command stamps now, by episode id. The stamp will be newer than every entry
   * the tab knows, so until it lands this is where the device holds the episode, and no server entry replaces it.
   */
  stamping: Schema.Record(Schema.String, Schema.Number),
  /** The page hid, or 5 s of playback passed: `reconcile` saves the listener's place now, once. */
  isSaveDue: Schema.Boolean,
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
  /** The attached files of the batch. */
  Files: {},
})
export type Draft = typeof Draft.Type

export const toDraft = (model: Model): Draft => {
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
