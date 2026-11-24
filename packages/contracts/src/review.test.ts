import { Schema } from "effect"
import { describe, expect, test } from "vitest"
import { CreateEpisode, DocumentStored, JobState, StartReview } from "./index.ts"

const document = { title: "Harbour Days", author: null, language: "en", chapters: [{ title: "Morning", text: "Quiet." }] }

describe("CreateEpisode", () => {
  const decode = Schema.decodeUnknownSync(CreateEpisode)
  const source = { _tag: "Url", url: "https://example.com/a" }

  test("review is off for a client that leaves it out", () => {
    expect(decode({ source, voice: null, speed: 1 }).review).toBe(false)
    expect(decode({ source, voice: null, speed: 1, review: true }).review).toBe(true)
  })

  test("review must be a boolean", () => {
    expect(() => decode({ source, voice: null, speed: 1, review: "yes" })).toThrow()
  })
})

describe("StartReview", () => {
  const decode = Schema.decodeUnknownResult(StartReview)

  test("takes the Document to narrate", () => {
    expect(decode({ document })._tag).toBe("Success")
  })

  test("refuses a Document with no chapter left", () => {
    expect(decode({ document: { ...document, chapters: [] } })._tag).toBe("Failure")
    expect(decode({})._tag).toBe("Failure")
  })
})

test("Review is a job state with no fields", () => {
  expect(Schema.decodeUnknownSync(JobState)({ _tag: "Review" })).toEqual({ _tag: "Review" })
})

test("DocumentStored names what comes next for the job", () => {
  const decode = Schema.decodeUnknownResult(DocumentStored)
  expect(decode({ next: "Review" })._tag).toBe("Success")
  expect(decode({ next: "Narrate" })._tag).toBe("Success")
  expect(decode({ next: "Queued" })._tag).toBe("Failure")
})
