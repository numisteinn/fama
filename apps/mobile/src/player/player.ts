import type { Episode } from "@fama/contracts"
import { useSyncExternalStore } from "react"
import { isActive } from "../lib/format"
import { jsonFile } from "../lib/jsonFile"
import { FamaPlayer, type NativeStatus, type Track } from "./native"
import { progress } from "./progress"
import { IDLE_TRACKER, type Moment, type Tracker, makePlayGate, startMs, track } from "./progressRules"

// One native player per app, so its state lives in one module-level store.

const IDLE: NativeStatus = {
  episodeId: null,
  index: 0,
  position: 0,
  duration: 0,
  playing: false,
  buffering: false,
  rate: 1,
  ended: false,
  error: null,
}

type Prefs = { rate: number; lastEpisodeId: string | null }

const prefsFile = jsonFile<Prefs>("player.json", { rate: 1, lastEpisodeId: null })

let status: NativeStatus = IDLE
let prefs = prefsFile.read()
let loadedChapters = 0
let tracker: Tracker = IDLE_TRACKER
/** The episode in the native player, as the library last listed it. */
let loadedEpisode: Episode | null = null

const statusListeners = new Set<() => void>()

/**
 * Holds a Play that was pressed while the library loads. The library reports each request and each answer, after
 * it merged the list with the device's progress, so the Play starts from the newer position (see `makePlayGate`).
 */
export const playGate = makePlayGate()

/** The native status in whole-episode milliseconds. The native player speaks seconds. */
const momentOf = (next: NativeStatus): Moment => ({
  episodeId: next.episodeId,
  positionMs: Math.round(next.position * 1000),
  playing: next.playing,
  ended: next.ended,
})

FamaPlayer.addListener("onStatus", (next) => {
  status = next
  const step = track(tracker, momentOf(next))
  tracker = step.tracker
  if (step.isSaved && next.episodeId) progress.save(next.episodeId, step.tracker.savedMs)
  statusListeners.forEach((listener) => listener())
})

/** Saves where the loaded episode is now, when it moved since the last save: before a switch, and on background. */
function saveNow() {
  const moment = momentOf(status)
  // Not moved since the last save or the load: nothing the listener did, so no stamp.
  if (!moment.episodeId || moment.episodeId !== tracker.episodeId || moment.positionMs === tracker.savedMs) return
  tracker = { ...tracker, savedMs: moment.positionMs }
  progress.save(moment.episodeId, moment.positionMs)
}

// A newer server entry for the loaded, paused episode moves the player there, without a save: the move is not the
// listener's. A finished episode moves to the top, where its next play starts.
progress.onAdopt((episodeId, entry) => {
  if (status.episodeId !== episodeId || status.playing) return
  const episode = loadedEpisode
  const targetMs = episode && episode.id === episodeId ? startMs(entry, episode) : entry.positionMs
  tracker = { ...tracker, savedMs: targetMs }
  void FamaPlayer.seek(targetMs / 1000)
})

export function usePlayerStatus(): NativeStatus {
  return useSyncExternalStore(
    (listener) => {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },
    () => status,
  )
}

export function lastEpisodeId(): string | null {
  return prefs.lastEpisodeId
}

export type TrackSource = {
  mediaUrl(path: string): string
  localUri(episodeId: string, index: number): string | null
}

function tracksOf(episode: Episode, source: TrackSource): Track[] {
  return episode.chapters.map((chapter) => ({
    url: source.localUri(episode.id, chapter.index) ?? source.mediaUrl(chapter.url),
    title: chapter.title,
    durationMs: chapter.durationMs,
  }))
}

/**
 * Loads an episode at the newer of the device's and the server's position. A finished episode starts over.
 * Loading saves nothing for the new episode; only the listener's play and moves do.
 */
async function loadNow(episode: Episode, source: TrackSource, autoplay: boolean) {
  if (status.episodeId === episode.id) {
    if (autoplay && !status.playing) await FamaPlayer.play()
    return
  }
  saveNow()
  const position = startMs(progress.get(episode.id), episode) / 1000
  loadedEpisode = episode
  loadedChapters = episode.chapters.length
  prefs = { ...prefs, lastEpisodeId: episode.id }
  prefsFile.write(prefs)
  await FamaPlayer.load({
    episodeId: episode.id,
    title: episode.title,
    artist: episode.author,
    artworkUrl: episode.coverUrl ? source.mediaUrl(episode.coverUrl) : null,
    tracks: tracksOf(episode, source),
    position,
    rate: prefs.rate,
    autoplay,
  })
}

export const player = {
  /**
   * Loads an episode (see `loadNow`). With `autoplay` it is a Play: pressed while the library loads, it waits for
   * the answer. Without it (the restore after launch) it loads at once.
   */
  async load(episode: Episode, source: TrackSource, autoplay: boolean) {
    if (!autoplay) return loadNow(episode, source, false)
    playGate.play(episode.id, () => void loadNow(episode, source, true))
  },
  /** Feeds chapters that appeared while the job runs. */
  async sync(episode: Episode, source: TrackSource) {
    if (status.episodeId !== episode.id) return
    loadedEpisode = episode
    if (episode.chapters.length <= loadedChapters) return
    loadedChapters = episode.chapters.length
    await FamaPlayer.updateTracks(tracksOf(episode, source))
  },
  /** Pauses, or plays. A Play pressed while the library loads waits for the answer; a pause takes it back. */
  toggle() {
    if (status.playing) {
      playGate.cancel()
      void FamaPlayer.pause()
    } else {
      playGate.play(status.episodeId ?? "", () => void FamaPlayer.play())
    }
  },
  skip(delta: number) {
    playGate.cancel()
    return FamaPlayer.skip(delta)
  },
  seek(position: number) {
    playGate.cancel()
    return FamaPlayer.seek(position)
  },
  async setRate(rate: number) {
    prefs = { ...prefs, rate }
    prefsFile.write(prefs)
    await FamaPlayer.setRate(rate)
  },
  rate: () => prefs.rate,
  /** The app goes to the background: save where the listener is, if it moved since the last save. */
  saveNow,
  /** Stops and forgets an episode, for example after it was deleted. */
  async forget(episodeId: string) {
    progress.forget(episodeId)
    if (prefs.lastEpisodeId === episodeId) {
      prefs = { ...prefs, lastEpisodeId: null }
      prefsFile.write(prefs)
    }
    if (status.episodeId === episodeId) {
      loadedEpisode = null
      await FamaPlayer.unload()
    }
  },
}

/** Buffering, or played to the last chapter while the job still renders the next. */
export function isWaiting(status: NativeStatus, episode: Episode): boolean {
  return status.buffering || (status.ended && isActive(episode.job))
}
