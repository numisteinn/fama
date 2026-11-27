import type { Chapter, Episode } from "@fama/contracts"

/**
 * An episode plays as one timeline made of its chapter files in order.
 * Positions are milliseconds from the start of chapter 0.
 */
export function totalMs(chapters: ReadonlyArray<Chapter>): number {
  return chapters.reduce((sum, chapter) => sum + chapter.durationMs, 0)
}

/** The Position slider moves in whole seconds. */
export const SCRUB_STEP_MS = 1000

/**
 * The slider's max: the duration rounded up to a whole step. A range input cannot reach a max that is not a
 * whole step, so this extra stop stands for the very end, and every whole second before it stays a stop,
 * as in the React slider.
 */
export function scrubMaxMs(chapters: ReadonlyArray<Chapter>): number {
  return Math.max(SCRUB_STEP_MS, Math.ceil(totalMs(chapters) / SCRUB_STEP_MS) * SCRUB_STEP_MS)
}

/** The position a slider value stands for: the value, with the extra last stop at the very end. */
export function scrubTargetMs(chapters: ReadonlyArray<Chapter>, valueMs: number): number {
  return Math.min(valueMs, totalMs(chapters))
}

export function chapterStartMs(chapters: ReadonlyArray<Chapter>, index: number): number {
  return totalMs(chapters.slice(0, index))
}

/** The chapter that holds `ms`, and the offset into it. Past the end lands at the end of the last chapter. */
export function locate(
  chapters: ReadonlyArray<Chapter>,
  ms: number,
): { index: number; offsetMs: number } {
  let start = 0
  for (const [index, chapter] of chapters.entries()) {
    if (ms < start + chapter.durationMs) return { index, offsetMs: Math.max(0, ms - start) }
    start += chapter.durationMs
  }
  const last = chapters.length - 1
  return last < 0 ? { index: 0, offsetMs: 0 } : { index: last, offsetMs: chapters[last]!.durationMs }
}

/** Whether the episode has at least one chapter with a timing file, so Read-along can show its text. */
export function hasText(episode: Episode): boolean {
  return episode.chapters.some((chapter) => chapter.timingUrl !== null)
}
