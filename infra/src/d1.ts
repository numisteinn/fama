// Remote D1 calls for `fama setup`, through the Cloudflare credentials Alchemy resolved.
import * as d1 from "@distilled.cloud/cloudflare/d1"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import { createUserSql, type NewUser } from "../../apps/api/scripts/create-user.ts"

export interface Database {
  readonly accountId: string
  readonly databaseId: string
}

class InvalidUserCount extends Data.TaggedError("InvalidUserCount")<{ readonly message: string }> {}

export const countUsers = (db: Database) =>
  d1.queryDatabase({ ...db, sql: "SELECT COUNT(*) AS n FROM users" }).pipe(
    Effect.map((response) => {
      const row = response.result[0]?.results?.[0] as { n?: unknown } | undefined
      return Number(row?.n ?? Number.NaN)
    }),
    Effect.filterOrFail(
      (count) => Number.isInteger(count) && count >= 0,
      () => new InvalidUserCount({ message: "D1 did not return a user count." }),
    ),
  )

export const createUser = (db: Database, user: NewUser) =>
  Effect.promise(() => createUserSql(user)).pipe(
    Effect.flatMap((sql) => d1.queryDatabase({ ...db, sql })),
    Effect.asVoid,
  )
