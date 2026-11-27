import { type Chapter, type Episode, type EpisodeId, playStart } from "@fama/contracts"
import { Option, Record } from "effect"
import { LoadChapter, PauseAudio, PlayAudio, SeekAudio, StopAudio } from "~/core/audio"
import { locate, totalMs } from "~/core/timeline"
import { type Listening, type LoadedPlayback, Playback, isPlayPending } from "~/playback/model"
import { globalMs, heldMs, type Player, type PlayerCommand, type PlayerStep, unchanged } from "~/playback/playerState"

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

const findLoaded = (player: Player, episode: Episode) => {
  const loaded = player.playback
  if (loaded._tag !== "Loaded") return { here: undefined, left: undefined }
  return loaded.episodeId === episode.id ? { here: loaded, left: undefined } : { here: undefined, left: loaded }
}

const listeningPosition = (player: Player, episode: Episode, listening: Listening, here: LoadedPlayback | undefined) => {
  const lengthMs = totalMs(episode.chapters)
  const heardMs = here === undefined ? undefined : globalMs(here, episode)
  const entry = player.localProgress[episode.id]
  const isStamping = player.stamping[episode.id] !== undefined
  const maybeSeekMs = Option.map(listening.maybeSeekMs, (ms) => Math.min(Math.max(0, ms), lengthMs))
  const isSeek = Option.isSome(maybeSeekMs)
  const isOn = here !== undefined && here.isPlaying && listening.wantsPlay && !listening.isPlayDue
  const news = !isStamping && entry !== undefined && !Option.contains(listening.maybeFollowedAt, entry.updatedAt)
    ? entry : undefined
  const moved = !isSeek && !isOn && heardMs !== undefined ? news : undefined
  const positionMs = Option.getOrElse(maybeSeekMs, () => moved?.positionMs ?? heardMs ?? heldMs(player, episode.id) ?? 0)
  return {
    lengthMs, heardMs, isSeek, isOn, positionMs,
    isMovedToEntry: moved !== undefined,
    maybeFollowedAt: followedStamp(listening, entry, { isStamping, isOn, isSeek, lengthMs }),
  }
}

const followedStamp = (
  listening: Listening,
  entry: Player["localProgress"][string] | undefined,
  { isStamping, isOn, isSeek, lengthMs }: { isStamping: boolean; isOn: boolean; isSeek: boolean; lengthMs: number },
) => {
  const isReached = isOn || isSeek || entry === undefined || entry.positionMs <= lengthMs
  return isStamping || !isReached ? listening.maybeFollowedAt : Option.fromNullishOr(entry?.updatedAt)
}

type Position = ReturnType<typeof listeningPosition>

const playbackIntent = (listening: Listening, episode: Episode, position: Position) => {
  const { positionMs, lengthMs, isMovedToEntry, isOn, isSeek } = position
  const startState = playStart(positionMs, episode.chapters, episode.job)
  const isStart = listening.isPlayDue || (listening.wantsPlay && isMovedToEntry)
  const isOver = listening.wantsPlay && !(isOn && !isSeek) && !startState.isWaiting && !isStart && positionMs >= lengthMs
  const mode: "Playing" | "Waiting" | "Paused" =
    !listening.wantsPlay || isOver ? "Paused" : isOn && !isSeek ? "Playing" : startState.isWaiting ? "Waiting" : "Playing"
  return { mode, isStart, isOver, placeMs: mode === "Playing" && isStart ? startState.positionMs : positionMs }
}

type Intent = ReturnType<typeof playbackIntent>

const replacementOffset = (here: LoadedPlayback, chapter: Chapter, previousDurationMs: number | null): number =>
  previousDurationMs !== null && previousDurationMs > 0
    ? Math.min(chapter.durationMs, Math.round((here.offsetMs / previousDurationMs) * chapter.durationMs))
    : Math.min(chapter.durationMs, here.offsetMs)

const resolveTarget = (
  chapters: Episode["chapters"],
  here: LoadedPlayback | undefined,
  position: Position,
  intent: Intent,
  loadedDurationMs: number | null,
) => {
  const { mode, isStart, placeMs } = intent
  const { isSeek, isMovedToEntry, isOn } = position
  const listed = here === undefined ? undefined : chapters[here.chapter]
  const isReplaced = here !== undefined && listed !== undefined && listed.url !== here.url
  const isPlaced = isSeek || isMovedToEntry || isReplaced || (mode === "Playing" && !isOn)
  if (isReplaced && !isSeek && !isMovedToEntry && !(mode === "Playing" && isStart)) {
    return { index: here.chapter, offsetMs: replacementOffset(here, listed, loadedDurationMs), isPlaced: true }
  }
  if (isPlaced || here === undefined) return { ...locate(chapters, placeMs), isPlaced: true }
  return { index: here.chapter, offsetMs: here.offsetMs, isPlaced: false }
}

type Target = ReturnType<typeof resolveTarget>

const desiredAudio = (player: Player, here: LoadedPlayback | undefined, target: Target, file: Chapter | undefined, intent: Intent) => {
  const hasFile = !target.isPlaced || file !== undefined
  const isPlaying = intent.mode === "Playing" && hasFile
  const commands = audioCommands(here, target, {
    file, isPlaying, isStart: intent.isStart,
    load: (chapter) => LoadChapter.make({
      src: player.connection.origin + chapter.url,
      offsetMs: target.offsetMs,
      rate: player.rate,
      isAutoplay: isPlaying,
    }),
  })
  return { hasFile, isPlaying, commands }
}

const audioCommands = (
  here: LoadedPlayback | undefined,
  target: Target,
  { file, isPlaying, isStart, load }: {
    file: Chapter | undefined
    isPlaying: boolean
    isStart: boolean
    load: (file: Chapter) => PlayerCommand
  },
): ReadonlyArray<PlayerCommand> => {
  if (file === undefined || !target.isPlaced) {
    if (here === undefined) return []
    return here.isPlaying === isPlaying ? [] : [isPlaying ? PlayAudio.make({}) : PauseAudio.make({})]
  }
  if (here === undefined || here.chapter !== target.index || here.url !== file.url) return [load(file)]
  if (Math.abs(here.offsetMs - target.offsetMs) >= 1) {
    return [isPlaying === here.isPlaying && !isStart ? SeekAudio.make({ offsetMs: target.offsetMs }) : load(file)]
  }
  return isPlaying === here.isPlaying ? [] : [isPlaying ? PlayAudio.make({}) : PauseAudio.make({})]
}

type Stamp = { readonly episodeId: EpisodeId; readonly positionMs: number }
const positionLeft = (player: Player, left: LoadedPlayback | undefined): Stamp | undefined => {
  if (left === undefined) return undefined
  const episode = player.episodes.find((item) => item.id === left.episodeId)
  if (episode === undefined) return undefined
  const shortOfEntry = !left.isPlaying && (heldMs(player, left.episodeId) ?? 0) > totalMs(episode.chapters)
  return shortOfEntry ? undefined : { episodeId: left.episodeId, positionMs: globalMs(left, episode) }
}

const positionToSave = (
  player: Player,
  episodeId: EpisodeId,
  position: Position,
  { left, isOver, paused }: { left: LoadedPlayback | undefined; isOver: boolean; paused: boolean },
): Stamp | undefined => {
  const stamp = positionLeft(player, left)
  if (stamp !== undefined) return stamp
  if (position.isSeek) return { episodeId, positionMs: position.positionMs }
  if (isOver) return { episodeId, positionMs: position.lengthMs }
  if (position.heardMs === undefined || position.isMovedToEntry || isPlayPending(player.maybePendingPlay, episodeId)) return undefined
  return player.isSaveDue || paused ? { episodeId, positionMs: position.heardMs } : undefined
}

const applyPlayback = (
  player: Player,
  current: Listening,
  next: { playback: Playback; listening: Listening; file: Chapter | undefined },
  stamp: Stamp | undefined,
): Player => {
  const { playback, listening, file } = next
  const duration = playback._tag === "Loaded"
    ? file !== undefined && file.url === playback.url ? file.durationMs : player.loadedChapterDurationMs
    : null
  const samePlayback = isSamePlayback(player.playback, playback)
  const sameListening = isSameListening(current, listening)
  if (samePlayback && sameListening && player.loadedChapterDurationMs === duration && !player.isSaveDue && stamp === undefined) {
    return player
  }
  return {
    ...player,
    playback: samePlayback ? player.playback : playback,
    loadedChapterDurationMs: duration,
    maybeListening: sameListening ? player.maybeListening : Option.some(listening),
    isSaveDue: false,
    stamping: stamp === undefined
      ? player.stamping
      : Record.set(player.stamping, stamp.episodeId, Math.max(0, Math.round(stamp.positionMs))),
  }
}

/** Reconciles what the audio element has with the latest intent, library and progress. */
export const reconcile: PlayerStep = (player) => {
  if (Option.isNone(player.maybeListening)) return stopPlayback(player)
  const listening = player.maybeListening.value
  const episode = player.episodes.find((item) => item.id === listening.episodeId)
  if (episode === undefined) return stopPlayback(player)

  const { here, left } = findLoaded(player, episode)
  const position = listeningPosition(player, episode, listening, here)
  const intent = playbackIntent(listening, episode, position)
  const target = resolveTarget(episode.chapters, here, position, intent, player.loadedChapterDurationMs)
  const file = episode.chapters[target.index]
  const { hasFile, isPlaying, commands } = desiredAudio(player, here, target, file, intent)
  const save = positionToSave(player, episode.id, position, {
    left, isOver: intent.isOver, paused: here?.isPlaying === true && !isPlaying,
  })
  const stamp = save !== undefined && heldMs(player, save.episodeId) !== Math.max(0, Math.round(save.positionMs))
    ? save : undefined

  const playback = !hasFile && here === undefined ? player.playback : Playback.Loaded({
    episodeId: episode.id,
    chapter: target.index,
    url: file?.url ?? here?.url ?? "",
    offsetMs: target.offsetMs,
    isPlaying,
    isWaiting: intent.mode === "Waiting",
  })
  const nextListening: Listening = {
    episodeId: episode.id,
    wantsPlay: listening.wantsPlay && !intent.isOver,
    isPlayDue: false,
    maybeSeekMs: Option.none(),
    maybeFollowedAt: position.maybeFollowedAt,
  }
  return {
    player: applyPlayback(player, listening, { playback, listening: nextListening, file }, stamp),
    commands,
    progress: stamp === undefined ? [] : [{ _tag: "SaveProgress", ...stamp }],
  }
}
