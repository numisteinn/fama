import type { Episode, EpisodeId } from "@fama/contracts"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { isWorking } from "~/library"
import { asNumber, stored } from "~/lib/storage"
import { mediaUrl, playbackRate } from "~/settings"
import { chapterStartMs, locate, totalMs } from "~/timeline"

export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const

const SAVE_EVERY_MS = 5000
/** Closer than this to the end counts as finished, so the next start is from the top. */
const FINISHED_MARGIN_MS = 3000

const positionOf = (id: EpisodeId) => stored(`fama.position.${id}`, 0, asNumber)

interface Playback {
  episodeId: EpisodeId
  chapter: number
  /** Position inside the current chapter file. */
  offsetMs: number
  playing: boolean
  /** The current chapter ended and the next one is still rendering. */
  waiting: boolean
}

export interface Player {
  episode: Episode | null
  chapter: number
  /** Position on the whole episode timeline. */
  positionMs: number
  /** Sum of the chapters rendered so far. */
  durationMs: number
  playing: boolean
  waiting: boolean
  rate: number
  /** Plays `episode` from its saved position, or toggles it when it is already loaded. */
  start: (episode: Episode) => void
  toggle: () => void
  seek: (ms: number) => void
  skip: (deltaMs: number) => void
  playChapter: (index: number) => void
  setRate: (rate: number) => void
}

const PlayerContext = createContext<Player | null>(null)

export function usePlayer(): Player {
  const player = useContext(PlayerContext)
  if (!player) throw new Error("usePlayer needs a PlayerProvider")
  return player
}

export function PlayerProvider({
  episodes,
  children,
}: {
  episodes: ReadonlyArray<Episode> | null
  children: ReactNode
}) {
  const [audio] = useState(() => {
    const element = new Audio()
    element.preload = "auto"
    return element
  })
  const rate = playbackRate.use()
  const [playback, setPlayback] = useState<Playback | null>(null)

  const episode = useMemo(
    () => (playback && episodes?.find((item) => item.id === playback.episodeId)) || null,
    [episodes, playback],
  )

  // Event handlers read the latest values through refs, so they attach once.
  const episodeRef = useRef(episode)
  episodeRef.current = episode
  const playbackRef = useRef(playback)
  playbackRef.current = playback
  const lastSave = useRef(0)

  const globalMs = (current: Playback, chapters: Episode["chapters"]) =>
    chapterStartMs(chapters, current.chapter) + current.offsetMs

  const save = useCallback((force: boolean) => {
    const current = playbackRef.current
    const item = episodeRef.current
    if (!current || !item) return
    const now = Date.now()
    if (!force && now - lastSave.current < SAVE_EVERY_MS) return
    lastSave.current = now
    positionOf(item.id).set(globalMs(current, item.chapters))
  }, [])

  const load = useCallback(
    (item: Episode, index: number, offsetMs: number, autoplay: boolean) => {
      const chapter = item.chapters[index]
      if (!chapter) return
      audio.src = mediaUrl(chapter.url)
      audio.currentTime = offsetMs / 1000
      audio.defaultPlaybackRate = playbackRate.get()
      audio.playbackRate = playbackRate.get()
      setPlayback({ episodeId: item.id, chapter: index, offsetMs, playing: autoplay, waiting: false })
      if (autoplay) void audio.play().catch(() => setPlayback((p) => p && { ...p, playing: false }))
    },
    [audio],
  )

  const seek = useCallback(
    (ms: number) => {
      const current = playbackRef.current
      const item = episodeRef.current
      if (!current || !item) return
      const clamped = Math.min(Math.max(0, ms), totalMs(item.chapters))
      const target = locate(item.chapters, clamped)
      if (target.index === current.chapter && audio.src) {
        audio.currentTime = target.offsetMs / 1000
        setPlayback({ ...current, offsetMs: target.offsetMs, waiting: false })
      } else {
        load(item, target.index, target.offsetMs, current.playing || current.waiting)
      }
      positionOf(item.id).set(clamped)
    },
    [audio, load],
  )

  const toggle = useCallback(() => {
    const current = playbackRef.current
    const item = episodeRef.current
    if (!current || !item) return
    if (current.waiting) return setPlayback({ ...current, waiting: false })
    if (audio.ended) return load(item, 0, 0, true)
    if (audio.paused) void audio.play().catch(() => undefined)
    else audio.pause()
  }, [audio, load])

  const start = useCallback(
    (item: Episode) => {
      if (playbackRef.current?.episodeId === item.id) return toggle()
      if (item.chapters.length === 0) return
      save(true)
      const saved = positionOf(item.id).get()
      const end = totalMs(item.chapters)
      const finished = !isWorking(item.job) && saved >= end - FINISHED_MARGIN_MS
      const target = locate(item.chapters, finished ? 0 : saved)
      load(item, target.index, target.offsetMs, true)
    },
    [load, save, toggle],
  )

  const skip = useCallback(
    (deltaMs: number) => {
      const current = playbackRef.current
      const item = episodeRef.current
      if (current && item) seek(globalMs(current, item.chapters) + deltaMs)
    },
    [seek],
  )

  const playChapter = useCallback(
    (index: number) => {
      const item = episodeRef.current
      if (item) load(item, index, 0, true)
    },
    [load],
  )

  const setRate = useCallback((value: number) => playbackRate.set(value), [])

  useEffect(() => {
    audio.defaultPlaybackRate = rate
    audio.playbackRate = rate
  }, [audio, rate])

  // Audio element events.
  useEffect(() => {
    const onTime = () => {
      setPlayback((p) => p && { ...p, offsetMs: audio.currentTime * 1000 })
      save(false)
    }
    const onPlay = () => setPlayback((p) => p && { ...p, playing: true, waiting: false })
    const onPause = () => {
      if (audio.ended) return
      setPlayback((p) => p && { ...p, playing: false })
      save(true)
    }
    const onEnded = () => {
      const current = playbackRef.current
      const item = episodeRef.current
      if (!current || !item) return
      const next = current.chapter + 1
      if (item.chapters[next]) return load(item, next, 0, true)
      if (isWorking(item.job)) {
        setPlayback({ ...current, playing: false, waiting: true })
        return
      }
      setPlayback({ ...current, playing: false })
      positionOf(item.id).set(0)
    }
    audio.addEventListener("timeupdate", onTime)
    audio.addEventListener("play", onPlay)
    audio.addEventListener("pause", onPause)
    audio.addEventListener("ended", onEnded)
    return () => {
      audio.removeEventListener("timeupdate", onTime)
      audio.removeEventListener("play", onPlay)
      audio.removeEventListener("pause", onPause)
      audio.removeEventListener("ended", onEnded)
    }
  }, [audio, load, save])

  // A chapter ended before the next one existed: continue once it shows up.
  useEffect(() => {
    if (!playback?.waiting || !episode) return
    if (episode.chapters[playback.chapter + 1]) load(episode, playback.chapter + 1, 0, true)
    else if (!isWorking(episode.job)) setPlayback({ ...playback, waiting: false })
  }, [episode, playback, load])

  // The episode was deleted: stop.
  useEffect(() => {
    if (playback && episodes && !episode) {
      audio.pause()
      audio.removeAttribute("src")
      audio.load()
      setPlayback(null)
    }
  }, [audio, episode, episodes, playback])

  useEffect(() => {
    const flush = () => save(true)
    window.addEventListener("pagehide", flush)
    return () => window.removeEventListener("pagehide", flush)
  }, [save])

  const positionMs = playback && episode ? globalMs(playback, episode.chapters) : 0
  const durationMs = episode ? totalMs(episode.chapters) : 0

  useMediaSession({
    episode,
    chapter: playback?.chapter ?? 0,
    positionMs,
    durationMs,
    rate,
    playing: playback?.playing ?? false,
    toggle,
    skip,
    seek,
    playChapter,
  })

  const value: Player = {
    episode,
    chapter: playback?.chapter ?? 0,
    positionMs,
    durationMs,
    playing: playback?.playing ?? false,
    waiting: playback?.waiting ?? false,
    rate,
    start,
    toggle,
    seek,
    skip,
    playChapter,
    setRate,
  }

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>
}

/** OS media keys, lock screen, and headphone controls. */
function useMediaSession(input: {
  episode: Episode | null
  chapter: number
  positionMs: number
  durationMs: number
  rate: number
  playing: boolean
  toggle: () => void
  skip: (deltaMs: number) => void
  seek: (ms: number) => void
  playChapter: (index: number) => void
}) {
  const { episode, chapter, positionMs, durationMs, rate, playing } = input
  const actions = useRef(input)
  actions.current = input
  const session = typeof navigator !== "undefined" ? navigator.mediaSession : undefined

  const title = episode?.title
  const chapterTitle = episode?.chapters[chapter]?.title
  const author = episode?.author
  const cover = episode?.coverUrl
  useEffect(() => {
    if (!session) return
    if (!title) {
      session.metadata = null
      return
    }
    const artwork = cover
      ? [{ src: new URL(mediaUrl(cover), location.href).href }]
      : [{ src: new URL("/icon-512.png", location.href).href, sizes: "512x512", type: "image/png" }]
    session.metadata = new MediaMetadata({
      title,
      artist: author ?? chapterTitle ?? "",
      album: chapterTitle ?? "Fama",
      artwork,
    })
  }, [session, title, chapterTitle, author, cover])

  useEffect(() => {
    if (!session) return
    session.playbackState = !episode ? "none" : playing ? "playing" : "paused"
  }, [session, episode, playing])

  useEffect(() => {
    if (!session || !episode || durationMs <= 0) return
    try {
      session.setPositionState({
        duration: durationMs / 1000,
        position: Math.min(positionMs, durationMs) / 1000,
        playbackRate: rate,
      })
    } catch {
      // Some browsers reject position state during a source change.
    }
  }, [session, episode, positionMs, durationMs, rate])

  useEffect(() => {
    if (!session) return
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ["play", () => !actions.current.playing && actions.current.toggle()],
      ["pause", () => actions.current.playing && actions.current.toggle()],
      ["seekbackward", (d) => actions.current.skip(-(d.seekOffset ?? 15) * 1000)],
      ["seekforward", (d) => actions.current.skip((d.seekOffset ?? 30) * 1000)],
      ["seekto", (d) => d.seekTime !== undefined && actions.current.seek(d.seekTime * 1000)],
      ["previoustrack", () => actions.current.playChapter(Math.max(0, actions.current.chapter - 1))],
      [
        "nexttrack",
        () => {
          const { episode: item, chapter: index } = actions.current
          if (item?.chapters[index + 1]) actions.current.playChapter(index + 1)
        },
      ],
    ]
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler)
      } catch {
        // Action not supported here.
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          session.setActionHandler(action, null)
        } catch {
          // Action not supported here.
        }
      }
    }
  }, [session])
}
