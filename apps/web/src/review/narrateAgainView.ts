import type { EpisodeId } from "@fama/contracts"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { formatRate } from "~/lib/format"
import { Message } from "~/message"
import { type Model, SPEEDS, episodes, languageName, sortedVoices } from "~/model"
import { NarrateAgainMessage } from "~/review/narrateAgainMessage"
import {
  type EditingNarrateAgain,
  isSubmitting,
  isTextDirty,
  isVoiceDirty,
} from "~/review/narrateAgainModel"
import { buttonClass } from "~/view/button"
import * as Icon from "~/view/icon"

const toParent = (message: NarrateAgainMessage) => Message.GotNarrateAgainMessage({ message })

export const isNarrateAgainShown = (model: Model): boolean => model.narrateAgain.view._tag !== "Closed"

export const openNarrateAgainMessage = (episodeId: EpisodeId): Message =>
  toParent(NarrateAgainMessage.ClickedEpisode({ episodeId }))

const backButton = (h: HtmlBuilder<Message>): Html =>
  h.button(
    [h.Type("button"), h.OnClick(toParent(NarrateAgainMessage.ClickedBack())), h.Class(buttonClass({ size: "sm" }, "-ml-2"))],
    [Icon.arrowLeft(), "Back"],
  )

const chapterText = (editing: EditingNarrateAgain, h: HtmlBuilder<Message>): Html =>
  Option.match(editing.document, {
    onNone: () =>
      h.p(
        [h.Role("status"), h.Class("rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground")],
        ["Chapter text is not stored for this episode. You can still change the voice and speed."],
      ),
    onSome: (document) => {
      const busy = isSubmitting(editing)
      return h.section(
        [h.Class("flex flex-col gap-3")],
        [
          h.h2([h.Class("text-lg font-semibold")], ["Chapter text"]),
          h.ul(
            [h.Class("flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface")],
            document.chapters.map((chapter, index) => {
              const expanded = Option.contains(editing.maybeExpandedIndex, index)
              const panelId = `narrate-again-chapter-${index}`
              return h.keyed("li")(
                String(index),
                [],
                [
                  h.button(
                    [
                      h.Type("button"),
                      h.AriaLabel(`${index + 1} ${chapter.title}`),
                      h.AriaExpanded(expanded),
                      h.AriaControls(panelId),
                      h.OnClick(toParent(NarrateAgainMessage.ClickedChapter({ index }))),
                      h.Class(
                        "flex min-h-12 w-full min-w-0 cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      ),
                    ],
                    [
                      h.span(
                        [h.Class("flex min-w-0 items-baseline gap-2.5")],
                        [
                          h.span([h.Class("w-6 text-right text-[13px] text-muted-foreground tabular-nums")], [String(index + 1)]),
                          h.span([h.Class("truncate text-[15px]")], [chapter.title]),
                        ],
                      ),
                      Icon.chevronDown(expanded ? "size-4 rotate-180 text-muted-foreground" : "size-4 text-muted-foreground"),
                    ],
                  ),
                  ...(expanded
                    ? [
                        h.div(
                          [h.Id(panelId), h.Class("border-t border-border p-3")],
                          [
                            h.textarea([
                              h.AriaLabel(`Text of ${chapter.title}`),
                              h.Value(editing.texts[index] ?? chapter.text),
                              h.Rows(10),
                              h.Disabled(busy),
                              h.OnInput((value) => toParent(NarrateAgainMessage.UpdatedChapterText({ index, value }))),
                              h.Class(
                                "min-h-48 max-h-[55vh] w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2.5 text-base leading-relaxed outline-none focus:border-ring disabled:opacity-40",
                              ),
                            ]),
                          ],
                        ),
                      ]
                    : []),
                ],
              )
            }),
          ),
          ...(editing.submit._tag === "Failed" && editing.submit.target === "text"
            ? [h.p([h.Role("alert"), h.Class("text-[13px] text-destructive")], [editing.submit.message])]
            : []),
          ...(isTextDirty(editing) && isVoiceDirty(editing)
            ? [
                h.p(
                  [h.Class("text-[13px] text-muted-foreground")],
                  ["Queuing chapter edits starts narration now; apply voice and speed changes after it finishes."],
                ),
              ]
            : []),
          h.button(
            [
              h.Type("button"),
              h.Disabled(!isTextDirty(editing) || busy),
              h.OnClick(toParent(NarrateAgainMessage.ClickedNarrateText())),
              h.Class(buttonClass({ variant: "primary", size: "sm" }, "self-start")),
            ],
            [
              ...(editing.submit._tag === "SubmittingText" ? [Icon.loaderCircle("animate-spin")] : []),
              editing.submit._tag === "SubmittingText" ? "Queueing…" : "Narrate chapter edits",
            ],
          ),
        ],
      )
    },
  })

const voiceAndSpeed = (model: Model, editing: EditingNarrateAgain, h: HtmlBuilder<Message>): Html => {
  const busy = isSubmitting(editing)
  const registered = sortedVoices(model.voices)
  const voices =
    editing.voice !== null && !registered.some((voice) => voice.id === editing.voice)
      ? [{ id: editing.voice, name: editing.voice, language: "", engine: "", gender: null }, ...registered]
      : registered
  const speeds = SPEEDS.includes(editing.speed as (typeof SPEEDS)[number])
    ? SPEEDS
    : [...SPEEDS, editing.speed].sort((a, b) => a - b)
  return h.section(
    [h.Class("flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4")],
    [
      h.h2([h.Class("text-lg font-semibold")], ["Voice and speed"]),
      h.div(
        [h.Class("flex flex-wrap gap-3")],
        [
          h.label(
            [h.Class("flex min-w-48 flex-1 flex-col gap-1.5 text-sm")],
            [
              "Voice",
              h.select(
                [
                  h.AriaLabel("Voice"),
                  h.Value(editing.voice ?? ""),
                  h.Disabled(busy || voices.length === 0),
                  h.OnChange((value) => toParent(NarrateAgainMessage.ChangedVoice({ value }))),
                  h.Class("h-10 rounded-lg border border-input bg-background px-3 text-base outline-none focus:border-ring"),
                ],
                [
                  ...(editing.voice === null ? [h.option([h.Value("")], ["Choose a voice"])] : []),
                  ...voices.map((voice) =>
                    h.option([h.Value(voice.id)], [
                      voice.language ? `${voice.name} · ${languageName(voice.language)}` : voice.name,
                    ]),
                  ),
                ],
              ),
            ],
          ),
          h.label(
            [h.Class("flex w-28 flex-col gap-1.5 text-sm")],
            [
              "Speed",
              h.select(
                [
                  h.AriaLabel("Speed"),
                  h.Value(String(editing.speed)),
                  h.Disabled(busy),
                  h.OnChange((value) => toParent(NarrateAgainMessage.ChangedSpeed({ value }))),
                  h.Class("h-10 rounded-lg border border-input bg-background px-3 text-base tabular-nums outline-none focus:border-ring"),
                ],
                speeds.map((speed) => h.option([h.Value(String(speed))], [formatRate(speed)])),
              ),
            ],
          ),
        ],
      ),
      ...(editing.submit._tag === "Failed" && editing.submit.target === "voice"
        ? [h.p([h.Role("alert"), h.Class("text-[13px] text-destructive")], [editing.submit.message])]
        : []),
      ...(isTextDirty(editing) && isVoiceDirty(editing)
        ? [
            h.p(
              [h.Class("text-[13px] text-muted-foreground")],
              ["Changing voice and speed starts narration now and discards unsaved chapter edits."],
            ),
          ]
        : []),
      h.button(
        [
          h.Type("button"),
          h.Disabled(!isVoiceDirty(editing) || editing.voice === null || voices.length === 0 || busy),
          h.OnClick(toParent(NarrateAgainMessage.ClickedChangeVoice())),
          h.Class(buttonClass({ variant: "primary", size: "sm" }, "self-start")),
        ],
        [
          ...(editing.submit._tag === "SubmittingVoice" ? [Icon.loaderCircle("animate-spin")] : []),
          editing.submit._tag === "SubmittingVoice" ? "Queueing…" : "Change voice & speed",
        ],
      ),
    ],
  )
}

const editingView = (model: Model, editing: EditingNarrateAgain, h: HtmlBuilder<Message>): Html => {
  const episode = episodes(model).find((item) => item.id === editing.episodeId)
  return h.section(
    [h.Class("mt-2 flex flex-col gap-5")],
    [
      h.div([h.Class("flex items-center")], [backButton(h)]),
      h.header(
        [],
        [
          h.h1([h.Class("text-2xl font-semibold leading-tight")], ["Narrate again"]),
          ...(episode ? [h.p([h.Class("mt-1 text-muted-foreground")], [episode.title])] : []),
        ],
      ),
      chapterText(editing, h),
      voiceAndSpeed(model, editing, h),
    ],
  )
}

export const narrateAgain = (model: Model, h: HtmlBuilder<Message>): Html => {
  const view = model.narrateAgain.view
  switch (view._tag) {
    case "Closed":
      return h.empty
    case "Loading": {
      const episode = episodes(model).find((item) => item.id === view.episodeId)
      return h.section(
        [h.Class("mt-2 flex flex-col gap-4")],
        [
          h.div([h.Class("flex items-center")], [backButton(h)]),
          h.h1([h.Class("text-2xl font-semibold leading-tight")], ["Narrate again"]),
          ...(episode ? [h.p([h.Class("text-muted-foreground")], [episode.title])] : []),
          h.div(
            [h.Role("status"), h.AriaLabel("Loading"), h.Class("flex items-center justify-center py-12")],
            [Icon.loaderCircle("size-5 animate-spin text-muted-foreground")],
          ),
        ],
      )
    }
    case "LoadFailed":
      return h.section(
        [h.Class("mt-2 flex flex-col gap-4")],
        [
          h.div([h.Class("flex items-center")], [backButton(h)]),
          h.h1([h.Class("text-2xl font-semibold leading-tight")], ["Narrate again"]),
          h.div(
            [h.Class("flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3 text-sm")],
            [
              h.span([h.Role("alert"), h.Class("text-destructive")], [view.message]),
              h.button(
                [
                  h.Type("button"),
                  h.OnClick(toParent(NarrateAgainMessage.ClickedTryAgain())),
                  h.Class(buttonClass({ variant: "outline", size: "sm" })),
                ],
                ["Try again"],
              ),
            ],
          ),
        ],
      )
    case "Editing":
      return editingView(model, view, h)
  }
}
