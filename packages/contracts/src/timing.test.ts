import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { segmentIndexAt, Timing } from "./timing.ts"

const decodes = (value: unknown) => Schema.decodeUnknownResult(Timing)(value)._tag === "Success"

const title = { text: "Harbour", startMs: 0, endMs: 600, endsParagraph: true }
const body = { text: "The harbour has 3 boats.", startMs: 1500, endMs: 3200, endsParagraph: true }

describe("Timing", () => {
  it("takes Segments in order, with silence between them or none", () => {
    expect(decodes({ segments: [title, body] })).toBe(true)
    expect(decodes({ segments: [title, { ...body, startMs: 600 }] })).toBe(true)
    expect(decodes({ segments: [] })).toBe(true)
  })

  it("refuses Segments that overlap, run backwards or are out of order", () => {
    expect(decodes({ segments: [title, { ...body, startMs: 599 }] })).toBe(false)
    expect(decodes({ segments: [{ ...title, startMs: 700 }] })).toBe(false)
    expect(decodes({ segments: [body, title] })).toBe(false)
  })

  it("refuses times that are not whole milliseconds from 0", () => {
    expect(decodes({ segments: [{ ...title, endMs: 600.5 }] })).toBe(false)
    expect(decodes({ segments: [{ ...title, startMs: -1 }] })).toBe(false)
  })
})

describe("segmentIndexAt", () => {
  const segments = [{ startMs: 300 }, { startMs: 1500 }, { startMs: 4000 }]

  it("is null before the first Segment starts", () => {
    expect(segmentIndexAt(segments, 0)).toBe(null)
    expect(segmentIndexAt(segments, 299)).toBe(null)
    expect(segmentIndexAt([], 500)).toBe(null)
  })

  it("is the last Segment that started, also in the pause after it", () => {
    expect(segmentIndexAt(segments, 300)).toBe(0)
    expect(segmentIndexAt(segments, 1499)).toBe(0)
    expect(segmentIndexAt(segments, 1500)).toBe(1)
    expect(segmentIndexAt(segments, 99_000)).toBe(2)
  })
})
