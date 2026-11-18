import type { Episode } from "@fama/contracts"
import { Directory, File, Paths } from "expo-file-system"
import { createContext, use, useMemo, useState, type ReactNode } from "react"
import { useSettings } from "./settings"

export type DownloadState = { readonly _tag: "None" } | { readonly _tag: "Downloading"; readonly done: number; readonly total: number } | { readonly _tag: "Done" }

type Downloads = {
  state(episode: Episode): DownloadState
  /** The local file of a chapter, or null when it is not on the device. */
  localUri(episodeId: string, index: number): string | null
  download(episode: Episode): Promise<void>
  remove(episodeId: string): void
}

const DownloadsContext = createContext<Downloads | null>(null)

const episodeDir = (id: string) => new Directory(Paths.document, "episodes", id)
const chapterFile = (id: string, index: number) => new File(episodeDir(id), `${String(index).padStart(3, "0")}.m4a`)

export function DownloadsProvider({ children }: { children: ReactNode }) {
  const { api } = useSettings()
  const [active, setActive] = useState<ReadonlyMap<string, { done: number; total: number }>>(new Map())
  // File checks are synchronous. Bump after a change on disk so readers render again.
  const [version, setVersion] = useState(0)

  const value = useMemo<Downloads>(() => {
    const isComplete = (episode: Episode) =>
      episode.job._tag === "Ready" && episode.chapters.length > 0 && episode.chapters.every((c) => chapterFile(episode.id, c.index).exists)
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
      localUri(episodeId, index) {
        const file = chapterFile(episodeId, index)
        return file.exists ? file.uri : null
      },
      async download(episode) {
        if (!api || active.has(episode.id)) return
        const dir = episodeDir(episode.id)
        if (!dir.exists) dir.create({ intermediates: true })
        const total = episode.chapters.length
        setProgress(episode.id, { done: 0, total })
        try {
          for (const [done, chapter] of episode.chapters.entries()) {
            const file = chapterFile(episode.id, chapter.index)
            if (!file.exists) {
              // Download beside the target, then move, so a cut download never looks complete.
              const partial = new File(dir, `${chapter.index}.part`)
              if (partial.exists) partial.delete()
              await File.downloadFileAsync(api.mediaUrl(chapter.url), partial)
              partial.move(file)
            }
            setProgress(episode.id, { done: done + 1, total })
          }
        } finally {
          setProgress(episode.id, null)
          setVersion((v) => v + 1)
        }
      },
      remove(episodeId) {
        const dir = episodeDir(episodeId)
        if (dir.exists) dir.delete()
        setVersion((v) => v + 1)
      },
    }
    // version is a cache key for the file checks above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, active, version])

  return <DownloadsContext value={value}>{children}</DownloadsContext>
}

export function useDownloads(): Downloads {
  const downloads = use(DownloadsContext)
  if (!downloads) throw new Error("useDownloads needs DownloadsProvider")
  return downloads
}
