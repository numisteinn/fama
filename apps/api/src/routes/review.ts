// Review: the stop between extraction and narration. While the job waits, its owner changes the stored Document.
// `start` stores the Document to narrate and queues the job.
import { Document, StartReview } from "@fama/contracts"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/http"
import { EpisodeRepo } from "../episode-repo.ts"
import { Wake } from "../wake.ts"
import { stageDocument } from "./document.ts"
import { api, IdParams, json, noContent } from "./kit.ts"

export const reviewRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "PUT",
    "/api/episodes/:id/document",
    api(({ userId }) =>
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParams)
        const repo = yield* EpisodeRepo
        // Owner and state first: another user's id is 404, and outside Review nothing is written.
        yield* repo.inReview(userId, id)
        const document = yield* HttpServerRequest.schemaBodyJson(Document)
        yield* repo.editDocument(userId, id, yield* stageDocument(userId, id, document))
        return noContent
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/episodes/:id/start",
    api(({ userId }) =>
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParams)
        const repo = yield* EpisodeRepo
        yield* repo.inReview(userId, id)
        const { document } = yield* HttpServerRequest.schemaBodyJson(StartReview)
        yield* repo.start(userId, id, yield* stageDocument(userId, id, document))
        const episode = yield* repo.get(userId, id)
        yield* (yield* Wake).wake
        return json(episode)
      }),
    ),
  ),
])
