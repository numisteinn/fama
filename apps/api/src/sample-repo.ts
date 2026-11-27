// Samples: one row for each (episode, voice) a client asked a clip for. A Sample is its own kind of work, apart from
// the episode's job, with its own lease. Each write is one guarded statement, so a repeat or a race changes nothing.
import {
  ClaimedSample,
  type LeaseToken,
  Sample,
  SAMPLE_LEASE_MS,
  UserId,
  type VoiceRef,
} from "@fama/contracts"
import { Context, Effect, Layer, Schema } from "effect"
import { Bindings } from "./bindings.ts"
import { type DatabaseError, query } from "./db.ts"
import { LeaseLost } from "./job.ts"
import { keys, mediaPath } from "./media-store.ts"
import { randomToken, sha256Hex } from "./secrets.ts"

const SampleRow = Schema.Struct({
  voice: Schema.String,
  state: Schema.Literals(["Requested", "Ready", "Failed"]),
  fail_reason: Schema.NullOr(Schema.String),
  feed_token: Schema.String,
})

type Failure = DatabaseError | Schema.SchemaError

export interface Interface {
  /**
   * Asks for a clip of each voice, for an episode of `userId`. A Sample that is asked for or ready stays as it is.
   * A failed one is asked for again. Returns the number of Samples that are new work.
   */
  readonly request: (
    userId: UserId,
    episodeId: string,
    voices: ReadonlyArray<VoiceRef>,
  ) => Effect.Effect<number, DatabaseError>
  /** The Samples of an episode of `userId`, by voice. */
  readonly list: (userId: UserId, episodeId: string) => Effect.Effect<ReadonlyArray<Sample>, Failure>
  /**
   * Leases the oldest Sample that is asked for and has no live claim. A claim older than `SAMPLE_LEASE_MS` is
   * dead, so a worker that stopped does not hold a Sample for ever.
   */
  readonly claim: Effect.Effect<ClaimedSample | null, Failure>
  /** Checks the lease and returns the owner, so a route can build storage keys. */
  readonly holdLease: (
    episodeId: string,
    voice: VoiceRef,
    lease: LeaseToken,
  ) => Effect.Effect<{ readonly userId: UserId; readonly ready: boolean }, LeaseLost | Failure>
  /** The clip is stored. A repeat with the same lease changes nothing. */
  readonly ready: (episodeId: string, voice: VoiceRef, lease: LeaseToken) => Effect.Effect<void, LeaseLost | DatabaseError>
  /** A repeat with the same lease changes nothing. */
  readonly fail: (
    episodeId: string,
    voice: VoiceRef,
    lease: LeaseToken,
    reason: string,
  ) => Effect.Effect<void, LeaseLost | DatabaseError>
}

export class SampleRepo extends Context.Service<SampleRepo, Interface>()("@fama/api/SampleRepo") {}

export const layer = Layer.effect(
  SampleRepo,
  Effect.gen(function* () {
    const { DB: db } = yield* Bindings
    const now = Effect.clockWith((clock) => clock.currentTimeMillis)
    const leaseOf = (lease: string) => Effect.promise(() => sha256Hex(lease))

    const request = Effect.fn("SampleRepo.request")(function* (
      userId: UserId,
      episodeId: string,
      voices: ReadonlyArray<VoiceRef>,
    ) {
      if (voices.length === 0) return 0
      const requestedAt = new Date(yield* now).toISOString()
      const results = yield* query("samples.request", () =>
        db.batch(
          voices.map((voice) =>
            db
              .prepare(
                // The insert reads the episode row, so an episode the user does not own writes nothing.
                `INSERT INTO samples (episode_id, voice, state, requested_at)
                 SELECT id, ?, 'Requested', ? FROM episodes WHERE id = ? AND user_id = ? AND document_size IS NOT NULL
                 ON CONFLICT (episode_id, voice) DO UPDATE SET state = 'Requested',
                   requested_at = excluded.requested_at, lease_hash = NULL, claimed_at = NULL, fail_reason = NULL
                 WHERE samples.state = 'Failed'`,
              )
              .bind(voice, requestedAt, episodeId, userId),
          ),
        ),
      )
      return results.reduce((sum, result) => sum + result.meta.changes, 0)
    })

    const list = Effect.fn("SampleRepo.list")(function* (userId: UserId, episodeId: string) {
      const { results } = yield* query("samples.list", () =>
        db
          .prepare(
            `SELECT s.voice, s.state, s.fail_reason, u.feed_token FROM samples s
             JOIN episodes e ON e.id = s.episode_id JOIN users u ON u.id = e.user_id
             WHERE s.episode_id = ? AND e.user_id = ? ORDER BY s.voice`,
          )
          .bind(episodeId, userId)
          .all(),
      )
      const rows = yield* Schema.decodeUnknownEffect(Schema.Array(SampleRow))(results)
      return yield* Schema.decodeUnknownEffect(Schema.Array(Sample))(
        rows.map((row) => ({
          voice: row.voice,
          state:
            row.state === "Ready"
              ? { _tag: "Ready", url: mediaPath(row.feed_token, userId, keys.sample(userId, episodeId, row.voice)).replace(":", "%3A") }
              : row.state === "Failed"
                ? { _tag: "Failed", reason: row.fail_reason ?? "" }
                : { _tag: "Requested" },
        })),
      )
    })

    const claim = Effect.gen(function* () {
      const at = yield* now
      const leaseToken = randomToken()
      const leaseHash = yield* leaseOf(leaseToken)
      const deadBefore = new Date(at - SAMPLE_LEASE_MS).toISOString()
      // One statement picks the row and takes it, so two workers cannot both claim the same Sample.
      const { results } = yield* query("samples.claim", () =>
        db
          .prepare(
            `UPDATE samples SET lease_hash = ?, claimed_at = ?
             WHERE rowid = (
               SELECT rowid FROM samples
               WHERE state = 'Requested' AND (claimed_at IS NULL OR claimed_at <= ?)
               ORDER BY requested_at, episode_id, voice LIMIT 1
             )
             RETURNING episode_id AS episodeId, voice,
               (SELECT speed FROM episodes WHERE id = samples.episode_id) AS speed`,
          )
          .bind(leaseHash, new Date(at).toISOString(), deadBefore)
          .all(),
      )
      const row = results[0]
      if (row === undefined) return null
      return yield* Schema.decodeUnknownEffect(ClaimedSample)({
        ...row,
        leaseToken,
        documentPath: `/api/worker/samples/${String(row.episodeId)}/document`,
      })
    }).pipe(Effect.withSpan("SampleRepo.claim"))

    const holdLease = Effect.fn("SampleRepo.holdLease")(function* (episodeId: string, voice: VoiceRef, lease: LeaseToken) {
      const leaseHash = yield* leaseOf(lease)
      const deadBefore = new Date((yield* now) - SAMPLE_LEASE_MS).toISOString()
      const { results } = yield* query("samples.holdLease", () =>
        db
          .prepare(
            `SELECT e.user_id AS userId, s.state FROM samples s JOIN episodes e ON e.id = s.episode_id
             WHERE s.episode_id = ? AND s.voice = ? AND s.lease_hash = ?
               AND (s.state = 'Ready' OR (s.state = 'Requested' AND s.claimed_at > ?))`,
          )
          .bind(episodeId, voice, leaseHash, deadBefore)
          .all(),
      )
      if (results[0] === undefined) return yield* new LeaseLost()
      const row = yield* Schema.decodeUnknownEffect(Schema.Struct({
        userId: UserId,
        state: Schema.Literals(["Requested", "Ready"]),
      }))(results[0])
      return { userId: row.userId, ready: row.state === "Ready" }
    })

    /** Moves the Sample of this lease to `state`, from Requested or from `state` itself. */
    const finish = Effect.fn("SampleRepo.finish")(function* (
      episodeId: string,
      voice: VoiceRef,
      lease: LeaseToken,
      state: "Ready" | "Failed",
      reason: string | null,
    ) {
      const leaseHash = yield* leaseOf(lease)
      const deadBefore = new Date((yield* now) - SAMPLE_LEASE_MS).toISOString()
      const { results } = yield* query("samples.finish", () =>
        db
          .prepare(
            `UPDATE samples SET state = ?, fail_reason = CASE WHEN state = 'Requested' THEN ? ELSE fail_reason END
             WHERE episode_id = ? AND voice = ? AND lease_hash = ? AND ((state = 'Requested' AND claimed_at > ?) OR state = ?) RETURNING voice`,
          )
          .bind(state, reason, episodeId, voice, leaseHash, deadBefore, state)
          .all(),
      )
      if (results.length === 0) return yield* new LeaseLost()
    })

    return SampleRepo.of({
      request,
      list,
      claim,
      holdLease,
      ready: (episodeId, voice, lease) => finish(episodeId, voice, lease, "Ready", null),
      fail: (episodeId, voice, lease, reason) => finish(episodeId, voice, lease, "Failed", reason),
    })
  }),
)
