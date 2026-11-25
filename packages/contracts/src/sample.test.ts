import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ClaimResponse, SamplesRequest, SampleVoice } from "./index.ts"

const decodes = (schema: Schema.Decoder<unknown>, value: unknown) =>
  Schema.decodeUnknownResult(schema)(value)._tag === "Success"

describe("SampleVoice", () => {
  it("takes the voices the engines have", () => {
    expect(decodes(SampleVoice, "piper:is_IS-steinn-medium")).toBe(true)
    expect(decodes(SampleVoice, "kokoro:af_heart")).toBe(true)
  })

  it("refuses a voice that is not safe as a file name", () => {
    for (const voice of ["piper", "piper:", ":steinn", "piper:a/b", "piper:..", "piper:a b", "piper:a%2Fb", "a:b:c", ""]) {
      expect(decodes(SampleVoice, voice), voice).toBe(false)
    }
  })
})

describe("SamplesRequest", () => {
  it("means the default voices when it names none", () => {
    expect(Schema.decodeUnknownSync(SamplesRequest)({})).toEqual({ voices: null })
    expect(Schema.decodeUnknownSync(SamplesRequest)({ voices: null })).toEqual({ voices: null })
  })

  it("refuses an unsafe voice", () => {
    expect(decodes(SamplesRequest, { voices: ["piper:is_IS-salka-medium"] })).toBe(true)
    expect(decodes(SamplesRequest, { voices: ["piper:../x"] })).toBe(false)
  })
})

describe("ClaimResponse", () => {
  const narrate = {
    _tag: "Narrate",
    episodeId: "e1",
    leaseToken: "lease",
    source: { _tag: "Url", url: "https://example.com" },
    sourcePath: null,
    documentPath: null,
    coverPath: null,
    voice: null,
    speed: 1,
    chapters: [],
  }
  const sample = {
    _tag: "Sample",
    episodeId: "e1",
    voice: "piper:is_IS-steinn-medium",
    leaseToken: "lease",
    documentPath: "/api/worker/samples/e1/document",
    speed: 1.2,
  }

  it("is a job to narrate or a Sample to make", () => {
    expect(decodes(ClaimResponse, { work: narrate })).toBe(true)
    expect(decodes(ClaimResponse, { work: sample })).toBe(true)
  })

  it("needs the tag", () => {
    expect(decodes(ClaimResponse, { work: { ...sample, _tag: undefined } })).toBe(false)
    expect(decodes(ClaimResponse, { job: narrate })).toBe(false)
  })
})
