import { Schema } from "effect"

/** One chapter in the Review editor, aligned by `index` with `loaded.chapters`. */
export const ReviewChapter = Schema.Struct({
  index: Schema.Number,
  title: Schema.String,
  text: Schema.String,
  isKept: Schema.Boolean,
})
export type ReviewChapter = typeof ReviewChapter.Type

const MAX_REPEATED_LINE_LENGTH = 160
const MAX_REPEATED_LINES = 3

/**
 * Finds trimmed non-empty lines that repeat across most kept chapters (common PDF running headers/footers).
 * Kept in state and recomputed on load, keep-toggle, removal, and chapter collapse so typing stays O(1).
 */
export const detectRepeatedLines = (chapters: ReadonlyArray<ReviewChapter>): Array<string> => {
  const kept = chapters.filter((chapter) => chapter.isKept)
  if (kept.length < 2) return []
  const threshold = Math.max(2, Math.ceil(kept.length * 0.6))
  const counts = new Map<string, number>()
  for (const chapter of kept) {
    const seen = new Set<string>()
    for (const raw of chapter.text.split(/\r?\n/)) {
      const line = raw.trim()
      if (line.length === 0 || line.length > MAX_REPEATED_LINE_LENGTH || seen.has(line)) continue
      seen.add(line)
      counts.set(line, (counts.get(line) ?? 0) + 1)
    }
  }
  const matches: Array<readonly [string, number]> = []
  for (const [line, count] of counts) {
    if (count >= threshold) matches.push([line, count])
  }
  matches.sort((a, b) => b[1] - a[1])
  return matches.slice(0, MAX_REPEATED_LINES).map(([line]) => line)
}

/** Removes every line matching `target` (after trimming) and collapses leftover blank-line gaps. */
export const removeLineFromText = (text: string, target: string): string =>
  text
    .split(/\r?\n/)
    .filter((raw) => raw.trim() !== target)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

export const removeRepeatedLine = (
  chapters: ReadonlyArray<ReviewChapter>,
  target: string,
): Array<ReviewChapter> =>
  chapters.map((chapter) => ({ ...chapter, text: removeLineFromText(chapter.text, target) }))

/** Label of the Start button: reflects kept chapter count directly without helper text. */
export const startButtonLabel = (kept: number, total: number, isStarting: boolean): string => {
  if (isStarting) return "Starting…"
  if (kept === 0) return "Start · 0 chapters"
  if (kept === total) return kept === 1 ? "Start · 1 chapter" : `Start · ${kept} chapters`
  return `Start · ${kept} of ${total} chapters`
}
