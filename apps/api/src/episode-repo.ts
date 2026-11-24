import {
  ClaimedJob,
  type ClaimedSample,
  Episode,
  type EpisodeId,
  EpisodeProgress,
  JobState,
  LEASE_MS,
  type LeaseToken,
  type ProgressRequest,
  Source,
  UserId,
  Voice,
  type VoiceRef,
  type WorkerId,
  type Work,
} from "@fama/contracts"
import { Context, Effect, Layer, Result, Schema } from "effect"
import { Bindings } from "./bindings.ts"
import { DatabaseError, query } from "./db.ts"
import type { FeedItem } from "./feed.ts"
import * as Job from "./job.ts"
import { keys, mediaPath } from "./media-store.ts"
import { randomToken, sha256Hex } from "./secrets.ts"
import { hasTranscript } from "./transcript.ts"

export { DatabaseError } from "./db.ts"

export class EpisodeNotFound extends Schema.TaggedError<EpisodeNotFound>()("EpisodeNotFound", {
  id: Schema.String,
}) {}

const EpisodeRow = Schema.Struct({
  id: Schema.String,
  user_id: UserId,
  /** From the owner's row in `users`, to build media paths. */
  feed_token: Schema.String,
  created_at: Schema.String,
  source: Schema.fromJsonString(Source),
  title: Schema.String,
  author: Schema.NullOr(Schema.String),
  language: Schema.NullOr(Schema.String),
  voice: Schema.NullOr(Schema.String),
  speed: Schema.Number,
  duration_ms: Schema.NullOr(Schema.Number),
  book_size: Schema.NullOr(Schema.Number),
  cover_key: Schema.NullOr(Schema.String),
  document_size: Schema.NullOr(Schema.Number),
  document_key: Schema.NullOr(Schema.String),
  job_version: Schema.Number,
  job_state: Schema.Literals(["Queued", "Running", "Ready", "Failed"]),
  /** The stop for Review: `Wanted` until the worker stores the Document, `Open` while the job waits in Review. */
  review: Schema.NullOr(Schema.Literals(["Wanted", "Open"])),
  worker_id: Schema.NullOr(Schema.String),
  lease_hash: Schema.NullOr(Schema.String),
  stage: Schema.NullOr(Schema.String),
  done: Schema.NullOr(Schema.Number),
  total: Schema.NullOr(Schema.Number),
  heartbeat_at: Schema.NullOr(Schema.String),
  remaining_ms: Schema.NullOr(Schema.Number),
  finished_at: Schema.NullOr(Schema.String),
  fail_reason: Schema.NullOr(Schema.String),
  failed_at: Schema.NullOr(Schema.String),
  /** From the owner's row in `progress`. Both null when the owner has none. */
  progress_position_ms: Schema.NullOr(Schema.Number),
  progress_updated_at: Schema.NullOr(Schema.String),
})
interface EpisodeRow extends Schema.Schema.Type<typeof EpisodeRow> {}

const ChapterRow = Schema.Struct({
  episode_id: Schema.String,
  idx: Schema.Number,
  title: Schema.String,
  duration_ms: Schema.Number,
  /** 1 when the chapter has a row in `timings`. */
  has_timing: Schema.Number,
})
interface ChapterRow extends Schema.Schema.Type<typeof ChapterRow> {}

const decodeRows = <S extends Schema.Top>(schema: S) => Schema.decodeUnknownEffect(Schema.Array(schema))

const jobOf = (row: EpisodeRow) => {
  switch (row.job_state) {
    case "Queued":
      return row.review === "Open" ? { _tag: "Review" } : { _tag: "Queued" }
    case "Running":
      return {
        _tag: "Running",
        workerId: row.worker_id,
        stage: row.stage,
        done: row.done,
        total: row.total,
        heartbeatAt: row.heartbeat_at,
        remainingMs: row.remaining_ms,
      }
    case "Ready":
      return { _tag: "Ready", finishedAt: row.finished_at }
    case "Failed":
      return { _tag: "Failed", reason: row.fail_reason, failedAt: row.failed_at }
  }
}

const jobColumns = (job: JobState) => {
  const none = {
    worker_id: null,
    stage: null,
    done: null,
    total: null,
    heartbeat_at: null,
    remaining_ms: null,
    finished_at: null,
    fail_reason: null,
    failed_at: null,
  }
  return JobState.match(job, {
    // A job back in the queue has no lease, so no earlier attempt can write to it.
    Queued: () => ({ ...none, job_state: "Queued", lease_hash: null }),
    Running: (s) => ({
      ...none,
      job_state: "Running",
      worker_id: s.workerId,
      stage: s.stage,
      done: s.done,
      total: s.total,
      heartbeat_at: s.heartbeatAt,
      remaining_ms: s.remainingMs,
    }),
    // In the queue, but held for its user: `review` keeps `claim` away. The lease ends, as for `Queued`.
    Review: () => ({ ...none, job_state: "Queued", lease_hash: null, review: "Open" }),
    Ready: (s) => ({ ...none, job_state: "Ready", finished_at: s.finishedAt }),
    Failed: (s) => ({ ...none, job_state: "Failed", fail_reason: s.reason, failed_at: s.failedAt }),
  })
}

/** Episode fields a transition may also write. `null` keeps the stored value. */
interface EpisodeUpdate {
  readonly title?: string | null
  readonly author?: string | null
  readonly language?: string | null
  readonly voice?: string | null
  readonly duration_ms?: number | null
  readonly lease_hash?: string | null
  readonly document_size?: number
  readonly document_key?: string
}

interface StoredDocument {
  readonly key: string
  readonly size: number
}

const documentColumns = ({ key, size }: StoredDocument) => ({ document_key: key, document_size: size })

const documentKey = (row: EpisodeRow) =>
  row.document_size === null ? null : row.document_key ?? keys.document(row.user_id, row.id)

export interface NewEpisode {
  readonly id: EpisodeId
  readonly source: Source
  readonly title: string
  readonly voice: VoiceRef | null
  readonly speed: number
  /** Stop the job in Review when the worker stores the Document. */
  readonly review: boolean
}

type Failure = DatabaseError | Schema.SchemaError

/**
 * Client methods take the owner and only see that user's episodes. Worker methods are scoped to one claimed episode
 * and its lease token, and return the owner so routes can build storage keys.
 */
export interface Interface {
  readonly create: (userId: UserId, input: NewEpisode) => Effect.Effect<Episode, Failure>
  readonly list: (userId: UserId) => Effect.Effect<ReadonlyArray<Episode>, Failure>
  readonly get: (userId: UserId, id: string) => Effect.Effect<Episode, EpisodeNotFound | Failure>
  readonly remove: (userId: UserId, id: string) => Effect.Effect<void, DatabaseError>
  readonly retry: (userId: UserId, id: string) => Effect.Effect<Episode, EpisodeNotFound | Job.NotRetryable | Failure>
  /** Checks that the user owns the episode and that its job waits in Review, so its Document can change. */
  readonly inReview: (userId: UserId, id: string) => Effect.Effect<void, EpisodeNotFound | Job.NotInReview | Failure>
  readonly documentKey: (userId: UserId, id: string) => Effect.Effect<string | null, EpisodeNotFound | Failure>
  readonly editDocument: (
    userId: UserId,
    id: string,
    document: StoredDocument,
  ) => Effect.Effect<void, EpisodeNotFound | Job.NotInReview | Failure>
  readonly start: (
    userId: UserId,
    id: string,
    document: StoredDocument,
  ) => Effect.Effect<void, EpisodeNotFound | Job.NotInReview | Failure>
  readonly claim: (
    workerId: WorkerId,
    voices: ReadonlyArray<Voice>,
    claimSample: Effect.Effect<ClaimedSample | null, Failure>,
  ) => Effect.Effect<Work | null, Failure>
  readonly progress: (id: string, request: ProgressRequest) => Effect.Effect<void, EpisodeNotFound | Job.LeaseLost | Failure>
  readonly complete: (
    id: string,
    lease: LeaseToken,
    durationMs: number,
  ) => Effect.Effect<void, EpisodeNotFound | Job.LeaseLost | Failure>
  readonly fail: (id: string, lease: LeaseToken, reason: string) => Effect.Effect<void, EpisodeNotFound | Job.LeaseLost | Failure>
  /** Checks the lease and returns what a job route needs: the source, the owner and the key of the stored cover. */
  readonly holdLease: (
    id: string,
    lease: LeaseToken,
  ) => Effect.Effect<
    { readonly source: Source; readonly userId: UserId; readonly coverKey: string | null; readonly documentKey: string | null },
    EpisodeNotFound | Job.LeaseLost | Failure
  >
  readonly putChapter: (
    id: string,
    chapter: { readonly index: number; readonly title: string; readonly durationMs: number; readonly size: number },
  ) => Effect.Effect<void, DatabaseError>
  /** Records that the timing file of a chapter is stored. The chapter itself can come later. */
  readonly putTiming: (id: string, index: number) => Effect.Effect<void, DatabaseError>
  readonly setBook: (id: string, size: number) => Effect.Effect<void, DatabaseError>
  readonly setCover: (id: string, key: string) => Effect.Effect<void, DatabaseError>
  /**
   * Records the Document a worker stored under its lease. Returns the job after it: `Review` when the job stops
   * for its user, else `Running`.
   */
  readonly storeDocument: (
    id: string,
    lease: LeaseToken,
    document: StoredDocument,
    metadata: Pick<EpisodeUpdate, "title" | "author" | "language" | "voice">,
  ) => Effect.Effect<JobState, EpisodeNotFound | Job.LeaseLost | Failure>
  readonly feedItems: (userId: UserId, origin: string) => Effect.Effect<ReadonlyArray<FeedItem>, Failure>
  readonly voices: Effect.Effect<ReadonlyArray<Voice>, Failure>
  /**
   * Stores `progress` when its `updatedAt` is newer than the stored one, in one statement. A future stamp counts as
   * now. Returns what is stored after the write. Another user's episode is not found.
   */
  readonly putProgress: (
    userId: UserId,
    id: string,
    progress: EpisodeProgress,
  ) => Effect.Effect<EpisodeProgress, EpisodeNotFound | Failure>
}

export class EpisodeRepo extends Context.Service<EpisodeRepo, Interface>()("@fama/api/EpisodeRepo") {}

const VOICE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_CAS_ATTEMPTS = 5

export const layer = Layer.effect(
  EpisodeRepo,
  Effect.gen(function* () {
    const { DB: db } = yield* Bindings
    const media = (row: EpisodeRow, key: string) => mediaPath(row.feed_token, row.user_id, key)

    const all = (operation: string, sql: string, ...binds: ReadonlyArray<unknown>) =>
      query(operation, () =>
        db
          .prepare(sql)
          .bind(...binds)
          .all()
          .then((result) => result.results),
      )

    const run = (operation: string, sql: string, ...binds: ReadonlyArray<unknown>) =>
      Effect.asVoid(query(operation, () => db.prepare(sql).bind(...binds).run()))

    const now = Effect.clockWith((clock) => clock.currentTimeMillis)

    const toEpisode = (row: EpisodeRow, chapters: ReadonlyArray<ChapterRow>) =>
      Schema.decodeUnknownEffect(Episode)({
        id: row.id,
        createdAt: row.created_at,
        source: Schema.encodeSync(Source)(row.source),
        title: row.title,
        author: row.author,
        language: row.language,
        voice: row.voice,
        speed: row.speed,
        durationMs: row.duration_ms,
        chapters: chapters.map((chapter) => ({
          index: chapter.idx,
          title: chapter.title,
          durationMs: chapter.duration_ms,
          url: media(row, keys.chapter(row.user_id, row.id, chapter.idx)),
          timingUrl: chapter.has_timing === 1 ? media(row, keys.timing(row.user_id, row.id, chapter.idx)) : null,
        })),
        bookUrl: row.book_size === null ? null : media(row, keys.book(row.user_id, row.id)),
        coverUrl: row.cover_key === null ? null : media(row, row.cover_key),
        job: jobOf(row),
        progress:
          row.progress_position_ms === null || row.progress_updated_at === null
            ? null
            : { positionMs: row.progress_position_ms, updatedAt: row.progress_updated_at },
      })

    const selectEpisodes = `SELECT e.*, u.feed_token, p.position_ms AS progress_position_ms, p.updated_at AS progress_updated_at
      FROM episodes e JOIN users u ON u.id = e.user_id
      LEFT JOIN progress p ON p.user_id = e.user_id AND p.episode_id = e.id`

    /** One episode. With `userId`, only when that user owns it, so another user's id reads as not found. */
    const findRow = Effect.fnUntraced(function* (id: string, userId: UserId | null = null) {
      const rows = yield* (userId === null
        ? all("episode.find", `${selectEpisodes} WHERE e.id = ?`, id)
        : all("episode.findOwned", `${selectEpisodes} WHERE e.id = ? AND e.user_id = ?`, id, userId)
      ).pipe(Effect.flatMap(decodeRows(EpisodeRow)))
      const row = rows[0]
      if (row === undefined) return yield* new EpisodeNotFound({ id })
      return row
    })

    const selectChapters = `SELECT c.*, t.idx IS NOT NULL AS has_timing FROM chapters c
      LEFT JOIN timings t ON t.episode_id = c.episode_id AND t.idx = c.idx`

    const chaptersOf = (id: string) =>
      all("chapters.list", `${selectChapters} WHERE c.episode_id = ? ORDER BY c.idx`, id).pipe(
        Effect.flatMap(decodeRows(ChapterRow)),
      )

    const get = Effect.fn("EpisodeRepo.get")(function* (userId: UserId, id: string) {
      const row = yield* findRow(id, userId)
      return yield* toEpisode(row, yield* chaptersOf(id))
    })

    /**
     * Applies a pure job transition with compare-and-set on `job_version`, so two
     * concurrent writers can never both win. On a lost race it re-reads and re-applies.
     */
    const transition = Effect.fn("EpisodeRepo.transition")(function* <E>(
      id: string,
      step: (job: JobState, now: number, row: EpisodeRow) => Result.Result<JobState, E>,
      update: EpisodeUpdate = {},
      userId: UserId | null = null,
    ) {
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
        const row = yield* findRow(id, userId)
        const job = yield* Schema.decodeUnknownEffect(JobState)(jobOf(row))
        const at = yield* now
        const next = step(job, at, row)
        if (Result.isFailure(next)) return yield* Effect.fail(next.failure)
        if (next.success === job && Object.keys(update).length === 0) return { row, job }
        const columns: Record<string, unknown> = jobColumns(next.success)
        if (next.success._tag === "Queued" && job._tag !== "Queued") {
          columns.queued_at = new Date(at).toISOString()
        }
        // An episode stops for Review one time. Its job does not come back here.
        if (job._tag === "Review" && next.success._tag !== "Review") columns.review = null
        const sets = Object.keys(columns).map((column) => `${column} = ?`)
        const binds = Object.values(columns)
        for (const [column, value] of Object.entries(update)) {
          sets.push(`${column} = COALESCE(?, ${column})`)
          binds.push(value)
        }
        const changed = yield* query("episode.transition", () =>
          db
            .prepare(
              `UPDATE episodes SET ${sets.join(", ")}, job_version = job_version + 1 WHERE id = ? AND job_version = ? RETURNING id`,
            )
            .bind(...binds, id, row.job_version)
            .all(),
        )
        if (changed.results.length === 1) return { row, job: next.success }
      }
      return yield* Effect.die(new Error(`job ${id} kept changing under ${MAX_CAS_ATTEMPTS} writes`))
    })

    const create = Effect.fn("EpisodeRepo.create")(function* (userId: UserId, input: NewEpisode) {
      const createdAt = new Date(yield* now).toISOString()
      yield* run(
        "episode.create",
        `INSERT INTO episodes (id, user_id, created_at, source, title, voice, speed, job_state, queued_at, review)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Queued', ?, ?)`,
        input.id,
        userId,
        createdAt,
        JSON.stringify(Schema.encodeSync(Source)(input.source)),
        input.title,
        input.voice,
        input.speed,
        createdAt,
        input.review ? "Wanted" : null,
      )
      return yield* get(userId, input.id).pipe(Effect.catchTag("EpisodeNotFound", Effect.die))
    })

    const list = Effect.fn("EpisodeRepo.list")(function* (userId: UserId) {
      const rows = yield* all(
        "episode.list",
        `${selectEpisodes} WHERE e.user_id = ? ORDER BY e.created_at DESC, e.id DESC`,
        userId,
      ).pipe(Effect.flatMap(decodeRows(EpisodeRow)))
      const chapters = yield* all(
        "chapters.ofUser",
        `${selectChapters} JOIN episodes e ON e.id = c.episode_id WHERE e.user_id = ?
         ORDER BY c.episode_id, c.idx`,
        userId,
      ).pipe(Effect.flatMap(decodeRows(ChapterRow)))
      return yield* Effect.forEach(rows, (row) =>
        toEpisode(
          row,
          chapters.filter((chapter) => chapter.episode_id === row.id),
        ),
      )
    })

    const remove = Effect.fn("EpisodeRepo.remove")(function* (userId: UserId, id: string) {
      yield* query("episode.remove", () =>
        db.batch([
          db
            .prepare("DELETE FROM chapters WHERE episode_id = (SELECT id FROM episodes WHERE id = ? AND user_id = ?)")
            .bind(id, userId),
          db
            .prepare("DELETE FROM timings WHERE episode_id = (SELECT id FROM episodes WHERE id = ? AND user_id = ?)")
            .bind(id, userId),
          db
            .prepare("DELETE FROM progress WHERE episode_id = (SELECT id FROM episodes WHERE id = ? AND user_id = ?)")
            .bind(id, userId),
          db.prepare("DELETE FROM episodes WHERE id = ? AND user_id = ?").bind(id, userId),
        ]),
      )
    })

    const retry = Effect.fn("EpisodeRepo.retry")(function* (userId: UserId, id: string) {
      yield* findRow(id, userId)
      yield* transition(id, Job.retry)
      return yield* get(userId, id)
    })

    const inReview = Effect.fn("EpisodeRepo.inReview")(function* (userId: UserId, id: string) {
      const row = yield* findRow(id, userId)
      const open = Job.editDocument(yield* Schema.decodeUnknownEffect(JobState)(jobOf(row)))
      if (Result.isFailure(open)) return yield* Effect.fail(open.failure)
    })

    const editDocument = Effect.fn("EpisodeRepo.editDocument")(function* (
      userId: UserId, id: string, document: StoredDocument,
    ) {
      yield* transition(id, Job.editDocument, documentColumns(document), userId)
    })

    const start = Effect.fn("EpisodeRepo.start")(function* (userId: UserId, id: string, document: StoredDocument) {
      yield* transition(id, Job.start, documentColumns(document), userId)
    })

    /** Whether `lease` is the token of the row's current claim. */
    const leaseOf = (lease: string) => Effect.promise(() => sha256Hex(lease))
    const holds = (row: EpisodeRow, leaseHash: string) => row.lease_hash !== null && row.lease_hash === leaseHash

    const claim = Effect.fn("EpisodeRepo.claim")(function* (
      workerId: WorkerId,
      voices: ReadonlyArray<Voice>,
      claimSample: Effect.Effect<ClaimedSample | null, Failure>,
    ) {
      const at = yield* now
      const seenAt = new Date(at).toISOString()
      if (voices.length > 0) {
        yield* query("voices.register", () =>
          db.batch(
            voices.map((voice) =>
              db
                .prepare(
                  `INSERT INTO voices (id, engine, name, language, gender, seen_at) VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT (id) DO UPDATE SET engine = excluded.engine, name = excluded.name,
                     language = excluded.language, gender = excluded.gender, seen_at = excluded.seen_at`,
                )
                .bind(voice.id, voice.engine, voice.name, voice.language, voice.gender, seenAt),
            ),
          ),
        )
      }
      const sample = yield* claimSample
      if (sample !== null) return { ...sample, _tag: "Sample" as const }
      const staleBefore = new Date(at - LEASE_MS).toISOString()
      const candidates = yield* all(
        "episode.candidates",
        `SELECT id FROM episodes
         WHERE (job_state = 'Queued' AND review IS NOT 'Open') OR (job_state = 'Running' AND heartbeat_at <= ?)
         ORDER BY queued_at, id LIMIT 10`,
        staleBefore,
      ).pipe(Effect.flatMap(decodeRows(Schema.Struct({ id: Schema.String }))))
      for (const { id } of candidates) {
        const leaseToken = randomToken()
        const leaseHash = yield* leaseOf(leaseToken)
        const claimed = yield* transition(id, (job, at) => Job.claim(job, { workerId, now: at }), {
          lease_hash: leaseHash,
        }).pipe(
          Effect.map(({ row }) => row),
          Effect.catchTags({ NotClaimable: () => Effect.succeed(null), EpisodeNotFound: () => Effect.succeed(null) }),
        )
        if (claimed === null) continue
        const chapters = yield* chaptersOf(id)
        const job = yield* Schema.decodeUnknownEffect(ClaimedJob)({
          episodeId: claimed.id,
          leaseToken,
          source: Schema.encodeSync(Source)(claimed.source),
          sourcePath: claimed.source._tag === "File" ? `/api/worker/jobs/${claimed.id}/source` : null,
          documentPath: claimed.document_size === null ? null : `/api/worker/jobs/${claimed.id}/document`,
          coverPath: claimed.cover_key === null ? null : `/api/worker/jobs/${claimed.id}/cover`,
          voice: claimed.voice,
          speed: claimed.speed,
          completedChapters: chapters.map((chapter) => chapter.idx),
        })
        return { ...job, _tag: "Narrate" as const }
      }
      return null
    })

    const progress = Effect.fn("EpisodeRepo.progress")(function* (id: string, request: ProgressRequest) {
      const leaseHash = yield* leaseOf(request.leaseToken)
      yield* transition(id, (job, at, row) => Job.progress(job, { ...request, held: holds(row, leaseHash), now: at }), {
        title: request.title,
        author: request.author,
        language: request.language,
        voice: request.voice,
      })
    })

    const complete = Effect.fn("EpisodeRepo.complete")(function* (id: string, lease: LeaseToken, durationMs: number) {
      const leaseHash = yield* leaseOf(lease)
      yield* transition(id, (job, at, row) => Job.complete(job, { held: holds(row, leaseHash), now: at }), {
        duration_ms: durationMs,
      })
    })

    const fail = Effect.fn("EpisodeRepo.fail")(function* (id: string, lease: LeaseToken, reason: string) {
      const leaseHash = yield* leaseOf(lease)
      yield* transition(id, (job, at, row) => Job.fail(job, { held: holds(row, leaseHash), reason, now: at }))
    })

    const holdLease = Effect.fn("EpisodeRepo.holdLease")(function* (id: string, lease: LeaseToken) {
      const leaseHash = yield* leaseOf(lease)
      const row = yield* findRow(id)
      const job = yield* Schema.decodeUnknownEffect(JobState)(jobOf(row))
      const held = Job.holdLease(job, holds(row, leaseHash))
      if (Result.isFailure(held)) return yield* Effect.fail(held.failure)
      return { source: row.source, userId: row.user_id, coverKey: row.cover_key, documentKey: documentKey(row) }
    })

    const putChapter = Effect.fn("EpisodeRepo.putChapter")(function* (
      id: string,
      chapter: { readonly index: number; readonly title: string; readonly durationMs: number; readonly size: number },
    ) {
      yield* run(
        "chapters.put",
        `INSERT INTO chapters (episode_id, idx, title, duration_ms, size) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (episode_id, idx) DO UPDATE SET title = excluded.title,
           duration_ms = excluded.duration_ms, size = excluded.size`,
        id,
        chapter.index,
        chapter.title,
        chapter.durationMs,
        chapter.size,
      )
    })

    const putTiming = (id: string, index: number) =>
      run("timings.put", "INSERT INTO timings (episode_id, idx) VALUES (?, ?) ON CONFLICT DO NOTHING", id, index)

    const setBook = (id: string, size: number) =>
      run("episode.setBook", "UPDATE episodes SET book_size = ? WHERE id = ?", size, id)

    const setCover = (id: string, key: string) =>
      run("episode.setCover", "UPDATE episodes SET cover_key = ? WHERE id = ?", key, id)

    const storeDocument = Effect.fn("EpisodeRepo.storeDocument")(function* (
      id: string, lease: LeaseToken, document: StoredDocument,
      metadata: Pick<EpisodeUpdate, "title" | "author" | "language" | "voice">,
    ) {
      const leaseHash = yield* leaseOf(lease)
      const { job } = yield* transition(
        id,
        (job, _at, row) => Job.storeDocument(job, { held: holds(row, leaseHash), review: row.review === "Wanted" }),
        { ...documentColumns(document), ...metadata },
      )
      return job
    })

    const feedItems = Effect.fn("EpisodeRepo.feedItems")(function* (userId: UserId, origin: string) {
      const rows = yield* all(
        "episode.feed",
        `${selectEpisodes} WHERE e.user_id = ? AND e.job_state = 'Ready' AND e.book_size IS NOT NULL
         ORDER BY e.finished_at DESC`,
        userId,
      ).pipe(Effect.flatMap(decodeRows(EpisodeRow)))
      const chapters = yield* all(
        "chapters.ofFeed",
        `${selectChapters} JOIN episodes e ON e.id = c.episode_id WHERE e.user_id = ? AND e.job_state = 'Ready'`,
        userId,
      ).pipe(Effect.flatMap(decodeRows(ChapterRow)))
      const timed = new Map<string, Array<{ hasTiming: boolean }>>()
      for (const chapter of chapters) {
        const list = timed.get(chapter.episode_id) ?? []
        list.push({ hasTiming: chapter.has_timing === 1 })
        timed.set(chapter.episode_id, list)
      }
      return rows.flatMap((row): ReadonlyArray<FeedItem> =>
        row.finished_at === null || row.book_size === null
          ? []
          : [
              {
                id: row.id,
                title: row.title,
                author: row.author,
                finishedAt: row.finished_at,
                durationMs: row.duration_ms,
                bookUrl: origin + media(row, keys.book(row.user_id, row.id)),
                bookSize: row.book_size,
                coverUrl: row.cover_key === null ? null : origin + media(row, row.cover_key),
                language: row.language,
                transcriptUrl: hasTranscript(timed.get(row.id) ?? [])
                  ? origin + media(row, keys.transcript(row.user_id, row.id))
                  : null,
              },
            ],
      )
    })

    const voices = Effect.gen(function* () {
      const since = new Date((yield* now) - VOICE_TTL_MS).toISOString()
      const rows = yield* all(
        "voices.list",
        "SELECT id, engine, name, language, gender FROM voices WHERE seen_at >= ? ORDER BY language, id",
        since,
      )
      return yield* decodeRows(Voice)(rows)
    }).pipe(Effect.withSpan("EpisodeRepo.voices"))

    const putProgress = Effect.fn("EpisodeRepo.putProgress")(function* (
      userId: UserId,
      id: string,
      progress: EpisodeProgress,
    ) {
      // A clock ahead of the server's must not win every later write, so the server's clock caps the stamp.
      const updatedAt = new Date(Math.min(Date.parse(progress.updatedAt), yield* now)).toISOString()
      const [, stored] = yield* query("progress.put", () =>
        db.batch([
          // The insert reads the episode row, so an episode the user does not own writes nothing. An equal or older
          // stamp leaves the stored row as it is.
          db
            .prepare(
              `INSERT INTO progress (user_id, episode_id, position_ms, updated_at)
               SELECT user_id, id, ?, ? FROM episodes WHERE id = ? AND user_id = ?
               ON CONFLICT (user_id, episode_id) DO UPDATE SET
                 position_ms = excluded.position_ms, updated_at = excluded.updated_at
               WHERE excluded.updated_at > progress.updated_at`,
            )
            .bind(progress.positionMs, updatedAt, id, userId),
          db
            .prepare(
              `SELECT p.position_ms AS positionMs, p.updated_at AS updatedAt FROM progress p
               JOIN episodes e ON e.id = p.episode_id AND e.user_id = p.user_id
               WHERE p.user_id = ? AND p.episode_id = ?`,
            )
            .bind(userId, id),
        ]),
      )
      const row = stored?.results[0]
      if (row === undefined) return yield* new EpisodeNotFound({ id })
      return yield* Schema.decodeUnknownEffect(EpisodeProgress)(row)
    })

    return EpisodeRepo.of({
      putProgress,
      create,
      list,
      get,
      remove,
      retry,
      inReview,
      documentKey: (userId, id) => findRow(id, userId).pipe(Effect.map(documentKey)),
      editDocument,
      start,
      claim,
      progress,
      complete,
      fail,
      holdLease,
      putChapter,
      putTiming,
      setBook,
      setCover,
      storeDocument,
      feedItems,
      voices,
    })
  }),
)
