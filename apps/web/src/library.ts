import type { Episode, EpisodeId, JobState } from "@fama/contracts"
import { useCallback, useEffect, useState } from "react"
import { ApiError, api } from "~/api"
import { apiOrigin, apiToken } from "~/settings"

const POLL_MS = 2000

export const isWorking = (job: JobState) => job._tag === "Queued" || job._tag === "Running"

export interface Library {
  /** `null` until the first load finishes. */
  episodes: ReadonlyArray<Episode> | null
  error: ApiError | null
  refresh: () => Promise<void>
  /** Puts a new or changed episode in the list without a refetch. */
  upsert: (episode: Episode) => void
  retry: (id: EpisodeId) => Promise<void>
  remove: (id: EpisodeId) => Promise<void>
}

export function useLibrary(): Library {
  const token = apiToken.use()
  const origin = apiOrigin.use()
  const [episodes, setEpisodes] = useState<ReadonlyArray<Episode> | null>(null)
  const [error, setError] = useState<ApiError | null>(null)

  const refresh = useCallback(async () => {
    try {
      setEpisodes(await api.episodes())
      setError(null)
    } catch (cause) {
      setError(toApiError(cause))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, token, origin])

  const working = episodes?.some((episode) => isWorking(episode.job)) ?? false
  useEffect(() => {
    if (!working) return
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [working, refresh])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [refresh])

  const upsert = useCallback((episode: Episode) => {
    setEpisodes((list) => [episode, ...(list ?? []).filter((item) => item.id !== episode.id)])
  }, [])

  const retry = useCallback(
    async (id: EpisodeId) => {
      const episode = await api.retry(id)
      setEpisodes((list) => list?.map((item) => (item.id === id ? episode : item)) ?? null)
    },
    [],
  )

  const remove = useCallback(async (id: EpisodeId) => {
    await api.remove(id)
    setEpisodes((list) => list?.filter((item) => item.id !== id) ?? null)
  }, [])

  return { episodes, error, refresh, upsert, retry, remove }
}

export function toApiError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause
  return new ApiError(0, "The server sent a response this app does not understand")
}
