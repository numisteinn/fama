import type { Episode, EpisodeProgress } from "@fama/contracts"
import { useSyncExternalStore } from "react"
import type { Api } from "../lib/api"
import { isActive } from "../lib/format"
import { jsonFile } from "../lib/jsonFile"
import { type Core, type PlayerEffect, type PlayerEvent, initialCore, isWaitingForChapter, step } from "./core"
import { FamaPlayer, type NativeStatus, type Track } from "./native"
import { progress } from "./progress"

// One native player per app. `core.ts` decides what it does: this module only gives the core each event, and runs
// the effects the core returns, in their order. It decides nothing itself.

type Prefs = { rate: number; lastEpisodeId: string | null }

const prefsFile = jsonFile<Prefs>("player.json", { rate: 1, lastEpisodeId: null })

let prefs = prefsFile.read()
let core: Core = initialCore(progress.entries())
/** Where chapter audio comes from. The screens and `PlayerSync` give it before a load. */
let source: TrackSource | null = null
/** The server this account talks to. */
let api: Api | null = null

const statusListeners = new Set<() => void>()

export type TrackSource = {
  mediaUrl(path: string): string
  localUri(episodeId: string, index: number, url: string): string | null
}

function tracksOf(episode: Episode, from: TrackSource): Track[] {
  return episode.chapters.map((chapter) => ({
    url: from.localUri(episode.id, chapter.index, chapter.url) ?? from.mediaUrl(chapter.url),
    title: chapter.title,
    durationMs: chapter.durationMs,
  }))
}

function remember(episodeId: string | null) {
  if (prefs.lastEpisodeId === episodeId) return
  prefs = { ...prefs, lastEpisodeId: episodeId }
  prefsFile.write(prefs)
}

/** Sends the device's entry. The server keeps the newer one and answers with what it stores. */
async function push(episodeId: string, sent: EpisodeProgress) {
  const target = api
  if (!target) return
  try {
    const stored = await target.putProgress(episodeId, sent)
    dispatch({ _tag: "PushAnswered", episodeId, sent, stored })
  } catch {
    // Offline or refused: the entry stays newer than the server's and goes out on the next library load.
  }
}

/** One effect of the core. The native calls of one event reach the native player in the order the core gave. */
function run(effect: PlayerEffect) {
  switch (effect._tag) {
    case "Load": {
      if (!source) return
      const { episode } = effect
      remember(episode.id)
      void FamaPlayer.load({
        episodeId: episode.id,
        title: episode.title,
        artist: episode.author,
        artworkUrl: episode.coverUrl ? source.mediaUrl(episode.coverUrl) : null,
        tracks: tracksOf(episode, source),
        expectsMore: isActive(episode.job),
        position: effect.positionMs / 1000,
        rate: prefs.rate,
        autoplay: effect.autoplay,
      })
      return
    }
    case "UpdateTracks":
      if (source) void FamaPlayer.updateTracks(tracksOf(effect.episode, source), isActive(effect.episode.job))
      return
    case "Seek":
      void FamaPlayer.seek(effect.positionMs / 1000)
      return
    case "Skip":
      void FamaPlayer.skip(effect.deltaMs / 1000)
      return
    case "Play":
      void FamaPlayer.play()
      return
    case "Pause":
      void FamaPlayer.pause()
      return
    case "Unload":
      void FamaPlayer.unload()
      return
    case "Push":
      void push(effect.episodeId, effect.entry)
      return
  }
}

/** Gives the core one event, keeps what it now holds, and runs its effects. */
function dispatch(event: PlayerEvent) {
  const before = core
  const result = step(core, event, new Date().toISOString())
  core = result.core
  if (core.entries !== before.entries) progress.replace(core.entries)
  for (const effect of result.effects) run(effect)
  if (core.status !== before.status) statusListeners.forEach((listener) => listener())
}

FamaPlayer.addListener("onStatus", (status) => dispatch({ _tag: "Status", status }))

export function usePlayerStatus(): NativeStatus {
  return useSyncExternalStore(
    (listener) => {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },
    () => core.status,
  )
}

export function lastEpisodeId(): string | null {
  return prefs.lastEpisodeId
}

export const player = {
  /** The server of the account, for the device's progress. */
  connect(next: Api | null) {
    api = next
  },
  /**
   * Loads an episode. With `autoplay` it is a Play of the listener: pressed while the library loads, it waits, and
   * then starts the episode as the library lists it after the answer. Without it (the restore after launch) the
   * episode loads paused.
   */
  load(episode: Episode, from: TrackSource, autoplay: boolean) {
    source = from
    dispatch(autoplay ? { _tag: "PlayEpisode", episode } : { _tag: "Restore", episodeId: episode.id })
  },
  /** A library request goes out. Give its number back to `refreshAnswered` with its answer. */
  refreshStarted(): number {
    dispatch({ _tag: "RefreshStarted" })
    return core.requests
  },
  /** Library request `request` answered: with the list the library took, or `null` for a failure. */
  refreshAnswered(request: number, episodes: ReadonlyArray<Episode> | null) {
    dispatch({ _tag: "RefreshAnswered", request, episodes })
  },
  /** The library shows this list now: the cache of an account, or a change made on this phone. */
  listed(episodes: ReadonlyArray<Episode>, from: TrackSource | null = source) {
    source = from
    dispatch({ _tag: "Listed", episodes })
  },
  /** Pauses, or plays. A Play pressed while the library loads waits for the answer; a pause takes it back. */
  toggle() {
    dispatch({ _tag: "Toggle" })
  },
  /** Seconds. */
  skip(delta: number) {
    dispatch({ _tag: "Skip", deltaMs: delta * 1000 })
  },
  /** Episode seconds. */
  seek(position: number, play = false) {
    dispatch({ _tag: "Seek", positionMs: position * 1000, play })
  },
  async setRate(rate: number) {
    prefs = { ...prefs, rate }
    prefsFile.write(prefs)
    await FamaPlayer.setRate(rate)
  },
  rate: () => prefs.rate,
  /** The app goes to the background: save where the listener is, if it moved since the last save. */
  saveNow() {
    dispatch({ _tag: "Background" })
  },
  /** Stops and forgets an episode, for example after it was deleted. */
  forget(episodeId: string) {
    if (prefs.lastEpisodeId === episodeId) remember(null)
    dispatch({ _tag: "Forget", episodeId })
  },
}

/** Buffering, or a Play that waits at the end of the chapters while the job still renders the next. */
export function isWaiting(status: NativeStatus, episode: Episode): boolean {
  return status.buffering || (status.episodeId === episode.id && isWaitingForChapter(core))
}
