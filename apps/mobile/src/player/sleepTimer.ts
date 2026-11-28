import type { Episode } from "@fama/contracts"
import type { NativeStatus } from "./native"

const FIVE_MINUTES_MS = 5 * 60 * 1_000

export type SleepTimerMode =
  | { readonly _tag: "Off" }
  | { readonly _tag: "Countdown"; readonly endsAtMs: number }
  | { readonly _tag: "EndOfChapter"; readonly chapterIndex: number }

export type SleepTimerPreset = 15 | 30 | 45 | 60 | "EndOfChapter"

export type SleepTimerActions = {
  readonly pause: () => void
  readonly seek: (position: number) => void
}

export type SleepTimerSnapshot = {
  readonly mode: SleepTimerMode
  readonly episodeId: string | null
}

const OFF: SleepTimerMode = { _tag: "Off" }

export function formatRemaining(mode: SleepTimerMode, nowMs: number): string | null {
  switch (mode._tag) {
    case "Off":
      return null
    case "EndOfChapter":
      return "Ch. end"
    case "Countdown": {
      const totalSeconds = Math.max(0, Math.ceil((mode.endsAtMs - nowMs) / 1_000))
      return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`
    }
  }
}

export function accessibilityLabel(mode: SleepTimerMode, nowMs: number): string {
  switch (mode._tag) {
    case "Off":
      return "Sleep timer, off"
    case "EndOfChapter":
      return "Sleep timer, end of chapter"
    case "Countdown": {
      const totalSeconds = Math.max(0, Math.ceil((mode.endsAtMs - nowMs) / 1_000))
      if (totalSeconds < 60) return "Sleep timer, less than 1 minute left"
      const minutes = Math.ceil(totalSeconds / 60)
      return `Sleep timer, ${minutes} ${minutes === 1 ? "minute" : "minutes"} left`
    }
  }
}

export function setPreset(preset: SleepTimerPreset, nowMs: number, chapterIndex = 0): SleepTimerMode {
  if (preset === "EndOfChapter") return { _tag: "EndOfChapter", chapterIndex }
  return { _tag: "Countdown", endsAtMs: nowMs + preset * 60 * 1_000 }
}

export function addFiveMinutes(mode: SleepTimerMode, nowMs: number): SleepTimerMode {
  if (mode._tag !== "Countdown") return mode
  return { _tag: "Countdown", endsAtMs: Math.max(nowMs, mode.endsAtMs) + FIVE_MINUTES_MS }
}

export function isExpired(mode: SleepTimerMode, nowMs: number): boolean {
  return mode._tag === "Countdown" && nowMs >= mode.endsAtMs
}

export function chapterBoundaryReached(mode: SleepTimerMode, status: Pick<NativeStatus, "index" | "ended">): boolean {
  return mode._tag === "EndOfChapter" && (status.index > mode.chapterIndex || status.ended)
}

function chapterStart(episode: Episode | null, index: number): number | null {
  if (!episode?.chapters[index]) return null
  return episode.chapters.slice(0, index).reduce((seconds, chapter) => seconds + chapter.durationMs / 1_000, 0)
}

export function chapterIndexAt(episode: Episode | null, positionSec: number): number | null {
  if (!episode || episode.chapters.length === 0) return null
  let cursor = 0
  for (let index = 0; index < episode.chapters.length; index += 1) {
    const chapter = episode.chapters[index]
    if (!chapter) break
    cursor += chapter.durationMs / 1_000
    if (positionSec < cursor) return index
  }
  return episode.chapters.length - 1
}

class TimerController {
  private snapshot: SleepTimerSnapshot = { mode: OFF, episodeId: null }
  private readonly actions: SleepTimerActions
  private readonly listeners = new Set<() => void>()
  private readonly onArmedChange?: (mode: SleepTimerMode) => void

  constructor(actions: SleepTimerActions, onArmedChange?: (mode: SleepTimerMode) => void) {
    this.actions = actions
    this.onArmedChange = onArmedChange
  }

  getSnapshot = (): SleepTimerSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  arm(mode: SleepTimerMode, episodeId: string | null): void {
    this.snapshot = { mode, episodeId }
    this.onArmedChange?.(mode)
    this.listeners.forEach((listener) => listener())
  }

  setPreset(preset: SleepTimerPreset, nowMs: number, chapterIndex: number, episodeId: string | null): void {
    this.arm(setPreset(preset, nowMs, chapterIndex), episodeId)
  }

  addFiveMinutes(nowMs: number): void {
    this.arm(addFiveMinutes(this.snapshot.mode, nowMs), this.snapshot.episodeId)
  }

  off(): void {
    if (this.snapshot.mode._tag === "Off") return
    this.arm(OFF, null)
  }

  /** Re-targets `EndOfChapter` to the chapter the listener jumped to so manual seeks never trigger a false stop. */
  onManualSeek(episode: Episode | null, targetPositionSec: number): void {
    const { mode, episodeId } = this.snapshot
    if (mode._tag !== "EndOfChapter") return
    const nextIndex = chapterIndexAt(episode, targetPositionSec)
    if (nextIndex === null || nextIndex === mode.chapterIndex) return
    this.arm({ _tag: "EndOfChapter", chapterIndex: nextIndex }, episodeId)
  }

  check(status: Pick<NativeStatus, "episodeId" | "index" | "ended">, nowMs: number, episode: Episode | null): void {
    const { mode, episodeId } = this.snapshot
    if (mode._tag === "Off") return
    if (episodeId !== null && status.episodeId !== episodeId) {
      this.off()
      return
    }
    if (isExpired(mode, nowMs) || chapterBoundaryReached(mode, status)) {
      this.actions.pause()
      if (mode._tag === "EndOfChapter" && status.index > mode.chapterIndex) {
        const start = chapterStart(episode, status.index)
        if (start !== null) this.actions.seek(start)
      }
      this.off()
    }
  }
}

export function createSleepTimerController(
  actions: SleepTimerActions = { pause: () => undefined, seek: () => undefined },
  onArmedChange?: (mode: SleepTimerMode) => void,
): {
  readonly getSnapshot: () => SleepTimerSnapshot
  readonly subscribe: (listener: () => void) => () => void
  readonly arm: (mode: SleepTimerMode, episodeId: string | null) => void
  readonly setPreset: (preset: SleepTimerPreset, nowMs: number, chapterIndex: number, episodeId: string | null) => void
  readonly addFiveMinutes: (nowMs: number) => void
  readonly off: () => void
  readonly onManualSeek: (episode: Episode | null, targetPositionSec: number) => void
  readonly check: (status: Pick<NativeStatus, "episodeId" | "index" | "ended">, nowMs: number, episode: Episode | null) => void
} {
  return new TimerController(actions, onArmedChange)
}
