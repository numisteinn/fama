import { describe, expect, test } from "vitest"
import { EpisodeProgress, FINISHED_MARGIN_MS, isFinished, mergeProgress } from "./index.ts"
import { Schema } from "effect"

const at = (iso: string, positionMs: number): EpisodeProgress => ({ positionMs, updatedAt: iso })
const older = at("2026-11-23T10:00:00.000Z", 10_000)
const newer = at("2026-11-23T10:00:05.000Z", 60_000)

describe("mergeProgress", () => {
  test("a local entry newer than the server's wins and is pushed", () => {
    expect(mergeProgress(newer, older)).toEqual({ progress: newer, isPushed: true })
  })

  test("a server entry newer than the local one is adopted, and nothing is pushed", () => {
    expect(mergeProgress(older, newer)).toEqual({ progress: newer, isPushed: false })
  })

  test("a local entry the server does not have is pushed", () => {
    expect(mergeProgress(older, null)).toEqual({ progress: older, isPushed: true })
  })

  test("a server entry with no local one is adopted", () => {
    expect(mergeProgress(null, older)).toEqual({ progress: older, isPushed: false })
  })

  test("neither side has an entry: nothing to keep or push", () => {
    expect(mergeProgress(null, null)).toEqual({ progress: null, isPushed: false })
  })

  test("a tie keeps the server's entry and pushes nothing", () => {
    const local = at(older.updatedAt, 11_000)
    expect(mergeProgress(local, older)).toEqual({ progress: older, isPushed: false })
  })

  test("stamps compare as times, not as text", () => {
    const local = at("2026-11-23T10:00:05Z", 1)
    expect(mergeProgress(local, at("2026-11-23T10:00:04.500Z", 2)).isPushed).toBe(true)
  })
})

describe("isFinished", () => {
  test("inside the margin from the end is finished, before it is not", () => {
    expect(isFinished(46_525, 46_525)).toBe(true)
    expect(isFinished(46_525 - FINISHED_MARGIN_MS, 46_525)).toBe(true)
    expect(isFinished(46_525 - FINISHED_MARGIN_MS - 1, 46_525)).toBe(false)
  })

  test("an episode with no audio yet is never finished", () => {
    expect(isFinished(0, 0)).toBe(false)
  })
})

describe("EpisodeProgress", () => {
  const decode = Schema.decodeUnknownResult(EpisodeProgress)
  test("takes whole milliseconds and an ISO time", () => {
    expect(decode({ positionMs: 1500, updatedAt: "2026-11-23T10:00:00.000Z" })._tag).toBe("Success")
  })
  test("refuses a fraction, a negative position and a time that does not parse", () => {
    expect(decode({ positionMs: 1.5, updatedAt: "2026-11-23T10:00:00.000Z" })._tag).toBe("Failure")
    expect(decode({ positionMs: -1, updatedAt: "2026-11-23T10:00:00.000Z" })._tag).toBe("Failure")
    expect(decode({ positionMs: 1, updatedAt: "yesterday" })._tag).toBe("Failure")
  })
})
