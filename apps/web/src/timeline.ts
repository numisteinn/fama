import type { Chapter } from "@fama/contracts"

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
 * The position a slider value stands for. A range input cannot reach a max that is not a whole step, so its
 * last step stands for the very end, as the React slider's full right did.
 */
export function scrubTargetMs(chapters: ReadonlyArray<Chapter>, valueMs: number): number {
  const total = totalMs(chapters)
  return valueMs >= Math.floor(total / SCRUB_STEP_MS) * SCRUB_STEP_MS ? total : valueMs
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
