import { VoiceList, VoiceRef } from "@fama/contracts"
import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { keys, MediaStore } from "../media-store.ts"
import { mediaResponse } from "../media.ts"
import { VoicePreviewRepo } from "../voice-preview-repo.ts"
import { api, BadRequest, handle, json, noContent, NotStored, uploadRequest, webRequest, worker } from "./kit.ts"

const Params = Schema.Struct({ id: Schema.String })
const PreviewVoice = VoiceRef.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/)))
const readVoiceId = HttpRouter.schemaPathParams(Params).pipe(
  Effect.flatMap(({ id }) => Schema.decodeUnknownEffect(PreviewVoice)(id)),
  Effect.mapError(() => new NotStored({ message: "Unknown Voice." })),
)

const media = Effect.gen(function* () {
  const id = yield* readVoiceId
  const request = yield* webRequest
  const response = yield* mediaResponse(request, keys.voicePreview(id))
  if (response.ok) {
    const versioned = new URL(request.url).searchParams.has("v")
    response.headers.set("cache-control", versioned ? "public, max-age=31536000, immutable" : "public, max-age=300")
  }
  return HttpServerResponse.raw(response)
})

export const voicePreviewRoutes = HttpRouter.addAll([
  HttpRouter.route("GET", "/api/voices", api(() => Effect.gen(function* () {
    return json({ voices: yield* (yield* VoicePreviewRepo).list })
  }))),
  HttpRouter.route("POST", "/api/worker/voices", worker(Effect.gen(function* () {
    const { voices } = yield* HttpServerRequest.schemaBodyJson(VoiceList)
    yield* (yield* VoicePreviewRepo).register(voices)
    return noContent
  }))),
  HttpRouter.route("GET", "/api/worker/voices/missing-previews", worker(Effect.gen(function* () {
    return json(yield* (yield* VoicePreviewRepo).missing)
  }))),
  HttpRouter.route("PUT", "/api/worker/voices/:id/preview", worker(Effect.gen(function* () {
    const id = yield* readVoiceId
    const repo = yield* VoicePreviewRepo
    if (!(yield* repo.exists(id))) return yield* new NotStored({ message: "Unknown Voice." })
    const { body, headers } = yield* uploadRequest
    const type = headers.get("content-type")
    if (type !== "audio/mp4" && type !== "audio/x-m4a") {
      return yield* new BadRequest({ message: "Voice preview must be audio/mp4 or audio/x-m4a." })
    }
    if (Number(headers.get("content-length")) <= 0) {
      return yield* new BadRequest({ message: "Body required" })
    }
    yield* (yield* MediaStore).put(keys.voicePreview(id), body, type)
    const revision = crypto.randomUUID().replaceAll("-", "").slice(0, 16)
    const voice = yield* repo.publish(id, revision)
    if (voice === null) return yield* new NotStored({ message: "Unknown Voice." })
    return json(voice)
  }))),
  ...(["GET", "HEAD"] as const).map((method) => HttpRouter.route(method, "/voice-previews/:id", handle(media))),
])
