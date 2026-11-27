import { type Chapter, Episode, type Segment, segmentIndexAt } from "@fama/contracts"
import { Command, Component, Subscription, UiSchema } from "@effect/ui"
import { Button } from "@effect/ui-kit"
import { Html } from "@effect/ui/html"
import { Effect, Option, Queue, Redacted, Schema, Stream } from "effect"
import { AsyncResult } from "effect/reactivity"
import { AudioPlayer } from "~/core/audio"
import { TimingQuery, publicMediaPath } from "~/core/queries"
import { chapterStartMs } from "~/core/timeline"
import { buttonClass, cx } from "~/ui/button"

export const Mark = Schema.Struct({ chapter: Schema.Number, segment: Schema.Number })
export type Mark = typeof Mark.Type

export const isSameMark = (a: Mark, b: Mark): boolean => a.chapter === b.chapter && a.segment === b.segment
export const segmentId = (mark: Mark): string => `segment-${mark.chapter}-${mark.segment}`

export const MARK_SELECTOR = '#reader [aria-current="true"]'
const INTERACTIVE = "input, textarea, select, [contenteditable], button, a, [role=slider], [role^=menuitem], [role=menu]"
const SCROLL_KEYS = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]
const SETTLE_MS = 150

const sightBottom = (): number => window.innerHeight - (document.querySelector("footer")?.offsetHeight ?? 0)

export const isInSight = (element: Element): boolean => {
  const rect = element.getBoundingClientRect()
  return rect.bottom > 0 && rect.top < sightBottom()
}

export const ReaderScreenProps = Schema.Struct({
  episode: Episode,
  origin: Schema.String,
  chapter: Schema.Number,
  offsetMs: Schema.Number,
  isPlaying: Schema.Boolean,
})
export type ReaderScreenProps = typeof ReaderScreenProps.Type

export const ReaderScreenModel = Schema.Struct({
  isFollowing: Schema.Boolean,
  maybeShownMark: Schema.Option(Mark),
})
export type ReaderScreenModel = typeof ReaderScreenModel.Type

export const ReaderScreenMessage = UiSchema.TaggedEnum({
  ClickedSegment: { chapter: Schema.Number, segment: Schema.Number },
  GotSelectionOnClick: { chapter: Schema.Number, segment: Schema.Number, isSelecting: Schema.Boolean },
  ClickedFollow: {},
  SettledScrollByHand: { isMarkInView: Schema.Boolean },
  TickedAudioTime: { offsetMs: Schema.Number, atMs: Schema.Number },
  RequestedScrollToMark: { mark: Mark, isInstant: Schema.Boolean },
})
export type ReaderScreenMessage = typeof ReaderScreenMessage.Type

export const ReaderScreenEvents = UiSchema.TaggedEnum({
  PlayFrom: { positionMs: Schema.Number },
  UpdatedAudioTime: { offsetMs: Schema.Number, atMs: Schema.Number },
})
export type ReaderScreenEvents = typeof ReaderScreenEvents.Type

export const ReadSelection = Command.make(
  "reader/ReadSelection",
  { args: { chapter: Schema.Number, segment: Schema.Number } },
  ({ chapter, segment }) =>
    Effect.sync(() =>
      ReaderScreenMessage.GotSelectionOnClick({
        chapter,
        segment,
        isSelecting: !(window.getSelection()?.isCollapsed ?? true),
      }),
    ),
)

export const ScrollToMark = Command.make(
  "reader/ScrollToMark",
  { args: { id: Schema.String, isInstant: Schema.Boolean } },
  ({ id, isInstant }) =>
    Effect.sync(() => {
      const element = document.getElementById(id)
      if (element) {
        const space = sightBottom()
        const { top, bottom } = element.getBoundingClientRect()
        if (top < space * 0.15 || bottom > space * 0.7) {
          const isReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
          window.scrollTo({
            top: window.scrollY + top - space * 0.3,
            behavior: isInstant || isReduced ? "instant" : "smooth",
          })
        }
      }
      return Component.noop
    }),
)

const timingUrlsOf = (episode: Episode): ReadonlyArray<string> =>
  episode.chapters.flatMap((chapter) => (chapter.timingUrl !== null ? [chapter.timingUrl] : []))

const segmentsByPath = (
  results: Component.KeyedResults<typeof TimingQuery>,
): Map<string, ReadonlyArray<Segment>> => {
  const map = new Map<string, ReadonlyArray<Segment>>()
  for (const entry of results) {
    if (AsyncResult.isSuccess(entry.result)) {
      map.set(entry.args.path, entry.result.value.segments)
    }
  }
  return map
}

const currentMarkOf = (
  props: ReaderScreenProps,
  timings: Component.KeyedResults<typeof TimingQuery>,
): Option.Option<Mark> => {
  const chapter = props.episode.chapters[props.chapter]
  if (!chapter?.timingUrl) return Option.none()
  const segments = segmentsByPath(timings).get(publicMediaPath(chapter.timingUrl))
  if (!segments) return Option.none()
  return Option.map(Option.fromNullishOr(segmentIndexAt(segments, props.offsetMs)), (segment) => ({
    chapter: props.chapter,
    segment,
  }))
}

// --- Paragraph / heading layout ---

const keyOf = (text: string): string => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")

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
      result.push({ key: keyOf(open.map((item) => item.segment.text).join(" ")), segments: open })
      open = []
    }
  })
  return result
}

type Role = "Title" | "Author" | "Heading" | "Text"

const rolesOf = (episode: Episode, chapter: Chapter, list: ReadonlyArray<Paragraph>): ReadonlyArray<Role> => {
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
      : expected.find(([role, text]) => !found.has(role) && text !== null && keyOf(text) === paragraph.key)
    const role = match ? match[0] : "Text"
    found.add(role)
    result.push(role)
  }
  return result
}

export const ReaderScreenNoDeps = Html.component({
  name: "ReaderScreen",
  props: ReaderScreenProps,
  model: ReaderScreenModel,
  message: ReaderScreenMessage,
  events: ReaderScreenEvents,
  queries: {
    timings: {
      queryMany: TimingQuery,
      args: ({ props }) =>
        timingUrlsOf(props.episode).map((rawUrl) => ({
          origin: props.origin,
          path: publicMediaPath(rawUrl),
          url: Redacted.make(rawUrl),
        })),
    },
  },
}).make({
  init: () => ({ isFollowing: true, maybeShownMark: Option.none() }),
  update: {
    ClickedSegment: ($, { chapter, segment }) =>
      $.run(ReadSelection.make({ chapter, segment })),
    GotSelectionOnClick: ($, { chapter, segment, isSelecting }) => {
      if (isSelecting) return $.model
      const file = $.props.episode.chapters[chapter]
      if (!file?.timingUrl) return $.model
      const seg = segmentsByPath($.queries.timings).get(publicMediaPath(file.timingUrl))?.[segment]
      if (!seg) return $.model
      const mark = { chapter, segment }
      return $.evolve({ isFollowing: true, maybeShownMark: Option.some(mark) }).emit(
        ReaderScreenEvents.PlayFrom({
          positionMs: chapterStartMs($.props.episode.chapters, chapter) + seg.startMs,
        }),
      )
    },
    ClickedFollow: ($) => {
      const maybeMark = currentMarkOf($.props, $.queries.timings)
      if (Option.isNone(maybeMark)) {
        return $.evolve({ isFollowing: true, maybeShownMark: Option.none() })
      }
      const mark = maybeMark.value
      return $.evolve({ isFollowing: true, maybeShownMark: Option.some(mark) }).run(
        ScrollToMark.make({ id: segmentId(mark), isInstant: true }),
      )
    },
    SettledScrollByHand: ($, { isMarkInView }) =>
      $.evolve({
        isFollowing: isMarkInView,
        maybeShownMark: isMarkInView ? currentMarkOf($.props, $.queries.timings) : Option.none(),
      }),
    TickedAudioTime: ($, { offsetMs, atMs }) =>
      $.emit(ReaderScreenEvents.UpdatedAudioTime({ offsetMs, atMs })),
    RequestedScrollToMark: ($, { mark, isInstant }) =>
      $.evolve({ maybeShownMark: Option.some(mark) }).run(
        ScrollToMark.make({ id: segmentId(mark), isInstant }),
      ),
  },
  subscriptions: ({ model, props, queries }) => {
    const maybeMark = currentMarkOf(props, queries.timings)
    const shouldScroll =
      model.isFollowing &&
      Option.isSome(maybeMark) &&
      !Option.exists(model.maybeShownMark, (shown) => isSameMark(shown, maybeMark.value))
    const activeChapter = props.episode.chapters[props.chapter]
    const activeSegments =
      props.isPlaying && activeChapter?.timingUrl
        ? segmentsByPath(queries.timings).get(publicMediaPath(activeChapter.timingUrl))
        : undefined
    const startsKey = activeSegments ? activeSegments.map((s) => s.startMs).join(",") : ""

    return [
      shouldScroll &&
        Option.isSome(maybeMark) &&
        Subscription.make(
          "scroll-to-mark",
          [maybeMark.value.chapter, maybeMark.value.segment, Option.isNone(model.maybeShownMark)],
          ([chapter, segment, isInstant]) =>
            Stream.make(
              ReaderScreenMessage.RequestedScrollToMark({
                mark: { chapter, segment },
                isInstant,
              }),
            ),
        ),
      startsKey.length > 0 &&
        Subscription.make("read-along", startsKey, (key) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const audio = yield* AudioPlayer
              const segments = key.split(",").map((raw) => ({ startMs: Number(raw) }))
              return Stream.callback<ReaderScreenMessage>((queue) =>
                Effect.acquireRelease(
                  Effect.sync(() => {
                    let shown: number | null | undefined
                    let frame = 0
                    const read = () => {
                      const offsetMs = audio.currentTime * 1000
                      const index = segmentIndexAt(segments, offsetMs)
                      if (index !== shown) {
                        shown = index
                        Queue.offerUnsafe(
                          queue,
                          ReaderScreenMessage.TickedAudioTime({ offsetMs, atMs: Date.now() }),
                        )
                      }
                      frame = requestAnimationFrame(read)
                    }
                    frame = requestAnimationFrame(read)
                    return () => cancelAnimationFrame(frame)
                  }),
                  (stop) => Effect.sync(stop),
                ).pipe(Effect.flatMap(() => Effect.never)),
              )
            }),
          ),
        ),
      Subscription.make(
        "scroll-by-hand",
        Stream.callback<ReaderScreenMessage>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              let isByHand = false
              let timer: ReturnType<typeof setTimeout> | undefined
              const byHand = () => {
                isByHand = true
              }
              const onKey = (event: KeyboardEvent) => {
                const target = event.target instanceof Element ? event.target : null
                if (SCROLL_KEYS.includes(event.key) && !target?.closest(INTERACTIVE)) byHand()
              }
              const onPointer = (event: PointerEvent) => {
                if (event.target === document.documentElement) byHand()
              }
              let suspended = false
              const onScroll = () => {
                if (!isByHand) return
                const current = document.querySelector(MARK_SELECTOR)
                if (!suspended && (!current || !isInSight(current))) {
                  suspended = true
                  Queue.offerUnsafe(queue, ReaderScreenMessage.SettledScrollByHand({ isMarkInView: false }))
                }
                clearTimeout(timer)
                timer = setTimeout(() => {
                  suspended = false
                  isByHand = false
                  const mark = document.querySelector(MARK_SELECTOR)
                  Queue.offerUnsafe(
                    queue,
                    ReaderScreenMessage.SettledScrollByHand({ isMarkInView: mark !== null && isInSight(mark) }),
                  )
                }, SETTLE_MS)
              }
              const listeners = [
                ["wheel", byHand],
                ["touchmove", byHand],
                ["keydown", onKey],
                ["pointerdown", onPointer],
                ["scroll", onScroll],
              ] as const
              for (const [type, listener] of listeners) {
                window.addEventListener(type, listener as EventListener, { passive: true })
              }
              return () => {
                clearTimeout(timer)
                for (const [type, listener] of listeners) {
                  window.removeEventListener(type, listener as EventListener)
                }
              }
            }),
            (stop) => Effect.sync(stop),
          ).pipe(Effect.flatMap(() => Effect.never)),
        ),
      ),
    ]
  },
  view: (h, model) => {
    const { episode } = h.props
    const byPath = segmentsByPath(h.queries.timings)
    const maybeMark = currentMarkOf(h.props, h.queries.timings)

    const segmentSpans = (paragraph: Paragraph, chapterIndex: number) =>
      paragraph.segments.flatMap(({ index, segment }, position) => {
        const mark = { chapter: chapterIndex, segment: index }
        const isCurrent = Option.exists(maybeMark, (current) => isSameMark(current, mark))
        const element = h.span
          .id(segmentId(mark))
          .attrs({
            role: "button",
            tabindex: "0",
            ...(isCurrent ? { "aria-current": "true" } : {}),
          })
          .class(
            cx(
              "cursor-pointer rounded-[0.3em] px-[0.12em] -mx-[0.12em] py-[0.08em] [box-decoration-break:clone] transition-colors duration-200",
              isCurrent
                ? "bg-[light-dark(rgb(147_88_65/0.14),rgb(234_187_159/0.16))] text-foreground"
                : "hover:bg-accent",
            ),
          )
          .on("click", ReaderScreenMessage.ClickedSegment(mark))
          .on(
            "keydown",
            ({ key }) =>
              key === "Enter" || key === " "
                ? ReaderScreenMessage.GotSelectionOnClick({ ...mark, isSelecting: false })
                : undefined,
            { preventDefault: true },
          )
          .children(segment.text)
        return position === 0 ? [element] : [" ", element]
      })

    const chapterContent = (chapter: Chapter) => {
      const segments = chapter.timingUrl ? byPath.get(publicMediaPath(chapter.timingUrl)) : undefined
      if (!segments) return []
      const list = paragraphs(segments)
      const listRoles = rolesOf(episode, chapter, list)
      const headingClass = "mt-14 mb-5 text-xl font-semibold leading-snug text-foreground first:mt-0"
      const blocks = list.map((paragraph, index) => {
        const spans = segmentSpans(paragraph, chapter.index)
        switch (listRoles[index]) {
          case "Title":
            return h.h1.class("mb-1 text-2xl font-semibold leading-tight text-foreground").children(...spans)
          case "Author":
            return h.p.class("text-muted-foreground").children(...spans)
          case "Heading":
            return h.h2.class(headingClass).children(...spans)
          default:
            return h.p.class("mb-[1.1em]").children(...spans)
        }
      })
      const hasTitle = listRoles.includes("Title")
      const hasHeading = listRoles.includes("Heading")
      const firstBody = listRoles.findIndex((role) => role !== "Title" && role !== "Author")
      const prefixCount = firstBody === -1 ? blocks.length : firstBody
      const isFirst = chapter.index === 0
      return [
        isFirst && !hasTitle && h.h1.class("mb-1 text-2xl font-semibold leading-tight").children(episode.title),
        isFirst && !hasTitle && episode.author && h.p.class("text-muted-foreground").children(episode.author),
        ...blocks.slice(0, prefixCount),
        !hasHeading && episode.chapters.length > 1 && h.h2.class(headingClass).children(chapter.title),
        ...blocks.slice(prefixCount),
      ]
    }

    return h.div.children(
      h.article
        .id("reader")
        .attr("lang", episode.language ?? "")
        .class("mt-4 text-[17px] leading-[1.7] text-foreground/85 sm:text-lg")
        .children(
          ...episode.chapters.map((chapter) =>
            h.section.key(`${episode.id}-${chapter.index}`).children(...chapterContent(chapter)),
          ),
        ),
      !model.isFollowing &&
        Option.isSome(maybeMark) &&
        h.div.class("pointer-events-none fixed inset-x-0 bottom-28 z-40 flex justify-center sm:bottom-24").children(
          Button(h, { onPress: ReaderScreenMessage.ClickedFollow() })
            .class(
              buttonClass(
                { variant: "outline", size: "sm" },
                "pointer-events-auto rounded-full bg-popover shadow-[0_8px_24px_rgb(0_0_0/0.35)] hover:bg-popover",
              ),
            )
            .children("Current sentence"),
        ),
    )
  },
})

export const ReaderScreen = ReaderScreenNoDeps.pipe(Component.provide(TimingQuery.layer))
