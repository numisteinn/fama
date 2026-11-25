import type { Episode } from "@fama/contracts"
import { Directory, File, Paths } from "expo-file-system"
import { createContext, use, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  audioFileName,
  isEpisodeDownloaded,
  isUnversionedChapterPath,
  legacyAudioFileName,
  legacyTimingFileName,
  staleFileNames,
  timingFileName,
} from "./downloadFiles"
import { useLibrary } from "./library"
import { useSettings } from "./settings"

export type DownloadState = { readonly _tag: "None" } | { readonly _tag: "Downloading"; readonly done: number; readonly total: number } | { readonly _tag: "Done" }

type Downloads = {
  state(episode: Episode): DownloadState
  /** The local file of a chapter's current URL, or null when that revision is not on the device. */
  localUri(episodeId: string, index: number, url: string): string | null
  /** The local timing file of a chapter's current timingUrl, or null when that revision is not on the device. */
  localTimingUri(episodeId: string, index: number, timingUrl: string): string | null
  download(episode: Episode): Promise<void>
  remove(episodeId: string): void
}

const DownloadsContext = createContext<Downloads | null>(null)

// Downloads live per account (server and user), so two accounts on one server never share files.
const episodeDir = (accountKey: string, id: string) => new Directory(Paths.document, "accounts", accountKey, "episodes", id)
const chapterFile = (accountKey: string, id: string, index: number, url: string) =>
  new File(episodeDir(accountKey, id), audioFileName(index, url))
const timingFile = (accountKey: string, id: string, index: number, timingUrl: string) =>
  new File(episodeDir(accountKey, id), timingFileName(index, timingUrl))

/** Downloads beside the target, then moves, so a cut download never looks complete. */
async function fetchFile(url: string, dir: Directory, target: File) {
  if (target.exists) return
  const partial = new File(dir, `${target.name}.part`)
  if (partial.exists) partial.delete()
  await File.downloadFileAsync(url, partial)
  partial.move(target)
}

export function DownloadsProvider({ children }: { children: ReactNode }) {
  const { api, account } = useSettings()
  const { episodes } = useLibrary()
  const accountKey = account?.key
  const [active, setActive] = useState<ReadonlyMap<string, { done: number; total: number }>>(new Map())
  // File checks are synchronous. Bump after a change on disk so readers render again.
  const [version, setVersion] = useState(0)

  // Migrate unversioned legacy files and prune orphaned/replaced revisions when the library updates.
  useEffect(() => {
    if (accountKey === undefined || episodes.length === 0) return
    let changed = false
    for (const episode of episodes) {
      if (episode.job._tag !== "Ready" || episode.chapters.length === 0 || active.has(episode.id)) continue
      const dir = episodeDir(accountKey, episode.id)
      if (!dir.exists) continue
      for (const chapter of episode.chapters) {
        if (isUnversionedChapterPath(chapter.url)) {
          const legacy = new File(dir, legacyAudioFileName(chapter.index))
          const current = new File(dir, audioFileName(chapter.index, chapter.url))
          if (legacy.exists && !current.exists) {
            legacy.move(current)
            changed = true
          }
        }
        if (chapter.timingUrl !== null && isUnversionedChapterPath(chapter.timingUrl)) {
          const legacy = new File(dir, legacyTimingFileName(chapter.index))
          const current = new File(dir, timingFileName(chapter.index, chapter.timingUrl))
          if (legacy.exists && !current.exists) {
            legacy.move(current)
            changed = true
          }
        }
      }
      const entries = dir.list()
      const stale = new Set(staleFileNames(entries.map((entry) => entry.name), episode.chapters))
      for (const entry of entries) {
        if (stale.has(entry.name)) {
          entry.delete()
          changed = true
        }
      }
    }
    if (changed) setVersion((v) => v + 1)
  }, [accountKey, episodes, active])

  const value = useMemo<Downloads>(() => {
    const isComplete = (episode: Episode) =>
      accountKey !== undefined &&
      isEpisodeDownloaded(episode, (name) => new File(episodeDir(accountKey, episode.id), name).exists)
    const setProgress = (id: string, progress: { done: number; total: number } | null) =>
      setActive((map) => {
        const next = new Map(map)
        if (progress) next.set(id, progress)
        else next.delete(id)
        return next
      })
    return {
      state(episode) {
        const progress = active.get(episode.id)
        if (progress) return { _tag: "Downloading", ...progress }
        return isComplete(episode) ? { _tag: "Done" } : { _tag: "None" }
      },
      localUri(episodeId, index, url) {
        if (accountKey === undefined) return null
        const file = chapterFile(accountKey, episodeId, index, url)
        return file.exists ? file.uri : null
      },
      localTimingUri(episodeId, index, timingUrl) {
        if (accountKey === undefined) return null
        const file = timingFile(accountKey, episodeId, index, timingUrl)
        return file.exists ? file.uri : null
      },
      async download(episode) {
        if (!api || accountKey === undefined || active.has(episode.id)) return
        const dir = episodeDir(accountKey, episode.id)
        if (!dir.exists) dir.create({ intermediates: true })
        const total = episode.chapters.length
        setProgress(episode.id, { done: 0, total })
        try {
          for (const [done, chapter] of episode.chapters.entries()) {
            // The text too, so the reader works offline.
            if (chapter.timingUrl !== null) {
              await fetchFile(api.mediaUrl(chapter.timingUrl), dir, timingFile(accountKey, episode.id, chapter.index, chapter.timingUrl))
            }
            await fetchFile(api.mediaUrl(chapter.url), dir, chapterFile(accountKey, episode.id, chapter.index, chapter.url))
            setProgress(episode.id, { done: done + 1, total })
          }
          const stale = new Set(staleFileNames(dir.list().map((entry) => entry.name), episode.chapters))
          for (const entry of dir.list()) {
            if (stale.has(entry.name)) entry.delete()
          }
        } finally {
          setProgress(episode.id, null)
          setVersion((v) => v + 1)
        }
      },
      remove(episodeId) {
        if (accountKey === undefined) return
        const dir = episodeDir(accountKey, episodeId)
        if (dir.exists) dir.delete()
        setVersion((v) => v + 1)
      },
    }
    // version is a cache key for the file checks above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, accountKey, active, version])

  return <DownloadsContext value={value}>{children}</DownloadsContext>
}

export function useDownloads(): Downloads {
  const downloads = use(DownloadsContext)
  if (!downloads) throw new Error("useDownloads needs DownloadsProvider")
  return downloads
}
