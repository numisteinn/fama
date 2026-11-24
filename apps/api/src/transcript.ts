// The transcript of an episode for podcast apps: one WebVTT file on the timeline of the book file.
import type { Segment } from "@fama/contracts"

/** One chapter as the transcript needs it: its audio length and the Segments of its timing file. */
export interface TranscriptChapter {
  readonly durationMs: number
  readonly segments: ReadonlyArray<Segment>
}

export const TRANSCRIPT_TYPE = "text/vtt"

/** An episode has a transcript when it has chapters and each one has a timing file. An old episode has none. */
export const hasTranscript = (chapters: ReadonlyArray<{ readonly hasTiming: boolean }>) =>
  chapters.length > 0 && chapters.every((chapter) => chapter.hasTiming)

const pad = (value: number, width: number) => String(value).padStart(width, "0")

/** `HH:MM:SS.mmm`. The hours grow past two digits for a book longer than 99 hours. */
export const vttTime = (ms: number) =>
  `${pad(Math.floor(ms / 3_600_000), 2)}:${pad(Math.floor(ms / 60_000) % 60, 2)}:${pad(Math.floor(ms / 1000) % 60, 2)}.${pad(ms % 1000, 3)}`

/**
 * Cue text: the Document text on one line. `&` and `<` start markup in WebVTT, so they are escaped. `>` too, so the
 * text can never hold `-->`. A line break would end the cue, so each run of white space becomes one space.
 */
export const cueText = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[&<>]/g, (char) => `&${{ "&": "amp", "<": "lt", ">": "gt" }[char]};`)

/**
 * The WebVTT transcript of an episode: one cue for each Segment, in order. A cue's times are the Segment's times plus
 * the durations of the chapters before it, the offsets of the chapter marks in the book file. A cue ends at the end
 * of its chapter at the latest, so cues never overlap, and it lasts at least 1 ms.
 */
export const renderTranscript = (chapters: ReadonlyArray<TranscriptChapter>) => {
  const lines = ["WEBVTT", ""]
  let offsetMs = 0
  for (const chapter of chapters) {
    for (const segment of chapter.segments) {
      const text = cueText(segment.text)
      const start = offsetMs + segment.startMs
      const end = Math.max(start + 1, offsetMs + Math.min(segment.endMs, chapter.durationMs))
      lines.push(`${vttTime(start)} --> ${vttTime(end)}`, text, "")
    }
    offsetMs += chapter.durationMs
  }
  return lines.join("\n")
}
