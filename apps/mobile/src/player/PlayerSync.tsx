import { useEffect, useRef } from "react"
import { AppState } from "react-native"
import { useLibrary } from "../lib/library"
import { isPlayable } from "../lib/format"
import { useSettings } from "../lib/settings"
import { lastEpisodeId, player, usePlayerStatus } from "./player"
import { progress } from "./progress"
import { useTrackSource } from "./usePlayback"

/**
 * Keeps the native player in step with the library: new chapters, and the last episode after launch, loaded
 * without play. Syncs listening progress on every library load and saves it when the app goes to the background.
 */
export function PlayerSync() {
  const { api } = useSettings()
  const { episodes, loaded } = useLibrary()
  const status = usePlayerStatus()
  const source = useTrackSource()
  const restored = useRef(false)

  useEffect(() => progress.connect(api), [api])

  // Every list the server sent: pending local entries go out, newer server entries come in.
  useEffect(() => {
    if (loaded) progress.sync(episodes)
  }, [loaded, episodes])

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") player.saveNow()
    })
    return () => subscription.remove()
  }, [])

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
