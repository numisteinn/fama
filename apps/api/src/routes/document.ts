// The stored result of extraction: the Document, and the cover next to it. The worker writes both once and reads
// them back on every later attempt, so it never extracts a source twice.
import { Document, type DocumentStored, EpisodeId, SourceQuery, type UserId, VoiceRef } from "@fama/contracts"
import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { EpisodeRepo } from "../episode-repo.ts"
import { keys, MediaStore } from "../media-store.ts"
import { sha256Hex } from "../secrets.ts"
import { api, BlobParams, IdParams, json, NotStored, worker } from "./kit.ts"

const WriteParams = Schema.Struct({ ...BlobParams.fields, voice: Schema.optionalKey(VoiceRef) })
const ReadParams = Schema.Struct({ ...SourceQuery.fields, id: EpisodeId })

/** Serves one stored object, or `404` when the key holds nothing. */
export const stored = Effect.fn("document.stored")(function* (key: string | null, what: string) {
  const object = key === null ? null : yield* (yield* MediaStore).get(key, null)
  if (object === null) return yield* new NotStored({ message: `This episode has no ${what}.` })
  return HttpServerResponse.raw(
    new Response(object.body, {
      headers: {
        "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
        "content-length": String(object.size),
      },
    }),
  )
})

/** Stage immutable bytes before the database selects them. A losing writer cannot overwrite the selected Document. */
export const stageDocument = Effect.fn("document.stage")(function* (userId: UserId, id: EpisodeId, document: Document) {
  const body = JSON.stringify(document)
  const key = keys.documentRevision(userId, id, yield* Effect.promise(() => sha256Hex(body)))
  const { size } = yield* (yield* MediaStore).put(key, new Blob([body]), "application/json")
  return { key, size }
})

export const documentRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/episodes/:id/document",
    api(({ userId }) =>
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParams)
        // Ownership first: another user's id is 404 and reads no object.
        const key = yield* (yield* EpisodeRepo).documentKey(userId, id)
        return yield* stored(key, "Document")
      }),
    ),
  ),
  HttpRouter.route(
    "PUT",
    "/api/worker/jobs/:id/document",
    worker(
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaParams(WriteParams)
        const repo = yield* EpisodeRepo
        const { userId } = yield* repo.holdLease(params.id, params.leaseToken)
        const document = yield* HttpServerRequest.schemaBodyJson(Document)
        const revision = yield* stageDocument(userId, params.id, document)
        const job = yield* repo.storeDocument(params.id, params.leaseToken, revision, {
          title: document.title, author: document.author, language: document.language, voice: params.voice ?? null,
        })
        const result: DocumentStored = { next: job._tag === "Review" ? "Review" : "Narrate" }
        return json(result)
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/worker/jobs/:id/document",
    worker(
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaParams(ReadParams)
        const { documentKey } = yield* (yield* EpisodeRepo).holdLease(params.id, params.leaseToken)
        return yield* stored(documentKey, "Document")
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/worker/jobs/:id/cover",
    worker(
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaParams(ReadParams)
        const { coverKey } = yield* (yield* EpisodeRepo).holdLease(params.id, params.leaseToken)
        return yield* stored(coverKey, "cover")
      }),
    ),
  ),
])
