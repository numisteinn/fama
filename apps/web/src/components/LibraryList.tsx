import type { Episode, JobState } from "@fama/contracts"
import { AudioLines, Play, RotateCw, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { toApiError, type Library } from "~/library"
import { formatDuration } from "~/lib/format"
import { cn } from "~/lib/utils"
import { usePlayer } from "~/player"
import { mediaUrl } from "~/settings"
import { totalMs } from "~/timeline"
import { Button } from "./ui/button"

export function LibraryList({ library }: { library: Library }) {
  const { episodes, error } = library
  if (episodes === null) {
    if (!error) return null
    return (
      <div className="flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3 text-sm">
        <span className="text-destructive">{error.message}</span>
        <Button variant="outline" size="sm" onClick={() => void library.refresh()}>
          Try again
        </Button>
      </div>
    )
  }
  return (
    <ul className="-mx-2 flex flex-col">
      {episodes.map((episode) => (
        <EpisodeRow key={episode.id} episode={episode} library={library} />
      ))}
    </ul>
  )
}

function EpisodeRow({ episode, library }: { episode: Episode; library: Library }) {
  const player = usePlayer()
  const current = player.episode?.id === episode.id
  const playable = episode.chapters.length > 0
  const [actionError, setActionError] = useState<string | null>(null)

  const run = (action: () => Promise<void>) => {
    setActionError(null)
    action().catch((cause: unknown) => setActionError(toApiError(cause).message))
  }

  return (
    <li
      className={cn(
        "group relative flex min-h-14 items-center gap-3 rounded-xl px-2 py-2 transition-colors duration-150",
        playable && "hover:bg-accent",
        current && "bg-accent",
      )}
    >
      <button
        type="button"
        disabled={!playable}
        onClick={() => player.start(episode)}
        aria-label={current && player.playing ? `Pause ${episode.title}` : `Play ${episode.title}`}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left outline-none disabled:cursor-default before:absolute before:inset-0 before:rounded-xl focus-visible:before:ring-2 focus-visible:before:ring-ring"
      >
        <Artwork episode={episode} current={current} playing={current && player.playing} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] leading-snug">{episode.title}</span>
          {(episode.job._tag === "Failed" || actionError) && (
            <span className="block truncate text-[13px] text-destructive" title={actionError ?? undefined}>
              {actionError ?? (episode.job._tag === "Failed" ? episode.job.reason : null)}
            </span>
          )}
        </span>
      </button>
      <JobStatus episode={episode} />
      {episode.job._tag === "Failed" && (
        <Button
          variant="outline"
          size="sm"
          className="relative"
          onClick={() => run(() => library.retry(episode.id))}
        >
          <RotateCw />
          Retry
        </Button>
      )}
      <DeleteButton title={episode.title} onDelete={() => run(() => library.remove(episode.id))} />
    </li>
  )
}

function Artwork({ episode, current, playing }: { episode: Episode; current: boolean; playing: boolean }) {
  const playable = episode.chapters.length > 0
  return (
    <span className="relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-accent text-muted-foreground">
      {episode.coverUrl && (
        <img src={mediaUrl(episode.coverUrl)} alt="" className="absolute inset-0 size-full object-cover" />
      )}
      {playing ? (
        <AudioLines className="relative size-4.5 text-foreground" />
      ) : (
        playable && (
          <Play
            className={cn(
              "relative size-4 fill-current text-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100",
              current && "opacity-100",
            )}
          />
        )
      )}
    </span>
  )
}

const STAGE: Record<Extract<JobState, { _tag: "Running" }>["stage"], string> = {
  extracting: "Reading",
  synthesizing: "Narrating",
  encoding: "Encoding",
  uploading: "Uploading",
}

function JobStatus({ episode }: { episode: Episode }) {
  const { job } = episode
  switch (job._tag) {
    case "Ready": {
      const ms = episode.durationMs ?? totalMs(episode.chapters)
      return <span className="shrink-0 text-[13px] text-muted-foreground tabular-nums">{formatDuration(ms)}</span>
    }
    case "Queued":
      return <span className="shrink-0 animate-pulse text-[13px] text-muted-foreground">Queued</span>
    case "Running": {
      const fraction = job.total > 0 ? Math.min(1, job.done / job.total) : 0
      return (
        <span className="flex w-28 shrink-0 flex-col items-end gap-1.5 text-[13px] text-muted-foreground tabular-nums">
          <span>
            {STAGE[job.stage]}
            {job.total > 0 && ` ${job.done}/${job.total}`}
          </span>
          <span className="h-0.5 w-full overflow-hidden rounded-full bg-faint" aria-hidden>
            <span
              className="block h-full origin-left rounded-full bg-foreground transition-transform duration-700 ease-out"
              style={{ transform: `scaleX(${fraction})` }}
            />
          </span>
        </span>
      )
    }
    case "Failed":
      return null
  }
}

/** Two clicks: the first arms it, the second deletes. Disarms after a few seconds. */
function DeleteButton({ title, onDelete }: { title: string; onDelete: () => void }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(timer)
  }, [armed])
  if (armed) {
    return (
      <Button variant="destructive" size="sm" className="relative" onClick={onDelete} autoFocus>
        Delete
      </Button>
    )
  }
  return (
    <Button
      size="icon-sm"
      aria-label={`Delete ${title}`}
      onClick={() => setArmed(true)}
      className="relative opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
    >
      <Trash2 />
    </Button>
  )
}
