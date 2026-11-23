import type { Episode } from "@fama/contracts"
import { describe, expect, test } from "vitest"
import {
  IDLE_TRACKER,
  type Moment,
  type Tracker,
  makePlayGate,
  planSync,
  startMs,
  takesAnswer,
  track,
} from "./progressRules"

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

describe("makePlayGate", () => {
  /** A gate and the plays it started, in order. */
  const gateWithLog = () => {
    const started: Array<string> = []
    const gate = makePlayGate()
    return { gate, started, play: (episodeId: string) => gate.play(episodeId, () => started.push(episodeId)) }
  }

  test("with no library request in flight, Play starts at once", () => {
    const { started, play } = gateWithLog()
    play("e1")
    expect(started).toEqual(["e1"])
  })

  test("Play pressed while the library loads starts when the list came", () => {
    // The app came back to the front: the refresh is out when the listener taps Play.
    const { gate, started, play } = gateWithLog()
    const foreground = gate.refreshStarted()
    play("e1")
    expect(started).toEqual([])
    // The caller merges the list with the device's progress, then settles.
    gate.refreshSettled(foreground, true)
    expect(started).toEqual(["e1"])
  })

  test("a failed load starts the Play too, from what the phone knows", () => {
    const { gate, started, play } = gateWithLog()
    const foreground = gate.refreshStarted()
    play("e1")
    gate.refreshSettled(foreground, false)
    expect(started).toEqual(["e1"])
  })

  test("a later pull to refresh that fails does not start the Play: it waits for the request of the press", () => {
    const { gate, started, play } = gateWithLog()
    const foreground = gate.refreshStarted()
    play("e1")
    // The listener pulls to refresh while the foreground request is still out, and the server answers 503.
    const pull = gate.refreshStarted()
    gate.refreshSettled(pull, false)
    // Nothing plays from the old position, so no pause can stamp it over the other device's entry.
    expect(started).toEqual([])
    gate.refreshSettled(foreground, true)
    expect(started).toEqual(["e1"])
  })

  test("a later request that brings a list starts the Play at once, and the awaited answer starts nothing more", () => {
    const { gate, started, play } = gateWithLog()
    const foreground = gate.refreshStarted()
    play("e1")
    const pull = gate.refreshStarted()
    gate.refreshSettled(pull, true)
    expect(started).toEqual(["e1"])
    gate.refreshSettled(foreground, true)
    expect(started).toEqual(["e1"])
  })

  test("with two requests in flight, the list of the older one is not enough", () => {
    const { gate, started, play } = gateWithLog()
    const poll = gate.refreshStarted()
    const foreground = gate.refreshStarted()
    play("e1")
    gate.refreshSettled(poll, true)
    expect(started).toEqual([])
    gate.refreshSettled(foreground, true)
    expect(started).toEqual(["e1"])
  })

  test("with two requests in flight, the list of the newer one starts the Play", () => {
    const { gate, started, play } = gateWithLog()
    const poll = gate.refreshStarted()
    const foreground = gate.refreshStarted()
    play("e1")
    gate.refreshSettled(foreground, true)
    expect(started).toEqual(["e1"])
    gate.refreshSettled(poll, true)
    expect(started).toEqual(["e1"])
  })

  test("with two requests in flight, the Play starts when both have failed", () => {
    const { gate, started, play } = gateWithLog()
    const poll = gate.refreshStarted()
    const foreground = gate.refreshStarted()
    play("e1")
    gate.refreshSettled(foreground, false)
    expect(started).toEqual([])
    gate.refreshSettled(poll, false)
    expect(started).toEqual(["e1"])
  })

  test("a request that answered before the Play is not waited for", () => {
    const { gate, started, play } = gateWithLog()
    gate.refreshSettled(gate.refreshStarted(), true)
    play("e1")
    expect(started).toEqual(["e1"])
  })

  test("a second Play of the same episode does not wait again", () => {
    const { gate, started, play } = gateWithLog()
    const foreground = gate.refreshStarted()
    play("e1")
    play("e1")
    expect(started).toEqual(["e1"])
    gate.refreshSettled(foreground, true)
    expect(started).toEqual(["e1"])
  })

  test("a pause or a seek takes the waiting Play back", () => {
    const { gate, started, play } = gateWithLog()
    const foreground = gate.refreshStarted()
    play("e1")
    gate.cancel()
    gate.refreshSettled(foreground, true)
    expect(started).toEqual([])
  })

  test("a Play of another episode replaces the waiting one", () => {
    const { gate, started, play } = gateWithLog()
    const foreground = gate.refreshStarted()
    play("e1")
    play("e2")
    gate.refreshSettled(foreground, true)
    expect(started).toEqual(["e2"])
  })
})
