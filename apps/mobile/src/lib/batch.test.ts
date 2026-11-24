import type { VoiceRef } from "@fama/contracts"
import { describe, expect, test } from "vitest"
import { type Batch, attach, fail, hasAttached, isSending, remove, retry, send, startNext, succeed } from "./batch"

const picked = (name: string) => ({ uri: `file:///tmp/${name}`, name, mimeType: null })
const states = (batch: Batch) => batch.map((item) => `${item.file.name} ${item.state._tag}`)
const voice = "kokoro:af_heart" as VoiceRef

/** Starts the next upload and returns the batch and the key it started. */
const next = (batch: Batch) => {
  const { batch: started, started: file } = startNext(batch)
  return { batch: started, file }
}

describe("a batch of picked files", () => {
  test("a refused type is named and never sent; the others upload one at a time with the voice and speed of Create", () => {
    const attached = attach([], [picked("harbour-days.epub"), picked("cover.png"), picked("harbour.md")], 0)
    expect(states(attached)).toEqual(["harbour-days.epub Attached", "cover.png Refused", "harbour.md Attached"])
    expect(hasAttached(attached)).toBe(true)

    const first = next(send(attached, voice, 1.2))
    expect(first.file).toMatchObject({ key: 0, state: { _tag: "Uploading", voice, speed: 1.2 } })
    expect(next(first.batch).file).toBeNull()

    const second = next(succeed(first.batch, 0))
    expect(second.file).toMatchObject({ key: 2, state: { _tag: "Uploading", voice, speed: 1.2 } })
    expect(states(second.batch)).toEqual(["harbour-days.epub Done", "cover.png Refused", "harbour.md Uploading"])

    const ended = succeed(second.batch, 2)
    expect(isSending(ended)).toBe(false)
    expect(states(ended)).toEqual(["cover.png Refused"])
    expect(remove(ended, 1)).toEqual([])
  })

  test("one failed file does not stop the others, keeps its reason, and goes again with its own voice and speed", () => {
    const first = next(send(attach([], [picked("a.pdf"), picked("b.pdf")], 0), null, 0.9))
    const second = next(fail(first.batch, 0, "The server failed (500)."))
    expect(second.file).toMatchObject({ key: 1 })
    const ended = succeed(second.batch, 1)
    expect(ended).toEqual([
      { key: 0, file: picked("a.pdf"), state: { _tag: "Failed", reason: "The server failed (500).", voice: null, speed: 0.9 } },
    ])

    const again = next(retry(ended, 0))
    expect(again.file).toMatchObject({ key: 0, state: { _tag: "Uploading", voice: null, speed: 0.9 } })
    expect(remove(again.batch, 0)).toEqual(again.batch)
  })
})
