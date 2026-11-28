import { UiSchema } from "@effect/ui"
import { Option, Schema } from "effect"
import { formatClock } from "~/lib/format"

/**
 * What the listener set before falling asleep: a countdown the tab pauses at, the end of the current
 * chapter, or nothing. All of the timer's math lives here, pure: the update layer only carries the
 * state and sends what these helpers return.
 */
export const SleepTimer = UiSchema.TaggedEnum({
  Off: {},
  Countdown: { endsAtMs: Schema.Number },
  EndOfChapter: {},
})
export type SleepTimer = typeof SleepTimer.Type

/** The last stretch of a countdown, where the volume ramps down to 0. */
export const FADE_MS = 3000
/** The minutes the menu offers. */
export const SLEEP_PRESET_MINUTES = [15, 30, 45, 60] as const
/** What `+5 min` adds to an active countdown. */
export const EXTEND_MINUTES = 5
/** The countdown ticks; the fade ticks faster, so the ramp stays smooth. */
export const SLEEP_TICK_MS = 500
export const SLEEP_FADE_TICK_MS = 250

/** What a tick of a countdown says: the state after it, the volume to hold, and the pause it asks for. */
export interface SleepTick {
  readonly sleep: SleepTimer
  readonly remainingMs: number
  readonly volume: number
  readonly isPauseDue: boolean
}

/** A countdown of `minutes` from `nowMs`. */
export const setSleepPreset = (minutes: number, nowMs: number): SleepTimer =>
  SleepTimer.Countdown({ endsAtMs: nowMs + minutes * 60_000 })

/** `+5 min`: five more minutes after the later of `nowMs` and the countdown's end. */
export const extendSleep = (sleep: SleepTimer, nowMs: number): SleepTimer =>
  sleep._tag === "Countdown"
    ? SleepTimer.Countdown({ endsAtMs: Math.max(nowMs, sleep.endsAtMs) + EXTEND_MINUTES * 60_000 })
    : sleep

/** What a menu pick means. `None` when `value` names no choice. */
export const applySleepChoice = (sleep: SleepTimer, value: string, nowMs: number): Option.Option<SleepTimer> => {
  if (value === "off") return Option.some(SleepTimer.Off())
  if (value === "end") return Option.some(SleepTimer.EndOfChapter())
  if (value === "+5") return Option.some(extendSleep(sleep, nowMs))
  const minutes = Number(value)
  return (SLEEP_PRESET_MINUTES as ReadonlyArray<number>).includes(minutes)
    ? Option.some(setSleepPreset(minutes, nowMs))
    : Option.none()
}

/** How long a countdown still has; 0 with no countdown. */
export const sleepRemainingMs = (sleep: SleepTimer, nowMs: number): number =>
  sleep._tag === "Countdown" ? Math.max(0, sleep.endsAtMs - nowMs) : 0

/** The volume the fade holds: 1 until the last `FADE_MS` of a countdown, then a ramp down to 0. */
export const sleepVolume = (sleep: SleepTimer, nowMs: number): number =>
  sleep._tag === "Countdown" ? Math.min(1, Math.max(0, (sleep.endsAtMs - nowMs) / FADE_MS)) : 1

/** True while the fade holds the volume below 1. */
export const isSleepFaded = (sleep: SleepTimer, nowMs: number): boolean => sleepVolume(sleep, nowMs) < 1

const remainingSeconds = (sleep: SleepTimer, nowMs: number) => Math.ceil(sleepRemainingMs(sleep, nowMs) / 1000)

/** `14:32` while a countdown runs, `Ch. end` at the end of a chapter, nothing when off. */
export const sleepBadge = (sleep: SleepTimer, nowMs: number): string | null =>
  sleep._tag === "Countdown"
    ? formatClock(remainingSeconds(sleep, nowMs) * 1000)
    : sleep._tag === "EndOfChapter"
      ? "Ch. end"
      : null

/**
 * A tick of the timer. A countdown that ran out while playback played pauses it and goes off; one
 * that ran out while nothing played (the Play after it armed `isResumed`) goes off without a pause,
 * so that Play plays on at full volume.
 */
export const tickSleep = (sleep: SleepTimer, nowMs: number, isResumed: boolean): SleepTick => {
  const remainingMs = sleepRemainingMs(sleep, nowMs)
  if (sleep._tag === "Countdown" && remainingMs === 0) {
    return { sleep: SleepTimer.Off(), remainingMs, volume: 1, isPauseDue: !isResumed }
  }
  return { sleep, remainingMs, volume: sleepVolume(sleep, nowMs), isPauseDue: false }
}

export const sleepLabel = (sleep: SleepTimer, nowMs: number): string => {
  if (sleep._tag === "Off") return "Sleep timer, off"
  if (sleep._tag === "EndOfChapter") return "Sleep timer, end of chapter"
  const seconds = remainingSeconds(sleep, nowMs)
  const minutes = Math.floor(seconds / 60)
  const parts = [
    minutes > 0 ? `${minutes} ${minutes === 1 ? "minute" : "minutes"}` : "",
    seconds % 60 > 0 || minutes === 0 ? `${seconds % 60} ${seconds % 60 === 1 ? "second" : "seconds"}` : "",
  ].filter(Boolean)
  return `Sleep timer, ${parts.join(" ")} left`
}

/** The end of a chapter: an End-of-chapter timer pauses at the boundary and goes off. */
export const endedChapterSleep = (sleep: SleepTimer): { readonly sleep: SleepTimer; readonly isPauseDue: boolean } =>
  sleep._tag === "EndOfChapter" ? { sleep: SleepTimer.Off(), isPauseDue: true } : { sleep, isPauseDue: false }

/**
 * The choice the menu marks as current. `Off` and End of chapter name their state; a countdown marks
 * nothing, because `+5 min` extends whatever is left rather than selecting a length.
 */
export const sleepChoiceValue = (sleep: SleepTimer): string | null =>
  sleep._tag === "Off" ? "off" : sleep._tag === "EndOfChapter" ? "end" : null
