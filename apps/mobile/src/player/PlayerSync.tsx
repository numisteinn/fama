import { useEffect, useRef } from "react"
import { AppState } from "react-native"
import { useLibrary } from "../lib/library"
import { isPlayable } from "../lib/format"
import { useSettings } from "../lib/settings"
import { lastEpisodeId, player, usePlayerStatus } from "./player"
import { useTrackSource } from "./usePlayback"

/**
 * Gives the player what React knows: the server, the list the library shows, where chapter audio comes from, and
 * the last episode after launch, loaded without play. Tells it when the app goes to the background. The library
 * provider gives it each library request and its answer.
 */
export function PlayerSync() {
  const { api } = useSettings()
  const { episodes, loaded } = useLibrary()
  const status = usePlayerStatus()
  const source = useTrackSource()
  const restored = useRef(false)

  useEffect(() => player.connect(api), [api])

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") player.saveNow()
    })
    return () => subscription.remove()
  }, [])

  // Also a list no request brought: an episode made, deleted or retried on this phone.
  useEffect(() => {
    if (source) player.listed(episodes, source)
  }, [episodes, source])

  useEffect(() => {
    if (restored.current || !loaded || !source || status.episodeId) return
    restored.current = true
    const last = episodes.find((episode) => episode.id === lastEpisodeId())
    if (last && isPlayable(last)) player.load(last, source, false)
  }, [loaded, source, episodes, status.episodeId])

  return null
}
