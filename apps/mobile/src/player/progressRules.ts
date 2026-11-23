// The progress rules of the phone app, kept free of React Native so they run under vitest.
import { type Episode, type EpisodeProgress, awaitedAfter, isFinished, mergeProgress } from "@fama/contracts"

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

/**
 * The Play rule. A Play pressed while library requests are in flight waits for them, so it starts from the newer of
 * the device's and the server's position, and not from one another device moved on from: a Play from the old
 * position would stamp it over the newer entry. It waits for the requests that were in flight at the press, by
 * number, and starts by the `awaitedAfter` rule of the contract: on the list of the newest of them or of a later
 * request, or when each of them has answered. The failure of a later request, a pull to refresh for example, does
 * not start it. A second Play of the same episode does not wait again, so a slow request never leaves Play dead. A
 * pause, a seek or another Play takes the waiting Play back.
 */
export function makePlayGate() {
  let requests = 0
  let inFlight: ReadonlyArray<number> = []
  let held: {
    readonly episodeId: string
    readonly awaiting: ReadonlyArray<number>
    readonly run: () => void
  } | null = null
  return {
    /** A library request went out. Give its number back to `refreshSettled` with its answer. */
    refreshStarted(): number {
      requests += 1
      inFlight = [...inFlight, requests]
      return requests
    },
    /**
     * Library request `request` answered. `isListed` says it brought a list the library took; a failure brings none.
     * Call it after the list merged with the device's progress.
     */
    refreshSettled(request: number, isListed: boolean) {
      inFlight = inFlight.filter((sent) => sent !== request)
      if (!held) return
      const awaiting = awaitedAfter(held.awaiting, request, isListed)
      if (awaiting.length > 0) {
        held = { ...held, awaiting }
        return
      }
      const { run } = held
      held = null
      run()
    },
    /** The listener plays `episodeId`: `run` starts it, now or when the wait is over. */
    play(episodeId: string, run: () => void) {
      if (inFlight.length > 0 && held?.episodeId !== episodeId) {
        held = { episodeId, awaiting: inFlight, run }
        return
      }
      held = null
      run()
    },
    /** A pause or a seek: a waiting Play is off. */
    cancel() {
      held = null
    },
  }
}
