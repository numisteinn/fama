import {
  type ChangeVoice,
  type Document,
  type Episode,
  type EpisodeId,
  type EpisodeProgress,
  type SourceInput,
  type VoiceRef,
  awaitedAfter,
  mergeProgress,
  playStart,
} from "@fama/contracts"
import { Command, type Component } from "@effect/ui"
import { Option, Record, Redacted } from "effect"
import { type Connection, isSameConnection } from "~/api"
import {
  type AudioCommandServices,
  LoadChapter,
  PauseAudio,
  PlayAudio,
  SeekAudio,
  SetAudioRate,
  StopAudio,
} from "~/audio"
import * as Batch from "~/batch"
import {
  type AppCommandServices,
  ChangeNarrateAgainVoice,
  ChangeReviewVoice,
  CreateEpisodeFromSource,
  DeleteEpisode,
  FetchEpisodes,
  FetchVoices,
  NarrateAgainWithDocument,
  PushProgress,
  ReadStoredProgress,
  RetryEpisode,
  SaveDocument,
  SaveProgress,
  StartReviewNarration,
  StoreConnection,
  StoreProgress,
  StoreSetting,
  UploadEpisode,
  WaitBeforeDisarmDelete,
  focusAddText,
  focusDeleteConfirm,
} from "~/command"
import { AppMessage, type PlayerShortcut } from "~/message"
import {
  type AppModel,
  type Flags,
  type Listening,
  type LoadedPlayback,
  Playback,
  RATES,
  SAVE_EVERY_MS,
  SKIP_BACK_MS,
  SKIP_FORWARD_MS,
  SPEEDS,
  Screen,
  StoredProgress,
  current,
  episodes,
  isPlayPending,
  toDraft,
} from "~/model"
import { InvalidateDocument } from "~/queries"
import { hasText } from "~/reader/ReaderScreen"
import { chapterStartMs, locate, scrubTargetMs, totalMs } from "~/timeline"

export type AppServices = AppCommandServices | AudioCommandServices
export type AppCommand = Command.Command<AppMessage | Component.Noop, AppServices>
export type UpdateResult = {
  readonly model: AppModel
  readonly commands: ReadonlyArray<AppCommand>
}
type StepReturn = {
  readonly model: AppModel
  readonly commands?: ReadonlyArray<AppCommand>
}
type Step = (model: AppModel) => StepReturn

const unchanged: Step = (model) => ({ model })

const combine = (model: AppModel, steps: ReadonlyArray<Step>): UpdateResult => {
  let currentModel = model
  const commands: Array<AppCommand> = []
  for (const step of steps) {
    const next = step(currentModel)
    currentModel = next.model
    if (next.commands) commands.push(...next.commands)
  }
  return { model: currentModel, commands }
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

/** A new library request for the current connection, tagged with its generation and its number, and in flight. */
const fetchLibrary = (model: AppModel): { model: AppModel; command: AppCommand } => {
  const request = model.libraryRequests + 1
  return {
    model: {
      ...model,
      libraryRequests: request,
      libraryRequestsInFlight: [...model.libraryRequestsInFlight, request],
    },
    command: FetchEpisodes.make({
      connection: model.connection,
      generation: model.connectionGeneration,
      request,
    }),
  }
}

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

const fetchEpisodes: Step = (model) => {
  const library = fetchLibrary(model)
  return { model: library.model, commands: [library.command] }
}

/** Library request `request` answered: it is no longer in flight. */
const answerLibrary = (model: AppModel, request: number): AppModel => ({
  ...model,
  libraryRequestsInFlight: model.libraryRequestsInFlight.filter((sent) => sent !== request),
})

/** Replaces the episode list. Captures the loaded chapter's duration before replacement so chapter fraction holds. */
const withEpisodes =
  (toEpisodes: (list: ReadonlyArray<Episode>) => ReadonlyArray<Episode>): Step =>
  (model) => {
    const previous = episodes(model)
    const playback = model.playback
    const previousDuration =
      model.loadedChapterDurationMs === null && playback._tag === "Loaded"
        ? (() => {
            const chapter = previous.find((item) => item.id === playback.episodeId)?.chapters[playback.chapter]
            return chapter && chapter.url === playback.url ? chapter.durationMs : null
          })()
        : model.loadedChapterDurationMs
    return {
      model: {
        ...model,
        maybeEpisodes: Option.some(toEpisodes(previous)),
        loadedChapterDurationMs: previousDuration,
      },
    }
  }

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
  return Number.isInteger(index) ? playChapter(index)(model) : { model }
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
    return { model: { ...model, playback: Playback.Loaded({ ...playback, ...fields }) } }
  }

/** What the listener asks of the episode they listen to. */
const setListening =
  (fields: Partial<Listening>): Step =>
  (model) => ({
    model: { ...model, maybeListening: Option.map(model.maybeListening, (listening) => ({ ...listening, ...fields })) },
  })

const isListeningTo = (model: AppModel, episodeId: EpisodeId) =>
  Option.exists(model.maybeListening, (listening) => listening.episodeId === episodeId)

const isSameProgress = (a: EpisodeProgress, b: EpisodeProgress) =>
  a.positionMs === b.positionMs && a.updatedAt === b.updatedAt

/** Where the device holds an episode: the position a save stamps now, else its entry. */
const heldMs = (model: AppModel, episodeId: EpisodeId): number | undefined =>
  model.stamping[episodeId] ?? model.localProgress[episodeId]?.positionMs

// Facts

/** Shows `progress` as the server's on the episode in the list. */
const setServerProgress = (episodeId: EpisodeId, progress: EpisodeProgress): Step => (model) => ({
  model: {
    ...model,
    maybeEpisodes: Option.map(model.maybeEpisodes, (list) =>
      list.map((item) => (item.id === episodeId ? { ...item, progress } : item)),
    ),
  },
})

/**
 * Takes an entry of the server or of storage as the device's, with its stamp, so it never counts as a new listener
 * action. It moves nothing: `reconcile` sees an entry the player does not follow yet.
 */
const takeEntry = (episodeId: EpisodeId, progress: EpisodeProgress): Step => (model) => {
  const local = model.localProgress[episodeId]
  if (local && isSameProgress(local, progress)) return { model }
  return {
    model: { ...model, localProgress: Record.set(model.localProgress, episodeId, progress) },
    commands: [StoreProgress.make({ episodeId, progress })],
  }
}

/**
 * A save stamped and stored: the tab now knows it, and sends it. The stamp is the listener's own, so the player
 * follows it already.
 */
const takeStamp = (episodeId: EpisodeId, progress: EpisodeProgress): Step => (model) => ({
  model: {
    ...model,
    localProgress: Record.set(model.localProgress, episodeId, progress),
    stamping:
      model.stamping[episodeId] === progress.positionMs
        ? Record.remove(model.stamping, episodeId)
        : model.stamping,
    maybeListening: Option.map(model.maybeListening, (listening) =>
      listening.episodeId === episodeId ? { ...listening, maybeFollowedAt: Option.some(progress.updatedAt) } : listening,
    ),
  },
  commands: [PushProgress.make({ connection: model.connection, episodeId, progress })],
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
  return combine(model, [
    setServerProgress(episodeId, stored),
    isLatest ? takeEntry(episodeId, stored) : unchanged,
    isLatest && isOwn
      ? (stepModel) => ({
          model: {
            ...stepModel,
            maybeListening: Option.map(stepModel.maybeListening, (listening) =>
              listening.episodeId === episodeId && Option.contains(listening.maybeFollowedAt, sent.updatedAt)
                ? { ...listening, maybeFollowedAt: Option.some(stored.updatedAt) }
                : listening,
            ),
          },
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
  combine(
    model,
    episodes(model).map((episode): Step => (stepModel) => {
      if (stepModel.stamping[episode.id] !== undefined) return { model: stepModel }
      const local = stepModel.localProgress[episode.id] ?? null
      const { progress, isPushed } = mergeProgress(local, episode.progress)
      if (isPushed && local !== null) {
        return {
          model: stepModel,
          commands: [PushProgress.make({ connection: stepModel.connection, episodeId: episode.id, progress: local })],
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
  const timed: AppModel =
    playback._tag === "Loaded" && playback.isPlaying
      ? { ...model, playback: Playback.Loaded({ ...playback, offsetMs }) }
      : model
  return atMs - model.lastSavedAtMs < SAVE_EVERY_MS
    ? { model: timed }
    : { model: { ...timed, lastSavedAtMs: atMs, isSaveDue: true } }
}

// Intent

/**
 * A playback action of the user. A start still reading storage is no longer the latest intent, and a Play that
 * waits for the library is off.
 */
const intend =
  (step: Step): Step =>
  (model) =>
    step({ ...model, playIntents: model.playIntents + 1, maybePendingPlay: Option.none() })

/** Reads the progress storage holds for an episode, to play it from there. The read carries the latest intent. */
const readThenPlay =
  (episodeId: EpisodeId): Step =>
  (model) => ({ model, commands: [ReadStoredProgress.make({ episodeId, intent: model.playIntents })] })

/**
 * A Play acts. The episode the listener listens to gets a Play to place. Another episode reads its progress from
 * storage first, so a pause in another tab is where it resumes.
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
        model: {
          ...held,
          maybePendingPlay: Option.some({ episodeId, awaiting: held.libraryRequestsInFlight }),
        },
      }))(model)
    : intend(actPlay(episodeId))(model)

/** The listener asks for no playback: of audio that plays, and of a Play that waits for the next chapter. */
const askPause: Step = intend(setListening({ wantsPlay: false, isPlayDue: false }))

/** A Pause while a Play waits for the library: the Play is off. */
const cancelPlay: Step = (model) => (Option.isSome(model.maybePendingPlay) ? intend(unchanged)(model) : { model })

const wantsPlay = (model: AppModel) => Option.exists(model.maybeListening, (listening) => listening.wantsPlay)

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
 * the Play acts, on what the device knows now.
 */
const settlePendingPlay = (request: number, isListed: boolean): Step => (model) =>
  Option.match(model.maybePendingPlay, {
    onNone: () => ({ model }),
    onSome: ({ episodeId, awaiting }) => {
      const stillAwaiting = awaitedAfter(awaiting, request, isListed)
      return stillAwaiting.length > 0
        ? { model: { ...model, maybePendingPlay: Option.some({ episodeId, awaiting: stillAwaiting }) } }
        : actPlay(episodeId)({ ...model, maybePendingPlay: Option.none() })
    },
  })

/**
 * The storage read of a start came back. The device's entry is the newer of what storage holds and the server's;
 * with neither, it has none. Only when storage cannot be read is the entry this tab knows used. Then the listener
 * listens to this episode, with a Play to place.
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
    const known: Step =
      progress !== null
        ? takeEntry(episodeId, progress)
        : (stepModel) => ({ model: { ...stepModel, localProgress: Record.remove(stepModel.localProgress, episodeId) } })
    return combine(model, [
      known,
      (stepModel) => ({
        model: {
          ...stepModel,
          maybeListening: Option.some({
            episodeId,
            wantsPlay: true,
            isPlayDue: true,
            maybeSeekMs: Option.none(),
            maybeFollowedAt: Option.none(),
          }),
        },
      }),
    ])
  }

/** The listener moves to `ms` on the episode timeline. `reconcile` moves the audio there and saves the place. */
const seek = (ms: number): Step => withLoaded(() => intend(setListening({ maybeSeekMs: Option.some(ms) })))

const skip = (deltaMs: number): Step =>
  withLoaded(({ playback, episode }) => seek(globalMs(playback, episode) + deltaMs))

/** The listener moves to `ms` on the episode timeline, and playback goes on from there. */
const playFrom = (ms: number): Step =>
  withLoaded(() => intend(setListening({ maybeSeekMs: Option.some(ms), wantsPlay: true, isPlayDue: false })))

/** The listener picks a chapter: a move to its start, and playback from there. */
const playChapter = (index: number): Step =>
  withLoaded(({ episode }) => (episode.chapters[index] ? playFrom(chapterStartMs(episode.chapters, index)) : unchanged))

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

// SUB-SCREENS

const openReview = (episodeId: EpisodeId): Step => (model) => {
  const episode = episodes(model).find((item) => item.id === episodeId)
  if (!episode || episode.job._tag !== "Review") return { model }
  const openId = model.screenOpens + 1
  const existingSave = model.reviewSaves[episodeId]
  const reviewSaves =
    existingSave !== undefined && !existingSave.isSaving
      ? Record.remove(model.reviewSaves, episodeId)
      : existingSave !== undefined
        ? Record.set(model.reviewSaves, episodeId, { ...existingSave, maybeError: Option.none() })
        : model.reviewSaves
  const existingStart = model.reviewStarts[episodeId]
  const reviewStarts =
    existingStart !== undefined && !existingStart.isStarting
      ? Record.remove(model.reviewStarts, episodeId)
      : model.reviewStarts
  return {
    model: {
      ...model,
      screen: Screen.Review({ episodeId, openId }),
      screenOpens: openId,
      maybeReaderEpisodeId: Option.none(),
      reviewSaves,
      reviewStarts,
    },
    commands:
      model.voices.length === 0
        ? [FetchVoices.make({ connection: model.connection, generation: model.connectionGeneration })]
        : [],
  }
}

const openNarrateAgain = (episodeId: EpisodeId): Step => (model) => {
  const episode = episodes(model).find((item) => item.id === episodeId)
  if (!episode || (episode.job._tag !== "Ready" && episode.job._tag !== "Failed")) return { model }
  const openId = model.screenOpens + 1
  const existing = model.narrateAgainSubmits[episodeId]
  const narrateAgainSubmits =
    existing !== undefined && !existing.isSubmitting
      ? Record.remove(model.narrateAgainSubmits, episodeId)
      : model.narrateAgainSubmits
  return {
    model: {
      ...model,
      screen: Screen.NarrateAgain({ episodeId, openId }),
      screenOpens: openId,
      maybeReaderEpisodeId: Option.none(),
      narrateAgainSubmits,
    },
    commands:
      model.voices.length === 0
        ? [FetchVoices.make({ connection: model.connection, generation: model.connectionGeneration })]
        : [],
  }
}

const toggleReader: Step = (model) => {
  if (Option.isSome(model.maybeReaderEpisodeId)) {
    return { model: { ...model, maybeReaderEpisodeId: Option.none() } }
  }
  return Option.match(current(model), {
    onNone: () => ({ model }),
    onSome: ({ episode }) =>
      hasText(episode)
        ? {
            model: {
              ...model,
              maybeReaderEpisodeId: Option.some(episode.id),
              // Opening Read-along closes Narrate again, while keeping Review mounted behind it.
              screen: model.screen._tag === "NarrateAgain" ? Screen.Library() : model.screen,
            },
          }
        : { model },
  })
}

const submitSaveReview =
  (episodeId: EpisodeId, document: Document): Step =>
  (model) => {
    const command = SaveDocument.make({ connection: model.connection, episodeId, document }).pipe(
      Command.match({
        onSuccess: (saved) => AppMessage.SucceededSaveReview({ episodeId, document: saved }),
        onFailure: (failure) => AppMessage.FailedSaveReview({ episodeId, failure }),
      }),
    )
    const previousSaved = model.reviewSaves[episodeId]?.maybeSavedDocument ?? Option.none()
    const existingStart = model.reviewStarts[episodeId]
    return {
      model: {
        ...model,
        reviewSaves: Record.set(model.reviewSaves, episodeId, {
          isSaving: true,
          maybePendingDocument: Option.some(document),
          maybeSavedDocument: previousSaved,
          maybeError: Option.none(),
        }),
        reviewStarts:
          existingStart !== undefined && !existingStart.isStarting
            ? Record.remove(model.reviewStarts, episodeId)
            : model.reviewStarts,
      },
      commands: [command],
    }
  }

const submitStartReview =
  (episodeId: EpisodeId, document: Document, voice?: VoiceRef): Step =>
  (model) => {
    const command = StartReviewNarration.make({
      connection: model.connection,
      episodeId,
      document,
      ...(voice !== undefined ? { voice } : {}),
    }).pipe(
      Command.match({
        onSuccess: (episode) => AppMessage.SucceededStartReview({ episode }),
        onFailure: (failure) => AppMessage.FailedStartReview({ episodeId, failure }),
      }),
    )
    const existingSave = model.reviewSaves[episodeId]
    return {
      model: {
        ...model,
        reviewStarts: Record.set(model.reviewStarts, episodeId, {
          isStarting: true,
          maybeError: Option.none(),
        }),
        reviewSaves:
          existingSave !== undefined
            ? Record.set(model.reviewSaves, episodeId, { ...existingSave, maybeError: Option.none() })
            : model.reviewSaves,
      },
      commands: [command],
    }
  }

const submitNarrateAgainText =
  (episodeId: EpisodeId, document: Document): Step =>
  (model) => {
    const command = NarrateAgainWithDocument.make({ connection: model.connection, episodeId, document }).pipe(
      Command.match({
        onSuccess: () => AppMessage.SucceededNarrateAgain({ episodeId }),
        onFailure: (failure) => AppMessage.FailedNarrateAgain({ episodeId, target: "text", failure }),
      }),
    )
    return {
      model: {
        ...model,
        narrateAgainSubmits: Record.set(model.narrateAgainSubmits, episodeId, {
          target: "text" as const,
          isSubmitting: true,
          maybeError: Option.none(),
        }),
      },
      commands: [command],
    }
  }

const submitNarrateAgainVoice =
  (episodeId: EpisodeId, input: typeof ChangeVoice.Type): Step =>
  (model) => {
    const command = ChangeNarrateAgainVoice.make({ connection: model.connection, episodeId, input }).pipe(
      Command.match({
        onSuccess: () => AppMessage.SucceededNarrateAgain({ episodeId }),
        onFailure: (failure) => AppMessage.FailedNarrateAgain({ episodeId, target: "voice", failure }),
      }),
    )
    return {
      model: {
        ...model,
        narrateAgainSubmits: Record.set(model.narrateAgainSubmits, episodeId, {
          target: "voice" as const,
          isSubmitting: true,
          maybeError: Option.none(),
        }),
      },
      commands: [command],
    }
  }

/** Closes a sub-screen or Read-along when its backing episode or playback state no longer supports it. */
const reconcileScreen: Step = (model) => {
  let screen = model.screen
  switch (screen._tag) {
    case "Library":
      break
    case "Review": {
      const id = screen.episodeId
      const episode = episodes(model).find((item) => item.id === id)
      if (!episode || episode.job._tag !== "Review") screen = Screen.Library()
      break
    }
    case "NarrateAgain": {
      const id = screen.episodeId
      const episode = episodes(model).find((item) => item.id === id)
      if (!episode || (episode.job._tag !== "Ready" && episode.job._tag !== "Failed")) screen = Screen.Library()
      break
    }
  }

  const maybeReaderEpisodeId = Option.filter(model.maybeReaderEpisodeId, (id) =>
    Option.exists(current(model), ({ episode }) => episode.id === id && hasText(episode)),
  )
  const isInReview = (id: string) =>
    episodes(model).some((episode) => episode.id === id && episode.job._tag === "Review")
  const canNarrateAgain = (id: string) =>
    episodes(model).some(
      (episode) => episode.id === id && (episode.job._tag === "Ready" || episode.job._tag === "Failed"),
    )
  const filterRecord = <T>(record: Record<string, T>, keep: (id: string) => boolean): Record<string, T> => {
    let changed = false
    for (const id of Object.keys(record)) {
      if (!keep(id)) {
        changed = true
        break
      }
    }
    if (!changed) return record
    const next: Record<string, T> = {}
    for (const [id, value] of Object.entries(record)) {
      if (keep(id)) next[id] = value
    }
    return next
  }
  const reviewSaves = filterRecord(model.reviewSaves, isInReview)
  const reviewVoices = filterRecord(model.reviewVoices, isInReview)
  const reviewStarts = filterRecord(model.reviewStarts, isInReview)
  const narrateAgainSubmits = filterRecord(model.narrateAgainSubmits, canNarrateAgain)

  return screen === model.screen &&
    Option.getOrNull(maybeReaderEpisodeId) === Option.getOrNull(model.maybeReaderEpisodeId) &&
    reviewSaves === model.reviewSaves &&
    reviewVoices === model.reviewVoices &&
    reviewStarts === model.reviewStarts &&
    narrateAgainSubmits === model.narrateAgainSubmits
    ? { model }
    : {
        model: {
          ...model,
          screen,
          maybeReaderEpisodeId,
          reviewSaves,
          reviewVoices,
          reviewStarts,
          narrateAgainSubmits,
        },
      }
}

// RECONCILE

const isSamePlayback = (a: Playback, b: Playback) =>
  a._tag === "Stopped" || b._tag === "Stopped"
    ? a._tag === b._tag
    : a.episodeId === b.episodeId &&
      a.chapter === b.chapter &&
      a.url === b.url &&
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
    return model.isSaveDue ? { model: { ...model, isSaveDue: false } } : { model }
  }
  return {
    model: {
      ...model,
      playback: Playback.Stopped(),
      loadedChapterDurationMs: null,
      maybeListening: Option.none(),
      isSaveDue: false,
      maybeScrubMs: Option.none(),
    },
    commands: model.playback._tag === "Loaded" ? [StopAudio.make({})] : [],
  }
}

/**
 * The one step that decides playback. Runs after every Message, on the Model alone. From the intent and the
 * facts it works out the target (the episode, the chapter, the offset, and playing, paused or waiting), compares
 * it with what the audio element has, and returns at most one audio Command and at most one save.
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
  const here = playback._tag === "Loaded" && playback.episodeId === episode.id ? playback : undefined
  const left = playback._tag === "Loaded" && playback.episodeId !== episode.id ? playback : undefined
  const heardMs = here ? globalMs(here, episode) : undefined
  const entry = model.localProgress[episode.id]
  const isStamping = model.stamping[episode.id] !== undefined
  const maybeSeekMs = Option.map(listening.maybeSeekMs, (ms) => Math.min(Math.max(0, ms), lengthMs))
  const isSeek = Option.isSome(maybeSeekMs)
  const isOn = here !== undefined && here.isPlaying && listening.wantsPlay && !listening.isPlayDue

  // Where the listener is.
  const hasNews = !isStamping && entry !== undefined && !Option.contains(listening.maybeFollowedAt, entry.updatedAt)
  const isMovedToEntry = !isSeek && !isOn && heardMs !== undefined && hasNews
  const positionMs = Option.getOrElse(maybeSeekMs, () =>
    heardMs === undefined ? (heldMs(model, episode.id) ?? 0) : isMovedToEntry && entry ? entry.positionMs : heardMs,
  )
  const isReached = isOn || isSeek || entry === undefined || entry.positionMs <= lengthMs
  const maybeFollowedAt = isStamping || !isReached ? listening.maybeFollowedAt : Option.fromNullishOr(entry?.updatedAt)

  // What the audio does there.
  const startState = playStart(positionMs, chapters, job)
  const isStart = listening.isPlayDue || (listening.wantsPlay && isMovedToEntry)
  const isOver = listening.wantsPlay && !(isOn && !isSeek) && !startState.isWaiting && !isStart && positionMs >= lengthMs
  const mode: "Playing" | "Waiting" | "Paused" =
    !listening.wantsPlay || isOver ? "Paused" : isOn && !isSeek ? "Playing" : startState.isWaiting ? "Waiting" : "Playing"
  const placeMs = mode === "Playing" && isStart ? startState.positionMs : positionMs

  // Where the audio must be.
  const listed = here !== undefined ? chapters[here.chapter] : undefined
  const isReplaced = here !== undefined && listed !== undefined && listed.url !== here.url
  const isPlaced = here === undefined || isSeek || isMovedToEntry || isReplaced || (mode === "Playing" && !(isOn && !isSeek))
  const replacedTarget =
    isReplaced && !isSeek && !isMovedToEntry && !(mode === "Playing" && isStart)
      ? {
          index: here.chapter,
          offsetMs:
            model.loadedChapterDurationMs !== null && model.loadedChapterDurationMs > 0
              ? Math.min(listed.durationMs, Math.round((here.offsetMs / model.loadedChapterDurationMs) * listed.durationMs))
              : Math.min(listed.durationMs, here.offsetMs),
        }
      : undefined
  const target =
    replacedTarget ?? (isPlaced || here === undefined ? locate(chapters, placeMs) : { index: here.chapter, offsetMs: here.offsetMs })
  const file = chapters[target.index]
  const hasFile = isPlaced ? file !== undefined : true
  const isPlaying = mode === "Playing" && hasFile

  // At most one audio Command, and it is absolute.
  const load = (chapter: { readonly url: string }) =>
    LoadChapter.make({
      src: model.connection.origin + chapter.url,
      offsetMs: target.offsetMs,
      rate: model.rate,
      isAutoplay: isPlaying,
    })
  const audio: ReadonlyArray<AppCommand> =
    file === undefined || !isPlaced
      ? here !== undefined && here.isPlaying !== isPlaying && hasFile
        ? [isPlaying ? PlayAudio.make({}) : PauseAudio.make({})]
        : here?.isPlaying && !hasFile
          ? [PauseAudio.make({})]
          : []
      : here === undefined || here.chapter !== target.index || here.url !== file.url
        ? [load(file)]
        : Math.abs(here.offsetMs - target.offsetMs) >= 1
          ? [isPlaying === here.isPlaying && !isStart ? SeekAudio.make({ offsetMs: target.offsetMs }) : load(file)]
          : isPlaying === here.isPlaying
            ? []
            : [isPlaying ? PlayAudio.make({}) : PauseAudio.make({})]

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
          url: file?.url ?? here?.url ?? "",
          offsetMs: target.offsetMs,
          isPlaying,
          isWaiting: mode === "Waiting",
        })
  const nextLoadedDurationMs =
    nextPlayback._tag === "Loaded"
      ? (file !== undefined && file.url === nextPlayback.url ? file.durationMs : model.loadedChapterDurationMs)
      : null
  const nextListening: Listening = {
    episodeId: episode.id,
    wantsPlay: listening.wantsPlay && !isOver,
    isPlayDue: false,
    maybeSeekMs: Option.none(),
    maybeFollowedAt,
  }
  const isUnchanged =
    isSamePlayback(playback, nextPlayback) &&
    isSameListening(listening, nextListening) &&
    model.loadedChapterDurationMs === nextLoadedDurationMs &&
    !model.isSaveDue &&
    !stamp
  return {
    model: isUnchanged
      ? model
      : {
          ...model,
          playback: isSamePlayback(playback, nextPlayback) ? playback : nextPlayback,
          loadedChapterDurationMs: nextLoadedDurationMs,
          maybeListening: isSameListening(listening, nextListening) ? model.maybeListening : Option.some(nextListening),
          isSaveDue: false,
          stamping: stamp
            ? Record.set(model.stamping, stamp.episodeId, Math.max(0, Math.round(stamp.positionMs)))
            : model.stamping,
        },
    commands: [...(stamp ? [SaveProgress.make(stamp)] : []), ...audio],
  }
}

// UPDATE

/** Changes intent and facts for `message`. It sends no audio Command and stamps nothing: `reconcile` does. */
const handle = (model: AppModel, message: AppMessage): StepReturn =>
  AppMessage.match(message, {
    SucceededFetchEpisodes: ({ generation, request, episodes: list }) => {
      const isListed = isCurrent(model, generation)
      const answered = answerLibrary(model, request)
      return isListed
        ? combine({ ...answered, maybeLibraryFailure: Option.none() }, [
            withEpisodes(() => list),
            syncProgress,
            settlePendingPlay(request, true),
          ])
        : settlePendingPlay(request, false)(answered)
    },
    FailedFetchEpisodes: ({ generation, request, failure }) => {
      const answered = answerLibrary(model, request)
      if (!isCurrent(model, generation)) return settlePendingPlay(request, false)(answered)
      const wasUnauthorized = Option.exists(model.maybeLibraryFailure, (previous) => previous.status === 401)
      const autoOpen = failure.status === 401 && !wasUnauthorized && !answered.isSettingsOpen
      const withFailure: AppModel = {
        ...answered,
        maybeLibraryFailure: Option.some(failure),
        isSettingsOpen: failure.status === 401 && !wasUnauthorized ? true : answered.isSettingsOpen,
        settingsOpens: autoOpen ? answered.settingsOpens + 1 : answered.settingsOpens,
      }
      return settlePendingPlay(request, false)(withFailure)
    },
    SucceededFetchVoices: ({ generation, voices }) =>
      isCurrent(model, generation) ? { model: { ...model, voices } } : { model },
    FailedFetchVoices: () => ({ model }),
    ClickedTryAgain: () => fetchEpisodes(model),
    TickedPoll: () => fetchEpisodes(model),
    BecameVisible: () => fetchEpisodes(model),
    HidPage: () => ({ model: { ...model, isSaveDue: true } }),

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
        onSome: (episode) => start(episode)(model),
      }),
    ClickedOpenReview: ({ episodeId }) => openReview(episodeId)(model),
    ClickedOpenNarrateAgain: ({ episodeId }) => openNarrateAgain(episodeId)(model),
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

    ClosedSubScreen: () => {
      let reviewSaves = model.reviewSaves
      let reviewStarts = model.reviewStarts
      let narrateAgainSubmits = model.narrateAgainSubmits
      if (model.screen._tag === "Review") {
        const id = model.screen.episodeId
        const existingSave = reviewSaves[id]
        if (existingSave !== undefined && !existingSave.isSaving) {
          reviewSaves = Record.remove(reviewSaves, id)
        }
        const existingStart = reviewStarts[id]
        if (existingStart !== undefined && !existingStart.isStarting) {
          reviewStarts = Record.remove(reviewStarts, id)
        }
      } else if (model.screen._tag === "NarrateAgain") {
        const id = model.screen.episodeId
        const existing = narrateAgainSubmits[id]
        if (existing !== undefined && !existing.isSubmitting) {
          narrateAgainSubmits = Record.remove(narrateAgainSubmits, id)
        }
      }
      return {
        model: {
          ...model,
          screen: Screen.Library(),
          reviewSaves,
          reviewStarts,
          narrateAgainSubmits,
        },
      }
    },
    SubmittedSaveReview: ({ episodeId, document }) => submitSaveReview(episodeId, document)(model),
    SucceededSaveReview: ({ episodeId, document }) => ({
      model: {
        ...model,
        reviewSaves:
          model.screen._tag === "Review" && model.screen.episodeId === episodeId
            ? Record.set(model.reviewSaves, episodeId, {
                isSaving: false,
                maybePendingDocument: Option.none(),
                maybeSavedDocument: Option.some(document),
                maybeError: Option.none(),
              })
            : Record.remove(model.reviewSaves, episodeId),
      },
      commands: [InvalidateDocument.make({})],
    }),
    FailedSaveReview: ({ episodeId, failure }) => {
      const previousSaved = model.reviewSaves[episodeId]?.maybeSavedDocument ?? Option.none()
      return {
        model: {
          ...model,
          reviewSaves:
            model.screen._tag === "Review" && model.screen.episodeId === episodeId
              ? Record.set(model.reviewSaves, episodeId, {
                  isSaving: false,
                  maybePendingDocument: Option.none(),
                  maybeSavedDocument: previousSaved,
                  maybeError: Option.some(failure.message),
                })
              : Record.remove(model.reviewSaves, episodeId),
        },
      }
    },
    SubmittedStartReview: ({ episodeId, document, voice }) => submitStartReview(episodeId, document, voice)(model),
    SucceededStartReview: ({ episode }) =>
      combine(
        {
          ...model,
          screen:
            model.screen._tag === "Review" && model.screen.episodeId === episode.id
              ? Screen.Library()
              : model.screen,
          reviewSaves: Record.remove(model.reviewSaves, episode.id),
          reviewVoices: Record.remove(model.reviewVoices, episode.id),
          reviewStarts: Record.remove(model.reviewStarts, episode.id),
        },
        [
          withEpisodes((list) => list.map((item) => (item.id === episode.id ? episode : item))),
          (stepModel) => ({
            model: stepModel,
            commands: [InvalidateDocument.make({})],
          }),
        ],
      ),
    FailedStartReview: ({ episodeId, failure }) => ({
      model: {
        ...model,
        reviewStarts:
          model.screen._tag === "Review" && model.screen.episodeId === episodeId
            ? Record.set(model.reviewStarts, episodeId, {
                isStarting: false,
                maybeError: Option.some(failure.message),
              })
            : Record.remove(model.reviewStarts, episodeId),
      },
    }),
    ClearedReviewError: ({ episodeId }) => {
      const existingSave = model.reviewSaves[episodeId]
      const existingStart = model.reviewStarts[episodeId]
      return {
        model: {
          ...model,
          reviewSaves:
            existingSave !== undefined
              ? Record.set(model.reviewSaves, episodeId, { ...existingSave, maybeError: Option.none() })
              : model.reviewSaves,
          reviewStarts:
            existingStart !== undefined && !existingStart.isStarting
              ? Record.remove(model.reviewStarts, episodeId)
              : model.reviewStarts,
        },
      }
    },
    RequestedChangeReviewVoice: ({ episodeId, voice, speed }) => {
      const existing = model.reviewVoices[episodeId]
      if (existing !== undefined && existing.isSaving) {
        return {
          model: {
            ...model,
            reviewVoices: Record.set(model.reviewVoices, episodeId, {
              ...existing,
              voice,
              maybeQueued: Option.some({ voice, speed, origin: model.connection.origin }),
              maybeError: Option.none(),
            }),
          },
        }
      }
      const request = model.reviewVoiceRequests + 1
      return {
        model: {
          ...model,
          reviewVoiceRequests: request,
          reviewVoices: Record.set(model.reviewVoices, episodeId, {
            request,
            voice,
            isSaving: true,
            maybeQueued: Option.none(),
            maybeError: Option.none(),
          }),
        },
        commands: [ChangeReviewVoice.make({ connection: model.connection, episodeId, request, voice, speed })],
      }
    },
    SucceededChangeReviewVoice: ({ episodeId, origin, request, voice, speed }) => {
      const currentVoice = model.reviewVoices[episodeId]
      const applyEpisode: Step =
        origin === model.connection.origin
          ? withEpisodes((list) =>
              list.map((item) =>
                item.id === episodeId && item.job._tag === "Review" ? { ...item, voice, speed } : item,
              ),
            )
          : unchanged
      if (currentVoice === undefined || currentVoice.request !== request) {
        return applyEpisode(model)
      }
      return Option.match(currentVoice.maybeQueued, {
        onNone: () =>
          combine({ ...model, reviewVoices: Record.remove(model.reviewVoices, episodeId) }, [applyEpisode]),
        onSome: (queued) => {
          if (queued.origin !== model.connection.origin) {
            return combine({ ...model, reviewVoices: Record.remove(model.reviewVoices, episodeId) }, [applyEpisode])
          }
          const nextRequest = model.reviewVoiceRequests + 1
          return combine(
            {
              ...model,
              reviewVoiceRequests: nextRequest,
              reviewVoices: Record.set(model.reviewVoices, episodeId, {
                request: nextRequest,
                voice: queued.voice,
                isSaving: true,
                maybeQueued: Option.none(),
                maybeError: Option.none(),
              }),
            },
            [
              applyEpisode,
              (stepModel) => ({
                model: stepModel,
                commands: [
                  ChangeReviewVoice.make({
                    connection: stepModel.connection,
                    episodeId,
                    request: nextRequest,
                    voice: queued.voice,
                    speed: queued.speed,
                  }),
                ],
              }),
            ],
          )
        },
      })
    },
    FailedChangeReviewVoice: ({ episodeId, request, voice, failure }) => {
      const currentVoice = model.reviewVoices[episodeId]
      if (currentVoice === undefined || currentVoice.request !== request) return { model }
      return Option.match(currentVoice.maybeQueued, {
        onNone: () => ({
          model: {
            ...model,
            reviewVoices: Record.set(model.reviewVoices, episodeId, {
              request,
              voice,
              isSaving: false,
              maybeQueued: Option.none(),
              maybeError: Option.some(failure.message),
            }),
          },
        }),
        onSome: (queued) => {
          if (queued.origin !== model.connection.origin) {
            return { model: { ...model, reviewVoices: Record.remove(model.reviewVoices, episodeId) } }
          }
          const nextRequest = model.reviewVoiceRequests + 1
          return {
            model: {
              ...model,
              reviewVoiceRequests: nextRequest,
              reviewVoices: Record.set(model.reviewVoices, episodeId, {
                request: nextRequest,
                voice: queued.voice,
                isSaving: true,
                maybeQueued: Option.none(),
                maybeError: Option.none(),
              }),
            },
            commands: [
              ChangeReviewVoice.make({
                connection: model.connection,
                episodeId,
                request: nextRequest,
                voice: queued.voice,
                speed: queued.speed,
              }),
            ],
          }
        },
      })
    },
    RequestedPauseMainPlayback: () => askPause(model),
    SubmittedNarrateAgainText: ({ episodeId, document }) => submitNarrateAgainText(episodeId, document)(model),
    SubmittedNarrateAgainVoice: ({ episodeId, input }) => submitNarrateAgainVoice(episodeId, input)(model),
    SucceededNarrateAgain: ({ episodeId }) =>
      combine(
        {
          ...model,
          screen:
            model.screen._tag === "NarrateAgain" && model.screen.episodeId === episodeId
              ? Screen.Library()
              : model.screen,
          narrateAgainSubmits: Record.remove(model.narrateAgainSubmits, episodeId),
        },
        [
          fetchEpisodes,
          (stepModel) => ({
            model: stepModel,
            commands: [InvalidateDocument.make({})],
          }),
        ],
      ),
    FailedNarrateAgain: ({ episodeId, target, failure }) => {
      const nextModel: AppModel = {
        ...model,
        narrateAgainSubmits:
          model.screen._tag === "NarrateAgain" && model.screen.episodeId === episodeId
            ? Record.set(model.narrateAgainSubmits, episodeId, {
                target,
                isSubmitting: false,
                maybeError: Option.some(failure.message),
              })
            : Record.remove(model.narrateAgainSubmits, episodeId),
      }
      return failure.status === 409 || failure.status === 404 ? fetchEpisodes(nextModel) : { model: nextModel }
    },
    ClearedNarrateAgainError: ({ episodeId, target }) => {
      const existing = model.narrateAgainSubmits[episodeId]
      return existing !== undefined && !existing.isSubmitting && existing.target === target
        ? { model: { ...model, narrateAgainSubmits: Record.remove(model.narrateAgainSubmits, episodeId) } }
        : { model }
    },
    ClickedToggleReader: () => toggleReader(model),
    RequestedPlayFromReader: ({ positionMs }) => playFrom(positionMs)(model),

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

    ClickedPlayPause: () => toggle(model),
    ClickedSkip: ({ deltaMs }) => skip(deltaMs)(model),
    UpdatedScrub: ({ value }) => ({ model: { ...model, maybeScrubMs: Option.some(Number(value)) } }),
    CommittedScrub: ({ value }) =>
      withLoaded(({ episode }) => seek(scrubTargetMs(episode.chapters, Number(value))))({
        ...model,
        maybeScrubMs: Option.none(),
      }),
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
    FailedPlayAudio: () =>
      combine(model, [setPlayback({ isPlaying: false }), setListening({ wantsPlay: false, isPlayDue: false })]),
    GotStoredProgress: ({ episodeId, intent, stored }) => startFromStored(episodeId, intent, stored)(model),

    SavedProgress: ({ episodeId, progress }) => takeStamp(episodeId, progress)(model),
    SucceededPushProgress: ({ episodeId, sent, stored }) => takePushAnswer(episodeId, sent, stored)(model),
    FailedPushProgress: () => ({ model }),
  })

/**
 * Every Message goes three steps: `handle` changes intent and facts, `reconcile` decides what the audio does, and
 * `reconcileScreen` closes any sub-screen whose backing episode or playback state went away.
 */
export const updateApp = (model: AppModel, message: AppMessage): UpdateResult =>
  combine(model, [(startModel) => handle(startModel, message), reconcile, reconcileScreen])
