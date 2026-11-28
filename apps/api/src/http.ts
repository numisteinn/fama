import {
  API_VERSION,
  ClaimRequest,
  CompleteRequest,
  CreateEpisode,
  EpisodeId,
  EpisodeProgress,
  FailRequest,
  ProgressRequest,
} from "@fama/contracts"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { AccountRepo } from "./account-repo.ts"
import { EpisodeRepo } from "./episode-repo.ts"
import { keys, MediaStore } from "./media-store.ts"
import { chapterRoutes } from "./routes/chapter.ts"
import { documentRoutes } from "./routes/document.ts"
import { api, BadRequest, BlobParams, IdParams, json, noContent, putBody, webRequest, worker } from "./routes/kit.ts"
import { organizeRoutes } from "./routes/organize.ts"
import { publicRoutes } from "./routes/public.ts"
import { reviewRoutes } from "./routes/review.ts"
import { sampleRoutes } from "./routes/sample.ts"
import { timingRoutes } from "./routes/timing.ts"
import { transcriptRoutes } from "./routes/transcript.ts"
import { provisionalTitle, uploadRoutes } from "./routes/upload.ts"
import { SampleRepo } from "./sample-repo.ts"
import { Wake } from "./wake.ts"

const feedUrl = (origin: string, feedToken: string) => `${origin}/feed/${feedToken}/rss.xml`


/** Wakes the cloud worker. Call it only after the write that made the job `Queued` has committed. */
const wakeWorker = Effect.gen(function* () {
  yield* (yield* Wake).wake
})


const clientRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/me",
    api(({ userId }) => Effect.succeed(json({ userId, apiVersion: API_VERSION }))),
  ),
  HttpRouter.route(
    "POST",
    "/api/episodes",
    api(({ userId }) =>
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(CreateEpisode)
        const repo = yield* EpisodeRepo
        const episode = yield* repo.create(userId, {
          id: EpisodeId.make(crypto.randomUUID()),
          source: body.source,
          title: provisionalTitle(body.source),
          voice: body.voice,
          speed: body.speed,
          review: body.review,
        })
        yield* wakeWorker
        return json(episode, 201)
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/episodes",
    api(({ userId }) =>
      Effect.gen(function* () {
        return json({ episodes: yield* (yield* EpisodeRepo).list(userId) })
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/episodes/:id",
    api(({ userId }) =>
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParams)
        return json(yield* (yield* EpisodeRepo).get(userId, id))
      }),
    ),
  ),
  HttpRouter.route(
    "DELETE",
    "/api/episodes/:id",
    api(({ userId }) =>
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParams)
        const repo = yield* EpisodeRepo
        // Ownership first: another user's id is 404 and touches no media.
        yield* repo.get(userId, id)
        const store = yield* MediaStore
        yield* store.deleteEpisode(userId, id)
        yield* repo.remove(userId, id)
        // Sweep clips that finished during the first media deletion.
        yield* store.deleteSamples(userId, id)
        return noContent
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/episodes/:id/retry",
    api(({ userId }) =>
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParams)
        const episode = yield* (yield* EpisodeRepo).retry(userId, id)
        yield* wakeWorker
        return json(episode)
      }),
    ),
  ),
  HttpRouter.route(
    "PUT",
    "/api/episodes/:id/progress",
    api(({ userId }) =>
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParams)
        const body = yield* HttpServerRequest.schemaBodyJson(EpisodeProgress)
        return json(yield* (yield* EpisodeRepo).putProgress(userId, id, body))
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/voices",
    api(() =>
      Effect.gen(function* () {
        return json({ voices: yield* (yield* EpisodeRepo).voices })
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/feed",
    api(({ userId }) =>
      Effect.gen(function* () {
        const origin = new URL((yield* webRequest).url).origin
        return json({ url: feedUrl(origin, yield* (yield* AccountRepo).feedToken(userId)) })
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/feed/rotate",
    api(({ userId }) =>
      Effect.gen(function* () {
        const origin = new URL((yield* webRequest).url).origin
        return json({ url: feedUrl(origin, yield* (yield* AccountRepo).rotateFeedToken(userId)) })
      }),
    ),
  ),
])

const workerRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "POST",
    "/api/worker/claim",
    worker(
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(ClaimRequest)
        const samples = yield* SampleRepo
        const work = yield* (yield* EpisodeRepo).claim(body.workerId, body.voices, samples.claim)
        return work === null ? noContent : json({ work })
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/worker/jobs/:id/progress",
    worker(
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParams)
        const body = yield* HttpServerRequest.schemaBodyJson(ProgressRequest)
        yield* (yield* EpisodeRepo).progress(id, body)
        return noContent
      }),
    ),
  ),
  HttpRouter.route(
    "PUT",
    "/api/worker/jobs/:id/book",
    worker(
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaParams(BlobParams)
        const repo = yield* EpisodeRepo
        const { userId, leaseHash } = yield* repo.holdLease(params.id, params.leaseToken)
        const { size } = yield* putBody(keys.book(userId, params.id, leaseHash), "audio/mp4")
        yield* repo.setBook(params.id, leaseHash, size)
        return noContent
      }),
    ),
  ),
  HttpRouter.route(
    "PUT",
    "/api/worker/jobs/:id/cover",
    worker(
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaParams(BlobParams)
        const request = yield* webRequest
        const contentType = request.headers.get("content-type") ?? ""
        const ext = { "image/jpeg": "jpg", "image/png": "png" }[contentType]
        if (ext === undefined) return yield* new BadRequest({ message: "Cover must be image/jpeg or image/png" })
        const repo = yield* EpisodeRepo
        const { userId } = yield* repo.holdLease(params.id, params.leaseToken)
        const key = keys.cover(userId, params.id, ext)
        yield* putBody(key, contentType)
        yield* repo.setCover(params.id, key)
        return noContent
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/worker/jobs/:id/complete",
    worker(
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParams)
        const body = yield* HttpServerRequest.schemaBodyJson(CompleteRequest)
        yield* (yield* EpisodeRepo).complete(id, body.leaseToken, body.durationMs)
        return noContent
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/worker/jobs/:id/fail",
    worker(
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParams)
        const body = yield* HttpServerRequest.schemaBodyJson(FailRequest)
        yield* (yield* EpisodeRepo).fail(id, body.leaseToken, body.reason)
        return noContent
      }),
    ),
  ),
])

const notFound = HttpRouter.route(
  "*",
  "*",
  Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "NotFound", message: "Not found" }, { status: 404 })),
)

export const routes = Layer.mergeAll(
  clientRoutes,
  workerRoutes,
  chapterRoutes,
  documentRoutes,
  organizeRoutes,
  publicRoutes,
  reviewRoutes,
  sampleRoutes,
  timingRoutes,
  transcriptRoutes,
  uploadRoutes,
  HttpRouter.addAll([notFound]),
  HttpRouter.cors({
    allowedHeaders: ["authorization", "content-type", "range"],
    exposedHeaders: ["content-length", "content-range", "accept-ranges", "etag"],
    maxAge: 86400,
  }),
)
