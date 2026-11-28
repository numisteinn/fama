import { Option } from "effect"
import { describe, expect, it } from "vitest"
import {
  type SleepTimer as SleepTimerState,
  FADE_MS,
  SLEEP_FADE_TICK_MS,
  SLEEP_TICK_MS,
  SleepTimer,
  applySleepChoice,
  endedChapterSleep,
  extendSleep,
  isSleepFaded,
  setSleepPreset,
  sleepBadge,
  sleepChoiceValue,
  sleepLabel,
  sleepRemainingMs,
  sleepVolume,
  tickSleep,
} from "~/playback/sleepTimer"

const MINUTE = 60_000
const now = 1_000_000

const countdown = (remainingMs: number, atMs = now): SleepTimerState =>
  SleepTimer.Countdown({ endsAtMs: atMs + remainingMs })

describe("sleep timer choices", () => {
  it("a preset counts from the pick's clock", () => {
    for (const minutes of [15, 30, 45, 60]) {
      expect(setSleepPreset(minutes, now)).toEqual(countdown(minutes * MINUTE))
    }
  })

  it("+5 min extends the end of a countdown, and leaves the other modes alone", () => {
    expect(extendSleep(countdown(10 * MINUTE), now)).toEqual(countdown(15 * MINUTE))
    // A countdown that already ran out extends from now, not from its past end.
    expect(extendSleep(countdown(-2 * MINUTE), now)).toEqual(countdown(5 * MINUTE))
    expect(extendSleep(SleepTimer.Off(), now)).toEqual(SleepTimer.Off())
    expect(extendSleep(SleepTimer.EndOfChapter(), now)).toEqual(SleepTimer.EndOfChapter())
  })

  it("a menu pick maps to its choice, and junk maps to nothing", () => {
    expect(applySleepChoice(SleepTimer.Off(), "off", now)).toEqual(Option.some(SleepTimer.Off()))
    expect(applySleepChoice(SleepTimer.Off(), "end", now)).toEqual(Option.some(SleepTimer.EndOfChapter()))
    expect(applySleepChoice(countdown(10 * MINUTE), "+5", now)).toEqual(Option.some(countdown(15 * MINUTE)))
    expect(applySleepChoice(SleepTimer.Off(), "30", now)).toEqual(Option.some(countdown(30 * MINUTE)))
    for (const junk of ["", "5", "10", "90", "abc", "-15"]) {
      expect(applySleepChoice(SleepTimer.Off(), junk, now)).toEqual(Option.none())
    }
  })

  it("the menu marks Off and End of chapter, and marks nothing while a countdown runs", () => {
    expect(sleepChoiceValue(SleepTimer.Off())).toBe("off")
    expect(sleepChoiceValue(SleepTimer.EndOfChapter())).toBe("end")
    expect(sleepChoiceValue(countdown(10 * MINUTE))).toBe(null)
  })
})

describe("sleep countdown math", () => {
  it("a countdown keeps what is left, and nothing else has time left", () => {
    expect(sleepRemainingMs(countdown(14 * MINUTE + 32_000), now)).toBe(14 * MINUTE + 32_000)
    expect(sleepRemainingMs(countdown(-5_000), now)).toBe(0)
    expect(sleepRemainingMs(SleepTimer.Off(), now)).toBe(0)
    expect(sleepRemainingMs(SleepTimer.EndOfChapter(), now)).toBe(0)
  })

  it("the volume holds 1 until the fade, then ramps down to 0 over the last 3 seconds", () => {
    expect(sleepVolume(countdown(10 * MINUTE), now)).toBe(1)
    expect(sleepVolume(countdown(3000), now)).toBe(1)
    expect(sleepVolume(countdown(1500), now)).toBe(0.5)
    expect(sleepVolume(countdown(0), now)).toBe(0)
    expect(sleepVolume(countdown(-1000), now)).toBe(0)
    expect(sleepVolume(SleepTimer.Off(), now)).toBe(1)
    expect(sleepVolume(SleepTimer.EndOfChapter(), now)).toBe(1)
    expect(isSleepFaded(countdown(1500), now)).toBe(true)
    expect(isSleepFaded(countdown(10 * MINUTE), now)).toBe(false)
  })

  it("the badge counts the minutes left, says Ch. end at a chapter, and says nothing when off", () => {
    expect(sleepBadge(countdown(14 * MINUTE + 32_000), now)).toBe("14:32")
    expect(sleepBadge(countdown(15 * MINUTE - 500), now)).toBe("15:00")
    expect(sleepBadge(countdown(60 * MINUTE), now)).toBe("1:00:00")
    expect(sleepBadge(countdown(-1000), now)).toBe("0:00")
    expect(sleepBadge(SleepTimer.EndOfChapter(), now)).toBe("Ch. end")
    expect(sleepBadge(SleepTimer.Off(), now)).toBe(null)
  })

  it("the accessible name uses full words and matches the badge", () => {
    expect(sleepLabel(SleepTimer.Off(), now)).toBe("Sleep timer, off")
    expect(sleepLabel(SleepTimer.EndOfChapter(), now)).toBe("Sleep timer, end of chapter")
    expect(sleepLabel(countdown(15 * MINUTE - 500), now)).toBe("Sleep timer, 15 minutes left")
    expect(sleepLabel(countdown(MINUTE + 100), now)).toBe("Sleep timer, 1 minute 1 second left")
  })

  it("a tick holds the fade volume, and a countdown that ran out asks for the pause", () => {
    expect(tickSleep(countdown(10 * MINUTE), now, false)).toEqual({
      sleep: countdown(10 * MINUTE),
      remainingMs: 10 * MINUTE,
      volume: 1,
      isPauseDue: false,
    })
    expect(tickSleep(countdown(1500), now, false)).toEqual({ sleep: countdown(1500), remainingMs: 1500, volume: 0.5, isPauseDue: false })
    expect(tickSleep(countdown(0), now, false)).toEqual({ sleep: SleepTimer.Off(), remainingMs: 0, volume: 1, isPauseDue: true })
    expect(tickSleep(SleepTimer.Off(), now, false)).toEqual({ sleep: SleepTimer.Off(), remainingMs: 0, volume: 1, isPauseDue: false })
    expect(tickSleep(SleepTimer.EndOfChapter(), now, false)).toEqual({
      sleep: SleepTimer.EndOfChapter(),
      remainingMs: 0,
      volume: 1,
      isPauseDue: false,
    })
  })

  it("the first tick after a Play clears a countdown that ran out while nothing played", () => {
    expect(tickSleep(countdown(0), now, true)).toEqual({ sleep: SleepTimer.Off(), remainingMs: 0, volume: 1, isPauseDue: false })
    expect(tickSleep(countdown(-60_000), now, true)).toEqual({ sleep: SleepTimer.Off(), remainingMs: 0, volume: 1, isPauseDue: false })
    // One that still has time left plays on with its fade.
    expect(tickSleep(countdown(1500), now, true)).toEqual({ sleep: countdown(1500), remainingMs: 1500, volume: 0.5, isPauseDue: false })
  })
})

describe("sleep at the end of a chapter", () => {
  it("an End-of-chapter timer pauses at the boundary and goes off", () => {
    expect(endedChapterSleep(SleepTimer.EndOfChapter())).toEqual({ sleep: SleepTimer.Off(), isPauseDue: true })
  })

  it("a countdown or no timer leaves the chapter to the player", () => {
    expect(endedChapterSleep(countdown(10 * MINUTE))).toEqual({
      sleep: countdown(10 * MINUTE),
      isPauseDue: false,
    })
    expect(endedChapterSleep(SleepTimer.Off())).toEqual({ sleep: SleepTimer.Off(), isPauseDue: false })
  })
})

describe("sleep tick pacing", () => {
  it("the countdown ticks every half second, the fade four times a second, and the fade is 3 seconds", () => {
    expect(SLEEP_TICK_MS).toBe(500)
    expect(SLEEP_FADE_TICK_MS).toBe(250)
    expect(FADE_MS).toBe(3000)
  })
})
