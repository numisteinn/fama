import { ChangeVoice, Document, EpisodeId } from "@fama/contracts"
import { Effect, Schema } from "effect"
import { HttpClientRequest } from "effect/http"
import { Command } from "foldkit"
import { Connection, episodePath, send, sendJson } from "~/api"
import { Message } from "~/message"
import { NarrateAgainMessage } from "~/review/narrateAgainMessage"

const toParent = (message: NarrateAgainMessage) => Message.GotNarrateAgainMessage({ message })
const encodeDocument = Schema.encodeSync(Document)
const encodeVoice = Schema.encodeSync(ChangeVoice)

export const FetchNarrateAgainDocument = Command.define("FetchNarrateAgainDocument", {
  args: { connection: Connection, episodeId: EpisodeId, request: Schema.Number },
  messages: [Message.GotNarrateAgainMessage],
  execute: ({ connection, episodeId, request }) =>
    sendJson(Document, connection, "GET", `${episodePath(episodeId)}/document`).pipe(
      Effect.map((document) => toParent(NarrateAgainMessage.SucceededFetchDocument({ episodeId, request, document }))),
      Effect.catch((failure) =>
        Effect.succeed(toParent(NarrateAgainMessage.FailedFetchDocument({ episodeId, request, failure }))),
      ),
    ),
})

export const NarrateAgainWithDocument = Command.define("NarrateAgainWithDocument", {
  args: { connection: Connection, episodeId: EpisodeId, document: Document },
  messages: [Message.GotNarrateAgainMessage],
  execute: ({ connection, episodeId, document }) =>
    send(connection, "PUT", `${episodePath(episodeId)}/document`, (request) =>
      HttpClientRequest.bodyJsonUnsafe(request, encodeDocument(document)),
    ).pipe(
      Effect.as(toParent(NarrateAgainMessage.SucceededQueueNarration({ episodeId }))),
      Effect.catch((failure) =>
        Effect.succeed(toParent(NarrateAgainMessage.FailedQueueNarration({ episodeId, failure }))),
      ),
    ),
})

export const ChangeNarrateAgainVoice = Command.define("ChangeNarrateAgainVoice", {
  args: { connection: Connection, episodeId: EpisodeId, input: ChangeVoice },
  messages: [Message.GotNarrateAgainMessage],
  execute: ({ connection, episodeId, input }) =>
    send(connection, "PUT", `${episodePath(episodeId)}/voice`, (request) =>
      HttpClientRequest.bodyJsonUnsafe(request, encodeVoice(input)),
    ).pipe(
      Effect.as(toParent(NarrateAgainMessage.SucceededQueueNarration({ episodeId }))),
      Effect.catch((failure) =>
        Effect.succeed(toParent(NarrateAgainMessage.FailedQueueNarration({ episodeId, failure }))),
      ),
    ),
})
