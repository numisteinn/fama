import { EpisodeId, Timing, UploadQuery } from "@fama/contracts"
import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { Bindings } from "../bindings.ts"
import { EpisodeRepo } from "../episode-repo.ts"
import { keys, MediaStore } from "../media-store.ts"

const TimingParams = Schema.Struct({
  ...UploadQuery.fields,
  id: EpisodeId,
  index: Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
})

/** The guard of a worker route in `http.ts`: it checks the worker token and turns errors into responses. */
type WorkerRoute = <E, R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, R | Bindings | HttpServerRequest.HttpServerRequest>

export const timingRoutes = (worker: WorkerRoute) =>
  HttpRouter.addAll([
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
          return HttpServerResponse.empty({ status: 204 })
        }),
      ),
    ),
  ])
