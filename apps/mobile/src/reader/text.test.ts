import type { Chapter, Segment } from "@fama/contracts"
import { describe, expect, test } from "vitest"
import {
  type ReaderText,
  hasText,
  lineOf,
  listed,
  markAt,
  nextLoads,
  openingRow,
  paragraphText,
  rowOf,
  rowsOf,
  seekTargetMs,
  update,
} from "./text"

const chapter = (index: number, title: string, durationMs: number, timed = true): Chapter => ({
  index,
  title,
  durationMs,
  url: `/media/t/episodes/e1/chapters/00${index}.m4a`,
  timingUrl: timed ? `/media/t/episodes/e1/chapters/00${index}.json` : null,
})
const seg = (text: string, startMs: number, endMs: number, endsParagraph = false): Segment => ({ text, startMs, endMs, endsParagraph })

const spring = chapter(0, "Spring", 20_000)
const summer = chapter(1, "Summer", 15_000)
const autumn = chapter(2, "Autumn", 10_000)
const springText = [
  seg("Harbour Year", 360, 1_550, true),
  seg("Spring, day 1.", 2_000, 4_000),
  seg("People come for the hot tubs.", 4_200, 9_000, true),
  seg("The light turns gold.", 9_700, 19_990, true),
]
const summerText = [seg("Summer", 300, 1_000, true), seg("Boats slide out.", 1_500, 6_000), seg("Gulls follow.", 6_200, 14_990, true)]

const episode = { id: "e1", chapters: [spring, summer] }
const load = (text: ReaderText, index: number, segments: ReadonlyArray<Segment>) => {
  const key = text.chapters[index]!._tag === "Absent" ? "" : (text.chapters[index] as { key: string }).key
  const started = update(text, { _tag: "Started", index, key })
  return update(started, { _tag: "Loaded", index, key, segments })
}
const loadedText = () => load(load(listed(null, episode), 0, springText), 1, summerText)

describe("chapter text state", () => {
  test("a chapter without a timing file is Absent, the others wait to load", () => {
    const text = listed(null, { id: "e1", chapters: [spring, chapter(1, "Old", 5_000, false)] })
    expect(text.chapters.map((c) => c._tag)).toEqual(["Idle", "Absent"])
    expect(listed(text, { id: "e1", chapters: [spring, chapter(1, "Old", 5_000, false)] })).toBe(text)
  })

  test("the entry point needs at least one timing file", () => {
    expect(hasText({ id: "e1", chapters: [chapter(0, "Old", 5_000, false)] })).toBe(false)
    expect(hasText(episode)).toBe(true)
  })

  test("a load goes Idle, Loading, Loaded", () => {
    const text = listed(null, episode)
    const key = (text.chapters[0] as { key: string }).key
    const started = update(text, { _tag: "Started", index: 0, key })
    expect(started.chapters[0]!._tag).toBe("Loading")
    const done = update(started, { _tag: "Loaded", index: 0, key, segments: springText })
    expect(done.chapters[0]).toEqual({ _tag: "Loaded", key, segments: springText })
  })

  test("a failed load can be retried", () => {
    const text = listed(null, episode)
    const key = (text.chapters[0] as { key: string }).key
    const failed = update(update(text, { _tag: "Started", index: 0, key }), { _tag: "Failed", index: 0, key })
    expect(failed.chapters[0]!._tag).toBe("Failed")
    expect(update(failed, { _tag: "Retry", index: 0 }).chapters[0]).toEqual({ _tag: "Idle", key })
  })

  test("new chapters of a running job arrive Idle, and loaded text stays", () => {
    const first = load(listed(null, { id: "e1", chapters: [spring] }), 0, springText)
    const grown = listed(first, { id: "e1", chapters: [spring, summer] })
    expect(grown.chapters.map((c) => c._tag)).toEqual(["Loaded", "Idle"])
    expect(grown.chapters[0]).toBe(first.chapters[0])
  })

  test("the same list keeps the same state object", () => {
    const text = loadedText()
    expect(listed(text, episode)).toBe(text)
  })

  test("a new timing file at the same path loads again", () => {
    const text = loadedText()
    const renarrated = listed(text, { id: "e1", chapters: [{ ...spring, durationMs: 21_000 }, summer] })
    expect(renarrated.chapters.map((c) => c._tag)).toEqual(["Idle", "Loaded"])
  })

  test("a new url or timingUrl with the same duration loads again while reused chapters stay Loaded", () => {
    const text = loadedText()
    const renarrated = listed(text, {
      id: "e1",
      chapters: [
        {
          ...spring,
          url: "/media/t/episodes/e1/chapters/rev2/000.m4a",
          timingUrl: "/media/t/episodes/e1/chapters/rev2/000.json",
        },
        summer,
      ],
    })
    expect(renarrated.chapters.map((c) => c._tag)).toEqual(["Idle", "Loaded"])
    expect(renarrated.chapters[1]).toBe(text.chapters[1])
  })

  test("an answer for a timing file the chapter no longer has changes nothing", () => {
    const text = listed(null, episode)
    const old = (text.chapters[0] as { key: string }).key
    const started = update(text, { _tag: "Started", index: 0, key: old })
    const renarrated = listed(started, { id: "e1", chapters: [{ ...spring, durationMs: 21_000 }, summer] })
    expect(update(renarrated, { _tag: "Loaded", index: 0, key: old, segments: springText })).toBe(renarrated)
  })

  test("another episode starts over", () => {
    expect(listed(loadedText(), { id: "e2", chapters: [spring] }).chapters.map((c) => c._tag)).toEqual(["Idle"])
  })

  test("the playing chapter loads first, then the ones after it, then the ones before", () => {
    const text = listed(null, { id: "e1", chapters: [spring, summer, autumn, chapter(3, "Winter", 1_000)] })
    expect(nextLoads(text, 2, 4)).toEqual([2, 3, 0, 1])
    expect(nextLoads(text, 2, 2)).toEqual([2, 3])
    const busy = update(text, { _tag: "Started", index: 2, key: (text.chapters[2] as { key: string }).key })
    expect(nextLoads(busy, 2, 2)).toEqual([3])
  })
})

describe("rows", () => {
  test("titles are headings, paragraphs end at endsParagraph, chapters still loading wait", () => {
    const text = load(listed(null, episode), 0, springText)
    expect(rowsOf(episode.chapters, text)).toEqual([
      { _tag: "Heading", key: "h0", chapter: 0, title: "Spring", segment: null },
      { _tag: "Paragraph", key: "p0.0", chapter: 0, first: 0, last: 0 },
      { _tag: "Paragraph", key: "p0.1", chapter: 0, first: 1, last: 2 },
      { _tag: "Paragraph", key: "p0.3", chapter: 0, first: 3, last: 3 },
      { _tag: "Heading", key: "h1", chapter: 1, title: "Summer", segment: null },
      { _tag: "Pending", key: "w1", chapter: 1 },
    ])
  })

  test("a spoken chapter title is the heading, not a paragraph", () => {
    const rows = rowsOf(episode.chapters, loadedText())
    expect(rows.slice(4)).toEqual([
      { _tag: "Heading", key: "h1", chapter: 1, title: "Summer", segment: 0 },
      { _tag: "Paragraph", key: "p1.1", chapter: 1, first: 1, last: 2 },
    ])
  })

  test("a paragraph is its Segments one space apart", () => {
    expect(paragraphText(springText, 1, 2)).toBe("Spring, day 1. People come for the hot tubs.")
  })
})

describe("the mark", () => {
  const text = loadedText()
  const rows = rowsOf(episode.chapters, text)

  test("before the first Segment of a chapter nothing is marked", () => {
    expect(markAt(episode.chapters, text, { index: 0, positionMs: 100 })).toBeNull()
  })

  test("the pause after a Segment still marks it", () => {
    expect(markAt(episode.chapters, text, { index: 0, positionMs: 9_500 })).toEqual({ chapter: 0, segment: 2 })
  })

  test("a later chapter counts from its own start on the episode timeline", () => {
    expect(markAt(episode.chapters, text, { index: 1, positionMs: 20_000 + 1_500 })).toEqual({ chapter: 1, segment: 1 })
    expect(markAt(episode.chapters, text, { index: 1, positionMs: 20_000 + 1_499 })).toEqual({ chapter: 1, segment: 0 })
  })

  test("the native player's chapter decides, not the sum of durations", () => {
    // Chapter 0's audio runs a little past its listed duration: the voice still reads chapter 0.
    expect(markAt(episode.chapters, text, { index: 0, positionMs: 20_030 })).toEqual({ chapter: 0, segment: 3 })
  })

  test("a chapter whose text is not loaded has no mark", () => {
    const partial = load(listed(null, episode), 0, springText)
    expect(markAt(episode.chapters, partial, { index: 1, positionMs: 25_000 })).toBeNull()
  })

  test("a seek lands on a float a hair under the target: the mark is still the tapped Segment", () => {
    const target = seekTargetMs(episode.chapters, text, { chapter: 1, segment: 2 })!
    const landed = (target / 1000) * 1000 - 1e-9
    expect(markAt(episode.chapters, text, { index: 1, positionMs: landed })).toEqual({ chapter: 1, segment: 2 })
  })

  test("the marked Segment's row", () => {
    expect(rowOf(rows, { chapter: 0, segment: 0 })).toBe(1)
    expect(rowOf(rows, { chapter: 0, segment: 2 })).toBe(2)
    expect(rowOf(rows, { chapter: 1, segment: 0 })).toBe(4)
    expect(rowOf(rows, { chapter: 1, segment: 2 })).toBe(5)
    expect(rowOf(rows, { chapter: 1, segment: 9 })).toBeNull()
  })

  test("the reader opens on the mark, else on the playing chapter's title", () => {
    expect(openingRow(rows, { chapter: 0, segment: 3 }, 0)).toBe(3)
    expect(openingRow(rows, null, 1)).toBe(4)
  })
})

describe("a tap", () => {
  const text = loadedText()

  test("seeks to the Segment's startMs on the episode timeline", () => {
    expect(seekTargetMs(episode.chapters, text, { chapter: 0, segment: 2 })).toBe(4_200)
    expect(seekTargetMs(episode.chapters, text, { chapter: 1, segment: 1 })).toBe(20_000 + 1_500)
  })

  test("a Segment that is not loaded has no target", () => {
    expect(seekTargetMs(episode.chapters, listed(null, episode), { chapter: 1, segment: 1 })).toBeNull()
  })
})

describe("the line of a Segment", () => {
  test("counts characters across the laid-out lines", () => {
    // "Spring, day 1. People come for the hot tubs." laid out in two lines.
    const lines = [{ text: "Spring, day 1. People come " }, { text: "for the hot tubs." }]
    expect(lineOf(springText, 1, 1, lines)).toBe(0)
    expect(lineOf(springText, 1, 2, lines)).toBe(0)
    expect(lineOf(springText, 1, 2, [{ text: "Spring, day 1. " }, { text: "People come for the hot tubs." }])).toBe(1)
  })
})
