import { type Episode, type EpisodeId, type EpisodeProgress, type VoiceRef, isFinished, mergeProgress } from "@fama/contracts"
import { Dialog } from "@foldkit/ui"
import { Option, Record, Redacted } from "effect"
import type { HttpClient } from "effect/http"
import { Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import { type Connection, apiToken, isSameConnection } from "~/api"
import { type AudioPlayer, LoadChapter, SeekAudio, SetAudioRate, StopAudio, ToggleAudio } from "~/audio"
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
  isWorking,
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
    libraryRequestsInFlight: 0,
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
    playIntents: 0,
    maybePendingPlay: Option.none(),
    rate: flags.rate,
    localProgress: flags.localProgress,
    lastSavedAtMs: 0,
    maybeScrubMs: Option.none(),
  }
  const library = fetchLibrary(model)
  return { model: library.model, commands: [library.command, FetchVoices({ connection }), FocusAddText()] }
}

// CONNECTION

/** A library request for the current connection, tagged with its generation and counted as in flight. */
const fetchLibrary = (model: Model): { model: Model; command: ReturnType<typeof FetchEpisodes> } => ({
  model: modifyFields(model, { libraryRequestsInFlight: (count) => count + 1 }),
  command: FetchEpisodes({ connection: model.connection, generation: model.connectionGeneration }),
})

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

/**
 * A library request answered, with a list or a failure: it is no longer in flight. `maybePlay` is the episode of a
 * pending Play that waited for this answer as its last one, so it starts now.
 *
 * A Play waits for as many answers as requests were in flight when it was pressed. By then each of those requests
 * answered, or a later and fresher one did.
 */
const answerLibrary = (model: Model): { model: Model; maybePlay: Option.Option<EpisodeId> } => {
  const counted = modifyFields(model, { libraryRequestsInFlight: (count) => Math.max(0, count - 1) })
  return Option.match(model.maybePendingPlay, {
    onNone: () => ({ model: counted, maybePlay: Option.none() }),
    onSome: ({ episodeId, awaiting }) =>
      awaiting > 1
        ? {
            model: modifyFields(counted, {
              maybePendingPlay: () => Option.some({ episodeId, awaiting: awaiting - 1 }),
            }),
            maybePlay: Option.none(),
          }
        : { model: modifyFields(counted, { maybePendingPlay: () => Option.none() }), maybePlay: Option.some(episodeId) },
  })
}

/** Replaces the episode list, then applies the playback rules that depend on it. */
const withEpisodes =
  (toEpisodes: (list: ReadonlyArray<Episode>) => ReadonlyArray<Episode>): Step =>
  (model) =>
    reconcilePlayback(modifyFields(model, { maybeEpisodes: () => Option.some(toEpisodes(episodes(model))) }))

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

const globalMs = (playback: LoadedPlayback, episode: Episode) =>
  chapterStartMs(episode.chapters, playback.chapter) + playback.offsetMs

const withLoaded =
  (toStep: (loaded: { playback: LoadedPlayback; episode: Episode }) => Step): Step =>
  (model) =>
    Option.match(current(model), { onNone: () => ({ model }), onSome: (loaded) => toStep(loaded)(model) })

const setPlayback =
  (fields: Partial<Omit<LoadedPlayback, "_tag">>): Step =>
  (model) => {
    const playback = model.playback
    if (playback._tag !== "Loaded") return { model }
    return { model: modifyFields(model, { playback: () => Playback.Loaded({ ...playback, ...fields }) }) }
  }

/**
 * A listener's action left `episodeId` at `positionMs`: stamp, store and send it. A position the device already
 * holds is not stamped again, so a pause or a hidden page with nothing new sends nothing, and a paused tab does not
 * overwrite what another device sent since.
 */
const savePositionAt = (episodeId: EpisodeId, positionMs: number): Step => (model) =>
  model.localProgress[episodeId]?.positionMs === Math.max(0, Math.round(positionMs))
    ? { model }
    : { model, commands: [SaveProgress({ episodeId, positionMs })] }

/**
 * Saves the position of the loaded episode now. While its Play waits for the library, nothing is stamped: the
 * position the tab holds may be one another device moved on from, also when the audio started by itself.
 */
const savePosition: Step = withLoaded(({ playback, episode }) => (model) =>
  isPlayPending(model, episode.id) ? { model } : savePositionAt(episode.id, globalMs(playback, episode))(model),
)

const isSameProgress = (a: EpisodeProgress, b: EpisodeProgress) =>
  a.positionMs === b.positionMs && a.updatedAt === b.updatedAt

/** A save stamped and stored: the tab now knows it, and sends it. */
const sendSaved = (episodeId: EpisodeId, progress: EpisodeProgress): Step => (model) => ({
  model: modifyFields(model, { localProgress: Record.set(episodeId, progress) }),
  commands: [PushProgress({ connection: model.connection, episodeId, progress })],
})

/** Shows `progress` as the server's on the episode in the list. */
const setServerProgress = (episodeId: EpisodeId, progress: EpisodeProgress): Step => (model) => ({
  model: modifyFields(model, {
    maybeEpisodes: Option.map((list) => list.map((item) => (item.id === episodeId ? { ...item, progress } : item))),
  }),
})

/**
 * Takes the server's entry as the device's, with the server's stamp, so it never counts as a new listener action.
 * A loaded, paused episode rests there, so the next Play resumes where the other device stopped. With `isPlayDue`,
 * a Play waited for this entry: the loaded episode plays from there now.
 */
const adoptProgress = (episodeId: EpisodeId, progress: EpisodeProgress, isPlayDue = false): Step => (model) => {
  const local = model.localProgress[episodeId]
  if (local && isSameProgress(local, progress)) return { model }
  const playback = model.playback
  const isLoaded = playback._tag === "Loaded" && playback.episodeId === episodeId
  const isPaused = isLoaded && !playback.isPlaying && !playback.isWaiting
  return Update.combine(model, [
    (stepModel) => ({
      model: modifyFields(stepModel, { localProgress: Record.set(episodeId, progress) }),
      commands: [StoreProgress({ episodeId, progress })],
    }),
    isPlayDue && isLoaded
      ? withLoaded(({ episode }) => playFrom(episode, progress.positionMs))
      : isPaused
        ? restAt(progress.positionMs)
        : unchanged,
  ])
}

/**
 * The server answered a push with what it stores. The device takes that answer, a clamped stamp included, unless
 * the listener saved again since: that newer save goes out with its own push.
 */
const takePushAnswer = (episodeId: EpisodeId, sent: EpisodeProgress, stored: EpisodeProgress): Step => (model) => {
  const local = model.localProgress[episodeId]
  const isLatest = local !== undefined && isSameProgress(local, sent)
  return Update.combine(model, [setServerProgress(episodeId, stored), isLatest ? adoptProgress(episodeId, stored) : unchanged])
}

/**
 * After a library load: each local entry newer than the server's is sent, so listening done offline syncs, and
 * each newer server entry is taken. Nothing is stamped. `maybePlay` is the episode whose pending Play starts with
 * this load.
 */
const syncProgress = (maybePlay: Option.Option<EpisodeId>): Step => (model) =>
  Update.combine(
    model,
    episodes(model).map((episode): Step => {
      const local = model.localProgress[episode.id] ?? null
      const { progress, isPushed } = mergeProgress(local, episode.progress)
      if (isPushed && local !== null) {
        return (stepModel) => ({
          model: stepModel,
          commands: [PushProgress({ connection: stepModel.connection, episodeId: episode.id, progress: local })],
        })
      }
      return progress === null
        ? unchanged
        : adoptProgress(episode.id, progress, Option.exists(maybePlay, (id) => id === episode.id))
    }),
  )

/**
 * The finished rule the devices share: `positionMs` is the end of `episode`, or within the last seconds of it.
 * Play then starts at 0. The end of the chapters of a working job is not the end of the episode.
 */
const isPlayedThrough = (episode: Episode, positionMs: number) =>
  !isWorking(episode.job) && isFinished(positionMs, totalMs(episode.chapters))

const loadChapter =
  (episode: Episode, index: number, offsetMs: number, isAutoplay: boolean): Step =>
  (model) => {
    const chapter = episode.chapters[index]
    if (!chapter) return { model }
    return {
      model: modifyFields(model, {
        playback: () =>
          Playback.Loaded({
            episodeId: episode.id,
            chapter: index,
            offsetMs,
            isPlaying: isAutoplay,
            isWaiting: false,
            isEnded: false,
          }),
      }),
      commands: [LoadChapter({ src: model.connection.origin + chapter.url, offsetMs, rate: model.rate, isAutoplay })],
    }
  }

/** Plays `episode` from a saved `positionMs`. A played-through position starts from the top. */
const playFrom = (episode: Episode, positionMs: number): Step => {
  const target = locate(episode.chapters, isPlayedThrough(episode, positionMs) ? 0 : positionMs)
  return loadChapter(episode, target.index, target.offsetMs, true)
}

/**
 * A playback action of the user. A start still reading storage is no longer the latest intent, and a Play that
 * waits for the library is off.
 */
const intend =
  (step: Step): Step =>
  (model) =>
    step(modifyFields(model, { playIntents: (count) => count + 1, maybePendingPlay: () => Option.none() }))

/**
 * A Play of the user. While a library request is in flight, it waits for the answer and does `now` then: the
 * library may hold a newer position from another device, and a Play from the old one would stamp it over that.
 * A second Play of the same episode does not wait again, so a slow request never leaves Play dead.
 */
const play =
  (episodeId: EpisodeId, now: Step): Step =>
  (model) =>
    model.libraryRequestsInFlight > 0 && !isPlayPending(model, episodeId)
      ? intend((held) => ({
          model: modifyFields(held, {
            maybePendingPlay: () => Option.some({ episodeId, awaiting: held.libraryRequestsInFlight }),
          }),
        }))(model)
      : intend(now)(model)

/** A Pause while a Play waits for the library: the Play is off. */
const cancelPlay: Step = (model) => (Option.isSome(model.maybePendingPlay) ? intend(unchanged)(model) : { model })

/** Plays the loaded, paused episode from where it rests. After the end of the episode, that is the top. */
const resume: Step = withLoaded(({ playback, episode }) =>
  playback.isPlaying
    ? unchanged
    : playback.isEnded
      ? loadChapter(episode, 0, 0, true)
      : (model) => ({ model, commands: [ToggleAudio()] }),
)

const toggle: Step = withLoaded(({ playback, episode }) => {
  if (playback.isWaiting) return intend(setPlayback({ isWaiting: false }))
  if (playback.isPlaying) return intend((model) => ({ model, commands: [ToggleAudio()] }))
  return play(episode.id, resume)
})

const isLoadedEpisode = (model: Model, episodeId: EpisodeId) =>
  model.playback._tag === "Loaded" && model.playback.episodeId === episodeId

/** Reads the progress storage holds for an episode, to play it from there. The read carries the latest intent. */
const readThenPlay =
  (episodeId: EpisodeId): Step =>
  (model) => ({ model, commands: [ReadStoredProgress({ episodeId, intent: model.playIntents })] })

/**
 * Toggles `episode` when it is already loaded. Otherwise reads its progress from storage first,
 * as the React app did, so a pause in another tab is where it resumes.
 */
const start =
  (episode: Episode): Step =>
  (model) => {
    if (isLoadedEpisode(model, episode.id)) return toggle(model)
    if (episode.chapters.length === 0) return { model }
    return play(episode.id, readThenPlay(episode.id))(model)
  }

/** A pending Play whose wait is over starts, from what the device knows now. */
const playDue = (maybePlay: Option.Option<EpisodeId>): Step =>
  Option.match(maybePlay, {
    onNone: () => unchanged,
    onSome:
      (episodeId): Step =>
      (model) => {
        if (isLoadedEpisode(model, episodeId)) return resume(model)
        const isPlayable = episodes(model).some((item) => item.id === episodeId && item.chapters.length > 0)
        return isPlayable ? readThenPlay(episodeId)(model) : { model }
      },
  })

/**
 * Plays an episode from the newer of the progress storage holds and the server's; with neither, from 0. Only
 * when storage cannot be read is the entry this tab knows used. A finished episode starts from the top. A result
 * whose start is no longer the latest playback intent is dropped: a later Pause, Play or seek wins.
 */
const playFromSaved =
  (episodeId: EpisodeId, intent: number, stored: StoredProgress): Step =>
  (model) => {
    if (intent !== model.playIntents) return { model }
    const episode = episodes(model).find((item) => item.id === episodeId)
    if (!episode || episode.chapters.length === 0 || isLoadedEpisode(model, episodeId)) return { model }
    const local = StoredProgress.match(stored, {
      Saved: ({ progress }) => progress,
      NotSaved: () => null,
      Unreadable: () => model.localProgress[episodeId] ?? null,
    })
    const { progress } = mergeProgress(local, episode.progress)
    // Storage is the truth for this device: an entry gone from it (site data cleared) is gone here too.
    const known: Step =
      progress !== null
        ? adoptProgress(episodeId, progress)
        : (stepModel) => ({ model: modifyFields(stepModel, { localProgress: Record.remove(episodeId) }) })
    return Update.combine(model, [savePosition, known, playFrom(episode, progress?.positionMs ?? 0)])
  }

const clampToEpisode = (episode: Episode, ms: number) => Math.min(Math.max(0, ms), totalMs(episode.chapters))

/**
 * Moves the loaded episode to `ms` on the timeline, without saving. A paused move to the very end leaves the
 * episode ended, as the audio element is: the next Play then starts from the top, not from the start of the
 * last chapter.
 */
const moveTo = (ms: number): Step =>
  withLoaded(({ playback, episode }) => {
    const clamped = clampToEpisode(episode, ms)
    const target = locate(episode.chapters, clamped)
    const isSameChapter = target.index === playback.chapter
    const willPlay = isSameChapter ? playback.isPlaying : playback.isPlaying || playback.isWaiting
    const isEnded = clamped >= totalMs(episode.chapters) && !willPlay
    return isSameChapter
      ? (model) => ({
          model: modifyFields(model, {
            playback: () => Playback.Loaded({ ...playback, offsetMs: target.offsetMs, isWaiting: false, isEnded }),
          }),
          commands: [SeekAudio({ offsetMs: target.offsetMs })],
        })
      : Update.combine([loadChapter(episode, target.index, target.offsetMs, willPlay), setPlayback({ isEnded })])
  })

/**
 * Rests the loaded, paused episode at a synced `positionMs`, without saving. A played-through position leaves it
 * ended, as its own end of episode does: the next Play starts at 0.
 */
const restAt = (positionMs: number): Step =>
  withLoaded(({ episode }) =>
    Update.combine([
      moveTo(positionMs),
      isPlayedThrough(episode, positionMs) ? setPlayback({ isEnded: true }) : unchanged,
    ]),
  )

/** The listener moves to `ms`: the move, saved. */
const seek = (ms: number): Step =>
  withLoaded(({ episode }) =>
    intend(Update.combine([moveTo(ms), savePositionAt(episode.id, clampToEpisode(episode, ms))])),
  )

const skip = (deltaMs: number): Step =>
  withLoaded(({ playback, episode }) => seek(globalMs(playback, episode) + deltaMs))

const playChapter = (index: number): Step => withLoaded(({ episode }) => intend(loadChapter(episode, index, 0, true)))

/** The episode played to its end: its total length is stored, so every device shows it played. The next Play starts at 0. */
const finish = (episode: Episode): Step =>
  Update.combine([
    setPlayback({ isPlaying: false, isWaiting: false, isEnded: true }),
    savePositionAt(episode.id, totalMs(episode.chapters)),
  ])

const endChapter: Step = withLoaded(({ playback, episode }) => {
  const next = playback.chapter + 1
  if (episode.chapters[next]) return loadChapter(episode, next, 0, true)
  // The end of the chapters made so far is not the end of the episode: wait, and save nothing new.
  if (isWorking(episode.job)) return setPlayback({ isPlaying: false, isWaiting: true, isEnded: true })
  return finish(episode)
})

const updateAudioTime = (offsetMs: number, atMs: number): Step => (model) => {
  const timed = setPlayback({ offsetMs })(model)
  if (atMs - model.lastSavedAtMs < SAVE_EVERY_MS) return timed
  return Update.combine(timed.model, [
    (stepModel) => ({ model: modifyFields(stepModel, { lastSavedAtMs: () => atMs }) }),
    savePosition,
  ])
}

/**
 * The rules that follow a change of the episode list: a deleted episode stops, and a waiting player moves on. When
 * the job ends with no chapter after the last one played, the wait was the end of the episode.
 */
const reconcilePlayback: Step = (model) => {
  const playback = model.playback
  if (playback._tag !== "Loaded") return { model }
  const episode = episodes(model).find((item) => item.id === playback.episodeId)
  if (!episode) {
    return {
      model: modifyFields(model, {
        playback: () => Playback.Stopped(),
        maybeScrubMs: () => Option.none(),
        picker: (picker) => (picker._tag === "Open" && picker.pickerId === "Chapters" ? Picker.Closed() : picker),
      }),
      commands: [StopAudio()],
    }
  }
  if (!playback.isWaiting) return { model }
  if (episode.chapters[playback.chapter + 1]) return loadChapter(episode, playback.chapter + 1, 0, true)(model)
  if (!isWorking(episode.job)) return finish(episode)(model)
  return { model }
}

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

const isPlaying = (model: Model) => model.playback._tag === "Loaded" && model.playback.isPlaying

// UPDATE

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    SucceededFetchEpisodes: ({ generation, episodes: list }) => {
      const answered = answerLibrary(model)
      return isCurrent(model, generation)
        ? Update.combine(modifyFields(answered.model, { maybeLibraryFailure: () => Option.none() }), [
            withEpisodes(() => list),
            syncProgress(answered.maybePlay),
            playDue(answered.maybePlay),
          ])
        : playDue(answered.maybePlay)(answered.model)
    },
    FailedFetchEpisodes: ({ generation, failure }) => {
      // A failed request is an answer too: a Play that waited for it starts from what the tab knows.
      const answered = answerLibrary(model)
      if (!isCurrent(model, generation)) return playDue(answered.maybePlay)(answered.model)
      const wasUnauthorized = Option.exists(model.maybeLibraryFailure, (previous) => previous.status === 401)
      return Update.combine(modifyFields(answered.model, { maybeLibraryFailure: () => Option.some(failure) }), [
        failure.status === 401 && !wasUnauthorized ? openSettings : unchanged,
        playDue(answered.maybePlay),
      ])
    },
    SucceededFetchVoices: ({ voices }) => ({ model: modifyFields(model, { voices: () => voices }) }),
    FailedFetchVoices: () => ({ model }),
    ClickedTryAgain: () => fetchEpisodes(model),
    TickedPoll: () => fetchEpisodes(model),
    BecameVisible: () => fetchEpisodes(model),
    HidPage: () => savePosition(model),

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
    PressedMediaPlay: () => (isPlaying(model) ? { model } : toggle(model)),
    PressedMediaPause: () => (isPlaying(model) ? toggle(model) : cancelPlay(model)),
    PressedMediaSkip: ({ deltaMs }) => skip(deltaMs)(model),
    PressedMediaSeekTo: ({ positionMs }) => seek(positionMs)(model),
    PressedMediaPreviousTrack: () =>
      model.playback._tag === "Loaded" ? playChapter(Math.max(0, model.playback.chapter - 1))(model) : { model },
    PressedMediaNextTrack: () =>
      withLoaded(({ playback, episode }) =>
        episode.chapters[playback.chapter + 1] ? playChapter(playback.chapter + 1) : unchanged,
      )(model),

    UpdatedAudioTime: ({ offsetMs, atMs }) => updateAudioTime(offsetMs, atMs)(model),
    StartedAudio: () => setPlayback({ isPlaying: true, isWaiting: false, isEnded: false })(model),
    PausedAudio: () => Update.combine(model, [setPlayback({ isPlaying: false }), savePosition]),
    EndedChapter: () => endChapter(model),
    CompletedLoadChapter: () => ({ model }),
    FailedPlayAudio: () => setPlayback({ isPlaying: false })(model),
    CompletedToggleAudio: () => ({ model }),
    CompletedSeekAudio: () => ({ model }),
    CompletedSetAudioRate: () => ({ model }),
    CompletedStopAudio: () => ({ model }),
    GotStoredProgress: ({ episodeId, intent, stored }) => playFromSaved(episodeId, intent, stored)(model),

    SavedProgress: ({ episodeId, progress }) => sendSaved(episodeId, progress)(model),
    SucceededPushProgress: ({ episodeId, sent, stored }) => takePushAnswer(episodeId, sent, stored)(model),
    FailedPushProgress: () => ({ model }),
    CompletedStoreProgress: () => ({ model }),
  })
