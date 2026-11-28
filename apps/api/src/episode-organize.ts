// Library organization: the owner renames an episode or moves it in and out of the archive. One direct row
// write, outside the job state machine: no lease, no worker wake, and the feed reads `archived_at` for itself.
import { type UpdateEpisode, type UserId } from "@fama/contracts"
import { Context, Effect, Layer } from "effect"
import { Bindings } from "./bindings.ts"
import { type DatabaseError, query } from "./db.ts"
import { EpisodeNotFound } from "./episode-repo.ts"

export interface Interface {
  /**
   * Writes the fields the owner gave. Only the owner's row can change, so another user's episode is not found.
   * The caller checks that at least one field is present.
   */
  readonly update: (userId: UserId, id: string, patch: UpdateEpisode) => Effect.Effect<void, EpisodeNotFound | DatabaseError>
}

export class EpisodeOrganize extends Context.Service<EpisodeOrganize, Interface>()("@fama/api/EpisodeOrganize") {}

export const layer = Layer.effect(
  EpisodeOrganize,
  Effect.gen(function* () {
    const { DB: db } = yield* Bindings
    const now = Effect.clockWith((clock) => clock.currentTimeMillis)

    const update = Effect.fn("EpisodeOrganize.update")(function* (userId: UserId, id: string, patch: UpdateEpisode) {
      const sets: Array<string> = []
      const binds: Array<unknown> = []
      if (patch.title !== undefined) {
        sets.push("title = ?", "title_locked = 1")
        binds.push(patch.title)
      }
      if (patch.author !== undefined) {
        sets.push("author = ?", "author_locked = 1")
        binds.push(patch.author)
      }
      if (patch.archived === true) {
        // Repeated archiving while already archived keeps the existing stamp.
        sets.push("archived_at = COALESCE(archived_at, ?)")
        binds.push(new Date(yield* now).toISOString())
      } else if (patch.archived === false) {
        sets.push("archived_at = NULL")
      }
      const written = yield* query("episode.organize", () =>
        db
          .prepare(`UPDATE episodes SET ${sets.join(", ")} WHERE id = ? AND user_id = ? RETURNING id`)
          .bind(...binds, id, userId)
          .all(),
      )
      if (written.results.length !== 1) return yield* new EpisodeNotFound({ id })
    })

    return EpisodeOrganize.of({ update })
  }),
)
