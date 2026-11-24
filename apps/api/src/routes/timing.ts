import { EpisodeId, Timing, UploadQuery } from "@fama/contracts"
import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/http"
import { EpisodeRepo } from "../episode-repo.ts"
import { keys, MediaStore } from "../media-store.ts"
import { noContent, worker } from "./kit.ts"

const TimingParams = Schema.Struct({
  ...UploadQuery.fields,
  id: EpisodeId,
  index: Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
})

export const timingRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "PUT",
    "/api/worker/jobs/:id/chapters/:index/timing",
    worker(
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaParams(TimingParams)
        const repo = yield* EpisodeRepo
        const { userId } = yield* repo.holdLease(params.id, params.leaseToken)
        const timing = yield* HttpServerRequest.schemaBodyJson(Timing)
        const file = new Blob([JSON.stringify(timing)])
        yield* (yield* MediaStore).put(keys.timing(userId, params.id, params.index), file, "application/json")
        yield* repo.putTiming(params.id, params.index)
        return noContent
      }),
    ),
  ),
])
