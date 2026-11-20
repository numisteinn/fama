import { Dialog } from "@foldkit/ui"
import { Redacted } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { apiToken } from "~/api"
import { Message } from "~/message"
import type { Model } from "~/model"
import { buttonClass } from "~/view/button"
import * as Icon from "~/view/icon"

const INPUT_CLASS =
  "h-10 w-full rounded-lg border border-input bg-transparent px-3 text-base outline-none placeholder:text-muted-foreground/60 focus:border-ring sm:h-9 sm:text-sm"
const LABEL_CLASS = "text-[13px] text-muted-foreground"

/** API token, server, and the private podcast feed. */
export const settingsDialog = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.submodel({
    slotId: "settings",
    model: model.settingsDialog,
    view: Dialog.view,
    toParentMessage: (message) => Message.GotSettingsDialogMessage({ message }),
    viewInputs: {
      toView: ({ dialog, backdrop, panel, title, initialFocus, closeButton, isVisible }) =>
        h.dialog(
          [...dialog],
          isVisible
            ? [
                h.div([...backdrop, h.Class("fixed inset-0 z-50 bg-black/60 transition-opacity duration-200 starting:opacity-0")], []),
                h.div(
                  [
                    ...panel,
                    h.Class(
                      "fixed top-1/2 left-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-popover p-5 shadow-[0_16px_48px_rgb(0_0_0/0.45)] outline-none transition-[opacity,scale] duration-200 ease-out starting:scale-95 starting:opacity-0",
                    ),
                  ],
                  [
                    h.div(
                      [h.Class("mb-4 flex items-center justify-between")],
                      [
                        h.h2([...title, h.Class("text-base font-semibold")], ["Settings"]),
                        h.button(
                          [...closeButton, h.AriaLabel("Close"), h.Class(buttonClass({ size: "icon-sm" }))],
                          [Icon.x()],
                        ),
                      ],
                    ),
                    h.form(
                      [h.OnSubmit(Message.SubmittedSettings()), h.Class("flex flex-col gap-4")],
                      [
                        field("settings-token", "API token", h, [
                          ...initialFocus,
                          h.Type("password"),
                          h.Autocomplete("off"),
                          h.Value(Redacted.value(model.settingsDraft.token)),
                          h.OnInput((value) => Message.UpdatedTokenDraft({ value: apiToken(value) })),
                        ]),
                        field("settings-server", "Server", h, [
                          h.Type("url"),
                          h.InputMode("url"),
                          h.Placeholder(location.origin),
                          h.Value(model.settingsDraft.origin),
                          h.OnInput((value) => Message.UpdatedOriginDraft({ value })),
                        ]),
                        h.button([h.Type("submit"), h.Class(buttonClass({ variant: "primary" }, "self-end"))], ["Save"]),
                      ],
                    ),
                    feedRow(model, h),
                  ],
                ),
              ]
            : [],
        ),
    },
  })

const field = (
  id: string,
  label: string,
  h: HtmlBuilder<Message>,
  attributes: Parameters<HtmlBuilder<Message>["input"]>[0],
): Html =>
  h.div(
    [h.Class("flex flex-col gap-1.5")],
    [
      h.label([h.For(id), h.Class(LABEL_CLASS)], [label]),
      h.input([h.Id(id), ...attributes, h.Class(INPUT_CLASS)]),
    ],
  )

/** The private podcast feed, for "Add to Podcasts". */
const feedRow = (model: Model, h: HtmlBuilder<Message>): Html => {
  const { feed, isFeedUrlCopied } = model
  return h.div(
    [h.Class("mt-5 border-t border-border pt-4")],
    [
      h.div([h.Class("mb-1.5 text-[13px] text-muted-foreground")], ["Podcast feed"]),
      feed._tag === "Failed"
        ? h.p([h.Class("text-[13px] text-destructive")], [feed.message])
        : h.div(
            [h.Class("flex items-center gap-2")],
            [
              h.code(
                [
                  h.Class(
                    "min-w-0 flex-1 truncate rounded-lg bg-accent px-3 py-2 font-mono text-[12px] text-muted-foreground",
                  ),
                ],
                [feed._tag === "Ready" ? feed.url : "…"],
              ),
              h.button(
                [
                  h.Type("button"),
                  h.AriaLabel(isFeedUrlCopied ? "Copied" : "Copy feed URL"),
                  h.Disabled(feed._tag !== "Ready"),
                  h.OnClick(Message.ClickedCopyFeedUrl()),
                  h.Class(buttonClass({ variant: "outline", size: "icon" })),
                ],
                [isFeedUrlCopied ? Icon.check() : Icon.copy()],
              ),
            ],
          ),
    ],
  )
}
