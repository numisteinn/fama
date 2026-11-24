import type { Chapter, Episode, Segment } from "@fama/contracts"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message } from "~/message"
import { type LoadedPlayback, type Model, current } from "~/model"
import { ReaderMessage } from "~/reader/message"
import { type Mark, chapterText, hasText, isSameMark, markAt, segmentId } from "~/reader/model"
import { buttonClass, cx } from "~/view/button"
import * as Icon from "~/view/icon"

const toParent = (message: ReaderMessage) => Message.GotReaderMessage({ message })

/** The reader is open on the episode that plays. */
const shown = (model: Model): Option.Option<{ playback: LoadedPlayback; episode: Episode; isFollowing: boolean }> => {
  const view = model.reader.view
  if (view._tag !== "Open") return Option.none()
  return Option.map(
    Option.filter(current(model), ({ episode }) => episode.id === view.episodeId),
    (loaded) => ({ ...loaded, isFollowing: view.isFollowing }),
  )
}

export const isReaderShown = (model: Model): boolean => Option.isSome(shown(model))

/** The player bar's Text button. An episode with no timing file has none. */
export const textButton = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Option.match(current(model), {
    onNone: () => [],
    onSome: ({ episode }) =>
      hasText(episode)
        ? [
            h.button(
              [
                h.Type("button"),
                h.AriaLabel("Text"),
                h.AriaPressed(String(isReaderShown(model))),
                h.OnClick(toParent(ReaderMessage.ClickedText())),
                h.Class(buttonClass({ size: "icon-sm" }, "aria-pressed:bg-accent aria-pressed:text-foreground")),
              ],
              [Icon.bookOpenText()],
            ),
          ]
        : [],
  })

/** Shown above the player bar while the listener has scrolled away from the sentence the voice reads. */
export const followButton = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Option.match(shown(model), {
    onNone: () => [],
    onSome: ({ playback, episode, isFollowing }) =>
      isFollowing || Option.isNone(markAt(model.reader, episode, playback.chapter, playback.offsetMs))
        ? []
        : [
            h.button(
              [
                h.Type("button"),
                h.OnClick(toParent(ReaderMessage.ClickedFollow())),
                h.Class(
                  buttonClass(
                    { variant: "outline", size: "sm" },
                    "absolute bottom-full left-1/2 mb-3 -translate-x-1/2 rounded-full bg-popover shadow-[0_8px_24px_rgb(0_0_0/0.35)] hover:bg-popover",
                  ),
                ),
              ],
              ["Current sentence"],
            ),
          ],
  })

// TEXT

/** Text compared without case, spaces or punctuation, as the worker compares titles. */
const key = (text: string): string => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")

interface Paragraph {
  readonly key: string
  readonly segments: ReadonlyArray<{ readonly index: number; readonly segment: Segment }>
}

const paragraphs = (segments: ReadonlyArray<Segment>): ReadonlyArray<Paragraph> => {
  const result: Array<Paragraph> = []
  let open: Array<{ index: number; segment: Segment }> = []
  segments.forEach((segment, index) => {
    open.push({ index, segment })
    if (segment.endsParagraph || index === segments.length - 1) {
      result.push({ key: key(open.map((item) => item.segment.text).join(" ")), segments: open })
      open = []
    }
  })
  return result
}

/**
 * The worker speaks the title, the author and the chapter title before the text, each as its own paragraph. The
 * reader shows them as the headings they are, so no heading shows twice.
 */
type Role = "Title" | "Author" | "Heading" | "Text"

const roles = (episode: Episode, chapter: Chapter, list: ReadonlyArray<Paragraph>): ReadonlyArray<Role> => {
  const result: Array<Role> = []
  const found = new Set<Role>()
  const expected: ReadonlyArray<readonly [Role, string | null]> = [
    ["Title", chapter.index === 0 ? episode.title : null],
    ["Author", chapter.index === 0 ? episode.author : null],
    ["Heading", chapter.title],
  ]
  for (const paragraph of list) {
    const match = found.has("Text")
      ? undefined
      : expected.find(([role, text]) => !found.has(role) && text !== null && key(text) === paragraph.key)
    const role = match ? match[0] : "Text"
    found.add(role)
    result.push(role)
  }
  return result
}

const segmentSpans = (paragraph: Paragraph, chapter: number, maybeMark: Option.Option<Mark>, h: HtmlBuilder<Message>) =>
  paragraph.segments.flatMap(({ index, segment }, position): ReadonlyArray<Html | string> => {
    const mark = { chapter, segment: index }
    const isCurrent = Option.exists(maybeMark, (current) => isSameMark(current, mark))
    const attributes = [
      h.Id(segmentId(mark)),
      h.OnClick(toParent(ReaderMessage.ClickedSegment(mark))),
      h.Class(
        cx(
          "cursor-pointer rounded-[0.3em] px-[0.12em] -mx-[0.12em] py-[0.08em] [box-decoration-break:clone] transition-colors duration-200",
          isCurrent
            ? "bg-[light-dark(rgb(147_88_65/0.14),rgb(234_187_159/0.16))] text-foreground"
            : "hover:bg-accent",
        ),
      ),
    ]
    const element = h.span([
      ...attributes,
      ...(isCurrent ? [h.AriaCurrent("true")] : []),
      h.Role("button"),
      h.Tabindex(0),
      h.OnKeyDownPreventDefault((key) =>
        key === "Enter" || key === " "
          ? Option.some(toParent(ReaderMessage.GotSelectionOnClick({ ...mark, isSelecting: false })))
          : Option.none(),
      ),
    ], [segment.text])
    return position === 0 ? [element] : [" ", element]
  })

const chapterView = (
  model: Model,
  episode: Episode,
  chapter: Chapter,
  maybeMark: Option.Option<Mark>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const text = chapterText(model.reader, chapter)
  if (text._tag !== "Loaded") return []
  const list = paragraphs(text.segments)
  const listRoles = roles(episode, chapter, list)
  const headingClass = "mt-14 mb-5 text-xl font-semibold leading-snug text-foreground first:mt-0"
  const blocks = list.map((paragraph, index) => {
    const spans = segmentSpans(paragraph, chapter.index, maybeMark, h)
    switch (listRoles[index]) {
      case "Title":
        return h.h1([h.Class("mb-1 text-2xl font-semibold leading-tight text-foreground")], spans)
      case "Author":
        return h.p([h.Class("text-muted-foreground")], spans)
      case "Heading":
        return h.h2([h.Class(headingClass)], spans)
      default:
        return h.p([h.Class("mb-[1.1em]")], spans)
    }
  })
  const hasTitle = listRoles.includes("Title")
  const hasHeading = listRoles.includes("Heading")
  const firstBody = listRoles.findIndex((role) => role !== "Title" && role !== "Author")
  const prefixCount = firstBody === -1 ? blocks.length : firstBody
  const isFirst = chapter.index === 0
  return [
    ...(isFirst && !hasTitle ? [h.h1([h.Class("mb-1 text-2xl font-semibold leading-tight")], [episode.title])] : []),
    ...(isFirst && !hasTitle && episode.author ? [h.p([h.Class("text-muted-foreground")], [episode.author])] : []),
    ...blocks.slice(0, prefixCount),
    ...(!hasHeading && episode.chapters.length > 1 ? [h.h2([h.Class(headingClass)], [chapter.title])] : []),
    ...blocks.slice(prefixCount),
  ]
}

/** The text of the episode that plays, with the sentence the voice reads marked. */
export const reader = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(shown(model), {
    onNone: () => h.empty,
    onSome: ({ playback, episode }) => {
      const maybeMark = markAt(model.reader, episode, playback.chapter, playback.offsetMs)
      return h.article(
        [
          h.Id("reader"),
          h.Lang(episode.language ?? ""),
          h.Class("mt-4 text-[17px] leading-[1.7] text-foreground/85 sm:text-lg"),
        ],
        episode.chapters.map((chapter) =>
          h.keyed("section")(`${episode.id}-${chapter.index}`, [], chapterView(model, episode, chapter, maybeMark, h)),
        ),
      )
    },
  })
