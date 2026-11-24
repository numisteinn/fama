import {
  API_VERSION,
  ClaimRequest,
  CompleteRequest,
  CreateEpisode,
  EpisodeId,
  EpisodeProgress,
  FailRequest,
  ProgressRequest,
  type Source,
  SourceQuery,
  VoiceRef,
} from "@fama/contracts"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { AccountRepo } from "./account-repo.ts"
import { feedUser } from "./auth.ts"
import cover from "./cover.jpg"
import { EpisodeRepo } from "./episode-repo.ts"
import { renderFeed } from "./feed.ts"
import { keys, MediaStore, mediaKey } from "./media-store.ts"
import { mediaResponse } from "./media.ts"
import { chapterRoutes } from "./routes/chapter.ts"
import { documentRoutes } from "./routes/document.ts"
import { api, BadRequest, BlobParams, handle, IdParams, json, MAX_UPLOAD_BYTES, noContent, putBody, TooLarge, webRequest, worker } from "./routes/kit.ts"
import { reviewRoutes } from "./routes/review.ts"
import { sampleRoutes } from "./routes/sample.ts"
import { timingRoutes } from "./routes/timing.ts"
import { transcriptRoutes } from "./routes/transcript.ts"
import { SampleRepo } from "./sample-repo.ts"
import { Wake } from "./wake.ts"

/** The decoded path after `/media/<token>/`, for example `episodes/<id>/book.m4b`. Empty when it does not decode. */
const mediaPathOf = (url: string) => {
  try {
    return new URL(url).pathname.split("/").slice(3).map(decodeURIComponent).join("/")
  } catch {
    return ""
  }
}

const feedUrl = (origin: string, feedToken: string) => `${origin}/feed/${feedToken}/rss.xml`

const SourceParams = Schema.Struct({ ...SourceQuery.fields, id: EpisodeId })

const firstWords = (text: string, count: number) => {
  const words = text.trim().split(/\s+/)
  return words.slice(0, count).join(" ") + (words.length > count ? "…" : "")
}

/** The provisional title a new episode shows until the worker reports the real one. */
const provisionalTitle = (source: Source) => {
  switch (source._tag) {
    case "Url": {
      const url = URL.parse(source.url)
      return url === null ? source.url : `${url.host}${url.pathname === "/" ? "" : url.pathname}`
    }
    case "Text":
      return source.title?.trim() || firstWords(source.text, 8) || "Untitled"
    case "File":
      return source.fileName
  }
}

/** Wakes the cloud worker. Call it only after the write that made the job `Queued` has committed. */
const wakeWorker = Effect.gen(function* () {
  yield* (yield* Wake).wake
})

const safeFileName = (name: string) => name.replace(/[/\\]/g, "_").replace(/^\.+/, "") || "upload"

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
    "POST",
    "/api/episodes/upload",
    api(({ userId }) =>
      Effect.gen(function* () {
        const request = yield* webRequest
        const length = Number(request.headers.get("content-length") ?? 0)
        if (length > MAX_UPLOAD_BYTES + 64 * 1024) return yield* new TooLarge()
        const form = yield* Effect.tryPromise({
          try: () => request.formData(),
          catch: () => new BadRequest({ message: "Expected multipart form data" }),
        })
        const file = form.get("file")
        if (file === null || typeof file === "string") return yield* new BadRequest({ message: "Missing file" })
        if (file.size > MAX_UPLOAD_BYTES) return yield* new TooLarge()
        const voiceField = form.get("voice")
        const speedField = form.get("speed")
        const voice = typeof voiceField === "string" && voiceField !== "" ? VoiceRef.make(voiceField) : null
        const speed = typeof speedField === "string" && speedField !== "" ? Number(speedField) : 1
        if (!Number.isFinite(speed) || speed <= 0) return yield* new BadRequest({ message: "Invalid speed" })
        const reviewField = form.get("review") ?? "false"
        if (reviewField !== "true" && reviewField !== "false") return yield* new BadRequest({ message: "Invalid review" })
        const id = EpisodeId.make(crypto.randomUUID())
        const fileName = safeFileName(file.name)
        const contentType = file.type || "application/octet-stream"
        const store = yield* MediaStore
        yield* store.put(keys.upload(userId, id, fileName), file, contentType)
        const repo = yield* EpisodeRepo
        const source: Source = { _tag: "File", fileName, contentType }
        const episode = yield* repo.create(userId, {
          id,
          source,
          title: provisionalTitle(source),
          voice,
          speed,
          review: reviewField === "true",
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
    "GET",
    "/api/worker/jobs/:id/source",
    worker(
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaParams(SourceParams)
        const { source, userId } = yield* (yield* EpisodeRepo).holdLease(params.id, params.leaseToken)
        if (source._tag !== "File") return yield* new BadRequest({ message: "Source is not a file" })
        const object = yield* (yield* MediaStore).get(keys.upload(userId, params.id, source.fileName), null)
        if (object === null) return yield* new BadRequest({ message: "Uploaded file is missing" })
        return HttpServerResponse.raw(
          new Response(object.body, {
            headers: { "content-type": source.contentType, "content-length": String(object.size) },
          }),
        )
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

const publicRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/feed/:token/rss.xml",
    handle(
      Effect.gen(function* () {
        const { userId, feedToken } = yield* feedUser
        const origin = new URL((yield* webRequest).url).origin
        const items = yield* (yield* EpisodeRepo).feedItems(userId, origin)
        const xml = renderFeed({
          title: "Fama",
          author: "Fama",
          link: origin,
          imageUrl: `${origin}/feed/${feedToken}/cover.jpg?v=ribbon-fan`,
          items,
        })
        return HttpServerResponse.text(xml, { contentType: "application/rss+xml; charset=utf-8" })
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/feed/:token/cover.jpg",
    handle(
      Effect.as(
        feedUser,
        HttpServerResponse.uint8Array(new Uint8Array(cover), { contentType: "image/jpeg" }),
      ),
    ),
  ),
  ...(["GET", "HEAD"] as const).map((method) =>
    HttpRouter.route(
      method,
      "/media/:token/*",
      handle(
        Effect.gen(function* () {
          const { userId } = yield* feedUser
          const request = yield* webRequest
          const key = mediaKey(userId, mediaPathOf(request.url))
          if (key === null) return HttpServerResponse.text("Not found", { status: 404 })
          return HttpServerResponse.raw(yield* mediaResponse(request, key))
        }),
      ),
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
  reviewRoutes,
  sampleRoutes,
  timingRoutes,
  transcriptRoutes,
  publicRoutes,
  HttpRouter.addAll([notFound]),
  HttpRouter.cors({
    allowedHeaders: ["authorization", "content-type", "range"],
    exposedHeaders: ["content-length", "content-range", "accept-ranges", "etag"],
    maxAge: 86400,
  }),
)
