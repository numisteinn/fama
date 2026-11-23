import { UserId } from "@fama/contracts"
import { Context, Effect, Layer, Schema } from "effect"
import { Bindings } from "./bindings.ts"
import { type DatabaseError, query } from "./db.ts"
import { randomToken, sha256Hex } from "./secrets.ts"

export interface Interface {
  /** The owner of a client token, or `null` for an unknown token. */
  readonly userForClientToken: (token: string) => Effect.Effect<UserId | null, DatabaseError>
  /** The owner of a feed token, or `null` for an unknown token. */
  readonly userForFeedToken: (token: string) => Effect.Effect<UserId | null, DatabaseError>
  readonly feedToken: (userId: UserId) => Effect.Effect<string, DatabaseError>
  /** Replaces the feed token, so the old feed and media URLs stop working. Returns the new token. */
  readonly rotateFeedToken: (userId: UserId) => Effect.Effect<string, DatabaseError>
}

export class AccountRepo extends Context.Service<AccountRepo, Interface>()("@fama/api/AccountRepo") {}

const UserRow = Schema.Struct({ user_id: UserId })
const decodeUser = (rows: ReadonlyArray<unknown>) =>
  rows.length === 0 ? null : Schema.decodeUnknownSync(UserRow)(rows[0]).user_id

export const layer = Layer.effect(
  AccountRepo,
  Effect.gen(function* () {
    const { DB: db } = yield* Bindings

    const userForClientToken = Effect.fn("AccountRepo.userForClientToken")(function* (token: string) {
      if (token === "") return null
      const hash = yield* Effect.promise(() => sha256Hex(token))
      const result = yield* query("tokens.find", () =>
        db.prepare("SELECT user_id FROM tokens WHERE hash = ?").bind(hash).all(),
      )
      return decodeUser(result.results)
    })

    const userForFeedToken = Effect.fn("AccountRepo.userForFeedToken")(function* (token: string) {
      if (token === "") return null
      const result = yield* query("users.byFeedToken", () =>
        db.prepare("SELECT id AS user_id FROM users WHERE feed_token = ?").bind(token).all(),
      )
      return decodeUser(result.results)
    })

    const feedToken = Effect.fn("AccountRepo.feedToken")(function* (userId: UserId) {
      const row = yield* query("users.feedToken", () =>
        db.prepare("SELECT feed_token FROM users WHERE id = ?").bind(userId).first<{ feed_token: string }>(),
      )
      if (row === null) return yield* Effect.die(new Error(`user ${userId} is gone`))
      return row.feed_token
    })

    const rotateFeedToken = Effect.fn("AccountRepo.rotateFeedToken")(function* (userId: UserId) {
      const token = randomToken()
      yield* query("users.rotateFeedToken", () =>
        db.prepare("UPDATE users SET feed_token = ? WHERE id = ?").bind(token, userId).run(),
      )
      return token
    })

    return AccountRepo.of({ userForClientToken, userForFeedToken, feedToken, rotateFeedToken })
  }),
)
