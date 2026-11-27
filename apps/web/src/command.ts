import {
  ChangeVoice,
  CreateEpisode,
  Document,
  Episode,
  EpisodeId,
  EpisodeList,
  EpisodeProgress,
  StartReview,
  VoiceList,
  VoiceRef,
} from "@fama/contracts"
import { Command, Component } from "@effect/ui"
import { HtmlCommand } from "@effect/ui/html"
import { Duration, Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ApiFailure, Connection, episodePath, send, sendJson } from "~/core/api"
import { PROGRESS_PREFIX, storedProgress } from "~/core/flags"
import { AppMessage } from "~/message"
import { FamaConnection } from "~/core/services"
import { AddTextRef, DeleteConfirmRef } from "~/ui/refs"

export const focusAddText = () => HtmlCommand.focus(AddTextRef, () => Component.noop)

export const focusDeleteConfirm = (episodeId: EpisodeId) =>
  HtmlCommand.focus(DeleteConfirmRef.at(episodeId), () => Component.noop)

// HTTP COMMANDS

export class FetchEpisodes extends Command.Service<FetchEpisodes>()("app/FetchEpisodes", {
  args: { connection: Connection, generation: Schema.Number, request: Schema.Number },
  success: AppMessage,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return ({ connection, generation, request }) =>
        sendJson(EpisodeList, connection, "GET", "/api/episodes").pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.map(({ episodes }) => AppMessage.SucceededFetchEpisodes({ generation, request, episodes })),
          Effect.catch((failure) => Effect.succeed(AppMessage.FailedFetchEpisodes({ generation, request, failure }))),
        )
    }),
  )
}

export class FetchVoices extends Command.Service<FetchVoices>()("app/FetchVoices", {
  args: { connection: Connection, generation: Schema.Number },
  success: AppMessage,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return ({ connection, generation }) =>
        sendJson(VoiceList, connection, "GET", "/api/voices").pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.map(({ voices }) => AppMessage.SucceededFetchVoices({ generation, voices })),
          Effect.catch(() => Effect.succeed(AppMessage.FailedFetchVoices())),
        )
    }),
  )
}

const encodeCreate = Schema.encodeSync(CreateEpisode)

export class CreateEpisodeFromSource extends Command.Service<CreateEpisodeFromSource>()(
  "app/CreateEpisodeFromSource",
  {
    args: { connection: Connection, input: CreateEpisode },
    success: AppMessage,
  },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return ({ connection, input }) =>
        sendJson(Episode, connection, "POST", "/api/episodes", {
          withBody: (request) => HttpClientRequest.bodyJsonUnsafe(request, encodeCreate(input)),
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.map((episode) => AppMessage.SucceededCreateEpisode({ episode })),
          Effect.catch((failure) => Effect.succeed(AppMessage.FailedCreateEpisode({ failure }))),
        )
    }),
  )
}

export class UploadEpisode extends Command.Service<UploadEpisode>()("app/UploadEpisode", {
  args: {
    connection: Connection,
    key: Schema.Number,
    file: Schema.instanceOf(File),
    voice: Schema.NullOr(VoiceRef),
    speed: Schema.Number,
    review: Schema.Boolean,
  },
  success: AppMessage,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return ({ connection, key, file, voice, speed, review }) => {
        const form = new FormData()
        form.set("file", file)
        if (voice) form.set("voice", voice)
        form.set("speed", String(speed))
        form.set("review", String(review))
        return sendJson(Episode, connection, "POST", "/api/episodes/upload", {
          withBody: (request) => HttpClientRequest.bodyFormData(request, form),
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.map((episode) => AppMessage.SucceededUploadFile({ key, episode })),
          Effect.catch((failure) => Effect.succeed(AppMessage.FailedUploadFile({ key, failure }))),
        )
      }
    }),
  )
}

export class RetryEpisode extends Command.Service<RetryEpisode>()("app/RetryEpisode", {
  args: { connection: Connection, episodeId: EpisodeId },
  success: AppMessage,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return ({ connection, episodeId }) =>
        sendJson(Episode, connection, "POST", `${episodePath(episodeId)}/retry`).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.map((episode) => AppMessage.SucceededRetryEpisode({ episode })),
          Effect.catch((failure) => Effect.succeed(AppMessage.FailedRetryEpisode({ episodeId, failure }))),
        )
    }),
  )
}

export class DeleteEpisode extends Command.Service<DeleteEpisode>()("app/DeleteEpisode", {
  args: { connection: Connection, episodeId: EpisodeId },
  success: AppMessage,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return ({ connection, episodeId }) =>
        send(connection, "DELETE", episodePath(episodeId)).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.as(AppMessage.SucceededDeleteEpisode({ episodeId })),
          Effect.catch((failure) => Effect.succeed(AppMessage.FailedDeleteEpisode({ episodeId, failure }))),
        )
    }),
  )
}

const encodeProgress = Schema.encodeSync(EpisodeProgress)

/**
 * Sends the device's progress for an episode. The server keeps the newer of it and what it has, and answers
 * with that. It is a keepalive request, so a push started on `pagehide` still arrives.
 */
export class PushProgress extends Command.Service<PushProgress>()("app/PushProgress", {
  args: { connection: Connection, episodeId: EpisodeId, progress: EpisodeProgress },
  success: AppMessage,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return ({ connection, episodeId, progress }) =>
        sendJson(
          EpisodeProgress,
          connection,
          "PUT",
          `${episodePath(episodeId)}/progress`,
          {
            withBody: (request) => HttpClientRequest.bodyJsonUnsafe(request, encodeProgress(progress)),
            isKeepalive: true,
          },
        ).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.map((stored) => AppMessage.SucceededPushProgress({ episodeId, sent: progress, stored })),
          Effect.catch(() => Effect.succeed(AppMessage.FailedPushProgress({ episodeId }))),
        )
    }),
  )
}

// STORAGE COMMANDS

const writeStorage = (key: string, value: unknown) =>
  Effect.sync(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Storage full or blocked: the value lives in the Model for this session only.
    }
  })

/** Stores the token and server in localStorage and updates the shared `FamaConnection` service for queries. */
export class StoreConnection extends Command.Service<StoreConnection>()("app/StoreConnection", {
  args: { connection: Connection },
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const conn = yield* FamaConnection
      return ({ connection }) =>
        Effect.sync(() => {
          conn.set(connection)
        }).pipe(
          Effect.andThen(writeStorage("fama.token", Redacted.value(connection.token))),
          Effect.andThen(writeStorage("fama.origin", connection.origin)),
          Effect.as(Component.noop),
        )
    }),
  )
}

export const StoreSetting = Command.make(
  "app/StoreSetting",
  {
    args: {
      key: Schema.Literals(["fama.voice", "fama.speed", "fama.rate"]),
      value: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
    },
  },
  ({ key, value }) => writeStorage(key, value).pipe(Effect.as(Component.noop)),
)

export const ReadStoredProgress = Command.make(
  "app/ReadStoredProgress",
  { args: { episodeId: EpisodeId, intent: Schema.Number } },
  ({ episodeId, intent }) =>
    Effect.sync(() => AppMessage.GotStoredProgress({ episodeId, intent, stored: storedProgress(episodeId) })),
)

/**
 * A listener's action moved an episode to `positionMs`: stamps it with the device clock now and stores it.
 * Only listener actions save, so loading an episode without playing it never makes a new stamp.
 */
export const SaveProgress = Command.make(
  "app/SaveProgress",
  { args: { episodeId: EpisodeId, positionMs: Schema.Number } },
  ({ episodeId, positionMs }) =>
    Effect.gen(function* () {
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      const progress = { positionMs: Math.max(0, Math.round(positionMs)), updatedAt: new Date(now).toISOString() }
      yield* writeStorage(PROGRESS_PREFIX + episodeId, encodeProgress(progress))
      return AppMessage.SavedProgress({ episodeId, progress })
    }),
)

/** Stores progress the server sent, with the server's stamp. */
export const StoreProgress = Command.make(
  "app/StoreProgress",
  { args: { episodeId: EpisodeId, progress: EpisodeProgress } },
  ({ episodeId, progress }) =>
    writeStorage(PROGRESS_PREFIX + episodeId, encodeProgress(progress)).pipe(Effect.as(Component.noop)),
)

// TIMERS

const DISARM_DELETE_MS = 3000

export const WaitBeforeDisarmDelete = Command.make(
  "app/WaitBeforeDisarmDelete",
  { args: { episodeId: EpisodeId } },
  ({ episodeId }) =>
    Effect.sleep(Duration.millis(DISARM_DELETE_MS)).pipe(
      Effect.as(AppMessage.CompletedWaitBeforeDisarmDelete({ episodeId })),
    ),
)

const encodeDocument = Schema.encodeSync(Document)
const encodeStartReview = Schema.encodeSync(StartReview)
const encodeChangeVoice = Schema.encodeSync(ChangeVoice)

/**
 * Saves draft edits in Review at app scope so clicking Back never interrupts an accepted write.
 * `DocumentQuery` is invalidated only when `SucceededSaveReview` is handled.
 */
export class SaveDocument extends Command.Service<SaveDocument>()("app/SaveDocument", {
  args: { connection: Connection, episodeId: EpisodeId, document: Document },
  success: Document,
  error: ApiFailure,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return ({ connection, episodeId, document }) =>
        send(connection, "PUT", `${episodePath(episodeId)}/document`, (request) =>
          HttpClientRequest.bodyJsonUnsafe(request, encodeDocument(document)),
        ).pipe(Effect.as(document), Effect.provideService(HttpClient.HttpClient, client))
    }),
  )
}

/**
 * Starts narration of a reviewed episode at app scope so clicking Back never interrupts an
 * accepted write. `DocumentQuery` is invalidated only when `SucceededStartReview` is handled.
 */
export class StartReviewNarration extends Command.Service<StartReviewNarration>()(
  "app/StartReviewNarration",
  {
    args: {
      connection: Connection,
      episodeId: EpisodeId,
      document: Document,
      voice: Schema.optionalKey(VoiceRef),
    },
    success: Episode,
    error: ApiFailure,
  },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return ({ connection, episodeId, document, voice }) =>
        sendJson(Episode, connection, "POST", `${episodePath(episodeId)}/start`, {
          withBody: (request) => HttpClientRequest.bodyJsonUnsafe(
            request,
            encodeStartReview({ document, ...(voice !== undefined ? { voice } : {}) }),
          ),
        }).pipe(Effect.provideService(HttpClient.HttpClient, client))
    }),
  )
}

/**
 * Saves edited chapter text and re-queues narration at app scope so clicking Back never interrupts
 * an accepted write. `DocumentQuery` is invalidated only when `SucceededNarrateAgain` is handled.
 */
export class NarrateAgainWithDocument extends Command.Service<NarrateAgainWithDocument>()(
  "app/NarrateAgainWithDocument",
  {
    args: { connection: Connection, episodeId: EpisodeId, document: Document },
    success: Schema.Void,
    error: ApiFailure,
  },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return ({ connection, episodeId, document }) =>
        send(connection, "PUT", `${episodePath(episodeId)}/document`, (request) =>
          HttpClientRequest.bodyJsonUnsafe(request, encodeDocument(document)),
        ).pipe(Effect.asVoid, Effect.provideService(HttpClient.HttpClient, client))
    }),
  )
}

/**
 * Changes voice/speed and re-queues narration at app scope so clicking Back never interrupts
 * an accepted write.
 */
export class ChangeNarrateAgainVoice extends Command.Service<ChangeNarrateAgainVoice>()(
  "app/ChangeNarrateAgainVoice",
  {
    args: { connection: Connection, episodeId: EpisodeId, input: ChangeVoice },
    success: Schema.Void,
    error: ApiFailure,
  },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return ({ connection, episodeId, input }) =>
        send(connection, "PUT", `${episodePath(episodeId)}/voice`, (request) =>
          HttpClientRequest.bodyJsonUnsafe(request, encodeChangeVoice(input)),
        ).pipe(Effect.asVoid, Effect.provideService(HttpClient.HttpClient, client))
    }),
  )
}

/**
 * Persists the chosen voice in Review at app scope so clicking Back never cancels an accepted
 * voice selection. App serializes per-episode follow-up writes in `AppModel.reviewVoices` so a
 * pending voice change binds the latest Client token when it actually starts.
 */
export class ChangeReviewVoice extends Command.Service<ChangeReviewVoice>()("app/ChangeReviewVoice", {
  args: {
    connection: Connection,
    episodeId: EpisodeId,
    request: Schema.Number,
    voice: VoiceRef,
    speed: Schema.Number,
  },
  success: AppMessage,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return ({ connection, episodeId, request: reqId, voice, speed }) =>
        send(connection, "PUT", `${episodePath(episodeId)}/voice`, (request) =>
          HttpClientRequest.bodyJsonUnsafe(request, encodeChangeVoice({ voice, speed })),
        ).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.as(
            AppMessage.SucceededChangeReviewVoice({
              episodeId,
              origin: connection.origin,
              request: reqId,
              voice,
              speed,
            }),
          ),
          Effect.catch((failure) =>
            Effect.succeed(AppMessage.FailedChangeReviewVoice({ episodeId, request: reqId, voice, failure })),
          ),
        )
    }),
  )
}

export type AppCommandServices =
  | FetchEpisodes
  | FetchVoices
  | CreateEpisodeFromSource
  | UploadEpisode
  | RetryEpisode
  | DeleteEpisode
  | PushProgress
  | StoreConnection
  | SaveDocument
  | ChangeReviewVoice
  | StartReviewNarration
  | NarrateAgainWithDocument
  | ChangeNarrateAgainVoice

export const appCommandsLayer = Layer.mergeAll(
  FetchEpisodes.layer,
  FetchVoices.layer,
  CreateEpisodeFromSource.layer,
  UploadEpisode.layer,
  RetryEpisode.layer,
  DeleteEpisode.layer,
  PushProgress.layer,
  StoreConnection.layer,
  SaveDocument.layer,
  ChangeReviewVoice.layer,
  StartReviewNarration.layer,
  NarrateAgainWithDocument.layer,
  ChangeNarrateAgainVoice.layer,
)
