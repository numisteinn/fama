import {
  ClaimedJob,
  Episode,
  type EpisodeId,
  JobState,
  LEASE_MS,
  type ProgressRequest,
  Source,
  Voice,
  type VoiceRef,
  type WorkerId,
} from "@fama/contracts"
import { Context, Effect, Layer, Result, Schema } from "effect"
import { Bindings } from "./bindings.ts"
import type { FeedItem } from "./feed.ts"
import * as Job from "./job.ts"
import { keys } from "./media-store.ts"

export class EpisodeNotFound extends Schema.TaggedError<EpisodeNotFound>()("EpisodeNotFound", {
  id: Schema.String,
}) {}

export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

const EpisodeRow = Schema.Struct({
  id: Schema.String,
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
  job_version: Schema.Number,
  job_state: Schema.Literals(["Queued", "Running", "Ready", "Failed"]),
  worker_id: Schema.NullOr(Schema.String),
  stage: Schema.NullOr(Schema.String),
  done: Schema.NullOr(Schema.Number),
  total: Schema.NullOr(Schema.Number),
  heartbeat_at: Schema.NullOr(Schema.String),
  finished_at: Schema.NullOr(Schema.String),
  fail_reason: Schema.NullOr(Schema.String),
  failed_at: Schema.NullOr(Schema.String),
})
interface EpisodeRow extends Schema.Schema.Type<typeof EpisodeRow> {}

const ChapterRow = Schema.Struct({
  episode_id: Schema.String,
  idx: Schema.Number,
  title: Schema.String,
  duration_ms: Schema.Number,
})
interface ChapterRow extends Schema.Schema.Type<typeof ChapterRow> {}

const decodeRows = <S extends Schema.Top>(schema: S) => Schema.decodeUnknownEffect(Schema.Array(schema))

const jobOf = (row: EpisodeRow) => {
  switch (row.job_state) {
    case "Queued":
      return { _tag: "Queued" }
    case "Running":
      return {
        _tag: "Running",
        workerId: row.worker_id,
        stage: row.stage,
        done: row.done,
        total: row.total,
        heartbeatAt: row.heartbeat_at,
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
    finished_at: null,
    fail_reason: null,
    failed_at: null,
  }
  return JobState.match(job, {
    Queued: () => ({ ...none, job_state: "Queued" }),
    Running: (s) => ({
      ...none,
      job_state: "Running",
      worker_id: s.workerId,
      stage: s.stage,
      done: s.done,
      total: s.total,
      heartbeat_at: s.heartbeatAt,
    }),
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
}

export interface NewEpisode {
  readonly id: EpisodeId
  readonly source: Source
  readonly title: string
  readonly voice: VoiceRef | null
  readonly speed: number
}

export interface Interface {
  readonly create: (input: NewEpisode) => Effect.Effect<Episode, DatabaseError | Schema.SchemaError>
  readonly list: Effect.Effect<ReadonlyArray<Episode>, DatabaseError | Schema.SchemaError>
  readonly get: (id: string) => Effect.Effect<Episode, EpisodeNotFound | DatabaseError | Schema.SchemaError>
  readonly remove: (id: string) => Effect.Effect<void, DatabaseError>
  readonly retry: (
    id: string,
  ) => Effect.Effect<Episode, EpisodeNotFound | Job.NotRetryable | DatabaseError | Schema.SchemaError>
  readonly claim: (
    workerId: WorkerId,
    voices: ReadonlyArray<Voice>,
  ) => Effect.Effect<ClaimedJob | null, DatabaseError | Schema.SchemaError>
  readonly progress: (
    id: string,
    request: ProgressRequest,
  ) => Effect.Effect<void, EpisodeNotFound | Job.LeaseLost | DatabaseError | Schema.SchemaError>
  readonly complete: (
    id: string,
    workerId: WorkerId,
    durationMs: number,
  ) => Effect.Effect<void, EpisodeNotFound | Job.LeaseLost | DatabaseError | Schema.SchemaError>
  readonly fail: (
    id: string,
    workerId: WorkerId,
    reason: string,
  ) => Effect.Effect<void, EpisodeNotFound | Job.LeaseLost | DatabaseError | Schema.SchemaError>
  readonly holdLease: (
    id: string,
    workerId: WorkerId,
  ) => Effect.Effect<Source, EpisodeNotFound | Job.LeaseLost | DatabaseError | Schema.SchemaError>
  readonly source: (id: string) => Effect.Effect<Source, EpisodeNotFound | DatabaseError | Schema.SchemaError>
  readonly putChapter: (
    id: string,
    chapter: { readonly index: number; readonly title: string; readonly durationMs: number; readonly size: number },
  ) => Effect.Effect<void, DatabaseError>
  readonly setBook: (id: string, size: number) => Effect.Effect<void, DatabaseError>
  readonly setCover: (id: string, key: string) => Effect.Effect<void, DatabaseError>
  readonly feedItems: (origin: string) => Effect.Effect<ReadonlyArray<FeedItem>, DatabaseError | Schema.SchemaError>
  readonly voices: Effect.Effect<ReadonlyArray<Voice>, DatabaseError | Schema.SchemaError>
}

export class EpisodeRepo extends Context.Service<EpisodeRepo, Interface>()("@fama/api/EpisodeRepo") {}

const VOICE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_CAS_ATTEMPTS = 5

export const layer = Layer.effect(
  EpisodeRepo,
  Effect.gen(function* () {
    const { DB: db, FAMA_FEED_TOKEN: feedToken } = yield* Bindings
    const mediaPath = (key: string) => `/media/${feedToken}/${key}`

    const query = <A>(operation: string, run: () => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: (cause) => new DatabaseError({ operation, cause }) })

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
          url: mediaPath(keys.chapter(row.id, chapter.idx)),
        })),
        bookUrl: row.book_size === null ? null : mediaPath(keys.book(row.id)),
        coverUrl: row.cover_key === null ? null : mediaPath(row.cover_key),
        job: jobOf(row),
      })

    const findRow = Effect.fnUntraced(function* (id: string) {
      const rows = yield* all("episode.find", "SELECT * FROM episodes WHERE id = ?", id).pipe(
        Effect.flatMap(decodeRows(EpisodeRow)),
      )
      const row = rows[0]
      if (row === undefined) return yield* new EpisodeNotFound({ id })
      return row
    })

    const chaptersOf = (id: string) =>
      all("chapters.list", "SELECT * FROM chapters WHERE episode_id = ? ORDER BY idx", id).pipe(
        Effect.flatMap(decodeRows(ChapterRow)),
      )

    const get = Effect.fn("EpisodeRepo.get")(function* (id: string) {
      const row = yield* findRow(id)
      return yield* toEpisode(row, yield* chaptersOf(id))
    })

    /**
     * Applies a pure job transition with compare-and-set on `job_version`, so two
     * concurrent writers can never both win. On a lost race it re-reads and re-applies.
     */
    const transition = Effect.fn("EpisodeRepo.transition")(function* <E>(
      id: string,
      step: (job: JobState, now: number) => Result.Result<JobState, E>,
      update: EpisodeUpdate = {},
    ) {
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
        const row = yield* findRow(id)
        const job = yield* Schema.decodeUnknownEffect(JobState)(jobOf(row))
        const at = yield* now
        const next = step(job, at)
        if (Result.isFailure(next)) return yield* Effect.fail(next.failure)
        if (next.success === job && Object.keys(update).length === 0) return { row, job }
        const columns: Record<string, unknown> = jobColumns(next.success)
        if (next.success._tag === "Queued" && job._tag !== "Queued") {
          columns.queued_at = new Date(at).toISOString()
        }
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

    const create = Effect.fn("EpisodeRepo.create")(function* (input: NewEpisode) {
      const createdAt = new Date(yield* now).toISOString()
      yield* run(
        "episode.create",
        `INSERT INTO episodes (id, created_at, source, title, voice, speed, job_state, queued_at)
         VALUES (?, ?, ?, ?, ?, ?, 'Queued', ?)`,
        input.id,
        createdAt,
        JSON.stringify(Schema.encodeSync(Source)(input.source)),
        input.title,
        input.voice,
        input.speed,
        createdAt,
      )
      return yield* get(input.id).pipe(Effect.catchTag("EpisodeNotFound", Effect.die))
    })

    const list = Effect.gen(function* () {
      const rows = yield* all("episode.list", "SELECT * FROM episodes ORDER BY created_at DESC, id DESC").pipe(
        Effect.flatMap(decodeRows(EpisodeRow)),
      )
      const chapters = yield* all("chapters.all", "SELECT * FROM chapters ORDER BY episode_id, idx").pipe(
        Effect.flatMap(decodeRows(ChapterRow)),
      )
      return yield* Effect.forEach(rows, (row) =>
        toEpisode(
          row,
          chapters.filter((chapter) => chapter.episode_id === row.id),
        ),
      )
    }).pipe(Effect.withSpan("EpisodeRepo.list"))

    const remove = Effect.fn("EpisodeRepo.remove")(function* (id: string) {
      yield* query("episode.remove", () =>
        db.batch([
          db.prepare("DELETE FROM chapters WHERE episode_id = ?").bind(id),
          db.prepare("DELETE FROM episodes WHERE id = ?").bind(id),
        ]),
      )
    })

    const retry = Effect.fn("EpisodeRepo.retry")(function* (id: string) {
      yield* transition(id, Job.retry)
      return yield* get(id)
    })

    const claim = Effect.fn("EpisodeRepo.claim")(function* (workerId: WorkerId, voices: ReadonlyArray<Voice>) {
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
      const staleBefore = new Date(at - LEASE_MS).toISOString()
      const candidates = yield* all(
        "episode.candidates",
        `SELECT id FROM episodes
         WHERE job_state = 'Queued' OR (job_state = 'Running' AND heartbeat_at <= ?)
         ORDER BY queued_at, id LIMIT 10`,
        staleBefore,
      ).pipe(Effect.flatMap(decodeRows(Schema.Struct({ id: Schema.String }))))
      for (const { id } of candidates) {
        const claimed = yield* transition(id, (job, at) => Job.claim(job, { workerId, now: at })).pipe(
          Effect.map(({ row }) => row),
          Effect.catchTags({ NotClaimable: () => Effect.succeed(null), EpisodeNotFound: () => Effect.succeed(null) }),
        )
        if (claimed === null) continue
        const chapters = yield* chaptersOf(id)
        return yield* Schema.decodeUnknownEffect(ClaimedJob)({
          episodeId: claimed.id,
          source: Schema.encodeSync(Source)(claimed.source),
          sourcePath: claimed.source._tag === "File" ? `/api/worker/jobs/${claimed.id}/source` : null,
          voice: claimed.voice,
          speed: claimed.speed,
          completedChapters: chapters.map((chapter) => chapter.idx),
        })
      }
      return null
    })

    const progress = Effect.fn("EpisodeRepo.progress")(function* (id: string, request: ProgressRequest) {
      yield* transition(id, (job, at) => Job.progress(job, { ...request, now: at }), {
        title: request.title,
        author: request.author,
        language: request.language,
        voice: request.voice,
      })
    })

    const complete = Effect.fn("EpisodeRepo.complete")(function* (
      id: string,
      workerId: WorkerId,
      durationMs: number,
    ) {
      yield* transition(id, (job, at) => Job.complete(job, { workerId, now: at }), { duration_ms: durationMs })
    })

    const fail = Effect.fn("EpisodeRepo.fail")(function* (id: string, workerId: WorkerId, reason: string) {
      yield* transition(id, (job, at) => Job.fail(job, { workerId, reason, now: at }))
    })

    const holdLease = Effect.fn("EpisodeRepo.holdLease")(function* (id: string, workerId: WorkerId) {
      const row = yield* findRow(id)
      const job = yield* Schema.decodeUnknownEffect(JobState)(jobOf(row))
      const held = Job.holdLease(job, workerId)
      if (Result.isFailure(held)) return yield* Effect.fail(held.failure)
      return row.source
    })

    const source = Effect.fn("EpisodeRepo.source")(function* (id: string) {
      return (yield* findRow(id)).source
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

    const setBook = (id: string, size: number) =>
      run("episode.setBook", "UPDATE episodes SET book_size = ? WHERE id = ?", size, id)

    const setCover = (id: string, key: string) =>
      run("episode.setCover", "UPDATE episodes SET cover_key = ? WHERE id = ?", key, id)

    const feedItems = Effect.fn("EpisodeRepo.feedItems")(function* (origin: string) {
      const rows = yield* all(
        "episode.feed",
        `SELECT * FROM episodes WHERE job_state = 'Ready' AND book_size IS NOT NULL ORDER BY finished_at DESC`,
      ).pipe(Effect.flatMap(decodeRows(EpisodeRow)))
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
                bookUrl: origin + mediaPath(keys.book(row.id)),
                bookSize: row.book_size,
                coverUrl: row.cover_key === null ? null : origin + mediaPath(row.cover_key),
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

    return EpisodeRepo.of({
      create,
      list,
      get,
      remove,
      retry,
      claim,
      progress,
      complete,
      fail,
      holdLease,
      source,
      putChapter,
      setBook,
      setCover,
      feedItems,
      voices,
    })
  }),
)
