// Library organization: the owner renames an episode or moves it in and out of the archive with one PATCH.
import { UpdateEpisode } from "@fama/contracts"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/http"
import { EpisodeOrganize } from "../episode-organize.ts"
import { EpisodeRepo } from "../episode-repo.ts"
import { api, BadRequest, IdParams, json } from "./kit.ts"

export const organizeRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "PATCH",
    "/api/episodes/:id",
    api(({ userId }) =>
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParams)
        const patch = yield* HttpServerRequest.schemaBodyJson(UpdateEpisode)
        if (patch.title === undefined && patch.author === undefined && patch.archived === undefined) {
          return yield* new BadRequest({ message: "Give at least one of title, author or archived." })
        }
        yield* (yield* EpisodeOrganize).update(userId, id, patch)
        return json(yield* (yield* EpisodeRepo).get(userId, id))
      }),
    ),
  ),
])
