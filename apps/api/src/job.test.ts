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
  })
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
})

describe("progress", () => {
  it("moves the stage and the heartbeat for the lease holder", () => {
    const next = ok(
      Job.progress(runningFor(a, t0), { workerId: a, stage: "encoding", done: 3, total: 3, now: t0 + 5000 }),
    )
    expect(next).toEqual(
      JobState.cases.Running.make({
        workerId: a,
        stage: "encoding",
        done: 3,
        total: 3,
        heartbeatAt: "2026-11-18T12:00:05.000Z",
      }),
    )
  })

  it("keeps an expired lease for its holder until another worker takes it", () => {
    const next = ok(
      Job.progress(runningFor(a, t0), { workerId: a, stage: "encoding", done: 3, total: 3, now: t0 + 2 * LEASE_MS }),
    )
    expect(next._tag).toBe("Running")
  })

  it.each([runningFor(b, t0), queued, ready, failed])("rejects a worker without the lease ($_tag)", (state) => {
    expect(
      rejection(Job.progress(state, { workerId: a, stage: "encoding", done: 0, total: 0, now: t0 }))._tag,
    ).toBe("LeaseLost")
  })

  it("rejects the old holder after a takeover", () => {
    const takenOver = ok(Job.claim(runningFor(a, t0), { workerId: b, now: t0 + LEASE_MS }))
    expect(
      rejection(Job.progress(takenOver, { workerId: a, stage: "encoding", done: 0, total: 0, now: t0 }))._tag,
    ).toBe("LeaseLost")
  })
})

describe("complete", () => {
  it("makes the holder's job ready", () => {
    expect(ok(Job.complete(runningFor(a, t0), { workerId: a, now: t0 }))).toEqual(
      JobState.cases.Ready.make({ finishedAt: "2026-11-18T12:00:00.000Z" }),
    )
  })

  it("is a no-op on a ready job, so a worker can retry it", () => {
    expect(ok(Job.complete(ready, { workerId: a, now: t0 }))).toBe(ready)
  })

  it.each([runningFor(b, t0), queued, failed])("rejects a worker without the lease ($_tag)", (state) => {
    expect(rejection(Job.complete(state, { workerId: a, now: t0 }))._tag).toBe("LeaseLost")
  })
})

describe("fail", () => {
  it("fails the holder's job with a reason", () => {
    expect(ok(Job.fail(runningFor(a, t0), { workerId: a, reason: "no text", now: t0 }))).toEqual(
      JobState.cases.Failed.make({ reason: "no text", failedAt: "2026-11-18T12:00:00.000Z" }),
    )
  })

  it("is a no-op on a failed job", () => {
    expect(ok(Job.fail(failed, { workerId: a, reason: "again", now: t0 }))).toBe(failed)
  })

  it.each([runningFor(b, t0), queued, ready])("rejects a worker without the lease ($_tag)", (state) => {
    expect(rejection(Job.fail(state, { workerId: a, reason: "x", now: t0 }))._tag).toBe("LeaseLost")
  })
})

describe("retry", () => {
  it("queues a failed job", () => {
    expect(ok(Job.retry(failed))).toEqual(queued)
  })

  it("leaves a queued job as it is", () => {
    expect(ok(Job.retry(queued))).toBe(queued)
  })

  it.each([runningFor(a, t0), ready])("refuses a $_tag job", (state) => {
    expect(rejection(Job.retry(state))._tag).toBe("NotRetryable")
  })
})
