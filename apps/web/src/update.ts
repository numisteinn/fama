import type { Episode, EpisodeId } from "@fama/contracts"
import { Dialog } from "@foldkit/ui"
import { Option, Record, Redacted } from "effect"
import type { HttpClient } from "effect/http"
import { Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import { type Connection, apiToken, isSameConnection } from "~/api"
import { type AudioPlayer, LoadChapter, SeekAudio, SetAudioRate, StopAudio, ToggleAudio } from "~/audio"
import {
  ClickFileInput,
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
  RetryEpisode,
  SavePosition,
  ScrollPickerItem,
  StoreConnection,
  StoreSetting,
  UploadEpisode,
  WaitBeforeDisarmDelete,
  WaitBeforeResetCopied,
} from "~/command"
import { Message, type PlayerShortcut } from "~/message"
import {
  Draft,
  FINISHED_MARGIN_MS,
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
  current,
  episodes,
  isWorking,
  selectedVoice,
  sortedVoices,
  toDraft,
} from "~/model"
import { chapterStartMs, locate, totalMs } from "~/timeline"

export type Services = AudioPlayer | HttpClient.HttpClient
type UpdateReturn = Update.Return<Model, Message, Services>
type Step = Update.Step<Model, Message, Services>

const unchanged: Step = (model) => ({ model })

// INIT

export const init = (flags: Flags): UpdateReturn => {
  const connection = { origin: flags.origin, token: flags.token }
  return {
    model: {
      connection,
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
      settingsDialog: Dialog.init({ id: "settings" }),
      settingsDraft: connection,
      feed: Feed.Loading(),
      isFeedUrlCopied: false,
      feedUrlCopies: 0,
      playback: Playback.Stopped(),
      rate: flags.rate,
      savedPositions: flags.savedPositions,
      lastSavedAtMs: 0,
      maybeScrubMs: Option.none(),
    },
    commands: [FetchEpisodes({ connection }), FetchVoices({ connection }), FocusAddText()],
  }
}

// SETTINGS DIALOG

const foldSettingsOutMessage = Dialog.OutMessage.match<Step>({
  Opened: () => (model) => ({
    model: modifyFields(model, {
      settingsDraft: () => model.connection,
      feed: () => Feed.Loading(),
      isFeedUrlCopied: () => false,
    }),
    commands: [FetchFeed({ connection: model.connection })],
  }),
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
    (stepModel) => ({
      model: modifyFields(stepModel, { connection: () => connection }),
      commands: [
        StoreConnection({ connection }),
        ...(isChanged ? [FetchEpisodes({ connection }), FetchFeed({ connection })] : []),
      ],
    }),
    closeSettings,
  ])
}

/** Shows a feed result, unless it was fetched for a connection that is no longer current. */
const setFeed = (connection: Connection, feed: Feed): Step => (model) =>
  isSameConnection(connection, model.connection) ? { model: modifyFields(model, { feed: () => feed }) } : { model }

/** Follows a token or server saved in another tab, as the React app did: the library and an open feed refetch. */
const followStoredConnection = (connection: Connection): Step => (model) => {
  if (isSameConnection(connection, model.connection)) return { model }
  const isFeedShown = model.settingsDialog.isOpen
  return {
    model: modifyFields(model, {
      connection: () => connection,
      feed: (feed) => (isFeedShown ? Feed.Loading() : feed),
    }),
    commands: [FetchEpisodes({ connection }), ...(isFeedShown ? [FetchFeed({ connection })] : [])],
  }
}

// LIBRARY

const fetchEpisodes: Step = (model) => ({ model, commands: [FetchEpisodes({ connection: model.connection })] })

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

const pickerItemCount = (model: Model, pickerId: PickerId): number => {
  switch (pickerId) {
    case "Voice":
      return model.voices.length + 1
    case "VoiceSpeed":
      return SPEEDS.length
    case "PlaybackSpeed":
      return RATES.length
    case "Chapters":
      return Option.match(current(model), { onNone: () => 0, onSome: ({ episode }) => episode.chapters.length })
  }
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
    model: modifyFields(model, { picker: () => Picker.Open({ pickerId, maybeActiveIndex }) }),
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
  model: modifyFields(model, { picker: () => Picker.Open({ pickerId, maybeActiveIndex: Option.some(index) }) }),
  commands: [ScrollPickerItem({ pickerId, index })],
})

const pressPickerKey = (key: string): Step => (model) => {
  if (model.picker._tag === "Closed") return { model }
  const { pickerId, maybeActiveIndex } = model.picker
  const count = pickerItemCount(model, pickerId)
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
    case " ":
      return Option.match(maybeActiveIndex, {
        onNone: () => ({ model }),
        onSome: (index) => selectPickerItem(pickerId, index)(model),
      })
    default:
      return { model }
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

const savePositionAt = (episodeId: EpisodeId, positionMs: number): Step => (model) => ({
  model: modifyFields(model, { savedPositions: Record.set(episodeId, positionMs) }),
  commands: [SavePosition({ episodeId, positionMs })],
})

/** Saves the position of the loaded episode now. */
const savePosition: Step = withLoaded(({ playback, episode }) => savePositionAt(episode.id, globalMs(playback, episode)))

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

const toggle: Step = withLoaded(({ playback, episode }) => {
  if (playback.isWaiting) return setPlayback({ isWaiting: false })
  if (playback.isEnded) return loadChapter(episode, 0, 0, true)
  return (model) => ({ model, commands: [ToggleAudio()] })
})

/** Plays `episode` from its saved position, or toggles it when it is already loaded. */
const start =
  (episode: Episode): Step =>
  (model) => {
    if (model.playback._tag === "Loaded" && model.playback.episodeId === episode.id) return toggle(model)
    if (episode.chapters.length === 0) return { model }
    const saved = model.savedPositions[episode.id] ?? 0
    const isFinished = !isWorking(episode.job) && saved >= totalMs(episode.chapters) - FINISHED_MARGIN_MS
    const target = locate(episode.chapters, isFinished ? 0 : saved)
    return Update.combine(model, [savePosition, loadChapter(episode, target.index, target.offsetMs, true)])
  }

/**
 * Moves to `ms` on the timeline. A paused move to the very end leaves the episode ended, as the
 * audio element is: the next Play then starts from the top, not from the start of the last chapter.
 */
const seek = (ms: number): Step =>
  withLoaded(({ playback, episode }) => {
    const total = totalMs(episode.chapters)
    const clamped = Math.min(Math.max(0, ms), total)
    const target = locate(episode.chapters, clamped)
    const isSameChapter = target.index === playback.chapter
    const willPlay = isSameChapter ? playback.isPlaying : playback.isPlaying || playback.isWaiting
    const isEnded = clamped >= total && !willPlay
    const move: Step = isSameChapter
      ? (model) => ({
          model: modifyFields(model, {
            playback: () => Playback.Loaded({ ...playback, offsetMs: target.offsetMs, isWaiting: false, isEnded }),
          }),
          commands: [SeekAudio({ offsetMs: target.offsetMs })],
        })
      : Update.combine([
          loadChapter(episode, target.index, target.offsetMs, willPlay),
          setPlayback({ isEnded }),
        ])
    return Update.combine([move, savePositionAt(episode.id, clamped)])
  })

const skip = (deltaMs: number): Step =>
  withLoaded(({ playback, episode }) => seek(globalMs(playback, episode) + deltaMs))

const playChapter = (index: number): Step => withLoaded(({ episode }) => loadChapter(episode, index, 0, true))

const endChapter: Step = withLoaded(({ playback, episode }) => {
  const next = playback.chapter + 1
  if (episode.chapters[next]) return loadChapter(episode, next, 0, true)
  if (isWorking(episode.job)) return setPlayback({ isPlaying: false, isWaiting: true, isEnded: true })
  return Update.combine([setPlayback({ isPlaying: false, isEnded: true }), savePositionAt(episode.id, 0)])
})

const updateAudioTime = (offsetMs: number, atMs: number): Step => (model) => {
  const timed = setPlayback({ offsetMs })(model)
  if (atMs - model.lastSavedAtMs < SAVE_EVERY_MS) return timed
  return Update.combine(timed.model, [
    (stepModel) => ({ model: modifyFields(stepModel, { lastSavedAtMs: () => atMs }) }),
    savePosition,
  ])
}

/** The rules that follow a change of the episode list: a deleted episode stops, and a waiting player moves on. */
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
  if (!isWorking(episode.job)) return setPlayback({ isWaiting: false })(model)
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
    SucceededFetchEpisodes: ({ episodes: list }) =>
      withEpisodes(() => list)(modifyFields(model, { maybeLibraryFailure: () => Option.none() })),
    FailedFetchEpisodes: ({ failure }) => {
      const wasUnauthorized = Option.exists(model.maybeLibraryFailure, (previous) => previous.status === 401)
      const failed = modifyFields(model, { maybeLibraryFailure: () => Option.some(failure) })
      return failure.status === 401 && !wasUnauthorized ? openSettings(failed) : { model: failed }
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
    ClickedAttachFile: () => ({ model, commands: [ClickFileInput()] }),
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
    CompletedClickFileInput: () => ({ model }),
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
    ChangedStoredConnection: ({ connection }) => followStoredConnection(connection)(model),
    SucceededFetchFeed: ({ connection, url }) =>
      setFeed(connection, Feed.Ready({ url }))(model),
    FailedFetchFeed: ({ connection, failure }) =>
      setFeed(connection, failure.status === 401 ? Feed.Loading() : Feed.Failed({ message: failure.message }))(model),
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
      seek(Number(value))(modifyFields(model, { maybeScrubMs: () => Option.none() })),
    PressedPlayerShortcut: ({ shortcut: name }) => shortcut(name)(model),
    PressedMediaPlay: () => (isPlaying(model) ? { model } : toggle(model)),
    PressedMediaPause: () => (isPlaying(model) ? toggle(model) : { model }),
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
    CompletedSavePosition: () => ({ model }),
  })
