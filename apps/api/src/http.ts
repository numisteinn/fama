import {
  ChapterUploadQuery,
  ClaimRequest,
  CompleteRequest,
  CreateEpisode,
  EpisodeId,
  FailRequest,
  ProgressRequest,
  type Source,
  UploadQuery,
  VoiceRef,
} from "@fama/contracts"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Bindings } from "./bindings.ts"
import cover from "./cover.jpg"
import { EpisodeRepo } from "./episode-repo.ts"
import { renderFeed } from "./feed.ts"
import { keys, MediaStore } from "./media-store.ts"
import { mediaResponse } from "./media.ts"

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}
class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", { message: Schema.String }) {}
class TooLarge extends Schema.TaggedError<TooLarge>()("TooLarge", {}) {}

const statusOf: Record<string, number> = {
  Unauthorized: 401,
  BadRequest: 400,
  SchemaError: 400,
  HttpServerError: 400,
  EpisodeNotFound: 404,
  TooLarge: 413,
  LeaseLost: 409,
  NotRetryable: 409,
}

const errorResponse = (error: unknown) =>
  Effect.gen(function* () {
    const tag =
      typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "Unknown"
    const status = statusOf[tag] ?? 500
    if (status === 500) yield* Effect.logError("request failed", error)
    const message = status === 500 ? "Internal error" : error instanceof Error && error.message !== "" ? error.message : tag
    return HttpServerResponse.jsonUnsafe({ error: tag, message }, { status })
  })

const sha256 = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))

const sameSecret = (given: string, expected: string) =>
  Effect.promise(async () => crypto.subtle.timingSafeEqual(await sha256(given), await sha256(expected)))

const webRequest = Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
  HttpServerRequest.toWeb(request),
)

const requireApiToken = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const { FAMA_API_TOKEN } = yield* Bindings
  const header = request.headers.authorization ?? ""
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : ""
  if (!(yield* sameSecret(token, FAMA_API_TOKEN))) return yield* new Unauthorized()
})

const requireFeedToken = Effect.gen(function* () {
  const { token } = yield* HttpRouter.schemaPathParams(Schema.Struct({ token: Schema.String }))
  const { FAMA_FEED_TOKEN } = yield* Bindings
  if (!(yield* sameSecret(token, FAMA_FEED_TOKEN))) return yield* new Unauthorized()
})

const handle = <E, R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.catch(effect, errorResponse)

const api = <E, R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  handle(Effect.andThen(requireApiToken, effect))

const noContent = HttpServerResponse.empty({ status: 204 })
const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status })

const IdParams = Schema.Struct({ id: EpisodeId })
const ChapterParams = Schema.Struct({
  ...ChapterUploadQuery.fields,
  id: EpisodeId,
  index: Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
})
const BlobParams = Schema.Struct({ ...UploadQuery.fields, id: EpisodeId })

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

const safeFileName = (name: string) => name.replace(/[/\\]/g, "_").replace(/^\.+/, "") || "upload"

/** Reads a raw upload body into R2. Needs `Content-Length`, because R2 stores only bodies of known length. */
const putBody = Effect.fn("http.putBody")(function* (key: string, fallbackType: string) {
  const request = yield* webRequest
  const length = Number(request.headers.get("content-length") ?? Number.NaN)
  if (!Number.isFinite(length)) return yield* new BadRequest({ message: "Content-Length required" })
  if (length > MAX_UPLOAD_BYTES) return yield* new TooLarge()
  if (request.body === null) return yield* new BadRequest({ message: "Body required" })
  const store = yield* MediaStore
  return yield* store.put(key, request.body, request.headers.get("content-type") ?? fallbackType)
})

const clientRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "POST",
    "/api/episodes",
    api(
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(CreateEpisode)
        const repo = yield* EpisodeRepo
        const episode = yield* repo.create({
          id: EpisodeId.make(crypto.randomUUID()),
          source: body.source,
          title: provisionalTitle(body.source),
          voice: body.voice,
          speed: body.speed,
        })
        return json(episode, 201)
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/episodes/upload",
    api(
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
        const id = EpisodeId.make(crypto.randomUUID())
        const fileName = safeFileName(file.name)
        const contentType = file.type || "application/octet-stream"
        const store = yield* MediaStore
        yield* store.put(keys.upload(id, fileName), file, contentType)
        const repo = yield* EpisodeRepo
        const source: Source = { _tag: "File", fileName, contentType }
        const episode = yield* repo.create({ id, source, title: provisionalTitle(source), voice, speed })
        return json(episode, 201)
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/episodes",
    api(Effect.gen(function* () {
      return json({ episodes: yield* (yield* EpisodeRepo).list })
    })),
  ),
  HttpRouter.route(
    "GET",
    "/api/episodes/:id",
    api(
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParams)
        return json(yield* (yield* EpisodeRepo).get(id))
      }),
    ),
  ),
  HttpRouter.route(
    "DELETE",
    "/api/episodes/:id",
    api(
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParams)
        yield* (yield* MediaStore).deleteEpisode(id)
        yield* (yield* EpisodeRepo).remove(id)
        return noContent
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/episodes/:id/retry",
    api(
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParams)
        return json(yield* (yield* EpisodeRepo).retry(id))
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/voices",
    api(Effect.gen(function* () {
      return json({ voices: yield* (yield* EpisodeRepo).voices })
    })),
  ),
  HttpRouter.route(
    "GET",
    "/api/feed",
    api(
      Effect.gen(function* () {
        const request = yield* webRequest
        const { FAMA_FEED_TOKEN } = yield* Bindings
        return json({ url: `${new URL(request.url).origin}/feed/${FAMA_FEED_TOKEN}/rss.xml` })
      }),
    ),
  ),
])

const workerRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "POST",
    "/api/worker/claim",
    api(
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(ClaimRequest)
        const job = yield* (yield* EpisodeRepo).claim(body.workerId, body.voices)
        return job === null ? noContent : json({ job })
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/worker/jobs/:id/source",
    api(
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParams)
        const source = yield* (yield* EpisodeRepo).source(id)
        if (source._tag !== "File") return yield* new BadRequest({ message: "Source is not a file" })
        const object = yield* (yield* MediaStore).get(keys.upload(id, source.fileName), null)
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
    api(
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
    "/api/worker/jobs/:id/chapters/:index",
    api(
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaParams(ChapterParams)
        const repo = yield* EpisodeRepo
        yield* repo.holdLease(params.id, params.workerId)
        const { size } = yield* putBody(keys.chapter(params.id, params.index), "audio/mp4")
        yield* repo.putChapter(params.id, { ...params, size })
        return noContent
      }),
    ),
  ),
  HttpRouter.route(
    "PUT",
    "/api/worker/jobs/:id/book",
    api(
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaParams(BlobParams)
        const repo = yield* EpisodeRepo
        yield* repo.holdLease(params.id, params.workerId)
        const { size } = yield* putBody(keys.book(params.id), "audio/mp4")
        yield* repo.setBook(params.id, size)
        return noContent
      }),
    ),
  ),
  HttpRouter.route(
    "PUT",
    "/api/worker/jobs/:id/cover",
    api(
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaParams(BlobParams)
        const request = yield* webRequest
        const contentType = request.headers.get("content-type") ?? ""
        const ext = { "image/jpeg": "jpg", "image/png": "png" }[contentType]
        if (ext === undefined) return yield* new BadRequest({ message: "Cover must be image/jpeg or image/png" })
        const repo = yield* EpisodeRepo
        yield* repo.holdLease(params.id, params.workerId)
        yield* putBody(keys.cover(params.id, ext), contentType)
        yield* repo.setCover(params.id, keys.cover(params.id, ext))
        return noContent
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/worker/jobs/:id/complete",
    api(
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParams)
        const body = yield* HttpServerRequest.schemaBodyJson(CompleteRequest)
        yield* (yield* EpisodeRepo).complete(id, body.workerId, body.durationMs)
        return noContent
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/worker/jobs/:id/fail",
    api(
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParams)
        const body = yield* HttpServerRequest.schemaBodyJson(FailRequest)
        yield* (yield* EpisodeRepo).fail(id, body.workerId, body.reason)
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
        yield* requireFeedToken
        const origin = new URL((yield* webRequest).url).origin
        const { FAMA_FEED_TOKEN } = yield* Bindings
        const items = yield* (yield* EpisodeRepo).feedItems(origin)
        const xml = renderFeed({
          title: "Fama",
          author: "Fama",
          link: origin,
          imageUrl: `${origin}/feed/${FAMA_FEED_TOKEN}/cover.jpg`,
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
        requireFeedToken,
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
          yield* requireFeedToken
          const request = yield* webRequest
          const prefix = `/media/${(yield* Bindings).FAMA_FEED_TOKEN}/`
          const key = decodeURIComponent(new URL(request.url).pathname.slice(prefix.length))
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
  publicRoutes,
  HttpRouter.addAll([notFound]),
  HttpRouter.cors({
    allowedHeaders: ["authorization", "content-type", "range"],
    exposedHeaders: ["content-length", "content-range", "accept-ranges", "etag"],
    maxAge: 86400,
  }),
)
