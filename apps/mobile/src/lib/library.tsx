import { EpisodeList, type Episode, type SourceInput, type VoiceRef } from "@fama/contracts"
import { Schema } from "effect"
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { AppState } from "react-native"
import { ApiError, type PickedFile } from "./api"
import { isActive } from "./format"
import { jsonFile } from "./jsonFile"
import { useSettings } from "./settings"
import { playGate } from "../player/player"
import { progress } from "../player/progress"

const POLL_MS = 3_000

type Library = {
  readonly episodes: ReadonlyArray<Episode>
  /** True after the first list arrived for the current account. */
  readonly loaded: boolean
  readonly refreshing: boolean
  readonly error: string | null
  refresh(): Promise<void>
  create(source: SourceInput, voice: VoiceRef | null, speed: number): Promise<Episode>
  upload(file: PickedFile, voice: VoiceRef | null, speed: number): Promise<Episode>
  remove(id: string): Promise<void>
  retry(id: string): Promise<void>
}

const LibraryContext = createContext<Library | null>(null)

// The last list of each account (server and user), so downloaded episodes stay playable offline and two accounts
// on one server never see each other's episodes.
const cacheFile = jsonFile<Record<string, unknown>>("libraries.json", {})
const decodeList = Schema.decodeUnknownSync(EpisodeList)

function cachedEpisodes(accountKey: string | undefined): ReadonlyArray<Episode> {
  if (accountKey === undefined) return []
  try {
    return decodeList({ episodes: cacheFile.read()[accountKey] }).episodes
  } catch {
    return []
  }
}

const message = (error: unknown) => (error instanceof ApiError ? error.message : "Something went wrong.")

export function LibraryProvider({ children }: { children: ReactNode }) {
  const { api, account } = useSettings()
  const accountKey = account?.key
  const [episodes, setEpisodes] = useState<ReadonlyArray<Episode>>([])
  const [loaded, setLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The library loads only once the account is known, so a list is never cached under the wrong user.
  const sessionRef = useRef({ api, accountKey })
  sessionRef.current = { api, accountKey }

  const load = useCallback(async () => {
    const current = sessionRef.current
    if (!current.api || current.accountKey === undefined) return
    const isCurrent = () => sessionRef.current.api === current.api && sessionRef.current.accountKey === current.accountKey
    // A Play pressed while this request is out waits for it, by its number.
    const request = playGate.refreshStarted()
    let isListed = false
    try {
      const list = await current.api.listEpisodes()
      if (!isCurrent()) return
      // Every list the server sent: pending local entries go out, newer server entries come in. This runs before
      // the gate opens, so a waiting Play starts from the newer position.
      progress.sync(list)
      isListed = true
      setEpisodes(list)
      setLoaded(true)
      setError(null)
      cacheFile.write({
        ...cacheFile.read(),
        [current.accountKey]: Schema.encodeSync(EpisodeList)({ episodes: list }).episodes,
      })
    } catch (cause) {
      if (isCurrent()) setError(message(cause))
    } finally {
      playGate.refreshSettled(request, isListed)
    }
  }, [])

  // A new server, token or user starts a fresh library.
  useEffect(() => {
    setEpisodes(cachedEpisodes(accountKey))
    setLoaded(false)
    setError(null)
    void load()
  }, [api, accountKey, load])

  // Poll while any job is queued or running and the app is in front.
  const working = episodes.some((episode) => isActive(episode.job))
  useEffect(() => {
    if (!working) return
    let timer: ReturnType<typeof setInterval> | null = null
    const start = () => {
      if (!timer) timer = setInterval(() => void load(), POLL_MS)
    }
    const stop = () => {
      if (timer) clearInterval(timer)
      timer = null
    }
    if (AppState.currentState === "active") start()
    const subscription = AppState.addEventListener("change", (state) => (state === "active" ? start() : stop()))
    return () => {
      stop()
      subscription.remove()
    }
  }, [working, load])

  // Coming back to the app refreshes once.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void load()
    })
    return () => subscription.remove()
  }, [load])

  const value = useMemo<Library>(() => {
    const requireApi = () => {
      if (!sessionRef.current.api) throw new ApiError("Set your server in Settings first.", null)
      return sessionRef.current.api
    }
    const prepend = (episode: Episode) => setEpisodes((list) => [episode, ...list.filter((e) => e.id !== episode.id)])
    return {
      episodes,
      loaded,
      refreshing,
      error,
      async refresh() {
        setRefreshing(true)
        await load()
        setRefreshing(false)
      },
      async create(source, voice, speed) {
        const episode = await requireApi().createEpisode(source, voice, speed)
        prepend(episode)
        return episode
      },
      async upload(file, voice, speed) {
        const episode = await requireApi().uploadEpisode(file, voice, speed)
        prepend(episode)
        return episode
      },
      async remove(id) {
        const before = episodes
        setEpisodes((list) => list.filter((e) => e.id !== id))
        try {
          await requireApi().deleteEpisode(id)
        } catch (cause) {
          setEpisodes(before)
          throw cause
        }
      },
      async retry(id) {
        const episode = await requireApi().retryEpisode(id)
        setEpisodes((list) => list.map((e) => (e.id === id ? episode : e)))
      },
    }
  }, [episodes, loaded, refreshing, error, load])

  return <LibraryContext value={value}>{children}</LibraryContext>
}

export function useLibrary(): Library {
  const library = use(LibraryContext)
  if (!library) throw new Error("useLibrary needs LibraryProvider")
  return library
}

export function useEpisode(id: string | null): Episode | null {
  const { episodes } = useLibrary()
  return id ? (episodes.find((episode) => episode.id === id) ?? null) : null
}
