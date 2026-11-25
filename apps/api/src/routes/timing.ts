import { InputHash, Timing, UploadQuery } from "@fama/contracts"
import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/http"
import { EpisodeRepo } from "../episode-repo.ts"
import { keys, MediaStore } from "../media-store.ts"
import { ChapterPath, chapterRevision } from "./chapter.ts"
import { noContent, worker } from "./kit.ts"

const TimingParams = Schema.Struct({
  ...UploadQuery.fields,
  ...ChapterPath,
  inputHash: InputHash,
})

export const timingRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "PUT",
    "/api/worker/jobs/:id/chapters/:index/timing",
    worker(
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaParams(TimingParams)
        const repo = yield* EpisodeRepo
        const { userId, leaseHash } = yield* repo.holdLease(params.id, params.leaseToken)
        const timing = yield* HttpServerRequest.schemaBodyJson(Timing)
        const file = new Blob([JSON.stringify(timing)])
        const revision = chapterRevision(leaseHash, params.inputHash)
        yield* (yield* MediaStore).putTiming(keys.timing(userId, params.id, params.index, revision), file)
        return noContent
      }),
    ),
  ),
])
