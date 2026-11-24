// The stored result of extraction: the Document, and the cover next to it. The worker writes both once and reads
// them back on every later attempt, so it never extracts a source twice.
import { Document, EpisodeId, SourceQuery } from "@fama/contracts"
import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { EpisodeRepo } from "../episode-repo.ts"
import { keys, MediaStore } from "../media-store.ts"
import { api, BlobParams, IdParams, NotStored, noContent, worker } from "./kit.ts"

const ReadParams = Schema.Struct({ ...SourceQuery.fields, id: EpisodeId })

/** Serves one stored object, or `404` when the key holds nothing. */
const stored = Effect.fn("document.stored")(function* (key: string | null, what: string) {
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

export const documentRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/episodes/:id/document",
    api(({ userId }) =>
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParams)
        // Ownership first: another user's id is 404 and reads no object.
        yield* (yield* EpisodeRepo).get(userId, id)
        return yield* stored(keys.document(userId, id), "Document")
      }),
    ),
  ),
  HttpRouter.route(
    "PUT",
    "/api/worker/jobs/:id/document",
    worker(
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaParams(BlobParams)
        const repo = yield* EpisodeRepo
        const { userId } = yield* repo.holdLease(params.id, params.leaseToken)
        const document = yield* HttpServerRequest.schemaBodyJson(Document)
        const { size } = yield* (yield* MediaStore).put(
          keys.document(userId, params.id),
          new Blob([JSON.stringify(document)]),
          "application/json",
        )
        yield* repo.setDocument(params.id, size)
        return noContent
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/worker/jobs/:id/document",
    worker(
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaParams(ReadParams)
        const { userId } = yield* (yield* EpisodeRepo).holdLease(params.id, params.leaseToken)
        return yield* stored(keys.document(userId, params.id), "Document")
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
