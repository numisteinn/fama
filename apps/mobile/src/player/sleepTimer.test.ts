import { describe, expect, test, vi } from "vitest"
import {
  accessibilityLabel,
  addFiveMinutes,
  chapterBoundaryReached,
  chapterIndexAt,
  createSleepTimerController,
  formatRemaining,
  isExpired,
  setPreset,
  type SleepTimerMode,
} from "./sleepTimer"
import type { Episode } from "@fama/contracts"
import { IDLE_STATUS } from "./core"

const episode = {
  id: "episode",
  chapters: [
    { index: 0, title: "One", durationMs: 90_000, url: "one", timingUrl: null },
    { index: 1, title: "Two", durationMs: 120_000, url: "two", timingUrl: null },
  ],
} as unknown as Episode

const status = (fields: Partial<typeof IDLE_STATUS> = {}) => ({ ...IDLE_STATUS, episodeId: "episode", ...fields })

describe("sleep timer modes", () => {
  test.each([
    [15, 15 * 60 * 1_000],
    [30, 30 * 60 * 1_000],
    [45, 45 * 60 * 1_000],
    [60, 60 * 60 * 1_000],
  ] as const)("sets the %s minute preset", (minutes, duration) => {
    expect(setPreset(minutes, 1_000)).toEqual({ _tag: "Countdown", endsAtMs: 1_000 + duration })
  })

  test("sets End of chapter to the current chapter", () => {
    expect(setPreset("EndOfChapter", 1_000, 3)).toEqual({ _tag: "EndOfChapter", chapterIndex: 3 })
  })

  test("+5 minutes extends a countdown from its later endpoint", () => {
    expect(addFiveMinutes({ _tag: "Countdown", endsAtMs: 10_000 }, 20_000)).toEqual({
      _tag: "Countdown",
      endsAtMs: 320_000,
    })
  })

  test("formats countdowns with ceil rounding and chapter endings", () => {
    expect(formatRemaining({ _tag: "Countdown", endsAtMs: 15 * 60 * 1_000 }, 10)).toBe("15:00")
    expect(formatRemaining({ _tag: "Countdown", endsAtMs: 91_000 }, 0)).toBe("1:31")
    expect(formatRemaining({ _tag: "Countdown", endsAtMs: 0 }, 1_000)).toBe("0:00")
    expect(formatRemaining({ _tag: "EndOfChapter", chapterIndex: 0 }, 0)).toBe("Ch. end")
    expect(formatRemaining({ _tag: "Off" }, 0)).toBeNull()
  })

  test("builds full-word accessibility labels", () => {
    expect(accessibilityLabel({ _tag: "Off" }, 0)).toBe("Sleep timer, off")
    expect(accessibilityLabel({ _tag: "EndOfChapter", chapterIndex: 0 }, 0)).toBe("Sleep timer, end of chapter")
    expect(accessibilityLabel({ _tag: "Countdown", endsAtMs: 15 * 60 * 1_000 }, 0)).toBe("Sleep timer, 15 minutes left")
    expect(accessibilityLabel({ _tag: "Countdown", endsAtMs: 30_000 }, 0)).toBe("Sleep timer, less than 1 minute left")
  })

  test("checks countdown expiration inclusively", () => {
    const mode: SleepTimerMode = { _tag: "Countdown", endsAtMs: 1_000 }
    expect(isExpired(mode, 999)).toBe(false)
    expect(isExpired(mode, 1_000)).toBe(true)
  })

  test("pauses and turns off when countdown expires", () => {
    const pause = vi.fn<() => void>()
    const controller = createSleepTimerController({ pause, seek: vi.fn<() => void>() })
    controller.setPreset(15, 0, 0, "episode")
    controller.check(status(), 15 * 60 * 1_000, episode)
    expect(pause).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().mode).toEqual({ _tag: "Off" })
  })

  test("pauses and seeks to the next chapter at an End of chapter boundary", () => {
    const pause = vi.fn<() => void>()
    const seek = vi.fn<(position: number) => void>()
    const controller = createSleepTimerController({ pause, seek })
    controller.arm({ _tag: "EndOfChapter", chapterIndex: 0 }, "episode")
    controller.check(status({ index: 1 }), 0, episode)
    expect(chapterBoundaryReached({ _tag: "EndOfChapter", chapterIndex: 0 }, status({ index: 1 }))).toBe(true)
    expect(pause).toHaveBeenCalledOnce()
    expect(seek).toHaveBeenCalledWith(90)
    expect(controller.getSnapshot().mode).toEqual({ _tag: "Off" })
  })

  test("manual chapter jump re-arms EndOfChapter instead of falsely pausing", () => {
    const pause = vi.fn<() => void>()
    const seek = vi.fn<(position: number) => void>()
    const controller = createSleepTimerController({ pause, seek })
    controller.arm({ _tag: "EndOfChapter", chapterIndex: 0 }, "episode")
    expect(chapterIndexAt(episode, 95)).toBe(1)
    controller.onManualSeek(episode, 95)
    controller.check(status({ index: 1 }), 0, episode)
    expect(pause).not.toHaveBeenCalled()
    expect(controller.getSnapshot().mode).toEqual({ _tag: "EndOfChapter", chapterIndex: 1 })
    // Seeking back to chapter 0 also re-arms to chapter 0.
    controller.onManualSeek(episode, 10)
    expect(controller.getSnapshot().mode).toEqual({ _tag: "EndOfChapter", chapterIndex: 0 })
  })

  test("clears an armed timer when the episode changes", () => {
    const pause = vi.fn<() => void>()
    const controller = createSleepTimerController({ pause, seek: vi.fn<() => void>() })
    controller.arm({ _tag: "EndOfChapter", chapterIndex: 0 }, "episode")
    controller.check({ episodeId: "other", index: 1, ended: false }, 0, episode)
    expect(pause).not.toHaveBeenCalled()
    expect(controller.getSnapshot().mode).toEqual({ _tag: "Off" })
  })
})
