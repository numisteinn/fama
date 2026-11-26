import { Document, Episode, EpisodeId, StartReview, VoiceRef } from "@fama/contracts"
import { Effect, Schema } from "effect"
import { HttpClientRequest } from "effect/http"
import { Command } from "foldkit"
import { Connection, episodePath, send, sendJson } from "~/api"
import { Message } from "~/message"
import { ReviewMessage } from "~/review/message"

const toParent = (message: ReviewMessage) => Message.GotReviewMessage({ message })
const encodeDocument = Schema.encodeSync(Document)
const encodeStartReview = Schema.encodeSync(StartReview)

export const FetchDocument = Command.define("FetchDocument", {
  args: { connection: Connection, episodeId: EpisodeId, request: Schema.Number },
  messages: [Message.GotReviewMessage],
  execute: ({ connection, episodeId, request }) =>
    sendJson(Document, connection, "GET", `${episodePath(episodeId)}/document`).pipe(
      Effect.map((document) => toParent(ReviewMessage.SucceededFetchDocument({ episodeId, request, document }))),
      Effect.catch((failure) => Effect.succeed(toParent(ReviewMessage.FailedFetchDocument({ episodeId, request, failure })))),
    ),
})

export const SaveDocument = Command.define("SaveDocument", {
  args: { connection: Connection, episodeId: EpisodeId, document: Document },
  messages: [Message.GotReviewMessage],
  execute: ({ connection, episodeId, document }) =>
    send(connection, "PUT", `${episodePath(episodeId)}/document`, (request) =>
      HttpClientRequest.bodyJsonUnsafe(request, encodeDocument(document)),
    ).pipe(
      Effect.as(toParent(ReviewMessage.SucceededSaveDocument({ episodeId, document }))),
      Effect.catch((failure) => Effect.succeed(toParent(ReviewMessage.FailedSaveDocument({ episodeId, failure })))),
    ),
})

export const StartReviewNarration = Command.define("StartReviewNarration", {
  args: { connection: Connection, episodeId: EpisodeId, document: Document, voice: Schema.optionalKey(VoiceRef) },
  messages: [Message.GotReviewMessage],
  execute: ({ connection, episodeId, document, voice }) =>
    sendJson(Episode, connection, "POST", `${episodePath(episodeId)}/start`, (request) =>
      HttpClientRequest.bodyJsonUnsafe(
        request,
        encodeStartReview({ document, ...(voice !== undefined ? { voice } : {}) }),
      ),
    ).pipe(
      Effect.map((episode) => toParent(ReviewMessage.SucceededStartReview({ episode }))),
      Effect.catch((failure) => Effect.succeed(toParent(ReviewMessage.FailedStartReview({ episodeId, failure })))),
    ),
})
