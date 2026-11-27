/**
 * Remaps an episode position from the chapter timeline the native player was told onto a replacement chapter list,
 * matching the server rule in `docs/api.md`: same fraction inside a replaced chapter, shifted by duration deltas after it.
 */
export function remapReplacedPosition(
  posMs: number,
  oldDurations: ReadonlyArray<number>,
  oldUrls: ReadonlyArray<string>,
  newChapters: ReadonlyArray<{ readonly url: string; readonly durationMs: number }>,
): number {
  const newTotal = newChapters.reduce((sum, chapter) => sum + chapter.durationMs, 0)
  if (oldDurations.length === 0 || newChapters.length === 0) return Math.min(Math.max(0, posMs), newTotal)
  let elapsed = 0
  let index = oldDurations.length - 1
  let offset = Math.max(0, posMs)
  for (let i = 0; i < oldDurations.length; i++) {
    const duration = oldDurations[i] ?? 0
    if (posMs < elapsed + duration || i === oldDurations.length - 1) {
      index = i
      offset = Math.max(0, Math.min(posMs - elapsed, duration))
      break
    }
    elapsed += duration
  }
  const targetIndex = Math.min(index, newChapters.length - 1)
  const newStart = newChapters.slice(0, targetIndex).reduce((sum, chapter) => sum + chapter.durationMs, 0)
  const oldDuration = oldDurations[targetIndex] ?? 0
  const chapter = newChapters[targetIndex]
  if (chapter === undefined) return newTotal
  const newDuration = chapter.durationMs
  const replaced = oldUrls[targetIndex] !== chapter.url
  const newOffset = replaced && oldDuration > 0 ? Math.round((offset / oldDuration) * newDuration) : Math.min(offset, newDuration)
  return Math.max(0, Math.min(newTotal, newStart + newOffset))
}
