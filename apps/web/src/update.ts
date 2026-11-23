import {
  type Episode,
  type EpisodeId,
  type EpisodeProgress,
  type VoiceRef,
  awaitedAfter,
  mergeProgress,
  playStart,
} from "@fama/contracts"
import { Dialog } from "@foldkit/ui"
import { Option, Record, Redacted } from "effect"
import type { HttpClient } from "effect/http"
import { Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import { type Connection, apiToken, isSameConnection } from "~/api"
import { type AudioPlayer, LoadChapter, PauseAudio, PlayAudio, SeekAudio, SetAudioRate, StopAudio } from "~/audio"
import {
  CopyFeedUrl,
  CreateEpisodeFromSource,
  DeleteEpisode,
  FetchEpisodes,
  FetchFeed,
  FetchVoices,
  FocusAddText,
  FocusDeleteConfirm,
  FocusPicker,
  FocusPickerTrigger,
  PushProgress,
  ReadStoredProgress,
  RetryEpisode,
  SaveProgress,
  ScrollPickerItem,
  StoreConnection,
  StoreProgress,
  StoreSetting,
  UploadEpisode,
  WaitBeforeDisarmDelete,
  WaitBeforeResetCopied,
  WaitBeforeResetTypeAhead,
} from "~/command"
import { Message, type PlayerShortcut } from "~/message"
import {
  Draft,
  Feed,
  type Flags,
  type Listening,
  type LoadedPlayback,
  type Model,
  Picker,
  type PickerId,
  Playback,
  RATES,
  SAVE_EVERY_MS,
  SKIP_BACK_MS,
  SKIP_FORWARD_MS,
  SPEEDS,
  StoredProgress,
  current,
  episodes,
  isPlayPending,
  pickerItemText,
  pickerItems,
  selectedVoice,
  sortedVoices,
  toDraft,
} from "~/model"
import { chapterStartMs, locate, scrubTargetMs, totalMs } from "~/timeline"

export type Services = AudioPlayer | HttpClient.HttpClient
type UpdateReturn = Update.Return<Model, Message, Services>
type Step = Update.Step<Model, Message, Services>

const unchanged: Step = (model) => ({ model })

// INIT

export const init = (flags: Flags): UpdateReturn => {
  const connection = { origin: flags.origin, token: flags.token }
  const model: Model = {
    connection,
    connectionGeneration: 0,
    libraryRequests: 0,
    libraryRequestsInFlight: [],
    maybeEpisodes: Option.none(),
    maybeLibraryFailure: Option.none(),
    voices: [],
    addText: "",
    maybeAttachedFile: Option.none(),
    isAdding: false,
    maybeAddError: Option.none(),
    maybeVoice: Option.fromNullishOr(flags.voice),
    speed: flags.speed,
    fileDragDepth: 0,
    armedDeletes: [],
    rowErrors: {},
    picker: Picker.Closed(),
    typeAheadKeys: 0,
    settingsDialog: Dialog.init({ id: "settings" }),
    settingsDraft: connection,
    feed: Feed.Loading(),
    feedRequests: 0,
    isFeedUrlCopied: false,
    feedUrlCopies: 0,
    playback: Playback.Stopped(),
    maybeListening: Option.none(),
    playIntents: 0,
    maybePendingPlay: Option.none(),
    rate: flags.rate,
    localProgress: flags.localProgress,
    stamping: {},
    isSaveDue: false,
    lastSavedAtMs: 0,
    maybeScrubMs: Option.none(),
  }
  const library = fetchLibrary(model)
  return { model: library.model, commands: [library.command, FetchVoices({ connection }), FocusAddText()] }
}

// CONNECTION

/** A new library request for the current connection, tagged with its generation and its number, and in flight. */
const fetchLibrary = (model: Model): { model: Model; command: ReturnType<typeof FetchEpisodes> } => {
  const request = model.libraryRequests + 1
  return {
    model: modifyFields(model, {
      libraryRequests: () => request,
      libraryRequestsInFlight: (inFlight) => [...inFlight, request],
    }),
    command: FetchEpisodes({ connection: model.connection, generation: model.connectionGeneration, request }),
  }
}

/** A new feed request for the current connection. Results of earlier requests are dropped. */
const fetchFeed = (model: Model): { model: Model; command: ReturnType<typeof FetchFeed> } => {
  const next = modifyFields(model, { feedRequests: (requests) => requests + 1 })
  return { model: next, command: FetchFeed({ connection: next.connection, request: next.feedRequests }) }
}

/** Moves to `connection` as a new generation, so every response fetched before is dropped. */
const changeConnection = (model: Model, connection: Connection): Model =>
  modifyFields(model, { connection: () => connection, connectionGeneration: (generation) => generation + 1 })

/** A response fetched for the current connection generation. */
const isCurrent = (model: Model, generation: number) => generation === model.connectionGeneration

// SETTINGS DIALOG

const foldSettingsOutMessage = Dialog.OutMessage.match<Step>({
  Opened: () => (model) => {
    const feed = fetchFeed(
      modifyFields(model, {
        settingsDraft: () => model.connection,
        feed: () => Feed.Loading(),
        isFeedUrlCopied: () => false,
      }),
    )
    return { model: feed.model, commands: [feed.command] }
  },
  Closed: () => unchanged,
})

const settingsFold = {
  read: (model: Model) => Option.some(model.settingsDialog),
  write: (model: Model, nextSettingsDialog: Dialog.Model) =>
    modifyFields(model, { settingsDialog: () => nextSettingsDialog }),
  toParentMessage: (message: Dialog.Message) => Message.GotSettingsDialogMessage({ message }),
  foldOutMessage: foldSettingsOutMessage,
}

const foldSettingsDialog = Update.foldChild({ update: Dialog.update, ...settingsFold })
const openSettings: Step = Update.foldChildStep({ update: Dialog.open, ...settingsFold })
const closeSettings: Step = Update.foldChildStep({ update: Dialog.close, ...settingsFold })

/** Saves the token and server and closes the dialog. A changed connection refetches; a new 401 opens it again. */
const saveSettings: Step = (model) => {
  const connection = {
    token: apiToken(Redacted.value(model.settingsDraft.token).trim()),
    origin: model.settingsDraft.origin.trim().replace(/\/+$/, ""),
  }
  const isChanged =
    Redacted.value(connection.token) !== Redacted.value(model.connection.token) ||
    connection.origin !== model.connection.origin
  return Update.combine(model, [
    (stepModel) => {
      if (!isChanged) return { model: stepModel, commands: [StoreConnection({ connection })] }
      const feed = fetchFeed(changeConnection(stepModel, connection))
      const library = fetchLibrary(feed.model)
      return { model: library.model, commands: [StoreConnection({ connection }), library.command, feed.command] }
    },
    closeSettings,
  ])
}

/** Shows a feed result, unless a later feed request was made. */
const setFeed = (request: number, feed: Feed): Step => (model) =>
  request === model.feedRequests ? { model: modifyFields(model, { feed: () => feed }) } : { model }

/** Follows a token or server saved in another tab, as the React app did: the library and an open feed refetch. */
const followStoredConnection = (connection: Connection): Step => (model) => {
  if (isSameConnection(connection, model.connection)) return { model }
  const isFeedShown = model.settingsDialog.isOpen
  const library = fetchLibrary(changeConnection(model, connection))
  if (!isFeedShown) return { model: library.model, commands: [library.command] }
  const feed = fetchFeed(modifyFields(library.model, { feed: () => Feed.Loading() }))
  return { model: feed.model, commands: [library.command, feed.command] }
}

/**
 * Follows settings saved in another tab, as the React app did. The add bar takes the Voice and Voice speed,
 * and a new Playback speed applies to the audio now.
 */
const followStoredSettings =
  (settings: { connection: Connection; maybeVoice: Option.Option<VoiceRef>; speed: number; rate: number }): Step =>
  (model) =>
    Update.combine(model, [
      followStoredConnection(settings.connection),
      (stepModel) => ({
        model: modifyFields(stepModel, {
          maybeVoice: () => settings.maybeVoice,
          speed: () => settings.speed,
          rate: () => settings.rate,
        }),
        commands: settings.rate === stepModel.rate ? [] : [SetAudioRate({ rate: settings.rate })],
      }),
    ])

// LIBRARY

const fetchEpisodes: Step = (model) => {
  const library = fetchLibrary(model)
  return { model: library.model, commands: [library.command] }
}

/** Library request `request` answered: it is no longer in flight. */
const answerLibrary = (model: Model, request: number): Model =>
  modifyFields(model, { libraryRequestsInFlight: (inFlight) => inFlight.filter((sent) => sent !== request) })

/** Replaces the episode list. It is a fact: `reconcile` applies the playback rules that depend on it. */
const withEpisodes =
  (toEpisodes: (list: ReadonlyArray<Episode>) => ReadonlyArray<Episode>): Step =>
  (model) => ({ model: modifyFields(model, { maybeEpisodes: () => Option.some(toEpisodes(episodes(model))) }) })

const forgetRow = (episodeId: EpisodeId): Step => (model) => ({
  model: modifyFields(model, {
    armedDeletes: (ids) => ids.filter((id) => id !== episodeId),
    rowErrors: Record.remove(episodeId),
  }),
})

const setRowError = (episodeId: EpisodeId, message: string): Step => (model) => ({
  model: modifyFields(model, { rowErrors: Record.set(episodeId, message) }),
})

// ADD BAR

const submitAdd: Step = (model) => {
  const draft = toDraft(model)
  if (draft._tag === "Empty" || model.isAdding) return { model }
  const { connection, speed } = model
  const voice = Option.getOrNull(model.maybeVoice)
  const command = Draft.match(draft, {
    Empty: () => undefined,
    Url: ({ url }) => CreateEpisodeFromSource({ connection, input: { source: { _tag: "Url", url }, voice, speed } }),
    Text: ({ text }) =>
      CreateEpisodeFromSource({ connection, input: { source: { _tag: "Text", title: null, text }, voice, speed } }),
    File: ({ file }) => UploadEpisode({ connection, file, voice, speed }),
  })
  return {
    model: modifyFields(model, { isAdding: () => true, maybeAddError: () => Option.none() }),
    commands: command ? [command] : [],
  }
}

// MENUS

/** The text of each item in a menu, in order, as the menu shows it. Type-ahead matches against it. */
const pickerItemTexts = (model: Model, pickerId: PickerId): ReadonlyArray<string> =>
  pickerItems(model, pickerId).map(pickerItemText)

const pickerItemCount = (model: Model, pickerId: PickerId): number => pickerItems(model, pickerId).length

/** A single printable character, as the menus' type-ahead takes it. */
export const isTypeAheadKey = (key: string): boolean => key.length === 1 && key !== " "

/** The first item from `start` on whose text starts with `prefix`, wrapping around. */
const findPrefix = (texts: ReadonlyArray<string>, start: number, prefix: string): Option.Option<number> => {
  const needle = prefix.toLocaleLowerCase()
  for (let step = 0; step < texts.length; step++) {
    const index = (((start + step) % texts.length) + texts.length) % texts.length
    if (texts[index]?.toLocaleLowerCase().startsWith(needle)) return Option.some(index)
  }
  return Option.none()
}

/** No item starts with a doubled letter (`Llama`), so a repeated letter may cycle, as base-ui decides. */
const canCycle = (texts: ReadonlyArray<string>): boolean =>
  texts.every((text) => !text || text[0]?.toLocaleLowerCase() !== text[1]?.toLocaleLowerCase())

/**
 * Type-ahead, ported from base-ui's `useTypeahead`. Keys typed within 750 ms make one prefix, searched
 * after the item that was highlighted when it started: `S`, `t`, `e` goes to Steinn. The same letter
 * again starts a one-letter prefix after the last match, so it cycles, and the next key extends that
 * prefix: `s`, `s`, `k` goes to Sky. Unlike base-ui, `s` then `S` also counts as the same letter.
 * A key with no match clears the prefix, so the next key starts a new search; a Space with no match
 * keeps it.
 */
const typeAhead = (key: string): Step => (model) => {
  if (model.picker._tag === "Closed") return { model }
  const open = model.picker
  const keys = model.typeAheadKeys + 1
  const texts = pickerItemTexts(model, open.pickerId)
  const active = Option.getOrElse(open.maybeActiveIndex, () => -1)
  const isNewPrefix = open.typedText === ""
  const isCycle = open.typedText.toLocaleLowerCase() === key.toLocaleLowerCase() && canCycle(texts)
  const from = isNewPrefix || isCycle ? active : open.typeAheadFrom
  const typedText = (isCycle ? "" : open.typedText) + key
  const maybeMatch = findPrefix(texts, from + 1, typedText)
  const nextTypedText = Option.isSome(maybeMatch) || key === " " ? typedText : ""
  return {
    model: modifyFields(model, {
      picker: () =>
        Picker.Open({
          ...open,
          typedText: nextTypedText,
          typeAheadFrom: from,
          maybeActiveIndex: Option.orElse(maybeMatch, () => open.maybeActiveIndex),
        }),
      typeAheadKeys: () => keys,
    }),
    commands: [
      ...(nextTypedText === "" ? [] : [WaitBeforeResetTypeAhead({ keys })]),
      ...Option.toArray(Option.map(maybeMatch, (index) => ScrollPickerItem({ pickerId: open.pickerId, index }))),
    ],
  }
}

const resetTypeAhead = (keys: number): Step => (model) => {
  const picker = model.picker
  if (picker._tag === "Closed" || keys !== model.typeAheadKeys) return { model }
  return { model: modifyFields(model, { picker: () => Picker.Open({ ...picker, typedText: "" }) }) }
}

/** The index of the checked item in a menu. */
export const pickerCheckedIndex = (model: Model, pickerId: PickerId): number => {
  switch (pickerId) {
    case "Voice":
      return Option.match(selectedVoice(model), {
        onNone: () => 0,
        onSome: (voice) => sortedVoices(model.voices).findIndex((item) => item.id === voice.id) + 1,
      })
    case "VoiceSpeed":
      return SPEEDS.findIndex((value) => value === model.speed)
    case "PlaybackSpeed":
      return RATES.findIndex((value) => value === model.rate)
    case "Chapters":
      return model.playback._tag === "Loaded" ? model.playback.chapter : -1
  }
}

const openPicker =
  (pickerId: PickerId, maybeActiveIndex: Option.Option<number>): Step =>
  (model) => ({
    model: modifyFields(model, {
      picker: () => Picker.Open({ pickerId, maybeActiveIndex, typedText: "", typeAheadFrom: -1 }),
    }),
    commands: [
      FocusPicker({ pickerId }),
      ...Option.toArray(Option.map(maybeActiveIndex, (index) => ScrollPickerItem({ pickerId, index }))),
    ],
  })

const closePicker =
  (isFocusReturned: boolean): Step =>
  (model) => {
    if (model.picker._tag === "Closed") return { model }
    const { pickerId } = model.picker
    return {
      model: modifyFields(model, { picker: () => Picker.Closed() }),
      commands: isFocusReturned ? [FocusPickerTrigger({ pickerId })] : [],
    }
  }

const startIndex = (model: Model, pickerId: PickerId, fallback: number): number => {
  const checked = pickerCheckedIndex(model, pickerId)
  return checked >= 0 ? checked : fallback
}

const pressPickerTriggerKey = (pickerId: PickerId, key: string): Step => (model) => {
  const count = pickerItemCount(model, pickerId)
  if (count === 0) return { model }
  if (key === "ArrowDown") return openPicker(pickerId, Option.some(startIndex(model, pickerId, 0)))(model)
  if (key === "ArrowUp") return openPicker(pickerId, Option.some(startIndex(model, pickerId, count - 1)))(model)
  return { model }
}

const activate = (pickerId: PickerId, index: number): Step => (model) => ({
  model: modifyFields(model, {
    picker: (picker) =>
      picker._tag === "Open"
        ? Picker.Open({ ...picker, pickerId, maybeActiveIndex: Option.some(index) })
        : Picker.Open({ pickerId, maybeActiveIndex: Option.some(index), typedText: "", typeAheadFrom: -1 }),
  }),
  commands: [ScrollPickerItem({ pickerId, index })],
})

const pressPickerKey = (key: string): Step => (model) => {
  if (model.picker._tag === "Closed") return { model }
  const { pickerId, maybeActiveIndex, typedText } = model.picker
  const count = pickerItemCount(model, pickerId)
  const selectActive: Step = Option.match(maybeActiveIndex, {
    onNone: () => unchanged,
    onSome: (index) => selectPickerItem(pickerId, index),
  })
  if (key === "Escape" || key === "Tab") return closePicker(true)(model)
  if (count === 0) return { model }
  const from = Option.getOrElse(maybeActiveIndex, () => -1)
  switch (key) {
    case "ArrowDown":
      return activate(pickerId, from < 0 ? startIndex(model, pickerId, 0) : (from + 1) % count)(model)
    case "ArrowUp":
      return activate(pickerId, from < 0 ? startIndex(model, pickerId, count - 1) : (from - 1 + count) % count)(model)
    case "Home":
      return activate(pickerId, 0)(model)
    case "End":
      return activate(pickerId, count - 1)(model)
    case "Enter":
      return selectActive(model)
    case " ":
      // Inside a typed prefix, Space is part of the search (`The E`), as in base-ui.
      return typedText === "" ? selectActive(model) : typeAhead(key)(model)
    default:
      return isTypeAheadKey(key) ? typeAhead(key)(model) : { model }
  }
}

const selectPickerItem = (pickerId: PickerId, index: number): Step =>
  Update.combine([closePicker(true), applyPickerItem(pickerId, index)])

const applyPickerItem = (pickerId: PickerId, index: number): Step => (model) => {
  switch (pickerId) {
    case "Voice": {
      const maybeVoice = index === 0 ? Option.none() : Option.fromNullishOr(sortedVoices(model.voices)[index - 1])
      const maybeVoiceRef = Option.map(maybeVoice, (voice) => voice.id)
      return {
        model: modifyFields(model, { maybeVoice: () => maybeVoiceRef }),
        commands: [StoreSetting({ key: "fama.voice", value: Option.getOrNull(maybeVoiceRef) })],
      }
    }
    case "VoiceSpeed": {
      const speed = SPEEDS[index]
      if (speed === undefined) return { model }
      return {
        model: modifyFields(model, { speed: () => speed }),
        commands: [StoreSetting({ key: "fama.speed", value: speed })],
      }
    }
    case "PlaybackSpeed": {
      const rate = RATES[index]
      if (rate === undefined) return { model }
      return {
        model: modifyFields(model, { rate: () => rate }),
        commands: [StoreSetting({ key: "fama.rate", value: rate }), SetAudioRate({ rate })],
      }
    }
    case "Chapters":
      return playChapter(index)(model)
  }
}

// PLAYER
//
// Playback and progress sync have one shape. The Model holds intent (`maybeListening`, `maybePendingPlay`) and
// facts (`playback`, `localProgress`, `stamping`, the library). The steps of this section only change intent and
// facts. `reconcile` runs after every Message. It alone works out what the audio must do, tells the element so
// with at most one audio Command, and stamps at most one position. So no order of Messages can make two steps
// move, start or stamp against each other.

const globalMs = (playback: LoadedPlayback, episode: Episode) =>
  chapterStartMs(episode.chapters, playback.chapter) + playback.offsetMs

const withLoaded =
  (toStep: (loaded: { playback: LoadedPlayback; episode: Episode }) => Step): Step =>
  (model) =>
    Option.match(current(model), { onNone: () => ({ model }), onSome: (loaded) => toStep(loaded)(model) })

/** A fact from the audio element. */
const setPlayback =
  (fields: Partial<Omit<LoadedPlayback, "_tag">>): Step =>
  (model) => {
    const playback = model.playback
    if (playback._tag !== "Loaded") return { model }
    return { model: modifyFields(model, { playback: () => Playback.Loaded({ ...playback, ...fields }) }) }
  }

/** What the listener asks of the episode they listen to. */
const setListening =
  (fields: Partial<Listening>): Step =>
  (model) => ({
    model: modifyFields(model, { maybeListening: Option.map((listening) => ({ ...listening, ...fields })) }),
  })

const isListeningTo = (model: Model, episodeId: EpisodeId) =>
  Option.exists(model.maybeListening, (listening) => listening.episodeId === episodeId)

const isSameProgress = (a: EpisodeProgress, b: EpisodeProgress) =>
  a.positionMs === b.positionMs && a.updatedAt === b.updatedAt

/** Where the device holds an episode: the position a save stamps now, else its entry. */
const heldMs = (model: Model, episodeId: EpisodeId): number | undefined =>
  model.stamping[episodeId] ?? model.localProgress[episodeId]?.positionMs

// Facts

/** Shows `progress` as the server's on the episode in the list. */
const setServerProgress = (episodeId: EpisodeId, progress: EpisodeProgress): Step => (model) => ({
  model: modifyFields(model, {
    maybeEpisodes: Option.map((list) => list.map((item) => (item.id === episodeId ? { ...item, progress } : item))),
  }),
})

/**
 * Takes an entry of the server or of storage as the device's, with its stamp, so it never counts as a new listener
 * action. It moves nothing: `reconcile` sees an entry the player does not follow yet.
 */
const takeEntry = (episodeId: EpisodeId, progress: EpisodeProgress): Step => (model) => {
  const local = model.localProgress[episodeId]
  if (local && isSameProgress(local, progress)) return { model }
  return {
    model: modifyFields(model, { localProgress: Record.set(episodeId, progress) }),
    commands: [StoreProgress({ episodeId, progress })],
  }
}

/**
 * A save stamped and stored: the tab now knows it, and sends it. The stamp is the listener's own, so the player
 * follows it already.
 */
const takeStamp = (episodeId: EpisodeId, progress: EpisodeProgress): Step => (model) => ({
  model: modifyFields(model, {
    localProgress: Record.set(episodeId, progress),
    stamping: (stamping) => (stamping[episodeId] === progress.positionMs ? Record.remove(stamping, episodeId) : stamping),
    maybeListening: Option.map((listening) =>
      listening.episodeId === episodeId ? { ...listening, maybeFollowedAt: Option.some(progress.updatedAt) } : listening,
    ),
  }),
  commands: [PushProgress({ connection: model.connection, episodeId, progress })],
})

/**
 * The server answered a push with what it stores. The device takes that answer, a clamped stamp included, unless
 * the listener saved again since: that newer save goes out with its own push. The same position with the server's
 * stamp is still the listener's own entry. Another position is news from another device.
 */
const takePushAnswer = (episodeId: EpisodeId, sent: EpisodeProgress, stored: EpisodeProgress): Step => (model) => {
  const local = model.localProgress[episodeId]
  const isLatest = local !== undefined && isSameProgress(local, sent)
  const isOwn = stored.positionMs === sent.positionMs
  return Update.combine(model, [
    setServerProgress(episodeId, stored),
    isLatest ? takeEntry(episodeId, stored) : unchanged,
    isLatest && isOwn
      ? (stepModel) => ({
          model: modifyFields(stepModel, {
            maybeListening: Option.map((listening) =>
              listening.episodeId === episodeId && Option.contains(listening.maybeFollowedAt, sent.updatedAt)
                ? { ...listening, maybeFollowedAt: Option.some(stored.updatedAt) }
                : listening,
            ),
          }),
        })
      : unchanged,
  ])
}

/**
 * After a library load: each local entry newer than the server's is sent, so listening done offline syncs, and
 * each newer server entry is taken. Nothing is stamped. An episode whose save is being stamped is left alone: that
 * stamp is newer than both, and goes out when it lands.
 */
const syncProgress: Step = (model) =>
  Update.combine(
    model,
    episodes(model).map((episode): Step => (stepModel) => {
      if (stepModel.stamping[episode.id] !== undefined) return { model: stepModel }
      const local = stepModel.localProgress[episode.id] ?? null
      const { progress, isPushed } = mergeProgress(local, episode.progress)
      if (isPushed && local !== null) {
        return {
          model: stepModel,
          commands: [PushProgress({ connection: stepModel.connection, episodeId: episode.id, progress: local })],
        }
      }
      return progress === null ? { model: stepModel } : takeEntry(episode.id, progress)(stepModel)
    }),
  )

/** The audio of the current chapter ended. The element rests at the listed end of that chapter. */
const endChapter: Step = withLoaded(({ playback, episode }) => {
  const chapter = episode.chapters[playback.chapter]
  return setPlayback({ ...(chapter ? { offsetMs: chapter.durationMs } : {}), isPlaying: false })
})

/** The element says where it is. Only audio that plays moves: a resting element is where the tab put it. */
const updateAudioTime = (offsetMs: number, atMs: number): Step => (model) => {
  const playback = model.playback
  const timed =
    playback._tag === "Loaded" && playback.isPlaying
      ? modifyFields(model, { playback: () => Playback.Loaded({ ...playback, offsetMs }) })
      : model
  return atMs - model.lastSavedAtMs < SAVE_EVERY_MS
    ? { model: timed }
    : { model: modifyFields(timed, { lastSavedAtMs: () => atMs, isSaveDue: () => true }) }
}

// Intent

/**
 * A playback action of the user. A start still reading storage is no longer the latest intent, and a Play that
 * waits for the library is off.
 */
const intend =
  (step: Step): Step =>
  (model) =>
    step(modifyFields(model, { playIntents: (count) => count + 1, maybePendingPlay: () => Option.none() }))

/** Reads the progress storage holds for an episode, to play it from there. The read carries the latest intent. */
const readThenPlay =
  (episodeId: EpisodeId): Step =>
  (model) => ({ model, commands: [ReadStoredProgress({ episodeId, intent: model.playIntents })] })

/**
 * A Play acts. The episode the listener listens to gets a Play to place. Another episode reads its progress from
 * storage first, as the React app did, so a pause in another tab is where it resumes.
 */
const actPlay = (episodeId: EpisodeId): Step => (model) =>
  isListeningTo(model, episodeId)
    ? setListening({ wantsPlay: true, isPlayDue: true })(model)
    : episodes(model).some((item) => item.id === episodeId && item.chapters.length > 0)
      ? readThenPlay(episodeId)(model)
      : { model }

/**
 * The listener asks for playback. While library requests are in flight, the Play waits for them and acts when
 * `settlePendingPlay` says so: the library may hold a newer position from another device, and a Play from the old
 * one would stamp it over that. A second Play of the same episode does not wait again, so a slow request never
 * leaves Play dead.
 */
const askPlay = (episodeId: EpisodeId): Step => (model) =>
  model.libraryRequestsInFlight.length > 0 && !isPlayPending(model, episodeId)
    ? intend((held) => ({
        model: modifyFields(held, {
          maybePendingPlay: () => Option.some({ episodeId, awaiting: held.libraryRequestsInFlight }),
        }),
      }))(model)
    : intend(actPlay(episodeId))(model)

/** The listener asks for no playback: of audio that plays, and of a Play that waits for the next chapter. */
const askPause: Step = intend(setListening({ wantsPlay: false, isPlayDue: false }))

/** A Pause while a Play waits for the library: the Play is off. */
const cancelPlay: Step = (model) => (Option.isSome(model.maybePendingPlay) ? intend(unchanged)(model) : { model })

const wantsPlay = (model: Model) => Option.exists(model.maybeListening, (listening) => listening.wantsPlay)

const toggle: Step = (model) =>
  Option.match(model.maybeListening, {
    onNone: () => ({ model }),
    onSome: ({ episodeId }) => (wantsPlay(model) ? askPause(model) : askPlay(episodeId)(model)),
  })

/** Toggles `episode` when the listener listens to it. Otherwise asks for its playback. */
const start =
  (episode: Episode): Step =>
  (model) => {
    if (isListeningTo(model, episode.id)) return toggle(model)
    if (episode.chapters.length === 0) return { model }
    return askPlay(episode.id)(model)
  }

/**
 * Library request `request` answered: `isListed` says it brought a list the tab takes. A Play waits for the
 * requests that were in flight when it was pressed, by number (`awaitedAfter` of the contract). When none is left,
 * the Play acts, on what the device knows now. The failure of a request sent later, a poll for example, does not
 * start it.
 */
const settlePendingPlay = (request: number, isListed: boolean): Step => (model) =>
  Option.match(model.maybePendingPlay, {
    onNone: () => ({ model }),
    onSome: ({ episodeId, awaiting }) => {
      const stillAwaiting = awaitedAfter(awaiting, request, isListed)
      return stillAwaiting.length > 0
        ? { model: modifyFields(model, { maybePendingPlay: () => Option.some({ episodeId, awaiting: stillAwaiting }) }) }
        : actPlay(episodeId)(modifyFields(model, { maybePendingPlay: () => Option.none() }))
    },
  })

/**
 * The storage read of a start came back. The device's entry is the newer of what storage holds and the server's;
 * with neither, it has none. Only when storage cannot be read is the entry this tab knows used. Then the listener
 * listens to this episode, with a Play to place. A result whose start is no longer the latest playback intent is
 * dropped: a later Pause, Play or seek wins.
 */
const startFromStored =
  (episodeId: EpisodeId, intent: number, stored: StoredProgress): Step =>
  (model) => {
    if (intent !== model.playIntents) return { model }
    const episode = episodes(model).find((item) => item.id === episodeId)
    if (!episode || episode.chapters.length === 0 || isListeningTo(model, episodeId)) return { model }
    const local = StoredProgress.match(stored, {
      Saved: ({ progress }) => progress,
      NotSaved: () => null,
      Unreadable: () => model.localProgress[episodeId] ?? null,
    })
    const { progress } = mergeProgress(local, episode.progress)
    // Storage is the truth for this device: an entry gone from it (site data cleared) is gone here too.
    const known: Step =
      progress !== null
        ? takeEntry(episodeId, progress)
        : (stepModel) => ({ model: modifyFields(stepModel, { localProgress: Record.remove(episodeId) }) })
    return Update.combine(model, [
      known,
      (stepModel) => ({
        model: modifyFields(stepModel, {
          maybeListening: () =>
            Option.some({
              episodeId,
              wantsPlay: true,
              isPlayDue: true,
              maybeSeekMs: Option.none(),
              maybeFollowedAt: Option.none(),
            }),
        }),
      }),
    ])
  }

/** The listener moves to `ms` on the episode timeline. `reconcile` moves the audio there and saves the place. */
const seek = (ms: number): Step => withLoaded(() => intend(setListening({ maybeSeekMs: Option.some(ms) })))

const skip = (deltaMs: number): Step =>
  withLoaded(({ playback, episode }) => seek(globalMs(playback, episode) + deltaMs))

/** The listener picks a chapter: a move to its start, and playback from there. */
const playChapter = (index: number): Step =>
  withLoaded(({ episode }) =>
    episode.chapters[index]
      ? intend(
          setListening({
            maybeSeekMs: Option.some(chapterStartMs(episode.chapters, index)),
            wantsPlay: true,
            isPlayDue: false,
          }),
        )
      : unchanged,
  )

/** The element stopped though the tab did not tell it to: that is a Pause of the listener. */
const takeOwnPause: Step = (model) =>
  model.playback._tag === "Loaded" && model.playback.isPlaying
    ? setListening({ wantsPlay: false, isPlayDue: false })(model)
    : { model }

const shortcut = (name: PlayerShortcut): Step => {
  switch (name) {
    case "Toggle":
      return toggle
    case "Back":
      return skip(-SKIP_BACK_MS)
    case "Forward":
      return skip(SKIP_FORWARD_MS)
  }
}

// RECONCILE

const isSamePlayback = (a: Playback, b: Playback) =>
  a._tag === "Stopped" || b._tag === "Stopped"
    ? a._tag === b._tag
    : a.episodeId === b.episodeId &&
      a.chapter === b.chapter &&
      a.offsetMs === b.offsetMs &&
      a.isPlaying === b.isPlaying &&
      a.isWaiting === b.isWaiting

const isSameListening = (a: Listening, b: Listening) =>
  a.episodeId === b.episodeId &&
  a.wantsPlay === b.wantsPlay &&
  a.isPlayDue === b.isPlayDue &&
  Option.getOrNull(a.maybeSeekMs) === Option.getOrNull(b.maybeSeekMs) &&
  Option.getOrNull(a.maybeFollowedAt) === Option.getOrNull(b.maybeFollowedAt)

/** Nothing is listened to, or the episode is gone from the library: the audio stops. */
const stopPlayback: Step = (model) => {
  if (model.playback._tag === "Stopped" && Option.isNone(model.maybeListening)) {
    return model.isSaveDue ? { model: modifyFields(model, { isSaveDue: () => false }) } : { model }
  }
  return {
    model: modifyFields(model, {
      playback: () => Playback.Stopped(),
      maybeListening: () => Option.none(),
      isSaveDue: () => false,
      maybeScrubMs: () => Option.none(),
      picker: (picker) => (picker._tag === "Open" && picker.pickerId === "Chapters" ? Picker.Closed() : picker),
    }),
    commands: model.playback._tag === "Loaded" ? [StopAudio()] : [],
  }
}

/**
 * The one step that decides playback. It runs after every Message, on the Model alone. From the intent and the
 * facts it works out the target (the episode, the chapter, the offset, and playing, paused or waiting), compares
 * it with what the audio element has, and returns at most one audio Command and at most one save.
 *
 * Where the listener is:
 *
 * - a seek puts them where they asked;
 * - audio that plays what they asked for leads: a newer entry of another device does not move it;
 * - a player whose audio does not play (paused, held for the library, waiting for a chapter) moves to a device
 *   entry it does not follow yet. That is each newer entry of the server or of storage. So listening never goes
 *   on, and nothing is stamped, from a place another device moved on from. An entry past the end of the listed
 *   audio is followed only when a later list has that audio;
 * - else they are where the audio rests.
 *
 * What the audio does there, by `playStart` of the contract on the chapters and the job the library lists now:
 *
 * - a Play that has no place yet (pressed, released by the library, or moved to a newer entry) starts at 0 on a
 *   finished position, waits at the end of the chapters of a job that still works, and plays every other place;
 * - a Play that ran out of audio (a chapter ended, or it waits) plays the audio listed from there on, waits while
 *   the job still works, and is over when the job ended: that was the end of the episode;
 * - with no Play, the audio rests.
 *
 * What is stamped: the place of an episode the listener left, a seek, the end of the episode, a pause, and the
 * place every 5 s and when the page hides. A place the device already holds is not stamped again. A player that
 * moved to a newer entry stamps nothing, and neither does one whose Play waits for the library.
 */
const reconcile: Step = (model) => {
  const maybeEpisode = Option.flatMap(model.maybeListening, (listening) =>
    Option.fromNullishOr(episodes(model).find((item) => item.id === listening.episodeId)),
  )
  if (Option.isNone(model.maybeListening) || Option.isNone(maybeEpisode)) return stopPlayback(model)
  const listening = model.maybeListening.value
  const episode = maybeEpisode.value
  const { chapters, job } = episode
  const lengthMs = totalMs(chapters)
  const playback = model.playback
  /** What the element has of this episode, and of the episode the listener left. */
  const here = playback._tag === "Loaded" && playback.episodeId === episode.id ? playback : undefined
  const left = playback._tag === "Loaded" && playback.episodeId !== episode.id ? playback : undefined
  const heardMs = here ? globalMs(here, episode) : undefined
  const entry = model.localProgress[episode.id]
  const isStamping = model.stamping[episode.id] !== undefined
  const maybeSeekMs = Option.map(listening.maybeSeekMs, (ms) => Math.min(Math.max(0, ms), lengthMs))
  const isSeek = Option.isSome(maybeSeekMs)
  /** The audio plays what the listener asked for. */
  const isOn = here !== undefined && here.isPlaying && listening.wantsPlay && !listening.isPlayDue

  // Where the listener is.
  const hasNews = !isStamping && entry !== undefined && !Option.contains(listening.maybeFollowedAt, entry.updatedAt)
  const isMovedToEntry = !isSeek && !isOn && heardMs !== undefined && hasNews
  const positionMs = Option.getOrElse(maybeSeekMs, () =>
    heardMs === undefined ? (heldMs(model, episode.id) ?? 0) : isMovedToEntry && entry ? entry.positionMs : heardMs,
  )
  // An entry past the end of the listed audio cannot be reached yet: the audio rests at that end, and the player
  // keeps moving to the entry as the list grows. Listening and a seek are the listener's own place: they follow.
  const isReached = isOn || isSeek || entry === undefined || entry.positionMs <= lengthMs
  const maybeFollowedAt = isStamping || !isReached ? listening.maybeFollowedAt : Option.fromNullishOr(entry?.updatedAt)

  // What the audio does there.
  const start = playStart(positionMs, chapters, job)
  const isStart = listening.isPlayDue || (listening.wantsPlay && isMovedToEntry)
  const isOver = listening.wantsPlay && !(isOn && !isSeek) && !start.isWaiting && !isStart && positionMs >= lengthMs
  const mode: "Playing" | "Waiting" | "Paused" =
    !listening.wantsPlay || isOver ? "Paused" : isOn && !isSeek ? "Playing" : start.isWaiting ? "Waiting" : "Playing"
  const placeMs = mode === "Playing" && isStart ? start.positionMs : positionMs

  // Where the audio must be. Audio that rests, waits or plays on stays in its place: only a reason moves it.
  const isPlaced = here === undefined || isSeek || isMovedToEntry || (mode === "Playing" && !(isOn && !isSeek))
  const target = isPlaced || here === undefined ? locate(chapters, placeMs) : { index: here.chapter, offsetMs: here.offsetMs }
  /** The file to load. Audio that stays in its place has its file already, also when a late list no longer has it. */
  const file = chapters[target.index]
  const hasFile = isPlaced ? file !== undefined : true
  const isPlaying = mode === "Playing" && hasFile

  // At most one audio Command, and it is absolute.
  const load = (chapter: { readonly url: string }) =>
    LoadChapter({ src: model.connection.origin + chapter.url, offsetMs: target.offsetMs, rate: model.rate, isAutoplay: isPlaying })
  const audio =
    file === undefined || !isPlaced
      ? here !== undefined && here.isPlaying !== isPlaying && hasFile
        ? [isPlaying ? PlayAudio() : PauseAudio()]
        : here?.isPlaying && !hasFile
          ? [PauseAudio()]
          : []
      : here === undefined || here.chapter !== target.index
        ? [load(file)]
        : Math.abs(here.offsetMs - target.offsetMs) >= 1
          ? [isPlaying === here.isPlaying && !isStart ? SeekAudio({ offsetMs: target.offsetMs }) : load(file)]
          : isPlaying === here.isPlaying
            ? []
            : [isPlaying ? PlayAudio() : PauseAudio()]

  // At most one save.
  const isNew = (episodeId: EpisodeId, ms: number) => heldMs(model, episodeId) !== Math.max(0, Math.round(ms))
  const leftEpisode = left ? episodes(model).find((item) => item.id === left.episodeId) : undefined
  const leftShortOfEntry =
    left && leftEpisode && !left.isPlaying && (heldMs(model, left.episodeId) ?? 0) > totalMs(leftEpisode.chapters)
  const isPaused = here !== undefined && here.isPlaying && !isPlaying
  const save: { readonly episodeId: EpisodeId; readonly positionMs: number } | undefined =
    left && leftEpisode && !leftShortOfEntry
      ? { episodeId: left.episodeId, positionMs: globalMs(left, leftEpisode) }
      : isSeek
        ? { episodeId: episode.id, positionMs }
        : isOver
          ? { episodeId: episode.id, positionMs: lengthMs }
          : heardMs !== undefined && !isMovedToEntry && !isPlayPending(model, episode.id) && (model.isSaveDue || isPaused)
            ? { episodeId: episode.id, positionMs: heardMs }
            : undefined
  const stamp = save && isNew(save.episodeId, save.positionMs) ? save : undefined

  const nextPlayback =
    !hasFile && here === undefined
      ? playback
      : Playback.Loaded({
          episodeId: episode.id,
          chapter: target.index,
          offsetMs: target.offsetMs,
          isPlaying,
          isWaiting: mode === "Waiting",
        })
  const nextListening: Listening = {
    episodeId: episode.id,
    wantsPlay: listening.wantsPlay && !isOver,
    isPlayDue: false,
    maybeSeekMs: Option.none(),
    maybeFollowedAt,
  }
  const isUnchanged =
    isSamePlayback(playback, nextPlayback) && isSameListening(listening, nextListening) && !model.isSaveDue && !stamp
  return {
    model: isUnchanged
      ? model
      : modifyFields(model, {
          playback: () => (isSamePlayback(playback, nextPlayback) ? playback : nextPlayback),
          maybeListening: () => (isSameListening(listening, nextListening) ? model.maybeListening : Option.some(nextListening)),
          isSaveDue: () => false,
          stamping: (stamping) =>
            stamp ? Record.set(stamping, stamp.episodeId, Math.max(0, Math.round(stamp.positionMs))) : stamping,
        }),
    commands: [...(stamp ? [SaveProgress(stamp)] : []), ...audio],
  }
}

// UPDATE

/** Changes intent and facts for `message`. It sends no audio Command and stamps nothing: `reconcile` does. */
const handle = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    SucceededFetchEpisodes: ({ generation, request, episodes: list }) => {
      const isListed = isCurrent(model, generation)
      const answered = answerLibrary(model, request)
      return isListed
        ? Update.combine(modifyFields(answered, { maybeLibraryFailure: () => Option.none() }), [
            withEpisodes(() => list),
            syncProgress,
            settlePendingPlay(request, true),
          ])
        : settlePendingPlay(request, false)(answered)
    },
    FailedFetchEpisodes: ({ generation, request, failure }) => {
      // When each request a Play waited for has failed, it starts from what the tab knows.
      const answered = answerLibrary(model, request)
      if (!isCurrent(model, generation)) return settlePendingPlay(request, false)(answered)
      const wasUnauthorized = Option.exists(model.maybeLibraryFailure, (previous) => previous.status === 401)
      return Update.combine(modifyFields(answered, { maybeLibraryFailure: () => Option.some(failure) }), [
        failure.status === 401 && !wasUnauthorized ? openSettings : unchanged,
        settlePendingPlay(request, false),
      ])
    },
    SucceededFetchVoices: ({ voices }) => ({ model: modifyFields(model, { voices: () => voices }) }),
    FailedFetchVoices: () => ({ model }),
    ClickedTryAgain: () => fetchEpisodes(model),
    TickedPoll: () => fetchEpisodes(model),
    BecameVisible: () => fetchEpisodes(model),
    HidPage: () => ({ model: modifyFields(model, { isSaveDue: () => true }) }),

    UpdatedAddText: ({ value }) => ({
      model: modifyFields(model, { addText: () => value, maybeAddError: () => Option.none() }),
    }),
    PressedEnterInAddText: () => submitAdd(model),
    SubmittedAddForm: () => submitAdd(model),
    ChangedFileInput: ({ files }) =>
      Option.match(Option.fromNullishOr(files[0]), {
        onNone: () => ({ model }),
        onSome: (file) => ({ model: modifyFields(model, { maybeAttachedFile: () => Option.some(file) }) }),
      }),
    ClickedRemoveFile: () => ({
      model: modifyFields(model, { maybeAttachedFile: () => Option.none() }),
      commands: [FocusAddText()],
    }),
    EnteredFileDrag: () => ({ model: modifyFields(model, { fileDragDepth: (depth) => depth + 1 }) }),
    LeftFileDrag: () => ({ model: modifyFields(model, { fileDragDepth: (depth) => Math.max(0, depth - 1) }) }),
    DroppedFile: ({ file }) => ({
      model: modifyFields(model, {
        fileDragDepth: () => 0,
        maybeAttachedFile: () => Option.some(file),
        maybeAddError: () => Option.none(),
      }),
    }),
    SucceededCreateEpisode: ({ episode }) =>
      Update.combine(model, [
        (stepModel) => ({
          model: modifyFields(stepModel, {
            addText: () => "",
            maybeAttachedFile: () => Option.none(),
            isAdding: () => false,
          }),
          commands: [FocusAddText()],
        }),
        withEpisodes((list) => [episode, ...list.filter((item) => item.id !== episode.id)]),
      ]),
    FailedCreateEpisode: ({ failure }) => ({
      model: modifyFields(model, { isAdding: () => false, maybeAddError: () => Option.some(failure.message) }),
    }),
    CompletedMountFilePickerKeys: () => ({ model }),
    CompletedFocusAddText: () => ({ model }),

    ClickedPickerTrigger: ({ pickerId }) =>
      model.picker._tag === "Open" && model.picker.pickerId === pickerId
        ? closePicker(false)(model)
        : openPicker(pickerId, Option.none())(model),
    PressedPickerTriggerKey: ({ pickerId, key }) => pressPickerTriggerKey(pickerId, key)(model),
    PressedPickerKey: ({ key }) => pressPickerKey(key)(model),
    ClickedPickerItem: ({ pickerId, index }) => selectPickerItem(pickerId, index)(model),
    ClickedPickerBackdrop: () => closePicker(false)(model),
    CompletedFocusPicker: () => ({ model }),
    CompletedFocusPickerTrigger: () => ({ model }),
    CompletedScrollPickerItem: () => ({ model }),
    CompletedAnchorPicker: () => ({ model }),
    CompletedWaitBeforeResetTypeAhead: ({ keys }) => resetTypeAhead(keys)(model),

    ClickedPlayEpisode: ({ episodeId }) =>
      Option.match(Option.fromNullishOr(episodes(model).find((item) => item.id === episodeId)), {
        onNone: () => ({ model }),
        onSome: (episode) => start(episode)(model),
      }),
    ClickedRetry: ({ episodeId }) => ({
      model: modifyFields(model, { rowErrors: Record.remove(episodeId) }),
      commands: [RetryEpisode({ connection: model.connection, episodeId })],
    }),
    SucceededRetryEpisode: ({ episode }) =>
      withEpisodes((list) => list.map((item) => (item.id === episode.id ? episode : item)))(model),
    FailedRetryEpisode: ({ episodeId, failure }) => setRowError(episodeId, failure.message)(model),
    ClickedArmDelete: ({ episodeId }) => ({
      model: modifyFields(model, { armedDeletes: (ids) => [...ids.filter((id) => id !== episodeId), episodeId] }),
      commands: [WaitBeforeDisarmDelete({ episodeId }), FocusDeleteConfirm({ episodeId })],
    }),
    ClickedConfirmDelete: ({ episodeId }) => ({
      model: modifyFields(model, { rowErrors: Record.remove(episodeId) }),
      commands: [DeleteEpisode({ connection: model.connection, episodeId })],
    }),
    SucceededDeleteEpisode: ({ episodeId }) =>
      Update.combine(model, [forgetRow(episodeId), withEpisodes((list) => list.filter((item) => item.id !== episodeId))]),
    FailedDeleteEpisode: ({ episodeId, failure }) => setRowError(episodeId, failure.message)(model),
    CompletedWaitBeforeDisarmDelete: ({ episodeId }) => ({
      model: modifyFields(model, { armedDeletes: (ids) => ids.filter((id) => id !== episodeId) }),
    }),
    CompletedFocusDeleteConfirm: () => ({ model }),

    ClickedSettings: () => openSettings(model),
    GotSettingsDialogMessage: ({ message: dialogMessage }) => foldSettingsDialog(model, dialogMessage),
    UpdatedTokenDraft: ({ value }) => ({
      model: modifyFields(model, {
        settingsDraft: (draft) => modifyFields(draft, { token: () => value }),
      }),
    }),
    UpdatedOriginDraft: ({ value }) => ({
      model: modifyFields(model, { settingsDraft: (draft) => modifyFields(draft, { origin: () => value }) }),
    }),
    SubmittedSettings: () => saveSettings(model),
    ChangedStoredSettings: (settings) => followStoredSettings(settings)(model),
    SucceededFetchFeed: ({ request, url }) => setFeed(request, Feed.Ready({ url }))(model),
    FailedFetchFeed: ({ request, failure }) =>
      setFeed(request, failure.status === 401 ? Feed.Loading() : Feed.Failed({ message: failure.message }))(model),
    ClickedCopyFeedUrl: () =>
      model.feed._tag === "Ready" ? { model, commands: [CopyFeedUrl({ url: model.feed.url })] } : { model },
    SucceededCopyFeedUrl: () => {
      if (model.isFeedUrlCopied) return { model }
      const copy = model.feedUrlCopies + 1
      return {
        model: modifyFields(model, { isFeedUrlCopied: () => true, feedUrlCopies: () => copy }),
        commands: [WaitBeforeResetCopied({ copy })],
      }
    },
    FailedCopyFeedUrl: () => ({ model }),
    CompletedWaitBeforeResetCopied: ({ copy }) =>
      copy === model.feedUrlCopies ? { model: modifyFields(model, { isFeedUrlCopied: () => false }) } : { model },
    CompletedStoreSetting: () => ({ model }),

    ClickedPlayPause: () => toggle(model),
    ClickedSkip: ({ deltaMs }) => skip(deltaMs)(model),
    UpdatedScrub: ({ value }) => ({ model: modifyFields(model, { maybeScrubMs: () => Option.some(Number(value)) }) }),
    CommittedScrub: ({ value }) =>
      withLoaded(({ episode }) => seek(scrubTargetMs(episode.chapters, Number(value))))(
        modifyFields(model, { maybeScrubMs: () => Option.none() }),
      ),
    PressedPlayerShortcut: ({ shortcut: name }) => shortcut(name)(model),
    PressedMediaPlay: () => (wantsPlay(model) ? { model } : toggle(model)),
    PressedMediaPause: () => (wantsPlay(model) ? askPause(model) : cancelPlay(model)),
    PressedMediaSkip: ({ deltaMs }) => skip(deltaMs)(model),
    PressedMediaSeekTo: ({ positionMs }) => seek(positionMs)(model),
    PressedMediaPreviousTrack: () =>
      model.playback._tag === "Loaded" ? playChapter(Math.max(0, model.playback.chapter - 1))(model) : { model },
    PressedMediaNextTrack: () =>
      withLoaded(({ playback, episode }) =>
        episode.chapters[playback.chapter + 1] ? playChapter(playback.chapter + 1) : unchanged,
      )(model),

    UpdatedAudioTime: ({ offsetMs, atMs }) => updateAudioTime(offsetMs, atMs)(model),
    StartedAudio: () => setPlayback({ isPlaying: true })(model),
    PausedAudio: () => takeOwnPause(model),
    EndedChapter: () => endChapter(model),
    CompletedLoadChapter: () => ({ model }),
    // The browser refused to play: the Play is off, and the element rests.
    FailedPlayAudio: () =>
      Update.combine(model, [setPlayback({ isPlaying: false }), setListening({ wantsPlay: false, isPlayDue: false })]),
    CompletedPlayAudio: () => ({ model }),
    CompletedPauseAudio: () => ({ model }),
    CompletedSeekAudio: () => ({ model }),
    CompletedSetAudioRate: () => ({ model }),
    CompletedStopAudio: () => ({ model }),
    GotStoredProgress: ({ episodeId, intent, stored }) => startFromStored(episodeId, intent, stored)(model),

    SavedProgress: ({ episodeId, progress }) => takeStamp(episodeId, progress)(model),
    SucceededPushProgress: ({ episodeId, sent, stored }) => takePushAnswer(episodeId, sent, stored)(model),
    FailedPushProgress: () => ({ model }),
    CompletedStoreProgress: () => ({ model }),
  })

/** Every Message goes two steps: `handle` changes intent and facts, then `reconcile` decides what the audio does. */
export const update = (model: Model, message: Message): UpdateReturn => {
  const handled = handle(model, message)
  const reconciled = reconcile(handled.model)
  return { model: reconciled.model, commands: [...(handled.commands ?? []), ...(reconciled.commands ?? [])] }
}
