import { JobState, LEASE_MS, type Stage, type WorkerId } from "@fama/contracts"
import { Result, Schema } from "effect"

export class LeaseLost extends Schema.TaggedError<LeaseLost>()("LeaseLost", {
  workerId: Schema.String,
}) {}

export class NotClaimable extends Schema.TaggedError<NotClaimable>()("NotClaimable", {}) {}

export class NotRetryable extends Schema.TaggedError<NotRetryable>()("NotRetryable", {
  state: Schema.String,
}) {}

const iso = (now: number) => new Date(now).toISOString()

export const leaseExpired = (heartbeatAt: string, now: number) =>
  Date.parse(heartbeatAt) + LEASE_MS <= now

export const claim = (
  state: JobState,
  event: { readonly workerId: WorkerId; readonly now: number },
): Result.Result<JobState, NotClaimable> => {
  const claimable =
    state._tag === "Queued" || (state._tag === "Running" && leaseExpired(state.heartbeatAt, event.now))
  return claimable
    ? Result.succeed(
        JobState.cases.Running.make({
          workerId: event.workerId,
          stage: "extracting",
          done: 0,
          total: 0,
          heartbeatAt: iso(event.now),
        }),
      )
    : Result.fail(new NotClaimable())
}

/** The lease holder is the worker named in a `Running` state, expired or not, until another worker takes it over. */
export const holdLease = (
  state: JobState,
  workerId: WorkerId,
): Result.Result<JobState, LeaseLost> =>
  state._tag === "Running" && state.workerId === workerId
    ? Result.succeed(state)
    : Result.fail(new LeaseLost({ workerId }))

export const progress = (
  state: JobState,
  event: {
    readonly workerId: WorkerId
    readonly stage: Stage
    readonly done: number
    readonly total: number
    readonly now: number
  },
): Result.Result<JobState, LeaseLost> =>
  Result.map(holdLease(state, event.workerId), () =>
    JobState.cases.Running.make({
      workerId: event.workerId,
      stage: event.stage,
      done: event.done,
      total: event.total,
      heartbeatAt: iso(event.now),
    }),
  )

/** A repeated `complete` after success is a no-op, so a worker can retry it. */
export const complete = (
  state: JobState,
  event: { readonly workerId: WorkerId; readonly now: number },
): Result.Result<JobState, LeaseLost> =>
  state._tag === "Ready"
    ? Result.succeed(state)
    : Result.map(holdLease(state, event.workerId), () =>
        JobState.cases.Ready.make({ finishedAt: iso(event.now) }),
      )

/** A repeated `fail` after failure is a no-op, so a worker can retry it. */
export const fail = (
  state: JobState,
  event: { readonly workerId: WorkerId; readonly reason: string; readonly now: number },
): Result.Result<JobState, LeaseLost> =>
  state._tag === "Failed"
    ? Result.succeed(state)
    : Result.map(holdLease(state, event.workerId), () =>
        JobState.cases.Failed.make({ reason: event.reason, failedAt: iso(event.now) }),
      )

/** Retrying a queued job is a no-op, so a double tap in the app is harmless. */
export const retry = (state: JobState): Result.Result<JobState, NotRetryable> => {
  switch (state._tag) {
    case "Queued":
      return Result.succeed(state)
    case "Failed":
      return Result.succeed(JobState.cases.Queued.make({}))
    default:
      return Result.fail(new NotRetryable({ state: state._tag }))
  }
}
