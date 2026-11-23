// The auth boundaries. Each turns one kind of credential into what a handler may act as. Handlers get the user from
// here and never read a token or an env secret themselves.
import type { UserId } from "@fama/contracts"
import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/http"
import { AccountRepo } from "./account-repo.ts"
import { Bindings } from "./bindings.ts"
import { sha256Hex } from "./secrets.ts"

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}

export interface User {
  readonly userId: UserId
}

const bearer = Effect.map(HttpServerRequest.HttpServerRequest, (request) => {
  const header = request.headers.authorization ?? ""
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : ""
})

/** `Authorization: Bearer <client token>` to its user. Guards the client routes under `/api/*`. */
export const clientUser = Effect.gen(function* () {
  const userId = yield* (yield* AccountRepo).userForClientToken(yield* bearer)
  if (userId === null) return yield* new Unauthorized()
  return { userId } satisfies User
})

/** The feed token in `/feed/<token>/...` and `/media/<token>/...` to its user. It opens nothing under `/api/*`. */
export const feedUser = Effect.gen(function* () {
  const { token } = yield* HttpRouter.schemaPathParams(Schema.Struct({ token: Schema.String }))
  const userId = yield* (yield* AccountRepo).userForFeedToken(token)
  if (userId === null) return yield* new Unauthorized()
  return { userId, feedToken: token }
})

/** Compares the SHA-256 of both values in constant time, so the time taken says nothing about the secret. */
const sameSecret = async (given: string, expected: string) => {
  const [a, b] = await Promise.all([sha256Hex(given), sha256Hex(expected)])
  let diff = 0
  for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return diff === 0
}

/** `Authorization: Bearer <FAMA_WORKER_TOKEN>`. Guards `/api/worker/*`. An unset secret lets no worker in. */
export const requireWorker = Effect.gen(function* () {
  const expected = (yield* Bindings).FAMA_WORKER_TOKEN ?? ""
  const given = yield* bearer
  const same = yield* Effect.promise(() => sameSecret(given, expected))
  if (expected === "" || !same) return yield* new Unauthorized()
})
