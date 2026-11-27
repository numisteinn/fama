import type { Episode, EpisodeId, SourceInput, VoiceRef } from "@fama/contracts"
import { Option, Record, Redacted } from "effect"
import { type Connection, isSameConnection } from "~/core/api"
import { SetAudioRate } from "~/core/audio"
import * as Batch from "~/core/batch"
import { type Flags } from "~/core/flags"
import { scrubTargetMs } from "~/core/timeline"
import { SPEEDS } from "~/core/voices"
import {
  CreateEpisodeFromSource,
  DeleteEpisode,
  FetchVoices,
  PushProgress,
  ReadStoredProgress,
  RetryEpisode,
  SaveProgress,
  StoreConnection,
  StoreProgress,
  StoreSetting,
  UploadEpisode,
  WaitBeforeDisarmDelete,
  focusAddText,
  focusDeleteConfirm,
} from "~/command"
import { fetchEpisodes, fetchLibrary, withEpisodes } from "~/libraryState"
import { AppMessage } from "~/message"
import { type AppModel, Screen, current, episodes, toDraft } from "~/model"
import { Player, type Player as PlayerState, type PlayerResult, type ProgressEffect } from "~/playback/player"
import { Playback, RATES } from "~/playback/model"
import { reconcileScreen, screenHandlers } from "~/screenUpdate"
import { type AppCommand, type Step, type StepReturn, type UpdateResult, combine } from "~/transition"

// PLAYER GLUE
//
// The player owns a flat slice of the App Model plus the read-only facts it reads. These helpers extract it,
// run the player's steps, and merge the owned fields back. Progress writes come back as `ProgressEffect`s, which
// the App translates to its own Commands.

const playerOf = (model: AppModel): PlayerState => ({
  playback: model.playback,
  loadedChapterDurationMs: model.loadedChapterDurationMs,
  maybeListening: model.maybeListening,
  playIntents: model.playIntents,
  maybePendingPlay: model.maybePendingPlay,
  localProgress: model.localProgress,
  stamping: model.stamping,
  isSaveDue: model.isSaveDue,
  lastSavedAtMs: model.lastSavedAtMs,
  episodes: episodes(model),
  connection: model.connection,
  rate: model.rate,
  libraryRequestsInFlight: model.libraryRequestsInFlight,
})

const withPlayer = (model: AppModel, player: PlayerState): AppModel => ({
  ...model,
  playback: player.playback,
  loadedChapterDurationMs: player.loadedChapterDurationMs,
  maybeListening: player.maybeListening,
  playIntents: player.playIntents,
  maybePendingPlay: player.maybePendingPlay,
  localProgress: player.localProgress,
  stamping: player.stamping,
  isSaveDue: player.isSaveDue,
  lastSavedAtMs: player.lastSavedAtMs,
})

const progressCommand = (effect: ProgressEffect, connection: Connection): AppCommand => {
  switch (effect._tag) {
    case "SaveProgress":
      return SaveProgress.make({ episodeId: effect.episodeId, positionMs: effect.positionMs })
    case "StoreProgress":
      return StoreProgress.make({ episodeId: effect.episodeId, progress: effect.progress })
    case "PushProgress":
      return PushProgress.make({ connection, episodeId: effect.episodeId, progress: effect.progress })
    case "ReadStoredProgress":
      return ReadStoredProgress.make({ episodeId: effect.episodeId, intent: effect.intent })
  }
}

const runPlayer = (model: AppModel, fn: (player: PlayerState) => PlayerResult): StepReturn => {
  const player = playerOf(model)
  const result = fn(player)
  return {
    model: result.player === player ? model : withPlayer(model, result.player),
    commands: [...result.progress.map((effect) => progressCommand(effect, model.connection)), ...result.commands],
  }
}

// INIT

export const initApp = (flags: Flags): UpdateResult => {
  const connection = { origin: flags.origin, token: flags.token }
  const model: AppModel = {
    connection,
    connectionGeneration: 0,
    libraryRequests: 0,
    libraryRequestsInFlight: [],
    maybeEpisodes: Option.none(),
    maybeLibraryFailure: Option.none(),
    voices: [],
    addText: "",
    batch: [],
    batchKeys: 0,
    isAdding: false,
    maybeAddError: Option.none(),
    maybeVoice: Option.fromNullishOr(flags.voice),
    speed: flags.speed,
    isReviewOn: false,
    fileDragDepth: 0,
    armedDeletes: [],
    rowErrors: {},
    isSettingsOpen: false,
    settingsOpens: 0,
    screen: Screen.Library(),
    screenOpens: 0,
    maybeReaderEpisodeId: Option.none(),
    reviewSaves: {},
    reviewVoices: {},
    reviewVoiceRequests: 0,
    reviewStarts: {},
    narrateAgainSubmits: {},
    playback: Playback.Stopped(),
    loadedChapterDurationMs: null,
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
  return {
    model: library.model,
    commands: [library.command, FetchVoices.make({ connection, generation: 0 }), focusAddText()],
  }
}

// CONNECTION

/** Moves to `connection` as a new generation, dropping old voices and responses and refreshing queries. */
const changeConnection = (model: AppModel, connection: Connection): AppModel => {
  const sameOrigin = connection.origin === model.connection.origin
  return {
    ...model,
    connection,
    connectionGeneration: model.connectionGeneration + 1,
    voices: [],
    reviewSaves: sameOrigin ? model.reviewSaves : {},
    reviewVoices: sameOrigin ? model.reviewVoices : {},
    reviewStarts: sameOrigin ? model.reviewStarts : {},
    narrateAgainSubmits: sameOrigin ? model.narrateAgainSubmits : {},
  }
}

/** A response fetched for the current connection generation. */
const isCurrent = (model: AppModel, generation: number) => generation === model.connectionGeneration

// SETTINGS

/** Saves the token and server and closes the dialog. A changed connection refetches; a new 401 opens it again. */
const saveSettings = (connection: Connection): Step => (model) => {
  const isChanged =
    Redacted.value(connection.token) !== Redacted.value(model.connection.token) ||
    connection.origin !== model.connection.origin
  if (!isChanged) {
    return {
      model: { ...model, isSettingsOpen: false },
      commands: [StoreConnection.make({ connection })],
    }
  }
  const changed = changeConnection(model, connection)
  const library = fetchLibrary({ ...changed, isSettingsOpen: false })
  return {
    model: library.model,
    commands: [
      StoreConnection.make({ connection }),
      library.command,
      FetchVoices.make({ connection, generation: changed.connectionGeneration }),
    ],
  }
}

/** Follows a token or server saved in another tab: the library and voices refetch and `connectionGeneration` refreshes queries. */
const followStoredConnection = (connection: Connection): Step => (model) => {
  if (isSameConnection(connection, model.connection)) return { model }
  const changed = changeConnection(model, connection)
  const library = fetchLibrary(changed)
  return {
    model: library.model,
    commands: [library.command, FetchVoices.make({ connection, generation: changed.connectionGeneration })],
  }
}

/**
 * Follows settings saved in another tab. The add bar takes the Voice and Voice speed,
 * and a new Playback speed applies to the audio now.
 */
const followStoredSettings =
  (settings: { connection: Connection; maybeVoice: Option.Option<VoiceRef>; speed: number; rate: number }): Step =>
  (model) =>
    combine(model, [
      followStoredConnection(settings.connection),
      (stepModel) => ({
        model: {
          ...stepModel,
          maybeVoice: settings.maybeVoice,
          speed: settings.speed,
          rate: settings.rate,
        },
        commands: settings.rate === stepModel.rate ? [] : [SetAudioRate.make({ rate: settings.rate })],
      }),
    ])

// LIBRARY

/** Library request `request` answered: it is no longer in flight. */
const answerLibrary = (model: AppModel, request: number): AppModel => ({
  ...model,
  libraryRequestsInFlight: model.libraryRequestsInFlight.filter((sent) => sent !== request),
})

/** Shows `progress` as the server's on the episode in the list. */
const setServerProgress = (episodeId: EpisodeId, progress: Episode["progress"]): Step => (model) => ({
  model: {
    ...model,
    maybeEpisodes: Option.map(model.maybeEpisodes, (list) =>
      list.map((item) => (item.id === episodeId ? { ...item, progress } : item)),
    ),
  },
})

const forgetRow = (episodeId: EpisodeId): Step => (model) => ({
  model: {
    ...model,
    armedDeletes: model.armedDeletes.filter((id) => id !== episodeId),
    rowErrors: Record.remove(model.rowErrors, episodeId),
  },
})

const setRowError = (episodeId: EpisodeId, message: string): Step => (model) => ({
  model: { ...model, rowErrors: Record.set(model.rowErrors, episodeId, message) },
})

// ADD BAR

/** Starts the next pending upload of the batch, when none uploads. */
const startNextUpload: Step = (model) => {
  const { batch, maybeStarted } = Batch.startNext(model.batch)
  return {
    model: { ...model, batch },
    commands: Option.match(maybeStarted, {
      onNone: () => [],
      onSome: ({ key, file, state }) =>
        state._tag === "Uploading"
          ? [
              UploadEpisode.make({
                connection: model.connection,
                key,
                file,
                voice: state.voice,
                speed: state.speed,
                review: state.review,
              }),
            ]
          : [],
    }),
  }
}

/** The batch changed. When it emptied, the text box returns and takes focus. */
const withBatch =
  (toBatch: (batch: Batch.Batch) => Batch.Batch): Step =>
  (model) => {
    const batch = toBatch(model.batch)
    const next: AppModel = { ...model, batch }
    return model.batch.length > 0 && batch.length === 0 ? { model: next, commands: [focusAddText()] } : { model: next }
  }

const attachFiles =
  (files: ReadonlyArray<File>): Step =>
  (model) =>
    files.length === 0
      ? { model }
      : withBatch((batch) => Batch.attach(batch, files, model.batchKeys))({
          ...model,
          batchKeys: model.batchKeys + files.length,
          maybeAddError: Option.none(),
        })

const submitAdd: Step = (model) => {
  const draft = toDraft(model)
  if (draft._tag === "Empty" || model.isAdding) return { model }
  const { connection, isReviewOn, speed } = model
  const voice = Option.getOrNull(model.maybeVoice)
  if (draft._tag === "Files")
    return combine(model, [withBatch((batch) => Batch.send(batch, voice, speed, isReviewOn)), startNextUpload])
  const source: SourceInput =
    draft._tag === "Url" ? { _tag: "Url", url: draft.url } : { _tag: "Text", title: null, text: draft.text }
  return {
    model: { ...model, isAdding: true, maybeAddError: Option.none() },
    commands: [
      CreateEpisodeFromSource.make({ connection, input: { source, voice, speed, review: isReviewOn } }),
    ],
  }
}

// PICKERS

const pickVoice = (value: string): Step => (model) => {
  const maybeVoiceRef =
    value === ""
      ? Option.none<VoiceRef>()
      : Option.fromNullishOr(model.voices.find((voice) => voice.id === value)?.id)
  return {
    model: { ...model, maybeVoice: maybeVoiceRef },
    commands: [StoreSetting.make({ key: "fama.voice", value: Option.getOrNull(maybeVoiceRef) })],
  }
}

const pickVoiceSpeed = (value: string): Step => (model) => {
  const parsed = Number(value)
  if (!SPEEDS.includes(parsed as (typeof SPEEDS)[number])) return { model }
  return {
    model: { ...model, speed: parsed },
    commands: [StoreSetting.make({ key: "fama.speed", value: parsed })],
  }
}

const pickPlaybackSpeed = (value: string): Step => (model) => {
  const parsed = Number(value)
  if (!RATES.includes(parsed as (typeof RATES)[number])) return { model }
  return {
    model: { ...model, rate: parsed },
    commands: [StoreSetting.make({ key: "fama.rate", value: parsed }), SetAudioRate.make({ rate: parsed })],
  }
}

const pickChapter = (value: string): Step => (model) => {
  const index = Number(value)
  return Number.isInteger(index) ? runPlayer(model, Player.playChapter(index)) : { model }
}

// UPDATE

/** Changes intent and facts for `message`. It sends no audio Command and stamps nothing: `reconcile` does. */
const handle = (model: AppModel, message: AppMessage): StepReturn =>
  AppMessage.match(message, {
    ...screenHandlers(model),
    SucceededFetchEpisodes: ({ generation, request, episodes: list }) => {
      const isListed = isCurrent(model, generation)
      const answered = answerLibrary(model, request)
      if (!isListed) return runPlayer(answered, Player.settlePendingPlay(request, false))
      const listed = withEpisodes(() => list)({ ...answered, maybeLibraryFailure: Option.none() }).model
      return runPlayer(listed, Player.libraryUpdated(request))
    },
    FailedFetchEpisodes: ({ generation, request, failure }) => {
      const answered = answerLibrary(model, request)
      if (!isCurrent(model, generation)) return runPlayer(answered, Player.settlePendingPlay(request, false))
      const wasUnauthorized = Option.exists(model.maybeLibraryFailure, (previous) => previous.status === 401)
      const autoOpen = failure.status === 401 && !wasUnauthorized && !answered.isSettingsOpen
      const withFailure: AppModel = {
        ...answered,
        maybeLibraryFailure: Option.some(failure),
        isSettingsOpen: failure.status === 401 && !wasUnauthorized ? true : answered.isSettingsOpen,
        settingsOpens: autoOpen ? answered.settingsOpens + 1 : answered.settingsOpens,
      }
      return runPlayer(withFailure, Player.settlePendingPlay(request, false))
    },
    SucceededFetchVoices: ({ generation, voices }) =>
      isCurrent(model, generation) ? { model: { ...model, voices } } : { model },
    FailedFetchVoices: () => ({ model }),
    ClickedTryAgain: () => fetchEpisodes(model),
    TickedPoll: () => fetchEpisodes(model),
    BecameVisible: () => fetchEpisodes(model),
    HidPage: () => runPlayer(model, Player.markSaveDue),

    UpdatedAddText: ({ value }) => ({
      model: { ...model, addText: value, maybeAddError: Option.none() },
    }),
    PressedEnterInAddText: () => submitAdd(model),
    SubmittedAddForm: () => submitAdd(model),
    ToggledAddReview: ({ checked }) => ({ model: { ...model, isReviewOn: checked } }),
    ChangedFileInput: ({ files }) => attachFiles(files)(model),
    ClickedRemoveFile: ({ key }) => withBatch((batch) => Batch.remove(batch, key))(model),
    ClickedRetryFile: ({ key }) =>
      combine(model, [withBatch((batch) => Batch.retry(batch, key)), startNextUpload]),
    EnteredFileDrag: () => ({ model: { ...model, fileDragDepth: model.fileDragDepth + 1 } }),
    LeftFileDrag: () => ({ model: { ...model, fileDragDepth: Math.max(0, model.fileDragDepth - 1) } }),
    DroppedFiles: ({ files }) => attachFiles(files)({ ...model, fileDragDepth: 0 }),
    SucceededCreateEpisode: ({ episode }) =>
      combine(model, [
        (stepModel) => ({
          model: { ...stepModel, addText: "", isAdding: false },
          commands: [focusAddText()],
        }),
        withEpisodes((list) => [episode, ...list.filter((item) => item.id !== episode.id)]),
      ]),
    FailedCreateEpisode: ({ failure }) => ({
      model: { ...model, isAdding: false, maybeAddError: Option.some(failure.message) },
    }),
    SucceededUploadFile: ({ key, episode }) =>
      combine(model, [
        withBatch((batch) => Batch.succeed(batch, key)),
        withEpisodes((list) => [episode, ...list.filter((item) => item.id !== episode.id)]),
        startNextUpload,
      ]),
    FailedUploadFile: ({ key, failure }) =>
      combine(model, [withBatch((batch) => Batch.fail(batch, key, failure.message)), startNextUpload]),

    PickedVoice: ({ value }) => pickVoice(value)(model),
    PickedVoiceSpeed: ({ value }) => pickVoiceSpeed(value)(model),
    PickedPlaybackSpeed: ({ value }) => pickPlaybackSpeed(value)(model),
    PickedChapter: ({ value }) => pickChapter(value)(model),

    ClickedPlayEpisode: ({ episodeId }) =>
      Option.match(Option.fromNullishOr(episodes(model).find((item) => item.id === episodeId)), {
        onNone: () => ({ model }),
        onSome: (episode) => runPlayer(model, Player.start(episode)),
      }),
    ClickedRetry: ({ episodeId }) => ({
      model: { ...model, rowErrors: Record.remove(model.rowErrors, episodeId) },
      commands: [RetryEpisode.make({ connection: model.connection, episodeId })],
    }),
    SucceededRetryEpisode: ({ episode }) =>
      withEpisodes((list) => list.map((item) => (item.id === episode.id ? episode : item)))(model),
    FailedRetryEpisode: ({ episodeId, failure }) => setRowError(episodeId, failure.message)(model),
    ClickedArmDelete: ({ episodeId }) => ({
      model: { ...model, armedDeletes: [...model.armedDeletes.filter((id) => id !== episodeId), episodeId] },
      commands: [WaitBeforeDisarmDelete.make({ episodeId }), focusDeleteConfirm(episodeId)],
    }),
    ClickedConfirmDelete: ({ episodeId }) => ({
      model: { ...model, rowErrors: Record.remove(model.rowErrors, episodeId) },
      commands: [DeleteEpisode.make({ connection: model.connection, episodeId })],
    }),
    SucceededDeleteEpisode: ({ episodeId }) =>
      combine(model, [forgetRow(episodeId), withEpisodes((list) => list.filter((item) => item.id !== episodeId))]),
    FailedDeleteEpisode: ({ episodeId, failure }) => setRowError(episodeId, failure.message)(model),
    CompletedWaitBeforeDisarmDelete: ({ episodeId }) => ({
      model: { ...model, armedDeletes: model.armedDeletes.filter((id) => id !== episodeId) },
    }),

    RequestedPauseMainPlayback: () => runPlayer(model, Player.askPause),
    RequestedPlayFromReader: ({ positionMs }) => runPlayer(model, Player.playFrom(positionMs)),

    RequestedOpenSettings: () => ({
      model: {
        ...model,
        isSettingsOpen: true,
        settingsOpens: model.isSettingsOpen ? model.settingsOpens : model.settingsOpens + 1,
      },
    }),
    RequestedCloseSettings: () => ({ model: { ...model, isSettingsOpen: false } }),
    SavedSettings: ({ connection }) => saveSettings(connection)(model),
    ChangedStoredSettings: (settings) => followStoredSettings(settings)(model),

    ClickedPlayPause: () => runPlayer(model, Player.toggle),
    ClickedSkip: ({ deltaMs }) => runPlayer(model, Player.skip(deltaMs)),
    UpdatedScrub: ({ value }) => ({ model: { ...model, maybeScrubMs: Option.some(Number(value)) } }),
    CommittedScrub: ({ value }) => {
      const base = { ...model, maybeScrubMs: Option.none() }
      return Option.match(current(model), {
        onNone: () => ({ model: base }),
        onSome: ({ episode }) => runPlayer(base, Player.seek(scrubTargetMs(episode.chapters, Number(value)))),
      })
    },
    PressedPlayerShortcut: ({ shortcut: name }) => runPlayer(model, Player.shortcut(name)),
    PressedMediaPlay: () => (Player.wantsPlay(playerOf(model)) ? { model } : runPlayer(model, Player.toggle)),
    PressedMediaPause: () => runPlayer(model, Player.wantsPlay(playerOf(model)) ? Player.askPause : Player.cancelPlay),
    PressedMediaSkip: ({ deltaMs }) => runPlayer(model, Player.skip(deltaMs)),
    PressedMediaSeekTo: ({ positionMs }) => runPlayer(model, Player.seek(positionMs)),
    PressedMediaPreviousTrack: () =>
      model.playback._tag === "Loaded"
        ? runPlayer(model, Player.playChapter(Math.max(0, model.playback.chapter - 1)))
        : { model },
    PressedMediaNextTrack: () =>
      Option.match(current(model), {
        onNone: () => ({ model }),
        onSome: ({ playback, episode }) =>
          episode.chapters[playback.chapter + 1] ? runPlayer(model, Player.playChapter(playback.chapter + 1)) : { model },
      }),

    UpdatedAudioTime: ({ offsetMs, atMs }) => runPlayer(model, Player.updateAudioTime(offsetMs, atMs)),
    StartedAudio: () => runPlayer(model, Player.started),
    PausedAudio: () => runPlayer(model, Player.takeOwnPause),
    EndedChapter: () => runPlayer(model, Player.endChapter),
    FailedPlayAudio: () => runPlayer(model, Player.failedPlay),
    GotStoredProgress: ({ episodeId, intent, stored }) => runPlayer(model, Player.startFromStored(episodeId, intent, stored)),

    SavedProgress: ({ episodeId, progress }) => runPlayer(model, Player.takeStamp(episodeId, progress)),
    SucceededPushProgress: ({ episodeId, sent, stored }) => {
      const withServer = setServerProgress(episodeId, stored)(model).model
      return runPlayer(withServer, Player.takePushAnswer(episodeId, sent, stored))
    },
    FailedPushProgress: () => ({ model }),
  })

/**
 * Every Message goes three steps: `handle` changes intent and facts, `reconcile` decides what the audio does, and
 * `reconcileScreen` closes any sub-screen whose backing episode or playback state went away.
 */
export const updateApp = (model: AppModel, message: AppMessage): UpdateResult =>
  combine(model, [
    (model) => handle(model, message),
    (model) => {
      const reconciled = runPlayer(model, Player.reconcile)
      const stopped =
        reconciled.model.playback._tag === "Stopped" &&
        (model.playback._tag === "Loaded" || Option.isSome(model.maybeListening))
      return stopped ? { ...reconciled, model: { ...reconciled.model, maybeScrubMs: Option.none() } } : reconciled
    },
    reconcileScreen,
  ])
