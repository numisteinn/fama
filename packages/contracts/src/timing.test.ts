import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Timing } from "./timing.ts"

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
