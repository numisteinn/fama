import { describe, expect, test } from "vitest"
import { EpisodeProgress, FINISHED_MARGIN_MS, awaitedAfter, isFinished, mergeProgress, playStart } from "./index.ts"
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

describe("playStart", () => {
  const morning = { durationMs: 26_825 }
  const evening = { durationMs: 19_700 }
  const ready = { _tag: "Ready" } as const
  const running = { _tag: "Running" } as const

  test("a position inside the audio plays there", () => {
    expect(playStart(30_000, [morning, evening], ready)).toEqual({ positionMs: 30_000, isWaiting: false })
    expect(playStart(10_000, [morning], running)).toEqual({ positionMs: 10_000, isWaiting: false })
  })

  test("a finished position of a job that ended starts at 0", () => {
    expect(playStart(46_525, [morning, evening], ready)).toEqual({ positionMs: 0, isWaiting: false })
    expect(playStart(46_525 - FINISHED_MARGIN_MS, [morning, evening], ready)).toEqual({ positionMs: 0, isWaiting: false })
    expect(playStart(46_525 - FINISHED_MARGIN_MS - 1, [morning, evening], ready).positionMs).toBe(43_524)
    // A failed job makes no more audio either.
    expect(playStart(26_825, [morning], { _tag: "Failed" })).toEqual({ positionMs: 0, isWaiting: false })
  })

  test("the end of the chapters of a job that still works is a wait, not the end", () => {
    expect(playStart(26_825, [morning], running)).toEqual({ positionMs: 26_825, isWaiting: true })
    expect(playStart(26_825, [morning], { _tag: "Queued" })).toEqual({ positionMs: 26_825, isWaiting: true })
    // Both chapters are made and the job still encodes the book.
    expect(playStart(46_525, [morning, evening], running)).toEqual({ positionMs: 46_525, isWaiting: true })
    // Inside the finished margin of the chapters made so far there is still audio to play.
    expect(playStart(25_000, [morning], running)).toEqual({ positionMs: 25_000, isWaiting: false })
  })

  test("the same position on a later list goes on in the new chapter, never at 0", () => {
    const saved = 26_825
    expect(playStart(saved, [morning], running)).toEqual({ positionMs: saved, isWaiting: true })
    expect(playStart(saved, [morning, evening], running)).toEqual({ positionMs: saved, isWaiting: false })
    expect(playStart(saved, [morning, evening], ready)).toEqual({ positionMs: saved, isWaiting: false })
  })

  test("a position after the audio a stale list holds waits at the end of that audio", () => {
    expect(playStart(40_000, [morning], running)).toEqual({ positionMs: 26_825, isWaiting: true })
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

describe("awaitedAfter", () => {
  test("the list of the awaited request starts the Play", () => {
    expect(awaitedAfter([4], 4, true)).toEqual([])
  })

  test("a later request that fails starts nothing: the Play still waits for the request of the press", () => {
    expect(awaitedAfter([4], 5, false)).toEqual([4])
  })

  test("the list of a later request starts the Play: it is fresher than the awaited one", () => {
    expect(awaitedAfter([4], 5, true)).toEqual([])
  })

  test("the failure of the only awaited request starts the Play, from what the device knows", () => {
    expect(awaitedAfter([4], 4, false)).toEqual([])
  })

  test("with two awaited requests, the list of the older one alone is not enough", () => {
    expect(awaitedAfter([3, 4], 3, true)).toEqual([4])
    expect(awaitedAfter([4], 4, true)).toEqual([])
  })

  test("with two awaited requests, the list of the newer one starts the Play", () => {
    expect(awaitedAfter([3, 4], 4, true)).toEqual([])
  })

  test("with two awaited requests, the Play starts when both have failed", () => {
    expect(awaitedAfter([3, 4], 4, false)).toEqual([3])
    expect(awaitedAfter([3], 3, false)).toEqual([])
  })

  test("after the newer awaited request failed, the list of the older one starts the Play", () => {
    expect(awaitedAfter([3], 3, true)).toEqual([])
  })
})
