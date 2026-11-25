import { EpisodeList, type Episode, type Document, type SourceInput, type VoiceRef } from "@fama/contracts"
import { Schema } from "effect"
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { AppState } from "react-native"
import { ApiError, type PickedFile } from "./api"
import { isActive } from "./format"
import { jsonFile } from "./jsonFile"
import { useSettings } from "./settings"
import { player } from "../player/player"

const POLL_MS = 3_000

type Library = {
  readonly episodes: ReadonlyArray<Episode>
  /** True after the first list arrived for the current account. */
  readonly loaded: boolean
  readonly refreshing: boolean
  readonly error: string | null
  refresh(): Promise<void>
  create(source: SourceInput, voice: VoiceRef | null, speed: number, review?: boolean): Promise<Episode>
  upload(file: PickedFile, voice: VoiceRef | null, speed: number, review?: boolean): Promise<Episode>
  remove(id: string): Promise<void>
  saveReviewVoice(id: string, voice: VoiceRef, speed: number): Promise<void>
  start(id: string, document: Document, voice?: VoiceRef | null): Promise<void>
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
    const request = player.refreshStarted()
    let listed: ReadonlyArray<Episode> | null = null
    try {
      const list = await current.api.listEpisodes()
      if (!isCurrent()) return
      listed = list
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
      // The player gets the answer as one event: the list, the server's progress in it, and the request that is
      // no longer out. So it gives the native player the new chapters and the job before a waiting Play starts.
      player.refreshAnswered(request, listed)
    }
  }, [])

  // A new server, token or user starts a fresh library.
  useEffect(() => {
    const cached = cachedEpisodes(accountKey)
    player.listed(cached)
    setEpisodes(cached)
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
      async create(source, voice, speed, review) {
        const episode = await requireApi().createEpisode(source, voice, speed, review)
        prepend(episode)
        return episode
      },
      async upload(file, voice, speed, review) {
        const episode = await requireApi().uploadEpisode(file, voice, speed, review)
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
      async saveReviewVoice(id, voice, speed) {
        await requireApi().changeVoice(id, voice, speed)
        setEpisodes((list) => list.map((e) => (e.id === id && e.job._tag === "Review" ? { ...e, voice, speed } : e)))
      },
      async start(id, document, voice) {
        const episode = await requireApi().start(id, document, voice ?? null)
        setEpisodes((list) => list.map((e) => (e.id === id ? episode : e)))
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
