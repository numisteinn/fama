import { CreateEpisode, Episode, EpisodeId, EpisodeList, FeedInfo, VoiceList, VoiceRef } from "@fama/contracts"
import { Duration, Effect, Redacted, Schema } from "effect"
import { HttpClientRequest } from "effect/http"
import { Command, Dom, File } from "foldkit"
import { Connection, episodePath, send, sendJson } from "~/api"
import { Message } from "~/message"
import { DISARM_DELETE_MS, PickerId, RESET_COPIED_MS } from "~/model"

// HTTP

export const FetchEpisodes = Command.define("FetchEpisodes", {
  args: { connection: Connection },
  messages: [Message.SucceededFetchEpisodes, Message.FailedFetchEpisodes],
  execute: ({ connection }) =>
    sendJson(EpisodeList, connection, "GET", "/api/episodes").pipe(
      Effect.map(({ episodes }) => Message.SucceededFetchEpisodes({ episodes })),
      Effect.catch((failure) => Effect.succeed(Message.FailedFetchEpisodes({ failure }))),
    ),
})

export const FetchVoices = Command.define("FetchVoices", {
  args: { connection: Connection },
  messages: [Message.SucceededFetchVoices, Message.FailedFetchVoices],
  execute: ({ connection }) =>
    sendJson(VoiceList, connection, "GET", "/api/voices").pipe(
      Effect.map(({ voices }) => Message.SucceededFetchVoices({ voices })),
      Effect.catch(() => Effect.succeed(Message.FailedFetchVoices())),
    ),
})

export const FetchFeed = Command.define("FetchFeed", {
  args: { connection: Connection },
  messages: [Message.SucceededFetchFeed, Message.FailedFetchFeed],
  execute: ({ connection }) =>
    sendJson(FeedInfo, connection, "GET", "/api/feed").pipe(
      Effect.map(({ url }) => Message.SucceededFetchFeed({ connection, url })),
      Effect.catch((failure) => Effect.succeed(Message.FailedFetchFeed({ connection, failure }))),
    ),
})

const encodeCreate = Schema.encodeSync(CreateEpisode)

export const CreateEpisodeFromSource = Command.define("CreateEpisodeFromSource", {
  args: { connection: Connection, input: CreateEpisode },
  messages: [Message.SucceededCreateEpisode, Message.FailedCreateEpisode],
  execute: ({ connection, input }) =>
    sendJson(Episode, connection, "POST", "/api/episodes", (request) =>
      HttpClientRequest.bodyJsonUnsafe(request, encodeCreate(input)),
    ).pipe(
      Effect.map((episode) => Message.SucceededCreateEpisode({ episode })),
      Effect.catch((failure) => Effect.succeed(Message.FailedCreateEpisode({ failure }))),
    ),
})

export const UploadEpisode = Command.define("UploadEpisode", {
  args: { connection: Connection, file: File.File, voice: Schema.NullOr(VoiceRef), speed: Schema.Number },
  messages: [Message.SucceededCreateEpisode, Message.FailedCreateEpisode],
  execute: ({ connection, file, voice, speed }) => {
    const form = new FormData()
    form.set("file", file)
    if (voice) form.set("voice", voice)
    form.set("speed", String(speed))
    return sendJson(Episode, connection, "POST", "/api/episodes/upload", (request) =>
      HttpClientRequest.bodyFormData(request, form),
    ).pipe(
      Effect.map((episode) => Message.SucceededCreateEpisode({ episode })),
      Effect.catch((failure) => Effect.succeed(Message.FailedCreateEpisode({ failure }))),
    )
  },
})

export const RetryEpisode = Command.define("RetryEpisode", {
  args: { connection: Connection, episodeId: EpisodeId },
  messages: [Message.SucceededRetryEpisode, Message.FailedRetryEpisode],
  execute: ({ connection, episodeId }) =>
    sendJson(Episode, connection, "POST", `${episodePath(episodeId)}/retry`).pipe(
      Effect.map((episode) => Message.SucceededRetryEpisode({ episode })),
      Effect.catch((failure) => Effect.succeed(Message.FailedRetryEpisode({ episodeId, failure }))),
    ),
})

export const DeleteEpisode = Command.define("DeleteEpisode", {
  args: { connection: Connection, episodeId: EpisodeId },
  messages: [Message.SucceededDeleteEpisode, Message.FailedDeleteEpisode],
  execute: ({ connection, episodeId }) =>
    send(connection, "DELETE", episodePath(episodeId)).pipe(
      Effect.as(Message.SucceededDeleteEpisode({ episodeId })),
      Effect.catch((failure) => Effect.succeed(Message.FailedDeleteEpisode({ episodeId, failure }))),
    ),
})

// STORAGE

const writeStorage = (key: string, value: unknown) =>
  Effect.sync(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Storage full or blocked: the value lives in the Model for this session only.
    }
  })

/** Stores the token and server, the way the React app did, as JSON strings. */
export const StoreConnection = Command.define("StoreConnection", {
  args: { connection: Connection },
  messages: [Message.CompletedStoreSetting],
  execute: ({ connection }) =>
    writeStorage("fama.token", Redacted.value(connection.token)).pipe(
      Effect.andThen(writeStorage("fama.origin", connection.origin)),
      Effect.as(Message.CompletedStoreSetting()),
    ),
})

export const StoreSetting = Command.define("StoreSetting", {
  args: { key: Schema.Literals(["fama.voice", "fama.speed", "fama.rate"]), value: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])) },
  messages: [Message.CompletedStoreSetting],
  execute: ({ key, value }) => writeStorage(key, value).pipe(Effect.as(Message.CompletedStoreSetting())),
})

export const SavePosition = Command.define("SavePosition", {
  args: { episodeId: EpisodeId, positionMs: Schema.Number },
  messages: [Message.CompletedSavePosition],
  execute: ({ episodeId, positionMs }) =>
    writeStorage(`fama.position.${episodeId}`, positionMs).pipe(Effect.as(Message.CompletedSavePosition())),
})

// DOM

export const FILE_INPUT_ID = "file-input"
export const ADD_TEXT_ID = "add-text"
export const deleteConfirmId = (episodeId: string) => `delete-confirm-${episodeId}`
export const pickerTriggerId = (pickerId: PickerId) => `${pickerId.toLowerCase()}-trigger`
export const pickerMenuId = (pickerId: PickerId) => `${pickerId.toLowerCase()}-menu`
export const pickerItemId = (pickerId: PickerId, index: number) => `${pickerId.toLowerCase()}-item-${index}`

/** Opens the native file picker through the hidden, persistent file input. */
export const ClickFileInput = Command.define("ClickFileInput", {
  messages: [Message.CompletedClickFileInput],
  execute: Dom.clickElement(`#${FILE_INPUT_ID}`).pipe(Effect.ignore, Effect.as(Message.CompletedClickFileInput())),
})

export const FocusAddText = Command.define("FocusAddText", {
  messages: [Message.CompletedFocusAddText],
  execute: Dom.focus(`#${ADD_TEXT_ID}`).pipe(Effect.ignore, Effect.as(Message.CompletedFocusAddText())),
})

export const FocusDeleteConfirm = Command.define("FocusDeleteConfirm", {
  args: { episodeId: EpisodeId },
  messages: [Message.CompletedFocusDeleteConfirm],
  execute: ({ episodeId }) =>
    Dom.focus(`#${CSS.escape(deleteConfirmId(episodeId))}`).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedFocusDeleteConfirm()),
    ),
})

export const FocusPicker = Command.define("FocusPicker", {
  args: { pickerId: PickerId },
  messages: [Message.CompletedFocusPicker],
  execute: ({ pickerId }) =>
    Dom.focus(`#${pickerMenuId(pickerId)}`, { preventScroll: true }).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedFocusPicker()),
    ),
})

export const FocusPickerTrigger = Command.define("FocusPickerTrigger", {
  args: { pickerId: PickerId },
  messages: [Message.CompletedFocusPickerTrigger],
  execute: ({ pickerId }) =>
    Dom.focus(`#${pickerTriggerId(pickerId)}`).pipe(Effect.ignore, Effect.as(Message.CompletedFocusPickerTrigger())),
})

export const ScrollPickerItem = Command.define("ScrollPickerItem", {
  args: { pickerId: PickerId, index: Schema.Number },
  messages: [Message.CompletedScrollPickerItem],
  execute: ({ pickerId, index }) =>
    Dom.scrollIntoView(`#${pickerItemId(pickerId, index)}`).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedScrollPickerItem()),
    ),
})

export const CopyFeedUrl = Command.define("CopyFeedUrl", {
  args: { url: Schema.String },
  messages: [Message.SucceededCopyFeedUrl, Message.FailedCopyFeedUrl],
  execute: ({ url }) =>
    Effect.tryPromise(() => navigator.clipboard.writeText(url)).pipe(
      Effect.as(Message.SucceededCopyFeedUrl()),
      Effect.catch(() => Effect.succeed(Message.FailedCopyFeedUrl())),
    ),
})

// TIMERS

export const WaitBeforeResetCopied = Command.define("WaitBeforeResetCopied", {
  messages: [Message.CompletedWaitBeforeResetCopied],
  execute: Effect.sleep(Duration.millis(RESET_COPIED_MS)).pipe(Effect.as(Message.CompletedWaitBeforeResetCopied())),
})

export const WaitBeforeDisarmDelete = Command.define("WaitBeforeDisarmDelete", {
  args: { episodeId: EpisodeId },
  messages: [Message.CompletedWaitBeforeDisarmDelete],
  execute: ({ episodeId }) =>
    Effect.sleep(Duration.millis(DISARM_DELETE_MS)).pipe(
      Effect.as(Message.CompletedWaitBeforeDisarmDelete({ episodeId })),
    ),
})
