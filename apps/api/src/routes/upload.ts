import { EpisodeId, linkedUploadMediaType, type Source, SourceQuery, VoiceRef } from "@fama/contracts"
import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { EpisodeRepo } from "../episode-repo.ts"
import { keys, MediaStore } from "../media-store.ts"
import { Wake } from "../wake.ts"
import { api, BadRequest, json, MAX_UPLOAD_BYTES, TooLarge, webRequest, worker } from "./kit.ts"

const SourceParams = Schema.Struct({ ...SourceQuery.fields, id: EpisodeId })
const safeFileName = (name: string) => name.replace(/[/\\]/g, "_").replace(/^\.+/, "") || "upload"

const firstWords = (text: string, count: number) => {
  const words = text.trim().split(/\s+/)
  return words.slice(0, count).join(" ") + (words.length > count ? "…" : "")
}

/** The provisional title a new episode shows until the worker reports the real one. */
export const provisionalTitle = (source: Source) => {
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

export const uploadRoutes = HttpRouter.addAll([
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
        const contentType = file.type || "application/octet-stream"
        const urlField = form.get("url")
        const url = typeof urlField === "string" ? URL.parse(urlField) : null
        if (urlField !== null && (url === null || !["http:", "https:"].includes(url.protocol))) {
          return yield* new BadRequest({ message: "Invalid URL" })
        }
        if (url !== null && linkedUploadMediaType(contentType) === undefined) {
          return yield* new BadRequest({ message: "Linked files must be HTML, PDF or EPUB" })
        }
        const fileName = safeFileName(file.name)
        const source: Source = url === null
          ? { _tag: "File", fileName, contentType }
          : { _tag: "Url", url: url.href }
        const key = source._tag === "File" ? keys.upload(userId, id, fileName) : keys.linkedUpload(userId, id)
        yield* (yield* MediaStore).put(key, file, contentType)
        const repo = yield* EpisodeRepo
        const episode = yield* repo.create(userId, {
          id,
          source,
          title: provisionalTitle(source),
          voice,
          speed,
          review: reviewField === "true",
        })
        if (source._tag === "Url") yield* Effect.logInfo(`Stored upload with url for episode ${id}`)
        yield* (yield* Wake).wake
        return json(episode, 201)
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
        if (source._tag === "Text") return yield* new BadRequest({ message: "Source is not a file" })
        const key = source._tag === "File"
          ? keys.upload(userId, params.id, source.fileName)
          : keys.linkedUpload(userId, params.id)
        const object = yield* (yield* MediaStore).get(key, null)
        if (object === null) return yield* new BadRequest({ message: "Uploaded file is missing" })
        return HttpServerResponse.raw(
          new Response(object.body, {
            headers: {
              "content-type": source._tag === "File"
                ? source.contentType
                : object.httpMetadata?.contentType ?? "application/octet-stream",
              "content-length": String(object.size),
            },
          }),
        )
      }),
    ),
  ),
])
