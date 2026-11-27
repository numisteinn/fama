// What every route file builds on: the auth wrappers, the error to status mapping, and the shared params.
import { EpisodeId, UploadQuery } from "@fama/contracts"
import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { clientUser, requireWorker, type User } from "../auth.ts"
import { MediaStore } from "../media-store.ts"

export class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", { message: Schema.String }) {}
export class TooLarge extends Schema.TaggedError<TooLarge>()("TooLarge", {}) {}
/** The episode exists, but the object the route serves was never stored. */
export class NotStored extends Schema.TaggedError<NotStored>()("NotStored", { message: Schema.String }) {}

const statusOf: Record<string, number> = {
  Unauthorized: 401,
  BadRequest: 400,
  SchemaError: 400,
  HttpServerError: 400,
  EpisodeNotFound: 404,
  NotStored: 404,
  TooLarge: 413,
  LeaseLost: 409,
  NotEditable: 409,
  NotInReview: 409,
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

export const webRequest = Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
  HttpServerRequest.toWeb(request),
)

export const handle = <E, R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  effect.pipe(Effect.catch(errorResponse))

/** A client route: runs as the user of the client token. */
export const api = <E, R>(effect: (user: User) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  handle(Effect.flatMap(clientUser, effect))

/** A worker route: needs the worker token. Job routes also check the lease token. */
export const worker = <E, R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  handle(Effect.andThen(requireWorker, effect))

export const noContent = HttpServerResponse.empty({ status: 204 })
export const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status })

export const IdParams = Schema.Struct({ id: EpisodeId })
export const BlobParams = Schema.Struct({ ...UploadQuery.fields, id: EpisodeId })

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

export const uploadRequest = Effect.gen(function* () {
  const request = yield* webRequest
  const length = Number(request.headers.get("content-length") ?? Number.NaN)
  if (!Number.isFinite(length)) return yield* new BadRequest({ message: "Content-Length required" })
  if (length > MAX_UPLOAD_BYTES) return yield* new TooLarge()
  if (request.body === null) return yield* new BadRequest({ message: "Body required" })
  return { body: request.body, headers: request.headers }
})

/** Reads a raw upload body into R2. Needs `Content-Length`, because R2 stores only bodies of known length. */
export const putBody = Effect.fn("http.putBody")(function* (key: string, fallbackType: string) {
  const { body, headers } = yield* uploadRequest
  return yield* (yield* MediaStore).put(key, body, headers.get("content-type") ?? fallbackType)
})
