import { JobState, LEASE_MS, WorkerId } from "@fama/contracts"
import { Result } from "effect"
import { describe, expect, it } from "vitest"
import * as Job from "./job.ts"

const a = WorkerId.make("worker-a")
const b = WorkerId.make("worker-b")
const t0 = Date.parse("2026-11-18T12:00:00.000Z")

const queued = JobState.cases.Queued.make({})
const runningFor = (workerId: WorkerId, heartbeatAt: number) =>
  JobState.cases.Running.make({
    workerId,
    stage: "synthesizing",
    done: 1,
    total: 3,
    heartbeatAt: new Date(heartbeatAt).toISOString(),
    remainingMs: 60_000,
  })
const review = JobState.cases.Review.make({})
const ready = JobState.cases.Ready.make({ finishedAt: "2026-11-18T12:30:00.000Z" })
const failed = JobState.cases.Failed.make({ reason: "boom", failedAt: "2026-11-18T12:30:00.000Z" })

const ok = <A, E>(result: Result.Result<A, E>) => {
  if (Result.isFailure(result)) throw new Error(`expected success, got ${String(result.failure)}`)
  return result.success
}
const rejection = <A, E>(result: Result.Result<A, E>) => {
  if (Result.isSuccess(result)) throw new Error("expected a rejection")
  return result.failure
}

describe("claim", () => {
  it("takes a queued job and starts its lease", () => {
    expect(ok(Job.claim(queued, { workerId: a, now: t0 }))).toEqual(
      JobState.cases.Running.make({
        workerId: a,
        stage: "extracting",
        done: 0,
        total: 0,
        heartbeatAt: "2026-11-18T12:00:00.000Z",
        remainingMs: null,
      }),
    )
  })

  it("refuses a running job whose lease is live", () => {
    const running = runningFor(a, t0)
    expect(rejection(Job.claim(running, { workerId: b, now: t0 + LEASE_MS - 1 }))._tag).toBe("NotClaimable")
  })

  it("takes over a running job once the lease expires", () => {
    const next = ok(Job.claim(runningFor(a, t0), { workerId: b, now: t0 + LEASE_MS }))
    expect(next._tag === "Running" && next.workerId).toBe(b)
  })

  it.each([ready, failed])("refuses a $_tag job", (state) => {
    expect(rejection(Job.claim(state, { workerId: a, now: t0 }))._tag).toBe("NotClaimable")
  })

  it("never takes a job in Review, however long it waits", () => {
    expect(rejection(Job.claim(review, { workerId: a, now: t0 }))._tag).toBe("NotClaimable")
    expect(rejection(Job.claim(review, { workerId: a, now: t0 + 100 * LEASE_MS }))._tag).toBe("NotClaimable")
  })
})

describe("progress", () => {
  const step = (held: boolean) => ({ held, workerId: a, stage: "encoding" as const, done: 3, total: 3, remainingMs: null })

  it("moves the stage, the time left and the heartbeat for the lease holder", () => {
    const next = ok(Job.progress(runningFor(a, t0), { ...step(true), now: t0 + 5000 }))
    expect(next).toEqual(
      JobState.cases.Running.make({
        workerId: a,
        stage: "encoding",
        done: 3,
        total: 3,
        heartbeatAt: "2026-11-18T12:00:05.000Z",
        remainingMs: null,
      }),
    )
  })

  it("keeps an expired lease for its holder until another worker takes it", () => {
    const next = ok(Job.progress(runningFor(a, t0), { ...step(true), now: t0 + 2 * LEASE_MS }))
    expect(next._tag).toBe("Running")
  })

  it("rejects a running job without its lease token", () => {
    expect(rejection(Job.progress(runningFor(a, t0), { ...step(false), now: t0 }))._tag).toBe("LeaseLost")
  })

  it.each([queued, review, ready, failed])("rejects progress on a $_tag job, even with the token", (state) => {
    expect(rejection(Job.progress(state, { ...step(true), now: t0 }))._tag).toBe("LeaseLost")
  })
})

describe("storeDocument", () => {
  it("leaves the job running when review is off", () => {
    const running = runningFor(a, t0)
    expect(ok(Job.storeDocument(running, { held: true, review: false }))).toBe(running)
  })

  it("stops the job in Review when review is on", () => {
    expect(ok(Job.storeDocument(runningFor(a, t0), { held: true, review: true }))).toEqual(review)
  })

  it("stops an expired lease too, until another worker takes it", () => {
    expect(ok(Job.storeDocument(runningFor(a, t0 - 2 * LEASE_MS), { held: true, review: true }))).toEqual(review)
  })

  it.each([true, false])("rejects a running job without its lease token (review %s)", (on) => {
    expect(rejection(Job.storeDocument(runningFor(a, t0), { held: false, review: on }))._tag).toBe("LeaseLost")
  })

  it.each([queued, review, ready, failed])("rejects a $_tag job, so a repeat after the stop writes nothing", (state) => {
    expect(rejection(Job.storeDocument(state, { held: true, review: true }))._tag).toBe("LeaseLost")
  })
})

describe("complete", () => {
  it("makes the holder's job ready", () => {
    expect(ok(Job.complete(runningFor(a, t0), { held: true, now: t0 }))).toEqual(
      JobState.cases.Ready.make({ finishedAt: "2026-11-18T12:00:00.000Z" }),
    )
  })

  it("is a no-op on a ready job for the same lease, so a worker can retry it", () => {
    expect(ok(Job.complete(ready, { held: true, now: t0 }))).toBe(ready)
  })

  it.each([runningFor(a, t0), ready])("rejects a $_tag job without its lease token", (state) => {
    expect(rejection(Job.complete(state, { held: false, now: t0 }))._tag).toBe("LeaseLost")
  })

  it.each([queued, review, failed])("rejects a $_tag job", (state) => {
    expect(rejection(Job.complete(state, { held: true, now: t0 }))._tag).toBe("LeaseLost")
  })
})

describe("fail", () => {
  it("fails the holder's job with a reason", () => {
    expect(ok(Job.fail(runningFor(a, t0), { held: true, reason: "no text", now: t0 }))).toEqual(
      JobState.cases.Failed.make({ reason: "no text", failedAt: "2026-11-18T12:00:00.000Z" }),
    )
  })

  it("is a no-op on a failed job for the same lease", () => {
    expect(ok(Job.fail(failed, { held: true, reason: "again", now: t0 }))).toBe(failed)
  })

  it.each([runningFor(a, t0), failed])("rejects a $_tag job without its lease token", (state) => {
    expect(rejection(Job.fail(state, { held: false, reason: "x", now: t0 }))._tag).toBe("LeaseLost")
  })

  it.each([queued, review, ready])("rejects a $_tag job", (state) => {
    expect(rejection(Job.fail(state, { held: true, reason: "x", now: t0 }))._tag).toBe("LeaseLost")
  })
})

describe("retry", () => {
  it("queues a failed job", () => {
    expect(ok(Job.retry(failed))).toEqual(queued)
  })

  it("leaves a queued job as it is", () => {
    expect(ok(Job.retry(queued))).toBe(queued)
  })

  it.each([runningFor(a, t0), review, ready])("refuses a $_tag job", (state) => {
    expect(rejection(Job.retry(state))).toMatchObject({ _tag: "NotRetryable", state: state._tag })
  })
})

describe("editDocument", () => {
  it("lets the user change the Document in Review", () => {
    expect(ok(Job.editDocument(review))).toBe(review)
  })

  it.each([queued, runningFor(a, t0), ready, failed])("refuses a $_tag job", (state) => {
    expect(rejection(Job.editDocument(state))).toMatchObject({ _tag: "NotInReview", state: state._tag })
  })
})

describe("start", () => {
  it("queues a job in Review for narration", () => {
    expect(ok(Job.start(review))).toEqual(queued)
  })

  it.each([queued, runningFor(a, t0), ready, failed])("refuses a $_tag job, so a second start changes nothing", (state) => {
    expect(rejection(Job.start(state))).toMatchObject({ _tag: "NotInReview", state: state._tag })
  })
})

describe("a job with review on", () => {
  const claimed = (state: JobState, now: number) => ok(Job.claim(state, { workerId: a, now }))

  it("goes Queued, Running, Review, Queued, Running, Ready", () => {
    const stopped = ok(Job.storeDocument(claimed(queued, t0), { held: true, review: true }))
    expect(stopped).toEqual(review)
    const narrating = claimed(ok(Job.start(stopped)), t0 + 1000)
    expect(ok(Job.complete(narrating, { held: true, now: t0 + 2000 }))._tag).toBe("Ready")
  })

  it("reaches Review after a lost lease during extraction", () => {
    const first = claimed(queued, t0)
    const second = ok(Job.claim(first, { workerId: b, now: t0 + LEASE_MS }))
    expect(rejection(Job.storeDocument(second, { held: false, review: true }))._tag).toBe("LeaseLost")
    expect(ok(Job.storeDocument(second, { held: true, review: true }))).toEqual(review)
  })

  it("reaches Review after a failed extraction and a retry", () => {
    const failedOnce = ok(Job.fail(claimed(queued, t0), { held: true, reason: "no text", now: t0 }))
    const again = claimed(ok(Job.retry(failedOnce)), t0 + 1000)
    expect(ok(Job.storeDocument(again, { held: true, review: true }))).toEqual(review)
  })
})
