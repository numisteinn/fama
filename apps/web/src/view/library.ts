import type { Episode, JobState } from "@fama/contracts"
import type { Html } from "@effect/ui/html"
import { Option } from "effect"
import { DeleteConfirmRef } from "~/command"
import { formatDuration } from "~/lib/format"
import { AppMessage } from "~/message"
import type { AppModel } from "~/model"
import { totalMs } from "~/timeline"
import { buttonClass, cx } from "~/view/button"
import * as Icon from "~/view/icon"

/** Status badge on a Library row whose job waits in Review. */
const reviewBadge = (h: Html.H<AppMessage>) =>
  h.span
    .class(
      "inline-flex shrink-0 items-center gap-1 rounded-full border border-input bg-accent px-2.5 py-0.5 text-[13px] font-medium text-foreground",
    )
    .children("Review", Icon.chevronRight(h, "size-3.5 text-muted-foreground"))

/** The episode list, or the error of the first load with a way to try again. */
export const Library = (model: AppModel, h: Html.H<AppMessage>) =>
  Option.match(model.maybeEpisodes, {
    onNone: () =>
      Option.match(model.maybeLibraryFailure, {
        onNone: () => null,
        onSome: (failure) =>
          h.div
            .class("flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3 text-sm")
            .children(
              h.span.class("text-destructive").children(failure.message),
              h.button
                .attr("type", "button")
                .on("click", AppMessage.ClickedTryAgain())
                .class(buttonClass({ variant: "outline", size: "sm" }))
                .children("Try again"),
            ),
      }),
    onSome: (list) =>
      list.length === 0
        ? h.img
            .attrs({ src: "/pan-sleeping.png", alt: "", draggable: "false" })
            .class("mx-auto mt-16 size-40 select-none")
        : h.ul.class("-mx-2 flex flex-col").children(...list.map((episode) => row(model, episode, h))),
  })

const row = (model: AppModel, episode: Episode, h: Html.H<AppMessage>) => {
  const playback = model.playback
  const isCurrent = playback._tag === "Loaded" && playback.episodeId === episode.id
  const isPlaying = isCurrent && playback.isPlaying
  const isPlayable = episode.chapters.length > 0
  const isReview = episode.job._tag === "Review"
  const isActionable = isPlayable || isReview
  const maybeRowError = Option.fromNullishOr(model.rowErrors[episode.id])
  const maybeErrorText = Option.orElse(maybeRowError, () =>
    episode.job._tag === "Failed" ? Option.some(episode.job.reason) : Option.none(),
  )
  const isArmed = model.armedDeletes.includes(episode.id)

  return h.li
    .key(episode.id)
    .class(
      cx(
        "group relative flex min-h-14 items-center gap-3 rounded-xl px-2 py-2 transition-colors duration-150",
        isActionable && "hover:bg-accent",
        isCurrent && "bg-accent",
      ),
    )
    .children(
      h.button
        .attrs({
          type: "button",
          "aria-label": isReview
            ? `Review ${episode.title}`
            : isPlaying
              ? `Pause ${episode.title}`
              : `Play ${episode.title}`,
        })
        .disabled(!isActionable)
        .on(
          "click",
          isReview
            ? AppMessage.ClickedOpenReview({ episodeId: episode.id })
            : AppMessage.ClickedPlayEpisode({ episodeId: episode.id }),
        )
        .class(
          "flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left outline-none disabled:cursor-default before:absolute before:inset-0 before:rounded-xl focus-visible:before:ring-2 focus-visible:before:ring-ring",
        )
        .children(
          artwork(model, episode, isCurrent, isPlaying, h),
          h.span.class("min-w-0 flex-1").children(
            h.span.class("block truncate text-[15px] leading-snug").children(episode.title),
            Option.match(maybeErrorText, {
              onNone: () => null,
              onSome: (text) =>
                h.span
                  .attr("title", Option.getOrUndefined(maybeRowError))
                  .class("block truncate text-[13px] text-destructive")
                  .children(text),
            }),
          ),
        ),
      jobStatus(episode, h),
      (episode.job._tag === "Ready" || episode.job._tag === "Failed") &&
        h.button
          .attrs({
            type: "button",
            "aria-label": `Narrate again ${episode.title}`,
            title: "Narrate again",
          })
          .on("click", AppMessage.ClickedOpenNarrateAgain({ episodeId: episode.id }))
          .class(
            buttonClass(
              { size: "icon-sm" },
              "relative opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100",
            ),
          )
          .children(Icon.pencil(h)),
      episode.job._tag === "Failed" &&
        h.button
          .attr("type", "button")
          .on("click", AppMessage.ClickedRetry({ episodeId: episode.id }))
          .class(buttonClass({ variant: "outline", size: "sm" }, "relative"))
          .children(Icon.rotateCw(h), "Retry"),
      isArmed
        ? h.button
            .ref(DeleteConfirmRef.at(episode.id))
            .attr("type", "button")
            .on("click", AppMessage.ClickedConfirmDelete({ episodeId: episode.id }))
            .class(buttonClass({ variant: "destructive", size: "sm" }, "relative"))
            .children("Delete")
        : h.button
            .attrs({ type: "button", "aria-label": `Delete ${episode.title}` })
            .on("click", AppMessage.ClickedArmDelete({ episodeId: episode.id }))
            .class(
              buttonClass(
                { size: "icon-sm" },
                "relative opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100",
              ),
            )
            .children(Icon.trash(h)),
    )
}

const SOURCE_ICON = { Url: Icon.link, Text: Icon.alignLeft, File: Icon.fileText } as const

const artwork = (
  model: AppModel,
  episode: Episode,
  isCurrent: boolean,
  isPlaying: boolean,
  h: Html.H<AppMessage>,
) => {
  const isHoverPlay = episode.chapters.length > 0 && !isPlaying
  const sourceIcon = SOURCE_ICON[episode.source._tag]
  return h.span
    .class(
      "relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-accent text-muted-foreground",
    )
    .children(
      episode.coverUrl
        ? h.img
            .attrs({ src: model.connection.origin + episode.coverUrl, alt: "" })
            .class("absolute inset-0 size-full object-cover")
        : !isPlaying &&
            sourceIcon(
              h,
              cx(
                "absolute size-4 transition-opacity duration-150",
                isHoverPlay && "group-hover:opacity-0",
                isCurrent && "opacity-0",
              ),
            ),
      isPlaying
        ? Icon.audioLines(h, "relative size-4.5 text-foreground")
        : isHoverPlay &&
            Icon.play(
              h,
              cx(
                "relative size-4 fill-current text-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100",
                isCurrent && "opacity-100",
              ),
            ),
    )
}

const STAGE: Record<Extract<JobState, { _tag: "Running" }>["stage"], string> = {
  extracting: "Reading",
  synthesizing: "Narrating",
  encoding: "Encoding",
  uploading: "Uploading",
}

const jobStatus = (episode: Episode, h: Html.H<AppMessage>) => {
  const { job } = episode
  switch (job._tag) {
    case "Ready":
      return h.span
        .class("shrink-0 text-[13px] text-muted-foreground tabular-nums")
        .children(formatDuration(episode.durationMs ?? totalMs(episode.chapters)))
    case "Queued":
      return h.span.class("shrink-0 animate-pulse text-[13px] text-muted-foreground").children("Queued")
    case "Review":
      return reviewBadge(h)
    case "Running": {
      const fraction = job.total > 0 ? Math.min(1, job.done / job.total) : 0
      const detail =
        job.remainingMs !== null
          ? ` · ${formatDuration(job.remainingMs)} left`
          : job.stage === "synthesizing" && job.total > 0
            ? ` ${job.done}/${job.total}`
            : ""
      return h.span
        .class("flex min-w-28 shrink-0 flex-col items-end gap-1.5 text-[13px] text-muted-foreground tabular-nums")
        .children(
          h.span.class("whitespace-nowrap").children(STAGE[job.stage] + detail),
          h.span
            .attr("aria-hidden", "true")
            .class("h-0.5 w-full overflow-hidden rounded-full bg-faint")
            .children(
              h.span
                .class(
                  "block h-full origin-left rounded-full bg-foreground transition-transform duration-700 ease-out",
                )
                .style({ transform: `scaleX(${fraction})` }),
            ),
        )
    }
    case "Failed":
      return null
  }
}
