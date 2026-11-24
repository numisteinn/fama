import { describe, expect, it } from "vitest"
import { cueText, hasTranscript, renderTranscript, vttTime } from "./transcript.ts"

const segment = (text: string, startMs: number, endMs: number, endsParagraph = false) => ({
  text,
  startMs,
  endMs,
  endsParagraph,
})

describe("renderTranscript", () => {
  it("puts each cue on the episode timeline: the Segment time plus the chapters before it", () => {
    const vtt = renderTranscript([
      { durationMs: 4_000, segments: [segment("Harbour Year.", 300, 1_500, true), segment("Morning.", 1_900, 3_980, true)] },
      { durationMs: 5_000, segments: [segment("Evening.", 250, 2_000, true)] },
      { durationMs: 3_725_400, segments: [segment("Night.", 400, 3_725_400, true)] },
    ])
    expect(vtt).toBe(
      [
        "WEBVTT",
        "",
        "00:00:00.300 --> 00:00:01.500",
        "Harbour Year.",
        "",
        "00:00:01.900 --> 00:00:03.980",
        "Morning.",
        "",
        "00:00:04.250 --> 00:00:06.000",
        "Evening.",
        "",
        "00:00:09.400 --> 01:02:14.400",
        "Night.",
        "",
      ].join("\n"),
    )
  })

  it("makes one cue for each Segment", () => {
    const segments = Array.from({ length: 50 }, (_, index) => segment(`Sentence ${index}.`, index * 100, index * 100 + 90))
    const vtt = renderTranscript([{ durationMs: 5_000, segments }, { durationMs: 5_000, segments }])
    expect(vtt.match(/ --> /g)).toHaveLength(100)
  })

  it("ends a cue at the end of its chapter, so cues of two chapters never overlap", () => {
    const vtt = renderTranscript([
      { durationMs: 2_000, segments: [segment("Over the end.", 100, 2_040)] },
      { durationMs: 2_000, segments: [segment("Next.", 0, 500)] },
    ])
    expect(vtt).toContain("00:00:00.100 --> 00:00:02.000\nOver the end.")
    expect(vtt).toContain("00:00:02.000 --> 00:00:02.500\nNext.")
  })

  it("gives an empty-length Segment 1 ms and keeps the cue for a Segment with no text", () => {
    const vtt = renderTranscript([{ durationMs: 2_000, segments: [segment("Now.", 700, 700), segment("  \n ", 800, 900)] }])
    expect(vtt).toBe("WEBVTT\n\n00:00:00.700 --> 00:00:00.701\nNow.\n\n00:00:00.800 --> 00:00:00.900\n\n")
  })

  it("is only the header for an episode with no Segments", () => {
    expect(renderTranscript([{ durationMs: 1_000, segments: [] }])).toBe("WEBVTT\n")
  })
})

describe("cueText", () => {
  it("escapes markup and keeps the Document text", () => {
    expect(cueText("Tom & Jerry <b>live</b> --> 3 bækur")).toBe("Tom &amp; Jerry &lt;b&gt;live&lt;/b&gt; --&gt; 3 bækur")
  })

  it("puts the text on one line, so a blank line cannot end the cue", () => {
    expect(cueText("  First line.\n\nSecond\tline.  ")).toBe("First line. Second line.")
  })
})

describe("vttTime", () => {
  it("writes hours, minutes, seconds and milliseconds", () => {
    expect(vttTime(0)).toBe("00:00:00.000")
    expect(vttTime(3_723_004)).toBe("01:02:03.004")
    expect(vttTime(100 * 3_600_000 + 59_999)).toBe("100:00:59.999")
  })
})

describe("hasTranscript", () => {
  it("needs a timing file for each chapter", () => {
    expect(hasTranscript([{ hasTiming: true }, { hasTiming: true }])).toBe(true)
    expect(hasTranscript([{ hasTiming: true }, { hasTiming: false }])).toBe(false)
    expect(hasTranscript([])).toBe(false)
  })
})
