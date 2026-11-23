import { Schema } from "effect"

export * from "./connect.ts"

export const EpisodeId = Schema.String.pipe(Schema.brand("EpisodeId"))
export type EpisodeId = typeof EpisodeId.Type

export const WorkerId = Schema.String.pipe(Schema.brand("WorkerId"))
export type WorkerId = typeof WorkerId.Type

export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

/** The secret `claim` hands out for one attempt at a job. Every job route needs it. */
export const LeaseToken = Schema.String.pipe(Schema.brand("LeaseToken"))
export type LeaseToken = typeof LeaseToken.Type

/** `engine:voiceId`, for example `kokoro:af_heart` or `piper:is_IS-salka-medium`. */
export const VoiceRef = Schema.String.pipe(Schema.brand("VoiceRef"))
export type VoiceRef = typeof VoiceRef.Type

export const Voice = Schema.Struct({
  id: VoiceRef,
  engine: Schema.String,
  name: Schema.String,
  language: Schema.String,
  gender: Schema.NullOr(Schema.Literals(["female", "male"])),
})
export interface Voice extends Schema.Schema.Type<typeof Voice> {}

export const SourceInput = Schema.TaggedUnion({
  Url: { url: Schema.String },
  Text: { title: Schema.NullOr(Schema.String), text: Schema.String },
})
export type SourceInput = typeof SourceInput.Type

export const Source = Schema.TaggedUnion({
  Url: { url: Schema.String },
  Text: { title: Schema.NullOr(Schema.String), text: Schema.String },
  File: { fileName: Schema.String, contentType: Schema.String },
})
export type Source = typeof Source.Type

export const Stage = Schema.Literals(["extracting", "synthesizing", "encoding", "uploading"])
export type Stage = typeof Stage.Type

export const JobState = Schema.TaggedUnion({
  Queued: {},
  Running: {
    workerId: WorkerId,
    stage: Stage,
    done: Schema.Number,
    total: Schema.Number,
    heartbeatAt: Schema.String,
  },
  Ready: { finishedAt: Schema.String },
  Failed: { reason: Schema.String, failedAt: Schema.String },
})
export type JobState = typeof JobState.Type

export const Chapter = Schema.Struct({
  index: Schema.Number,
  title: Schema.String,
  durationMs: Schema.Number,
  url: Schema.String,
})
export interface Chapter extends Schema.Schema.Type<typeof Chapter> {}

/** A whole number of milliseconds, 0 or more. */
const Millis = Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)))

/** An ISO 8601 time that `Date.parse` reads. */
const Instant = Schema.String.pipe(
  Schema.check(Schema.makeFilter((value: string) => Number.isFinite(Date.parse(value)), { expected: "an ISO 8601 time" })),
)

/**
 * Where one user is in one episode. `positionMs` is on the whole episode timeline (all chapters in order).
 * A finished episode holds its total length. The newest `updatedAt` wins.
 */
export const EpisodeProgress = Schema.Struct({ positionMs: Millis, updatedAt: Instant })
export interface EpisodeProgress extends Schema.Schema.Type<typeof EpisodeProgress> {}

/** Closer than this to the end counts as finished, so the next play starts from the top. */
export const FINISHED_MARGIN_MS = 3000

/**
 * Whether a position is the end of an episode of `totalMs`. Only for a finished job: the end of the chapters a
 * running job has made so far is not the end of the episode.
 */
export const isFinished = (positionMs: number, totalMs: number): boolean =>
  totalMs > 0 && positionMs >= totalMs - FINISHED_MARGIN_MS

/** `a` was written after `b`. */
export const isNewerProgress = (a: EpisodeProgress, b: EpisodeProgress): boolean =>
  Date.parse(a.updatedAt) > Date.parse(b.updatedAt)

/**
 * The client's rule for one episode, on library load: the newer entry wins. `progress` is what the client keeps
 * (`null` when neither side has one). `isPushed` says the local entry is newer, so the client sends it. A tie keeps
 * the server's entry and sends nothing.
 */
export const mergeProgress = (
  local: EpisodeProgress | null,
  server: EpisodeProgress | null,
): { readonly progress: EpisodeProgress | null; readonly isPushed: boolean } => {
  if (local === null) return { progress: server, isPushed: false }
  if (server === null || isNewerProgress(local, server)) return { progress: local, isPushed: true }
  return { progress: server, isPushed: false }
}

export const Episode = Schema.Struct({
  id: EpisodeId,
  createdAt: Schema.String,
  source: Source,
  title: Schema.String,
  author: Schema.NullOr(Schema.String),
  language: Schema.NullOr(Schema.String),
  voice: Schema.NullOr(VoiceRef),
  speed: Schema.Number,
  durationMs: Schema.NullOr(Schema.Number),
  chapters: Schema.Array(Chapter),
  bookUrl: Schema.NullOr(Schema.String),
  coverUrl: Schema.NullOr(Schema.String),
  job: JobState,
  /** The client token user's progress, as the server stores it. */
  progress: Schema.NullOr(EpisodeProgress),
})
export interface Episode extends Schema.Schema.Type<typeof Episode> {}

// Client API

export const CreateEpisode = Schema.Struct({
  source: SourceInput,
  voice: Schema.NullOr(VoiceRef),
  speed: Schema.Number,
})
export interface CreateEpisode extends Schema.Schema.Type<typeof CreateEpisode> {}

export const EpisodeList = Schema.Struct({ episodes: Schema.Array(Episode) })
export const VoiceList = Schema.Struct({ voices: Schema.Array(Voice) })
export const FeedInfo = Schema.Struct({ url: Schema.String })

/** Bumped on a breaking change to this contract. */
export const API_VERSION = 1

/** `GET /api/me`: who the client token belongs to. Clients key caches and downloads by server and `userId`. */
export const Me = Schema.Struct({ userId: UserId, apiVersion: Schema.Number })
export interface Me extends Schema.Schema.Type<typeof Me> {}

// Worker API

export const ClaimRequest = Schema.Struct({
  workerId: WorkerId,
  voices: Schema.Array(Voice),
})
export interface ClaimRequest extends Schema.Schema.Type<typeof ClaimRequest> {}

export const ClaimedJob = Schema.Struct({
  episodeId: EpisodeId,
  leaseToken: LeaseToken,
  source: Source,
  /** API path to GET the uploaded bytes. Set only for `File` sources. */
  sourcePath: Schema.NullOr(Schema.String),
  voice: Schema.NullOr(VoiceRef),
  speed: Schema.Number,
  /** Chapter indexes already uploaded by an earlier attempt. The worker skips them. */
  completedChapters: Schema.Array(Schema.Number),
})
export interface ClaimedJob extends Schema.Schema.Type<typeof ClaimedJob> {}

export const ClaimResponse = Schema.Struct({ job: ClaimedJob })

export const ProgressRequest = Schema.Struct({
  workerId: WorkerId,
  leaseToken: LeaseToken,
  stage: Stage,
  done: Schema.Number,
  total: Schema.Number,
  title: Schema.NullOr(Schema.String),
  author: Schema.NullOr(Schema.String),
  language: Schema.NullOr(Schema.String),
  voice: Schema.NullOr(VoiceRef),
})
export interface ProgressRequest extends Schema.Schema.Type<typeof ProgressRequest> {}

/** Query of `PUT /api/worker/jobs/:id/chapters/:index`. */
export const ChapterUploadQuery = Schema.Struct({
  workerId: WorkerId,
  leaseToken: LeaseToken,
  title: Schema.String,
  durationMs: Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
})

/** Query of `PUT /api/worker/jobs/:id/book` and `PUT /api/worker/jobs/:id/cover`. */
export const UploadQuery = Schema.Struct({ workerId: WorkerId, leaseToken: LeaseToken })

/** Query of `GET /api/worker/jobs/:id/source`. */
export const SourceQuery = Schema.Struct({ leaseToken: LeaseToken })

export const CompleteRequest = Schema.Struct({ workerId: WorkerId, leaseToken: LeaseToken, durationMs: Schema.Number })
export const FailRequest = Schema.Struct({ workerId: WorkerId, leaseToken: LeaseToken, reason: Schema.String })

/** A job whose heartbeat is older than this can be claimed by another worker. */
export const LEASE_MS = 10 * 60 * 1000
