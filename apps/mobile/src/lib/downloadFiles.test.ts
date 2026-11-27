import type { Chapter, JobState } from "@fama/contracts"
import { describe, expect, test } from "vitest"
import { audioFileName, episodeFileNames, isEpisodeDownloaded, sha256Hex, staleFileNames, timingFileName } from "./downloadFiles"
import { required } from "../../../../test/required.ts"

const chapter = (index: number, rev: string | null, timed = true): Chapter => ({
  index,
  title: `Chapter ${index + 1}`,
  durationMs: 10_000,
  url: `/media/tok/episodes/e1/chapters/${rev ? `${rev}/` : ""}00${index}.m4a`,
  timingUrl: timed ? `/media/tok/episodes/e1/chapters/${rev ? `${rev}/` : ""}00${index}.json` : null,
})

const ready: JobState = { _tag: "Ready", finishedAt: "2026-11-25T00:00:00.000Z" }
const queued: JobState = { _tag: "Queued" }

describe("downloadFiles revision invalidation", () => {
  test("sha256Hex matches standard test vectors including multi-block inputs", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    )
  })

  test("rotating the feed token keeps the same local file names", () => {
    const urlA = "/media/token-one/episodes/e1/chapters/rev1/000.m4a"
    const urlB = "/media/token-two/episodes/e1/chapters/rev1/000.m4a"
    expect(audioFileName(0, urlA)).toBe(audioFileName(0, urlB))
  })

  test("re-narrating one chapter invalidates only that chapter's audio and timing files", () => {
    const before = [chapter(0, "rev1"), chapter(1, "rev1")]
    const disk = new Set(episodeFileNames(before))

    expect(isEpisodeDownloaded({ job: ready, chapters: before }, (name) => disk.has(name))).toBe(true)

    // Chapter 1 gets a new url and timingUrl after re-narration; chapter 0 is reused.
    const after = [chapter(0, "rev1"), chapter(1, "rev2")]
    expect(disk.has(audioFileName(0, required(after[0]).url))).toBe(true)
    expect(disk.has(timingFileName(0, required(required(after[0]).timingUrl)))).toBe(true)
    expect(disk.has(audioFileName(1, required(after[1]).url))).toBe(false)
    expect(disk.has(timingFileName(1, required(required(after[1]).timingUrl)))).toBe(false)
    expect(isEpisodeDownloaded({ job: ready, chapters: after }, (name) => disk.has(name))).toBe(false)
    expect(isEpisodeDownloaded({ job: queued, chapters: before }, (name) => disk.has(name))).toBe(false)
  })

  test("staleFileNames removes replaced revisions and legacy unkeyed files while keeping reused chapters", () => {
    const before = [chapter(0, "rev1"), chapter(1, "rev1")]
    const after = [chapter(0, "rev1"), chapter(1, "rev2")]
    const existing = ["000.m4a", "000.json", ...episodeFileNames(before), ...episodeFileNames([required(after[1])])]

    const stale = staleFileNames(existing, after)
    expect(stale).toEqual([
      "000.m4a",
      "000.json",
      audioFileName(1, required(before[1]).url),
      timingFileName(1, required(required(before[1]).timingUrl)),
    ])
  })
})
