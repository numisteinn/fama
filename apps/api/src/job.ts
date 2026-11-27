// The job state machine. Each function is one event: it returns the next state, or the error of an illegal move.
//
//   Queued ──claim──▶ Running ──complete──▶ Ready
//      ▲                 │ ├──────fail────▶ Failed ──retry──▶ Queued
//      │                 │ └─storeDocument, review on─▶ Review ──start──▶ Queued
//      └─────────────────┘ a claim by another worker, when the lease is expired, stays Running
//
// A job in Review has no lease and waits for its user. A worker cannot claim it or write to it.
import { JobState, LEASE_MS, type Stage, type WorkerId } from "@fama/contracts"
import { Result, Schema } from "effect"

export class LeaseLost extends Schema.TaggedError<LeaseLost>()("LeaseLost", {}) {}

export class NotClaimable extends Schema.TaggedError<NotClaimable>()("NotClaimable", {}) {}

export class NotRetryable extends Schema.TaggedError<NotRetryable>()("NotRetryable", {
  state: Schema.String,
}) {}

export class NotInReview extends Schema.TaggedError<NotInReview>()("NotInReview", {
  state: Schema.String,
}) {}

export class NotEditable extends Schema.TaggedError<NotEditable>()("NotEditable", {
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
          remainingMs: null,
        }),
      )
    : Result.fail(new NotClaimable())
}

/**
 * A worker holds the lease when it shows the lease token of the current claim (`held`) and the job is `Running`,
 * expired or not, until another worker claims it and gets a new token.
 */
export const holdLease = (state: JobState, held: boolean): Result.Result<JobState, LeaseLost> =>
  held && state._tag === "Running" ? Result.succeed(state) : Result.fail(new LeaseLost())

export const progress = (
  state: JobState,
  event: {
    readonly held: boolean
    readonly workerId: WorkerId
    readonly stage: Stage
    readonly done: number
    readonly total: number
    readonly remainingMs: number | null
    readonly now: number
  },
): Result.Result<JobState, LeaseLost> =>
  Result.map(holdLease(state, event.held), () =>
    JobState.cases.Running.make({
      workerId: event.workerId,
      stage: event.stage,
      done: event.done,
      total: event.total,
      heartbeatAt: iso(event.now),
      remainingMs: event.remainingMs,
    }),
  )

/**
 * The worker stored the Document. With `review` (the episode was added with review on, and this is its first stored
 * Document) the job stops in `Review`, and the lease ends with it. So a repeat of the upload after the stop is
 * `LeaseLost` like every other worker call, and it cannot replace a Document the user has changed since.
 */
export const storeDocument = (
  state: JobState,
  event: { readonly held: boolean; readonly review: boolean },
): Result.Result<JobState, LeaseLost> =>
  Result.map(holdLease(state, event.held), (running) => (event.review ? JobState.cases.Review.make({}) : running))

/** A repeated `complete` by the same lease after success is a no-op, so a worker can retry it. */
export const complete = (
  state: JobState,
  event: { readonly held: boolean; readonly now: number },
): Result.Result<JobState, LeaseLost> =>
  event.held && state._tag === "Ready"
    ? Result.succeed(state)
    : Result.map(holdLease(state, event.held), () => JobState.cases.Ready.make({ finishedAt: iso(event.now) }))

/** A repeated `fail` by the same lease after failure is a no-op, so a worker can retry it. */
export const fail = (
  state: JobState,
  event: { readonly held: boolean; readonly reason: string; readonly now: number },
): Result.Result<JobState, LeaseLost> =>
  event.held && state._tag === "Failed"
    ? Result.succeed(state)
    : Result.map(holdLease(state, event.held), () =>
        JobState.cases.Failed.make({ reason: event.reason, failedAt: iso(event.now) }),
      )

/**
 * Retrying a queued job is a no-op, so a double tap in the app is harmless. A job in `Review` did not fail: its
 * user starts it or deletes it.
 */
export const retry = (state: JobState): Result.Result<JobState, NotRetryable> => {
  switch (state._tag) {
    case "Queued":
      return Result.succeed(state)
    case "Failed":
      return Result.succeed(JobState.cases.Queued.make({}))
    case "Ready":
    case "Review":
    case "Running":
      return Result.fail(new NotRetryable({ state: state._tag }))
  }
}

/** Guards actions that only work in Review. */
export const inReview = (state: JobState): Result.Result<JobState, NotInReview> =>
  state._tag === "Review" ? Result.succeed(state) : Result.fail(new NotInReview({ state: state._tag }))

/**
 * The user starts narration. Only from `Review`: `start` stores the Document it narrates, so a second `start` is
 * refused and cannot change the Document under a worker.
 */
export const start = (state: JobState): Result.Result<JobState, NotInReview> =>
  Result.map(inReview(state), () => JobState.cases.Queued.make({}))


/** A text or Voice change after an attempt needs a new claim. */
export const narrateAgain = (state: JobState): Result.Result<JobState, NotEditable> =>
  state._tag === "Ready" || state._tag === "Failed"
    ? Result.succeed(JobState.cases.Queued.make({}))
    : Result.fail(new NotEditable({ state: state._tag }))

/** Review still lets the User save a Document without starting the Job. */
export const editDocument = (state: JobState): Result.Result<JobState, NotEditable> =>
  state._tag === "Review" ? Result.succeed(state) : narrateAgain(state)
