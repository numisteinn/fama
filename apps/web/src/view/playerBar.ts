import type { Episode } from "@fama/contracts"
import { UiSchema } from "@effect/ui"
import type { Html } from "@effect/ui/html"
import { Option, Schema } from "effect"
import { SCRUB_STEP_MS, chapterStartMs, scrubMaxMs, totalMs } from "~/core/timeline"
import { formatClock, formatRate } from "~/lib/format"
import { type SleepTimer, SLEEP_PRESET_MINUTES, sleepBadge, sleepChoiceValue, sleepLabel } from "~/playback/sleepTimer"
import { Picker, type PickerOption } from "~/ui/Picker"
import { buttonClass, cx } from "~/ui/button"
import * as Icon from "~/ui/icon"

/** The slice of the loaded playback the bar renders. */
export interface PlayerBarPlayback {
  readonly chapter: number
  readonly offsetMs: number
  readonly isPlaying: boolean
  readonly isWaiting: boolean
}

/** What the player bar needs, computed by the App. */
export interface PlayerBarProps {
  readonly playback: PlayerBarPlayback
  readonly episode: Episode
  readonly rate: number
  readonly rates: ReadonlyArray<number>
  readonly skipBackMs: number
  readonly skipForwardMs: number
  readonly isReaderOpen: boolean
  readonly isPending: boolean
  readonly hasText: boolean
  readonly maybeScrubMs: Option.Option<number>
  readonly sleep: SleepTimer
  readonly sleepAtMs: number
  readonly origin: string
}

export const PlayerBarEvents = UiSchema.TaggedEnum({
  PickedPlaybackSpeed: { value: Schema.String },
  PickedChapter: { value: Schema.String },
  PickedSleep: { value: Schema.String, nowMs: Schema.Number },
  ToggledReader: {},
  ClickedPlayPause: {},
  ClickedSkip: { deltaMs: Schema.Number },
  UpdatedScrub: { value: Schema.String },
  CommittedScrub: { value: Schema.String },
})
export type PlayerBarEvents = typeof PlayerBarEvents.Type

/** The bar at the bottom while an episode is loaded. */
export const PlayerBar = <M>(props: PlayerBarProps, h: Html.H<M>, emit: (e: PlayerBarEvents) => M) => {
  const { playback, episode } = props
  const chapter = episode.chapters[playback.chapter]
  const chapterOptions: ReadonlyArray<PickerOption> = episode.chapters.map((item, index) => ({
    value: String(index),
    name: item.title,
    number: index + 1,
  }))
  const rateOptions: ReadonlyArray<PickerOption> = props.rates.map((rate) => ({
    value: String(rate),
    name: formatRate(rate),
  }))

  return h.footer
    .class("fixed inset-x-0 bottom-0 z-30 border-t border-border pb-[env(safe-area-inset-bottom)]")
    .children(
      h.div.attr("aria-hidden", "true").class("absolute inset-0 -z-10 bg-background/90 backdrop-blur-xl"),
      h.div
        .class(
          "mx-auto grid max-w-5xl grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:gap-x-6",
        )
        .children(
          h.div.class("min-w-0").children(
            h.div.class("truncate text-sm font-medium").children(episode.title),
            episode.chapters.length > 1 &&
              chapter &&
              h.div.class("truncate text-[13px] text-muted-foreground").children(chapter.title),
          ),
          h.div.class("contents sm:flex sm:flex-col sm:items-center sm:gap-1").children(
            transport(playback, props, h, emit),
            scrubber(props, playback, episode, h, emit),
          ),
          h.div
            .class("col-span-2 flex items-center justify-between gap-1 sm:col-span-1 sm:justify-end")
            .children(
              Picker(h, {
                key: "playback-speed",
                props: {
                  label: `Playback speed: ${formatRate(props.rate)}`,
                  triggerText: formatRate(props.rate),
                  triggerKind: "playbackSpeed",
                  triggerClass: buttonClass({ size: "sm" }, "w-14 tabular-nums"),
                  selectedValue: String(props.rate),
                  items: rateOptions,
                  side: "top",
                },
                onEmit: {
                  Picked: ({ value }) => emit(PlayerBarEvents.PickedPlaybackSpeed({ value })),
                },
              }),
              h.div.class("flex items-center justify-end gap-1").children(
                props.hasText &&
                  h.button
                    .attrs({
                      type: "button",
                      "aria-label": "Text",
                      "aria-pressed": String(props.isReaderOpen),
                    })
                    .on("click", emit(PlayerBarEvents.ToggledReader()))
                    .class(buttonClass({ size: "icon-sm" }, cx(props.isReaderOpen && "bg-accent text-foreground")))
                    .children(Icon.bookOpenText(h)),
                sleepPicker(props, h, emit),
                episode.chapters.length > 1 &&
                  Picker(h, {
                    key: "chapters",
                    props: {
                      label: "Chapters",
                      triggerText: "",
                      triggerKind: "chapters",
                      triggerClass: buttonClass({ size: "icon-sm" }),
                      selectedValue: String(playback.chapter),
                      items: chapterOptions,
                      side: "top",
                      align: "end",
                    },
                    onEmit: {
                      Picked: ({ value }) => emit(PlayerBarEvents.PickedChapter({ value })),
                    },
                  }),
                episode.bookUrl &&
                  h.a
                    .attrs({
                      href: props.origin + episode.bookUrl,
                      download: `${episode.title}.m4b`,
                      "aria-label": "Download",
                    })
                    .class(buttonClass({ size: "icon-sm" }))
                    .children(Icon.download(h)),
              ),
            ),
        ),
    )
}

/** The menu of the sleep timer: `Off` and `+5 min` while they apply, the presets, and the chapter end. */
export const sleepOptions = (sleep: SleepTimer): ReadonlyArray<PickerOption> => [
  ...(sleep._tag !== "Off" ? [{ value: "off", name: "Off" }] : []),
  ...(sleep._tag === "Countdown" ? [{ value: "+5", name: "+5 min" }] : []),
  ...SLEEP_PRESET_MINUTES.map((minutes) => ({ value: String(minutes), name: `${minutes} min` })),
  { value: "end", name: "End of chapter" },
]

/** The moon button with the countdown badge, and the menu behind it. */
const sleepPicker = <M>(props: PlayerBarProps, h: Html.H<M>, emit: (e: PlayerBarEvents) => M) => {
  const badge = sleepBadge(props.sleep, props.sleepAtMs)
  return Picker(h, {
    key: "sleep-timer",
    props: {
      label: sleepLabel(props.sleep, props.sleepAtMs),
      triggerText: badge ?? "",
      triggerKind: "sleep",
      triggerClass: buttonClass(
        { size: badge === null ? "icon-sm" : "sm" },
        cx(badge !== null && "gap-1 bg-accent px-2 text-foreground tabular-nums"),
      ),
      selectedValue: sleepChoiceValue(props.sleep),
      items: sleepOptions(props.sleep),
      side: "top",
      align: "end",
    },
    onEmit: {
      Picked: ({ value }) => emit(PlayerBarEvents.PickedSleep({ value, nowMs: Date.now() })),
    },
  })
}

const transport = <M>(
  playback: PlayerBarPlayback,
  { isPending, skipBackMs, skipForwardMs }: Pick<PlayerBarProps, "isPending" | "skipBackMs" | "skipForwardMs">,
  h: Html.H<M>,
  emit: (e: PlayerBarEvents) => M,
) =>
  h.div.class("col-start-2 row-start-1 flex items-center gap-1 sm:col-auto sm:row-auto").children(
    skipButton(h, -skipBackMs, emit),
    playButton(playback, isPending, h, emit),
    skipButton(h, skipForwardMs, emit),
    h.span.attr("aria-live", "polite").class("sr-only").children(playback.isWaiting ? "Waiting for the next chapter" : ""),
  )

/** The spinner shows a Play that waits: for the next chapter, or for the library (`isPending`). */
const playButton = <M>(playback: PlayerBarPlayback, isPending: boolean, h: Html.H<M>, emit: (e: PlayerBarEvents) => M) =>
  h.button
    .attrs({ type: "button", "aria-label": playback.isPlaying ? "Pause" : "Play" })
    .on("click", emit(PlayerBarEvents.ClickedPlayPause()))
    .class(buttonClass({ variant: "primary", size: "icon-lg" }))
    .children(
      playback.isWaiting || isPending
        ? Icon.loaderCircle(h, "animate-spin")
        : playback.isPlaying
          ? Icon.pause(h, "fill-current")
          : Icon.play(h, "translate-x-px fill-current"),
    )

const skipButton = <M>(h: Html.H<M>, deltaMs: number, emit: (e: PlayerBarEvents) => M) => {
  const direction = deltaMs < 0 ? "Back" : "Forward"
  const seconds = Math.abs(deltaMs) / 1000
  return h.button
    .attrs({ type: "button", "aria-label": `${direction} ${seconds} seconds` })
    .on("click", emit(PlayerBarEvents.ClickedSkip({ deltaMs })))
    .class(buttonClass({ size: "icon" }))
    .children(skipIcon(direction, seconds, h))
}

const skipIcon = <M>(direction: "Back" | "Forward", seconds: number, h: Html.H<M>) =>
  h.span.class("relative grid size-6 place-items-center").children(
    (direction === "Back" ? Icon.rotateCcw : Icon.rotateCw)(h, "absolute size-6 stroke-[1.5]"),
    h.span.class("relative text-[8.5px] leading-none font-semibold tabular-nums").children(String(seconds)),
  )

/** Position on the whole episode. The value moves while dragging; the seek happens on release. */
const scrubber = <M>(
  props: PlayerBarProps,
  playback: PlayerBarPlayback,
  episode: Episode,
  h: Html.H<M>,
  emit: (e: PlayerBarEvents) => M,
) => {
  const durationMs = totalMs(episode.chapters)
  const positionMs = chapterStartMs(episode.chapters, playback.chapter) + playback.offsetMs
  const max = scrubMaxMs(episode.chapters)
  const value = Option.getOrElse(props.maybeScrubMs, () => (positionMs >= durationMs ? max : positionMs))
  const shownMs = Math.min(value, durationMs)
  return h.div
    .class("col-span-2 flex w-full items-center gap-3 text-xs text-muted-foreground tabular-nums sm:col-span-1")
    .children(
      h.span.class("w-12 text-right").children(formatClock(shownMs)),
      h.div.attrs({ role: "group", "aria-label": "Position" }).class("flex-1").children(
        h.input
          .attrs({
            type: "range",
            min: "0",
            max: String(max),
            step: String(SCRUB_STEP_MS),
            "aria-valuenow": String(shownMs),
            "aria-valuetext": formatClock(shownMs),
          })
          .value(String(value))
          .on("input", ({ value: next }) => emit(PlayerBarEvents.UpdatedScrub({ value: next })))
          .on("change", ({ value: next }) => emit(PlayerBarEvents.CommittedScrub({ value: next })))
          .class("scrubber")
          .style({ "--fill": `${(value / max) * 100}%` }),
      ),
      h.span.class("w-12").children(formatClock(durationMs)),
    )
}
