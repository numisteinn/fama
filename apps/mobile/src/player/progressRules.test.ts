import type { Episode } from "@fama/contracts"
import { describe, expect, test } from "vitest"
import { IDLE_TRACKER, type Moment, type Tracker, planSync, startMs, takesAnswer, track } from "./progressRules"

const at = (positionMs: number, updatedAt: string) => ({ positionMs, updatedAt })
const older = at(10_000, "2026-11-23T09:00:00.000Z")
const newer = at(40_000, "2026-11-23T11:00:00.000Z")

/** Feeds statuses through the save rule and lists the positions it saved. */
const savesOf = (moments: ReadonlyArray<Moment>, start: Tracker = IDLE_TRACKER) => {
  let tracker = start
  const saved: Array<number> = []
  for (const moment of moments) {
    const step = track(tracker, moment)
    tracker = step.tracker
    if (step.isSaved) saved.push(step.tracker.savedMs)
  }
  return saved
}
const moment = (positionMs: number, fields: Partial<Moment> = {}): Moment => ({
  episodeId: "e1",
  positionMs,
  playing: false,
  ended: false,
  ...fields,
})

describe("track", () => {
  test("a passive load (app start, no play) saves nothing", () => {
    // The restore loads the last episode paused at 30 s; the native player reports it a few times.
    expect(savesOf([moment(30_000), moment(30_000), moment(30_000)])).toEqual([])
  })

  test("switching episodes sets a new baseline and saves nothing for the new one", () => {
    expect(savesOf([moment(30_000, { playing: true }), moment(0, { episodeId: "e2", playing: true })])).toEqual([])
  })

  test("playing saves about every 5 s of movement", () => {
    const playing = (ms: number) => moment(ms, { playing: true })
    expect(savesOf([playing(0), playing(2_000), playing(4_900), playing(5_000), playing(9_000), playing(10_500)])).toEqual([
      5_000, 10_500,
    ])
  })

  test("a pause saves, even after less than 5 s", () => {
    expect(savesOf([moment(0), moment(500, { playing: true }), moment(2_000, { playing: true }), moment(2_000)])).toEqual([2_000])
  })

  test("a seek of 5 s or more while paused saves", () => {
    expect(savesOf([moment(10_000), moment(25_000)])).toEqual([25_000])
  })

  test("reaching the end saves once, at the end", () => {
    const end = moment(46_525, { ended: true })
    expect(savesOf([moment(44_000, { playing: true }), end, end, end])).toEqual([46_525])
  })

  test("an unload resets, so the next load is a baseline", () => {
    expect(savesOf([moment(30_000), moment(0, { episodeId: null }), moment(30_000)])).toEqual([])
  })
})

describe("planSync", () => {
  const episode = (id: string, progress: typeof older | null) => ({ id: id as Episode["id"], progress })

  test("sends local entries newer than the server's and takes newer server entries", () => {
    const plan = planSync({ a: newer, b: older, c: older }, [
      episode("a", older),
      episode("b", newer),
      episode("c", null),
      episode("d", older),
    ])
    expect(plan.push).toEqual([
      ["a", newer],
      ["c", older],
    ])
    expect(plan.adopt).toEqual([
      ["b", newer],
      ["d", older],
    ])
  })

  test("a device that agrees with the server does nothing", () => {
    expect(planSync({ a: older }, [episode("a", older), episode("b", null)])).toEqual({ push: [], adopt: [] })
  })

  test("entries of episodes the server did not list are left alone", () => {
    expect(planSync({ gone: newer }, [])).toEqual({ push: [], adopt: [] })
  })
})

describe("takesAnswer", () => {
  test("the answer replaces the entry that was sent, not a newer save", () => {
    expect(takesAnswer(older, older)).toBe(true)
    expect(takesAnswer(newer, older)).toBe(false)
    expect(takesAnswer(undefined, older)).toBe(false)
  })
})

describe("startMs", () => {
  const chapters = [
    { index: 0, title: "Morning", durationMs: 26_825, url: "" },
    { index: 1, title: "Evening", durationMs: 19_700, url: "" },
  ]
  const ready = { chapters, job: { _tag: "Ready", finishedAt: "x" } } as const
  const running = {
    chapters: [chapters[0]!],
    job: { _tag: "Running", workerId: "w", stage: "synthesizing", done: 1, total: 2, heartbeatAt: "x" },
  } as unknown as Pick<Episode, "chapters" | "job">

  test("starts at the newer of the device's and the server's entry", () => {
    expect(startMs(older, { ...ready, progress: newer })).toBe(40_000)
    expect(startMs(newer, { ...ready, progress: older })).toBe(40_000)
    expect(startMs(null, { ...ready, progress: null })).toBe(0)
  })

  test("a finished episode starts at 0", () => {
    expect(startMs(at(46_525, newer.updatedAt), { ...ready, progress: null })).toBe(0)
  })

  test("the end of the audio of a running job is not finished", () => {
    expect(startMs(at(26_825, newer.updatedAt), { ...running, progress: null })).toBe(26_825)
  })
})
