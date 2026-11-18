import { useEffect, useRef } from "react"
import { useLibrary } from "../lib/library"
import { isPlayable } from "../lib/format"
import { lastEpisodeId, player, usePlayerStatus } from "./player"
import { useTrackSource } from "./usePlayback"

/** Keeps the native player in step with the library: new chapters, and the last episode after launch. */
export function PlayerSync() {
  const { episodes, loaded } = useLibrary()
  const status = usePlayerStatus()
  const source = useTrackSource()
  const restored = useRef(false)

  useEffect(() => {
    if (!source) return
    const current = episodes.find((episode) => episode.id === status.episodeId)
    if (current) void player.sync(current, source)
  }, [episodes, status.episodeId, source])

  useEffect(() => {
    if (restored.current || !loaded || !source || status.episodeId) return
    restored.current = true
    const last = episodes.find((episode) => episode.id === lastEpisodeId())
    if (last && isPlayable(last)) void player.load(last, source, false)
  }, [loaded, source, episodes, status.episodeId])

  return null
}
