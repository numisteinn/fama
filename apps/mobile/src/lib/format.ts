import type { Episode, JobState } from "@fama/contracts"

/** 0:42, 12:05, 1:02:03 */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`
}

/** 45 sec, 12 min, 1 h 5 min */
export function duration(seconds: number): string {
  const total = Math.round(seconds)
  if (total < 60) return `${total} sec`
  const minutes = Math.round(total / 60)
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

export function speed(rate: number): string {
  return `${Number(rate.toFixed(2))}×`
}

const STAGE: Record<Extract<JobState, { _tag: "Running" }>["stage"], string> = {
  extracting: "Reading",
  synthesizing: "Narrating",
  encoding: "Encoding",
  uploading: "Uploading",
}

export function jobLabel(job: JobState): string {
  switch (job._tag) {
    case "Queued":
      return "Queued"
    case "Running":
      if (job.remainingMs !== null) return `${STAGE[job.stage]} · ${duration(job.remainingMs / 1000)} left`
      return job.total > 0 ? `${STAGE[job.stage]} ${job.done}/${job.total}` : STAGE[job.stage]
    case "Ready":
      return "Ready"
    case "Failed":
      return "Failed"
  }
}

export function totalSeconds(episode: Episode): number {
  if (episode.durationMs !== null) return episode.durationMs / 1000
  return episode.chapters.reduce((sum, chapter) => sum + chapter.durationMs, 0) / 1000
}

/** Playable once the first chapter exists, even while the job runs. */
export function isPlayable(episode: Episode): boolean {
  return episode.chapters.length > 0 && episode.job._tag !== "Failed"
}

export function isActive(job: JobState): boolean {
  return job._tag === "Queued" || job._tag === "Running"
}
