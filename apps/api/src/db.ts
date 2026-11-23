import { Effect, Schema } from "effect"

export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Runs one D1 call and names its failure. */
export const query = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new DatabaseError({ operation, cause }) })
