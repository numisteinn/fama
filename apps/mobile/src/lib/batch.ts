import type { VoiceRef } from "@fama/contracts"
import type { PickedFile } from "./api"

/** File types the API narrates. */
const EXTENSIONS = [".pdf", ".epub", ".txt", ".md", ".markdown", ".html", ".htm"]

export const isAccepted = (name: string): boolean => {
  const lower = name.toLowerCase()
  return EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/** The voice and speed a file is sent with: the screen's choice when the user chose Create. */
type Sent = { readonly voice: VoiceRef | null; readonly speed: number }

/**
 * Where one picked file is. `Attached` waits for Create. `Refused` is a type the API does not narrate, and is never
 * sent. `Pending` waits for its turn to upload, `Failed` can be sent again with the same voice and speed.
 */
export type FileState =
  | { readonly _tag: "Attached" }
  | { readonly _tag: "Refused" }
  | ({ readonly _tag: "Pending" } & Sent)
  | ({ readonly _tag: "Uploading" } & Sent)
  | { readonly _tag: "Done" }
  | ({ readonly _tag: "Failed"; readonly reason: string } & Sent)

export type BatchFile = { readonly key: number; readonly file: PickedFile; readonly state: FileState }
export type Batch = ReadonlyArray<BatchFile>

const setState = (batch: Batch, key: number, state: FileState): Batch =>
  batch.map((item) => (item.key === key ? { ...item, state } : item))

/** Adds picked files. Keys start at `firstKey`. */
export const attach = (batch: Batch, files: ReadonlyArray<PickedFile>, firstKey: number): Batch => [
  ...batch,
  ...files.map((file, index) => ({
    key: firstKey + index,
    file,
    state: isAccepted(file.name) ? ({ _tag: "Attached" } as const) : ({ _tag: "Refused" } as const),
  })),
]

export const hasAttached = (batch: Batch): boolean => batch.some((item) => item.state._tag === "Attached")

export const isSending = (batch: Batch): boolean =>
  batch.some((item) => item.state._tag === "Pending" || item.state._tag === "Uploading")

/** Create: each attached file waits to upload with this voice and speed. */
export const send = (batch: Batch, voice: VoiceRef | null, speed: number): Batch =>
  batch.map((item) => (item.state._tag === "Attached" ? { ...item, state: { _tag: "Pending", voice, speed } } : item))

/** A failed file waits to upload again, with the voice and speed it had. */
export const retry = (batch: Batch, key: number): Batch =>
  batch.map((item) =>
    item.state._tag === "Failed" && item.key === key
      ? { ...item, state: { _tag: "Pending", voice: item.state.voice, speed: item.state.speed } }
      : item,
  )

/** An uploading file is not removed: its episode may already exist. */
export const remove = (batch: Batch, key: number): Batch =>
  batch.filter((item) => item.key !== key || item.state._tag === "Uploading")

/** One upload at a time: the first pending file starts when none uploads. */
export const startNext = (batch: Batch): { batch: Batch; started: (BatchFile & { state: { _tag: "Uploading" } & Sent }) | null } => {
  if (batch.some((item) => item.state._tag === "Uploading")) return { batch, started: null }
  const next = batch.find((item) => item.state._tag === "Pending")
  if (!next || next.state._tag !== "Pending") return { batch, started: null }
  const state = { _tag: "Uploading", voice: next.state.voice, speed: next.state.speed } as const
  return { batch: setState(batch, next.key, state), started: { ...next, state } }
}

/** When nothing waits or uploads, done files leave. Failed and refused files stay until the user acts. */
const settle = (batch: Batch): Batch => (isSending(batch) ? batch : batch.filter((item) => item.state._tag !== "Done"))

export const succeed = (batch: Batch, key: number): Batch => settle(setState(batch, key, { _tag: "Done" }))

export const fail = (batch: Batch, key: number, reason: string): Batch =>
  settle(
    batch.map((item) =>
      item.key === key && item.state._tag === "Uploading"
        ? { ...item, state: { _tag: "Failed", reason, voice: item.state.voice, speed: item.state.speed } }
        : item,
    ),
  )
