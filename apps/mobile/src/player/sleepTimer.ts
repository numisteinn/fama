import type { Episode } from "@fama/contracts"
import { useEffect, useState, useSyncExternalStore } from "react"
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
      return "End of ch."
    case "Countdown": {
      const totalSeconds = Math.max(0, Math.floor((mode.endsAtMs - nowMs) / 1_000))
      return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`
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

class TimerController {
  private snapshot: SleepTimerSnapshot = { mode: OFF, episodeId: null }
  private actions: SleepTimerActions = { pause: () => undefined, seek: () => undefined }
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): SleepTimerSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setActions(actions: SleepTimerActions): void {
    this.actions = actions
  }

  clearActions(): void {
    this.actions = { pause: () => undefined, seek: () => undefined }
  }

  arm(mode: SleepTimerMode, episodeId: string | null): void {
    this.snapshot = { mode, episodeId }
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

export function createSleepTimerController(actions?: SleepTimerActions): {
  readonly getSnapshot: () => SleepTimerSnapshot
  readonly subscribe: (listener: () => void) => () => void
  readonly setActions: (next: SleepTimerActions) => void
  readonly clearActions: () => void
  readonly arm: (mode: SleepTimerMode, episodeId: string | null) => void
  readonly setPreset: (preset: SleepTimerPreset, nowMs: number, chapterIndex: number, episodeId: string | null) => void
  readonly addFiveMinutes: (nowMs: number) => void
  readonly off: () => void
  readonly check: (status: Pick<NativeStatus, "episodeId" | "index" | "ended">, nowMs: number, episode: Episode | null) => void
} {
  const controller = new TimerController()
  if (actions) controller.setActions(actions)
  return controller
}

export const sleepTimer = createSleepTimerController()

export function useSleepTimer(
  status: NativeStatus,
  episode: Episode | null,
  actions: SleepTimerActions,
): { readonly mode: SleepTimerMode; readonly remaining: string | null } {
  const snapshot = useSyncExternalStore(sleepTimer.subscribe, sleepTimer.getSnapshot, sleepTimer.getSnapshot)
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    sleepTimer.setActions(actions)
    return () => sleepTimer.clearActions()
  }, [actions.pause, actions.seek])

  useEffect(() => {
    const check = () => {
      const now = Date.now()
      setNowMs(now)
      sleepTimer.check(status, now, episode)
    }
    check()
    if (snapshot.mode._tag !== "Countdown") return
    const interval = setInterval(check, 1_000)
    return () => clearInterval(interval)
  }, [episode, snapshot.mode, status.ended, status.episodeId, status.index])

  return { mode: snapshot.mode, remaining: formatRemaining(snapshot.mode, nowMs) }
}
