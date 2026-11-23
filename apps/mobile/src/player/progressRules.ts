// The progress rules of the phone app, kept free of React Native so they run under vitest.
import { type Episode, type EpisodeProgress, isFinished, mergeProgress } from "@fama/contracts"

/** How far playback moves before it is saved again. */
export const SAVE_EVERY_MS = 5000

/** What the save rule remembers between native status events. */
export type Tracker = {
  readonly episodeId: string | null
  /** The position of the last save, or where the episode was loaded. */
  readonly savedMs: number
  readonly playing: boolean
  readonly ended: boolean
}

export const IDLE_TRACKER: Tracker = { episodeId: null, savedMs: 0, playing: false, ended: false }

/** One native status, in whole-episode milliseconds. */
export type Moment = {
  readonly episodeId: string | null
  readonly positionMs: number
  readonly playing: boolean
  readonly ended: boolean
}

/**
 * Whether a status is a listener's progress worth saving: about every 5 s of movement, a pause, and the end of
 * the audio. A newly loaded episode only sets the baseline, so a load without play (app start) saves nothing.
 */
export function track(tracker: Tracker, moment: Moment): { readonly tracker: Tracker; readonly isSaved: boolean } {
  if (moment.episodeId === null) return { tracker: IDLE_TRACKER, isSaved: false }
  if (moment.episodeId !== tracker.episodeId) {
    return {
      tracker: { episodeId: moment.episodeId, savedMs: moment.positionMs, playing: moment.playing, ended: moment.ended },
      isSaved: false,
    }
  }
  const isSaved =
    Math.abs(moment.positionMs - tracker.savedMs) >= SAVE_EVERY_MS ||
    (tracker.playing && !moment.playing) ||
    (!tracker.ended && moment.ended)
  return {
    tracker: {
      episodeId: moment.episodeId,
      savedMs: isSaved ? moment.positionMs : tracker.savedMs,
      playing: moment.playing,
      ended: moment.ended,
    },
    isSaved,
  }
}

export const isSameProgress = (a: EpisodeProgress, b: EpisodeProgress): boolean =>
  a.positionMs === b.positionMs && a.updatedAt === b.updatedAt

/**
 * What a library load does with the device's entries: send each one newer than the server's, and take each newer
 * server entry with its own stamp. Nothing gets a new stamp.
 */
export function planSync(
  local: Readonly<Record<string, EpisodeProgress>>,
  episodes: ReadonlyArray<Pick<Episode, "id" | "progress">>,
): {
  readonly push: ReadonlyArray<readonly [string, EpisodeProgress]>
  readonly adopt: ReadonlyArray<readonly [string, EpisodeProgress]>
} {
  const push: Array<readonly [string, EpisodeProgress]> = []
  const adopt: Array<readonly [string, EpisodeProgress]> = []
  for (const episode of episodes) {
    const mine = local[episode.id] ?? null
    const { progress, isPushed } = mergeProgress(mine, episode.progress)
    if (isPushed && mine !== null) push.push([episode.id, mine])
    else if (progress !== null && (mine === null || !isSameProgress(mine, progress))) adopt.push([episode.id, progress])
  }
  return { push, adopt }
}

/** The device takes the server's answer to a push, unless the listener saved again since it was sent. */
export const takesAnswer = (current: EpisodeProgress | undefined, sent: EpisodeProgress): boolean =>
  current !== undefined && isSameProgress(current, sent)

/** Where an episode starts, in ms: the newer of the device's and the server's entry, and 0 when it was finished. */
export function startMs(
  local: EpisodeProgress | null,
  episode: Pick<Episode, "progress" | "chapters" | "job">,
): number {
  const saved = mergeProgress(local, episode.progress).progress?.positionMs ?? 0
  const totalMs = episode.chapters.reduce((sum, chapter) => sum + chapter.durationMs, 0)
  // The end of the chapters of a running job is not the end of the episode.
  return episode.job._tag === "Ready" && isFinished(saved, totalMs) ? 0 : saved
}
