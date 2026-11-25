import { ChapterUploadQuery, EpisodeId, SourceQuery } from "@fama/contracts"
import { Effect, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { EpisodeRepo } from "../episode-repo.ts"
import { keys, MediaStore } from "../media-store.ts"
import { stored } from "./document.ts"
import { noContent, putBody, worker } from "./kit.ts"

export const ChapterPath = {
  id: EpisodeId,
  index: Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
}

const ReadParams = Schema.Struct({ ...SourceQuery.fields, ...ChapterPath })
const WriteParams = Schema.Struct({ ...ChapterUploadQuery.fields, ...ChapterPath })

// A new lease or a different input gets a separate pair of objects. Neither staging nor a
// late upload from an old lease can change the bytes of the published Chapter.
export const chapterRevision = (leaseHash: string, inputHash: string) => `${leaseHash}-${inputHash}`

export const chapterRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/worker/jobs/:id/chapters/:index",
    worker(Effect.gen(function* () {
      const { id, index, leaseToken } = yield* HttpRouter.schemaParams(ReadParams)
      const repo = yield* EpisodeRepo
      const { userId } = yield* repo.holdLease(id, leaseToken)
      return yield* stored(yield* repo.chapterKey(userId, id, index), "chapter audio")
    })),
  ),
  HttpRouter.route(
    "PUT",
    "/api/worker/jobs/:id/chapters/:index",
    worker(Effect.gen(function* () {
      const params = yield* HttpRouter.schemaParams(WriteParams)
      const { id, index, inputHash, leaseToken } = params
      const repo = yield* EpisodeRepo
      const { userId, leaseHash } = yield* repo.holdLease(id, leaseToken)
      const revision = chapterRevision(leaseHash, inputHash)
      const { size } = yield* putBody(keys.chapter(userId, id, index, revision), "audio/mp4")
      const timing = yield* (yield* MediaStore).head(keys.timing(userId, id, index, revision))
      yield* repo.putChapter(id, leaseHash, { ...params, revision, size, timed: timing !== null })
      return noContent
    })),
  ),
])
