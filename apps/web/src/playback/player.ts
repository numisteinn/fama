import {
  type Episode,
  type EpisodeId,
  type EpisodeProgress,
  awaitedAfter,
  mergeProgress,
  playStart,
} from "@fama/contracts"
import { Command, type Component } from "@effect/ui"
import { Option, Record } from "effect"
import { type Connection } from "~/core/api"
import {
  type AudioCommandServices,
  type AudioFailure,
  LoadChapter,
  PauseAudio,
  PlayAudio,
  SeekAudio,
  StopAudio,
} from "~/core/audio"
import { StoredProgress } from "~/core/flags"
import { chapterStartMs, locate, totalMs } from "~/core/timeline"
import {
  type Listening,
  type LoadedPlayback,
  Playback,
  type PlaybackState,
  SAVE_EVERY_MS,
  SKIP_BACK_MS,
  SKIP_FORWARD_MS,
  type PlayerShortcut,
  currentPlayback,
  isPlayPending,
} from "~/playback/model"

/**
 * The slice of the App the player owns, plus the read-only facts it needs. The App extracts it, runs the steps of
 * this module, and merges the owned fields back. The player never sees the App's Message or Model.
 */
export interface Player extends PlaybackState {
  readonly episodes: ReadonlyArray<Episode>
  readonly connection: Connection
  readonly rate: number
  readonly libraryRequestsInFlight: ReadonlyArray<number>
}

/** An audio Command the player can issue directly: the audio layer's own Commands, needing nothing from the App. */
type PlayerCommand = Command.Command<AudioFailure | Component.Noop, AudioCommandServices>

/**
 * A progress write the player needs but cannot issue itself: the App translates these to its own Commands, which
 * carry its Message.
 */
export type ProgressEffect =
  | { readonly _tag: "SaveProgress"; readonly episodeId: EpisodeId; readonly positionMs: number }
  | { readonly _tag: "StoreProgress"; readonly episodeId: EpisodeId; readonly progress: EpisodeProgress }
  | { readonly _tag: "PushProgress"; readonly episodeId: EpisodeId; readonly progress: EpisodeProgress }
  | { readonly _tag: "ReadStoredProgress"; readonly episodeId: EpisodeId; readonly intent: number }

export interface PlayerResult {
  readonly player: Player
  readonly commands: ReadonlyArray<PlayerCommand>
  readonly progress: ReadonlyArray<ProgressEffect>
}

type PlayerStep = (player: Player) => PlayerResult

const unchanged: PlayerStep = (player) => ({ player, commands: [], progress: [] })

const sequence = (player: Player, steps: ReadonlyArray<PlayerStep>): PlayerResult => {
  let current = player
  const commands: Array<PlayerCommand> = []
  const progress: Array<ProgressEffect> = []
  for (const step of steps) {
    const next = step(current)
    current = next.player
    commands.push(...next.commands)
    progress.push(...next.progress)
  }
  return { player: current, commands, progress }
}

// FACTS

const globalMs = (playback: LoadedPlayback, episode: Episode) =>
  chapterStartMs(episode.chapters, playback.chapter) + playback.offsetMs

const current = (player: Player) => currentPlayback(player.playback, player.episodes)

const isListeningTo = (player: Player, episodeId: EpisodeId) =>
  Option.exists(player.maybeListening, (listening) => listening.episodeId === episodeId)

const isSameProgress = (a: EpisodeProgress, b: EpisodeProgress) =>
  a.positionMs === b.positionMs && a.updatedAt === b.updatedAt

/** Where the device holds an episode: the position a save stamps now, else its entry. */
const heldMs = (player: Player, episodeId: EpisodeId): number | undefined =>
  player.stamping[episodeId] ?? player.localProgress[episodeId]?.positionMs

const withLoaded = (toStep: (loaded: { playback: LoadedPlayback; episode: Episode }) => PlayerStep): PlayerStep => (player) =>
  Option.match(current(player), { onNone: () => unchanged(player), onSome: (loaded) => toStep(loaded)(player) })

/** A fact from the audio element. */
const setPlayback = (fields: Partial<Omit<LoadedPlayback, "_tag">>): PlayerStep => (player) => {
  const playback = player.playback
  if (playback._tag !== "Loaded") return unchanged(player)
  return { player: { ...player, playback: Playback.Loaded({ ...playback, ...fields }) }, commands: [], progress: [] }
}

/** What the listener asks of the episode they listen to. */
const setListening = (fields: Partial<Listening>): PlayerStep => (player) => ({
  player: { ...player, maybeListening: Option.map(player.maybeListening, (listening) => ({ ...listening, ...fields })) },
  commands: [],
  progress: [],
})

// PROGRESS SYNC

/**
 * Takes an entry of the server or of storage as the device's, with its stamp, so it never counts as a new listener
 * action. It moves nothing: `reconcile` sees an entry the player does not follow yet.
 */
const takeEntry = (episodeId: EpisodeId, progress: EpisodeProgress): PlayerStep => (player) => {
  const local = player.localProgress[episodeId]
  if (local && isSameProgress(local, progress)) return unchanged(player)
  return {
    player: { ...player, localProgress: Record.set(player.localProgress, episodeId, progress) },
    commands: [],
    progress: [{ _tag: "StoreProgress", episodeId, progress }],
  }
}

/**
 * A save stamped and stored: the tab now knows it, and sends it. The stamp is the listener's own, so the player
 * follows it already.
 */
const takeStamp = (episodeId: EpisodeId, progress: EpisodeProgress): PlayerStep => (player) => ({
  player: {
    ...player,
    localProgress: Record.set(player.localProgress, episodeId, progress),
    stamping:
      player.stamping[episodeId] === progress.positionMs ? Record.remove(player.stamping, episodeId) : player.stamping,
    maybeListening: Option.map(player.maybeListening, (listening) =>
      listening.episodeId === episodeId ? { ...listening, maybeFollowedAt: Option.some(progress.updatedAt) } : listening,
    ),
  },
  commands: [],
  progress: [{ _tag: "PushProgress", episodeId, progress }],
})

/**
 * The server answered a push with what it stores. The device takes that answer, a clamped stamp included, unless
 * the listener saved again since: that newer save goes out with its own push. The same position with the server's
 * stamp is still the listener's own entry. Another position is news from another device. The App applies the
 * server's progress to the list before this step.
 */
const takePushAnswer = (episodeId: EpisodeId, sent: EpisodeProgress, stored: EpisodeProgress): PlayerStep => (player) => {
  const local = player.localProgress[episodeId]
  const isLatest = local !== undefined && isSameProgress(local, sent)
  const isOwn = stored.positionMs === sent.positionMs
  return sequence(player, [
    isLatest ? takeEntry(episodeId, stored) : unchanged,
    isLatest && isOwn
      ? (stepPlayer) => ({
          player: {
            ...stepPlayer,
            maybeListening: Option.map(stepPlayer.maybeListening, (listening) =>
              listening.episodeId === episodeId && Option.contains(listening.maybeFollowedAt, sent.updatedAt)
                ? { ...listening, maybeFollowedAt: Option.some(stored.updatedAt) }
                : listening,
            ),
          },
          commands: [],
          progress: [],
        })
      : unchanged,
  ])
}

/**
 * After a library load: each local entry newer than the server's is sent, so listening done offline syncs, and
 * each newer server entry is taken. Nothing is stamped. An episode whose save is being stamped is left alone: that
 * stamp is newer than both, and goes out when it lands.
 */
const syncProgress: PlayerStep = (player) =>
  sequence(
    player,
    player.episodes.map((episode): PlayerStep => (stepPlayer) => {
      if (stepPlayer.stamping[episode.id] !== undefined) return unchanged(stepPlayer)
      const local = stepPlayer.localProgress[episode.id] ?? null
      const { progress, isPushed } = mergeProgress(local, episode.progress)
      if (isPushed && local !== null) {
        return { player: stepPlayer, commands: [], progress: [{ _tag: "PushProgress", episodeId: episode.id, progress: local }] }
      }
      return progress === null ? unchanged(stepPlayer) : takeEntry(episode.id, progress)(stepPlayer)
    }),
  )

// INTENT

/** The audio of the current chapter ended. The element rests at the listed end of that chapter. */
const endChapter: PlayerStep = withLoaded(({ playback, episode }) => {
  const chapter = episode.chapters[playback.chapter]
  return setPlayback({ ...(chapter ? { offsetMs: chapter.durationMs } : {}), isPlaying: false })
})

/** The element says where it is. Only audio that plays moves: a resting element is where the tab put it. */
const updateAudioTime = (offsetMs: number, atMs: number): PlayerStep => (player) => {
  const playback = player.playback
  const timed =
    playback._tag === "Loaded" && playback.isPlaying
      ? { ...player, playback: Playback.Loaded({ ...playback, offsetMs }) }
      : player
  return atMs - player.lastSavedAtMs < SAVE_EVERY_MS
    ? { player: timed, commands: [], progress: [] }
    : { player: { ...timed, lastSavedAtMs: atMs, isSaveDue: true }, commands: [], progress: [] }
}

/**
 * A playback action of the user. A start still reading storage is no longer the latest intent, and a Play that
 * waits for the library is off.
 */
const intend = (step: PlayerStep): PlayerStep => (player) =>
  step({ ...player, playIntents: player.playIntents + 1, maybePendingPlay: Option.none() })

/** Reads the progress storage holds for an episode, to play it from there. The read carries the latest intent. */
const readThenPlay = (episodeId: EpisodeId): PlayerStep => (player) => ({
  player,
  commands: [],
  progress: [{ _tag: "ReadStoredProgress", episodeId, intent: player.playIntents }],
})

/**
 * A Play acts. The episode the listener listens to gets a Play to place. Another episode reads its progress from
 * storage first, so a pause in another tab is where it resumes.
 */
const actPlay = (episodeId: EpisodeId): PlayerStep => (player) =>
  isListeningTo(player, episodeId)
    ? setListening({ wantsPlay: true, isPlayDue: true })(player)
    : player.episodes.some((item) => item.id === episodeId && item.chapters.length > 0)
      ? readThenPlay(episodeId)(player)
      : unchanged(player)

/**
 * The listener asks for playback. While library requests are in flight, the Play waits for them and acts when
 * `settlePendingPlay` says so: the library may hold a newer position from another device, and a Play from the old
 * one would stamp it over that. A second Play of the same episode does not wait again, so a slow request never
 * leaves Play dead.
 */
const askPlay = (episodeId: EpisodeId): PlayerStep => (player) =>
  player.libraryRequestsInFlight.length > 0 && !isPlayPending(player.maybePendingPlay, episodeId)
    ? intend((held) => ({
        player: { ...held, maybePendingPlay: Option.some({ episodeId, awaiting: held.libraryRequestsInFlight }) },
        commands: [],
        progress: [],
      }))(player)
    : intend(actPlay(episodeId))(player)

/** The listener asks for no playback: of audio that plays, and of a Play that waits for the next chapter. */
const askPause: PlayerStep = intend(setListening({ wantsPlay: false, isPlayDue: false }))

/** A Pause while a Play waits for the library: the Play is off. */
const cancelPlay: PlayerStep = (player) => (Option.isSome(player.maybePendingPlay) ? intend(unchanged)(player) : unchanged(player))

const wantsPlay = (player: Player) => Option.exists(player.maybeListening, (listening) => listening.wantsPlay)

const toggle: PlayerStep = (player) =>
  Option.match(player.maybeListening, {
    onNone: () => unchanged(player),
    onSome: ({ episodeId }) => (wantsPlay(player) ? askPause(player) : askPlay(episodeId)(player)),
  })

/** Toggles `episode` when the listener listens to it. Otherwise asks for its playback. */
const start = (episode: Episode): PlayerStep => (player) => {
  if (isListeningTo(player, episode.id)) return toggle(player)
  if (episode.chapters.length === 0) return unchanged(player)
  return askPlay(episode.id)(player)
}

/**
 * Library request `request` answered: `isListed` says it brought a list the tab takes. A Play waits for the
 * requests that were in flight when it was pressed, by number (`awaitedAfter` of the contract). When none is left,
 * the Play acts, on what the device knows now.
 */
const settlePendingPlay = (request: number, isListed: boolean): PlayerStep => (player) =>
  Option.match(player.maybePendingPlay, {
    onNone: () => unchanged(player),
    onSome: ({ episodeId, awaiting }) => {
      const stillAwaiting = awaitedAfter(awaiting, request, isListed)
      return stillAwaiting.length > 0
        ? { player: { ...player, maybePendingPlay: Option.some({ episodeId, awaiting: stillAwaiting }) }, commands: [], progress: [] }
        : actPlay(episodeId)({ ...player, maybePendingPlay: Option.none() })
    },
  })

/**
 * The storage read of a start came back. The device's entry is the newer of what storage holds and the server's;
 * with neither, it has none. Only when storage cannot be read is the entry this tab knows used. Then the listener
 * listens to this episode, with a Play to place.
 */
const startFromStored = (episodeId: EpisodeId, intent: number, stored: StoredProgress): PlayerStep => (player) => {
  if (intent !== player.playIntents) return unchanged(player)
  const episode = player.episodes.find((item) => item.id === episodeId)
  if (!episode || episode.chapters.length === 0 || isListeningTo(player, episodeId)) return unchanged(player)
  const local = StoredProgress.match(stored, {
    Saved: ({ progress }) => progress,
    NotSaved: () => null,
    Unreadable: () => player.localProgress[episodeId] ?? null,
  })
  const { progress } = mergeProgress(local, episode.progress)
  const known: PlayerStep =
    progress !== null
      ? takeEntry(episodeId, progress)
      : (stepPlayer) => ({
          player: { ...stepPlayer, localProgress: Record.remove(stepPlayer.localProgress, episodeId) },
          commands: [],
          progress: [],
        })
  return sequence(player, [
    known,
    (stepPlayer) => ({
      player: {
        ...stepPlayer,
        maybeListening: Option.some({
          episodeId,
          wantsPlay: true,
          isPlayDue: true,
          maybeSeekMs: Option.none(),
          maybeFollowedAt: Option.none(),
        }),
      },
      commands: [],
      progress: [],
    }),
  ])
}

/** The listener moves to `ms` on the episode timeline. `reconcile` moves the audio there and saves the place. */
const seek = (ms: number): PlayerStep => withLoaded(() => intend(setListening({ maybeSeekMs: Option.some(ms) })))

const skip = (deltaMs: number): PlayerStep => withLoaded(({ playback, episode }) => seek(globalMs(playback, episode) + deltaMs))

/** The listener moves to `ms` on the episode timeline, and playback goes on from there. */
const playFrom = (ms: number): PlayerStep =>
  withLoaded(() => intend(setListening({ maybeSeekMs: Option.some(ms), wantsPlay: true, isPlayDue: false })))

/** The listener picks a chapter: a move to its start, and playback from there. */
const playChapter = (index: number): PlayerStep =>
  withLoaded(({ episode }) => (episode.chapters[index] ? playFrom(chapterStartMs(episode.chapters, index)) : unchanged))

/** The element stopped though the tab did not tell it to: that is a Pause of the listener. */
const takeOwnPause: PlayerStep = (player) =>
  player.playback._tag === "Loaded" && player.playback.isPlaying
    ? setListening({ wantsPlay: false, isPlayDue: false })(player)
    : unchanged(player)

const shortcut = (name: PlayerShortcut): PlayerStep => {
  switch (name) {
    case "Toggle":
      return toggle
    case "Back":
      return skip(-SKIP_BACK_MS)
    case "Forward":
      return skip(SKIP_FORWARD_MS)
  }
}

/** The element refused to play: the Play is off. */
const failedPlay: PlayerStep = (player) =>
  sequence(player, [setPlayback({ isPlaying: false }), setListening({ wantsPlay: false, isPlayDue: false })])

/** A pause or a hidden page marks the position as due to save; `reconcile` stamps it. */
const markSaveDue: PlayerStep = (player) => ({ player: { ...player, isSaveDue: true }, commands: [], progress: [] })

/** The element reported it started playing. */
const started: PlayerStep = setPlayback({ isPlaying: true })

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
const stopPlayback: PlayerStep = (player) => {
  if (player.playback._tag === "Stopped" && Option.isNone(player.maybeListening)) {
    return player.isSaveDue ? { player: { ...player, isSaveDue: false }, commands: [], progress: [] } : unchanged(player)
  }
  return {
    player: {
      ...player,
      playback: Playback.Stopped(),
      loadedChapterDurationMs: null,
      maybeListening: Option.none(),
      isSaveDue: false,
    },
    commands: player.playback._tag === "Loaded" ? [StopAudio.make({})] : [],
    progress: [],
  }
}

/**
 * The one step that decides playback. Runs after every Message, on the player alone. From the intent and the
 * facts it works out the target (the episode, the chapter, the offset, and playing, paused or waiting), compares
 * it with what the audio element has, and returns at most one audio Command and at most one save.
 */
const reconcile: PlayerStep = (player) => {
  const maybeEpisode = Option.flatMap(player.maybeListening, (listening) =>
    Option.fromNullishOr(player.episodes.find((item) => item.id === listening.episodeId)),
  )
  if (Option.isNone(player.maybeListening) || Option.isNone(maybeEpisode)) return stopPlayback(player)
  const listening = player.maybeListening.value
  const episode = maybeEpisode.value
  const { chapters, job } = episode
  const lengthMs = totalMs(chapters)
  const playback = player.playback
  const here = playback._tag === "Loaded" && playback.episodeId === episode.id ? playback : undefined
  const left = playback._tag === "Loaded" && playback.episodeId !== episode.id ? playback : undefined
  const heardMs = here ? globalMs(here, episode) : undefined
  const entry = player.localProgress[episode.id]
  const isStamping = player.stamping[episode.id] !== undefined
  const maybeSeekMs = Option.map(listening.maybeSeekMs, (ms) => Math.min(Math.max(0, ms), lengthMs))
  const isSeek = Option.isSome(maybeSeekMs)
  const isOn = here !== undefined && here.isPlaying && listening.wantsPlay && !listening.isPlayDue

  // Where the listener is.
  const hasNews = !isStamping && entry !== undefined && !Option.contains(listening.maybeFollowedAt, entry.updatedAt)
  const isMovedToEntry = !isSeek && !isOn && heardMs !== undefined && hasNews
  const positionMs = Option.getOrElse(maybeSeekMs, () =>
    heardMs === undefined ? (heldMs(player, episode.id) ?? 0) : isMovedToEntry && entry ? entry.positionMs : heardMs,
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
            player.loadedChapterDurationMs !== null && player.loadedChapterDurationMs > 0
              ? Math.min(listed.durationMs, Math.round((here.offsetMs / player.loadedChapterDurationMs) * listed.durationMs))
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
      src: player.connection.origin + chapter.url,
      offsetMs: target.offsetMs,
      rate: player.rate,
      isAutoplay: isPlaying,
    })
  const audio: ReadonlyArray<PlayerCommand> =
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
  const isNew = (episodeId: EpisodeId, ms: number) => heldMs(player, episodeId) !== Math.max(0, Math.round(ms))
  const leftEpisode = left ? player.episodes.find((item) => item.id === left.episodeId) : undefined
  const leftShortOfEntry =
    left && leftEpisode && !left.isPlaying && (heldMs(player, left.episodeId) ?? 0) > totalMs(leftEpisode.chapters)
  const isPaused = here !== undefined && here.isPlaying && !isPlaying
  const save: { readonly episodeId: EpisodeId; readonly positionMs: number } | undefined =
    left && leftEpisode && !leftShortOfEntry
      ? { episodeId: left.episodeId, positionMs: globalMs(left, leftEpisode) }
      : isSeek
        ? { episodeId: episode.id, positionMs }
        : isOver
          ? { episodeId: episode.id, positionMs: lengthMs }
          : heardMs !== undefined && !isMovedToEntry && !isPlayPending(player.maybePendingPlay, episode.id) && (player.isSaveDue || isPaused)
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
      ? (file !== undefined && file.url === nextPlayback.url ? file.durationMs : player.loadedChapterDurationMs)
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
    player.loadedChapterDurationMs === nextLoadedDurationMs &&
    !player.isSaveDue &&
    !stamp
  return {
    player: isUnchanged
      ? player
      : {
          ...player,
          playback: isSamePlayback(playback, nextPlayback) ? playback : nextPlayback,
          loadedChapterDurationMs: nextLoadedDurationMs,
          maybeListening: isSameListening(listening, nextListening) ? player.maybeListening : Option.some(nextListening),
          isSaveDue: false,
          stamping: stamp
            ? Record.set(player.stamping, stamp.episodeId, Math.max(0, Math.round(stamp.positionMs)))
            : player.stamping,
        },
    commands: audio,
    progress: stamp ? [{ _tag: "SaveProgress", episodeId: stamp.episodeId, positionMs: stamp.positionMs }] : [],
  }
}

export const Player = {
  reconcile,
  settlePendingPlay,
  libraryUpdated: (request: number): PlayerStep =>
    (player) => sequence(player, [syncProgress, settlePendingPlay(request, true)]),
  takePushAnswer,
  takeStamp,
  startFromStored,
  toggle,
  start,
  askPause,
  cancelPlay,
  wantsPlay,
  skip,
  seek,
  playFrom,
  playChapter,
  shortcut,
  updateAudioTime,
  endChapter,
  started,
  takeOwnPause,
  failedPlay,
  markSaveDue,
} as const
