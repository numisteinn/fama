import { VoiceRef } from "@fama/contracts"
import { Option, Schema } from "effect"
import { File } from "foldkit"
import { defineTaggedUnion } from "foldkit/schema"

/** File types the API narrates. */
export const ACCEPT = ".pdf,.epub,.txt,.md,.markdown,.html,.htm"
const EXTENSIONS = ACCEPT.split(",")

export const isAccepted = (name: string): boolean => {
  const lower = name.toLowerCase()
  return EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/** The voice, speed and review flag a file is sent with: the add bar's choice when the user chose Add. */
const Sent = { voice: Schema.NullOr(VoiceRef), speed: Schema.Number, review: Schema.Boolean }

/**
 * Where one file of the add bar is. `Attached` waits for Add. `Refused` is a type the API does not narrate, and
 * is never sent. `Pending` waits for its turn to upload, `Failed` can be sent again with the same voice and speed.
 */
export const FileState = defineTaggedUnion({
  Attached: {},
  Refused: {},
  Pending: Sent,
  Uploading: Sent,
  Done: {},
  Failed: { reason: Schema.String, ...Sent },
})
export type FileState = typeof FileState.Type

export const BatchFile = Schema.Struct({ key: Schema.Number, file: File.File, state: FileState })
export type BatchFile = typeof BatchFile.Type
export type Batch = ReadonlyArray<BatchFile>

const setState = (batch: Batch, key: number, state: FileState): Batch =>
  batch.map((item) => (item.key === key ? { ...item, state } : item))

/** Adds files from the picker or a drop. Keys start at `firstKey`. */
export const attach = (batch: Batch, files: ReadonlyArray<File.File>, firstKey: number): Batch => [
  ...batch,
  ...files.map((file, index) => ({
    key: firstKey + index,
    file,
    state: isAccepted(file.name) ? FileState.Attached() : FileState.Refused(),
  })),
]

export const hasAttached = (batch: Batch): boolean => batch.some((item) => item.state._tag === "Attached")

export const isSending = (batch: Batch): boolean =>
  batch.some((item) => item.state._tag === "Pending" || item.state._tag === "Uploading")

/** Add: each attached file waits to upload with this voice, speed and review choice. */
export const send = (batch: Batch, voice: VoiceRef | null, speed: number, review: boolean): Batch =>
  batch.map((item) => (item.state._tag === "Attached" ? { ...item, state: FileState.Pending({ voice, speed, review }) } : item))

/** A failed file waits to upload again, with the voice, speed and review choice it had. */
export const retry = (batch: Batch, key: number): Batch =>
  batch.map((item) =>
    item.state._tag === "Failed" && item.key === key
      ? { ...item, state: FileState.Pending({ voice: item.state.voice, speed: item.state.speed, review: item.state.review }) }
      : item,
  )

/** An uploading file is not removed: its episode may already exist. */
export const remove = (batch: Batch, key: number): Batch =>
  batch.filter((item) => item.key !== key || item.state._tag === "Uploading")

/** One upload at a time: the first pending file starts when none uploads. */
export const startNext = (batch: Batch): { batch: Batch; maybeStarted: Option.Option<BatchFile> } => {
  if (batch.some((item) => item.state._tag === "Uploading")) return { batch, maybeStarted: Option.none() }
  const next = batch.find((item) => item.state._tag === "Pending")
  if (!next || next.state._tag !== "Pending") return { batch, maybeStarted: Option.none() }
  const started = {
    ...next,
    state: FileState.Uploading({ voice: next.state.voice, speed: next.state.speed, review: next.state.review }),
  }
  return { batch: setState(batch, next.key, started.state), maybeStarted: Option.some(started) }
}

/** When nothing waits or uploads, done files leave. Failed and refused files stay until the user acts. */
const settle = (batch: Batch): Batch =>
  isSending(batch) ? batch : batch.filter((item) => item.state._tag !== "Done")

export const succeed = (batch: Batch, key: number): Batch => settle(setState(batch, key, FileState.Done()))

export const fail = (batch: Batch, key: number, reason: string): Batch =>
  settle(
    batch.map((item) =>
      item.key === key && item.state._tag === "Uploading"
        ? {
            ...item,
            state: FileState.Failed({
              reason,
              voice: item.state.voice,
              speed: item.state.speed,
              review: item.state.review,
            }),
          }
        : item,
    ),
  )
