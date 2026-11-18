import type { Episode } from "@fama/contracts"
import { useSyncExternalStore } from "react"
import { isActive } from "../lib/format"
import { jsonFile } from "../lib/jsonFile"
import { FamaPlayer, type NativeStatus, type Track } from "./native"

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

const positionsFile = jsonFile<Record<string, number>>("positions.json", {})
const prefsFile = jsonFile<Prefs>("player.json", { rate: 1, lastEpisodeId: null })

let status: NativeStatus = IDLE
let positions = positionsFile.read()
let prefs = prefsFile.read()
let loadedChapters = 0
let lastSaved = { id: "", position: -1, playing: false }

const statusListeners = new Set<() => void>()
const positionListeners = new Set<() => void>()

function savePosition(next: NativeStatus) {
  const id = next.episodeId
  if (!id) return
  const moved = Math.abs(next.position - lastSaved.position) >= 5
  const stopped = lastSaved.playing && !next.playing
  if (id !== lastSaved.id || moved || stopped || next.ended) {
    positions = { ...positions, [id]: next.position }
    positionsFile.write(positions)
    lastSaved = { id, position: next.position, playing: next.playing }
    positionListeners.forEach((listener) => listener())
  }
}

FamaPlayer.addListener("onStatus", (next) => {
  status = next
  savePosition(next)
  statusListeners.forEach((listener) => listener())
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

/** Seconds listened, as last saved. */
export function useSavedPosition(episodeId: string): number {
  return useSyncExternalStore(
    (listener) => {
      positionListeners.add(listener)
      return () => positionListeners.delete(listener)
    },
    () => positions[episodeId] ?? 0,
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

function totalOf(episode: Episode): number {
  return episode.chapters.reduce((sum, chapter) => sum + chapter.durationMs, 0) / 1000
}

export const player = {
  /** Loads an episode at its saved position. A finished episode starts over. */
  async load(episode: Episode, source: TrackSource, autoplay: boolean) {
    if (status.episodeId === episode.id) {
      if (autoplay && !status.playing) await FamaPlayer.play()
      return
    }
    const saved = positions[episode.id] ?? 0
    const finished = episode.job._tag === "Ready" && saved >= totalOf(episode) - 2
    loadedChapters = episode.chapters.length
    prefs = { ...prefs, lastEpisodeId: episode.id }
    prefsFile.write(prefs)
    await FamaPlayer.load({
      episodeId: episode.id,
      title: episode.title,
      artist: episode.author,
      artworkUrl: episode.coverUrl ? source.mediaUrl(episode.coverUrl) : null,
      tracks: tracksOf(episode, source),
      position: finished ? 0 : saved,
      rate: prefs.rate,
      autoplay,
    })
  },
  /** Feeds chapters that appeared while the job runs. */
  async sync(episode: Episode, source: TrackSource) {
    if (status.episodeId !== episode.id || episode.chapters.length <= loadedChapters) return
    loadedChapters = episode.chapters.length
    await FamaPlayer.updateTracks(tracksOf(episode, source))
  },
  toggle: () => (status.playing ? FamaPlayer.pause() : FamaPlayer.play()),
  skip: (delta: number) => FamaPlayer.skip(delta),
  seek: (position: number) => FamaPlayer.seek(position),
  async setRate(rate: number) {
    prefs = { ...prefs, rate }
    prefsFile.write(prefs)
    await FamaPlayer.setRate(rate)
  },
  rate: () => prefs.rate,
  /** Stops and forgets an episode, for example after it was deleted. */
  async forget(episodeId: string) {
    const { [episodeId]: _, ...rest } = positions
    positions = rest
    positionsFile.write(positions)
    if (prefs.lastEpisodeId === episodeId) {
      prefs = { ...prefs, lastEpisodeId: null }
      prefsFile.write(prefs)
    }
    if (status.episodeId === episodeId) await FamaPlayer.unload()
  },
}

/** Buffering, or played to the last chapter while the job still renders the next. */
export function isWaiting(status: NativeStatus, episode: Episode): boolean {
  return status.buffering || (status.ended && isActive(episode.job))
}
