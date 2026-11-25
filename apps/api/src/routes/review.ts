// Review: the stop between extraction and narration. While the job waits, its owner changes the stored Document.
// `start` stores the Document to narrate and queues the job.
import { ChangeVoice, Document, StartReview, type UserId } from "@fama/contracts"
import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/http"
import { EpisodeRepo } from "../episode-repo.ts"
import { MediaStore } from "../media-store.ts"
import { Wake } from "../wake.ts"
import { stageDocument } from "./document.ts"
import { api, BadRequest, IdParams, json, noContent, NotStored } from "./kit.ts"

const decodeDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(Document))

const checkTextEdit = Effect.fn("review.checkTextEdit")(function* (key: string | null, document: Document) {
  const object = key === null ? null : yield* (yield* MediaStore).get(key, null)
  if (object === null) return yield* new NotStored({ message: "This episode has no Document." })
  const previous = yield* Effect.orDie(decodeDocument(yield* Effect.promise(() => object.text())))
  if (document.title !== previous.title || document.author !== previous.author || document.language !== previous.language ||
      document.chapters.length !== previous.chapters.length ||
      document.chapters.some((chapter, index) => chapter.title !== previous.chapters[index]?.title)) {
    return yield* new BadRequest({ message: "Only chapter text can change after narration starts." })
  }
})

const wakeNarration = Effect.fn("review.wakeNarration")(function* (userId: UserId, id: string, finishedAt: string | null) {
  if (finishedAt !== null) {
    yield* (yield* MediaStore).deleteTranscript(userId, id, finishedAt).pipe(
      Effect.catchTag("StorageError", (error) => Effect.logWarning("Could not delete the previous transcript", error)),
    )
  }
  yield* (yield* Wake).wake
})

export const reviewRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "PUT",
    "/api/episodes/:id/document",
    api(({ userId }) =>
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParams)
        const repo = yield* EpisodeRepo
        const edit = yield* repo.documentForEdit(userId, id)
        const document = yield* HttpServerRequest.schemaBodyJson(Document)
        if (!edit.review) yield* checkTextEdit(edit.key, document)
        const result = yield* repo.editDocument(userId, id, yield* stageDocument(userId, id, document), edit.version)
        if (result.queued) yield* wakeNarration(userId, id, result.finishedAt)
        return noContent
      }),
    ),
  ),
  HttpRouter.route(
    "PUT",
    "/api/episodes/:id/voice",
    api(({ userId }) =>
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParams)
        const { voice, speed } = yield* HttpServerRequest.schemaBodyJson(ChangeVoice)
        const { finishedAt } = yield* (yield* EpisodeRepo).changeVoice(userId, id, voice, speed)
        yield* wakeNarration(userId, id, finishedAt)
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
