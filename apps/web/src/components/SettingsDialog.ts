import { Command, Component, UiSchema } from "@effect/ui"
import { Button, Dialog } from "@effect/ui-kit"
import { Html } from "@effect/ui/html"
import { Cause, Duration, Effect, Option, Redacted, Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type ApiFailure, ApiToken, Connection, apiToken } from "~/api"
import { FeedQuery } from "~/queries"
import { buttonClass } from "~/view/button"
import * as Icon from "~/view/icon"

export const RESET_COPIED_MS = 1500

const INPUT_CLASS =
  "h-10 w-full rounded-lg border border-input bg-transparent px-3 text-base outline-none placeholder:text-muted-foreground/60 focus:border-ring sm:h-9 sm:text-sm"
const LABEL_CLASS = "text-[13px] text-muted-foreground"

// --- Settings form & feed (mounts only while the dialog is open) ---

export const SettingsFormProps = Schema.Struct({
  initialConnection: Connection,
  connectionGeneration: Schema.Number,
  openId: Schema.Number,
})
export type SettingsFormProps = typeof SettingsFormProps.Type

export const SettingsFormModel = Schema.Struct({
  tokenDraft: ApiToken,
  originDraft: Schema.String,
})
export type SettingsFormModel = typeof SettingsFormModel.Type

export const SettingsFormMessage = UiSchema.TaggedEnum({
  UpdatedTokenDraft: { value: ApiToken },
  UpdatedOriginDraft: { value: Schema.String },
  SubmittedSettings: {},
  ClickedCopyFeedUrl: { url: Schema.Redacted(Schema.String) },
  SucceededCopyFeedUrl: {},
  FailedCopyFeedUrl: {},
  CompletedWaitBeforeResetCopied: {},
})
export type SettingsFormMessage = typeof SettingsFormMessage.Type

export const SettingsFormEvents = UiSchema.TaggedEnum({
  Saved: { connection: Connection },
})
export type SettingsFormEvents = typeof SettingsFormEvents.Type

export const CopyFeedUrl = Command.make(
  "settings/CopyFeedUrl",
  { args: { url: Schema.Redacted(Schema.String) } },
  ({ url }) =>
    Effect.tryPromise(() => navigator.clipboard.writeText(Redacted.value(url))).pipe(
      Effect.as(SettingsFormMessage.SucceededCopyFeedUrl()),
      Effect.catch(() => Effect.succeed(SettingsFormMessage.FailedCopyFeedUrl())),
    ),
)

export const WaitBeforeResetCopied = Command.make(
  "settings/WaitBeforeResetCopied",
  { args: {}, mode: "switch" },
  () =>
    Effect.sleep(Duration.millis(RESET_COPIED_MS)).pipe(
      Effect.as(SettingsFormMessage.CompletedWaitBeforeResetCopied()),
    ),
)

const failureOf = (cause: Cause.Cause<ApiFailure>): ApiFailure | undefined =>
  Option.getOrUndefined(Cause.findErrorOption(cause))

const defaultOriginPlaceholder = () => (typeof location !== "undefined" ? location.origin : "")

export const SettingsForm = Html.component({
  name: "SettingsForm",
  props: SettingsFormProps,
  model: SettingsFormModel,
  message: SettingsFormMessage,
  events: SettingsFormEvents,
  queries: {
    feed: {
      query: FeedQuery,
      args: ({ props }) => ({
        origin: props.initialConnection.origin,
        generation: props.connectionGeneration,
        openId: props.openId,
      }),
    },
  },
}).make({
  init: ($) => ({
    tokenDraft: $.props.initialConnection.token,
    originDraft: $.props.initialConnection.origin,
  }),
  update: {
    UpdatedTokenDraft: ($, { value }) => $.evolve({ tokenDraft: value }),
    UpdatedOriginDraft: ($, { value }) => $.evolve({ originDraft: value }),
    SubmittedSettings: ($) =>
      $.emit(
        SettingsFormEvents.Saved({
          connection: {
            token: apiToken(Redacted.value($.model.tokenDraft).trim()),
            origin: $.model.originDraft.trim().replace(/\/+$/, ""),
          },
        }),
      ),
    ClickedCopyFeedUrl: ($, { url }) => $.run(CopyFeedUrl.make({ url })),
    SucceededCopyFeedUrl: ($) => $.run(WaitBeforeResetCopied.make({})),
    FailedCopyFeedUrl: ($) => $.model,
    CompletedWaitBeforeResetCopied: ($) => $.model,
  },
  view: (h, model) => {
    const isCopied = h.isRunning(WaitBeforeResetCopied)
    const placeholderFeedRow = () =>
      h.div.class("flex items-center gap-2").children(
        h.code
          .class(
            "min-w-0 flex-1 truncate rounded-lg bg-accent px-3 py-2 font-mono text-[12px] text-muted-foreground",
          )
          .children("…"),
        Button(h, { props: { disabled: true } })
          .attr("aria-label", "Copy feed URL")
          .class(buttonClass({ variant: "outline", size: "icon" }))
          .children(Icon.copy(h)),
      )

    const feedRow = AsyncResult.match(h.queries.feed, {
      onInitial: placeholderFeedRow,
      onFailure: ({ cause, waiting }) => {
        if (waiting) return placeholderFeedRow()
        const failure = failureOf(cause)
        if (failure?.status === 401) return placeholderFeedRow()
        return h.p
          .class("text-[13px] text-destructive")
          .children(failure?.message ?? "Could not load podcast feed")
      },
      onSuccess: ({ value, waiting }) =>
        waiting
          ? placeholderFeedRow()
          : h.div.class("flex items-center gap-2").children(
              h.code
                .class(
                  "min-w-0 flex-1 truncate rounded-lg bg-accent px-3 py-2 font-mono text-[12px] text-muted-foreground",
                )
                .children(Redacted.value(value.url)),
              Button(h, {
                props: { disabled: isCopied, focusableWhenDisabled: true },
                onPress: SettingsFormMessage.ClickedCopyFeedUrl({ url: value.url }),
              })
                .attr("aria-label", isCopied ? "Copied" : "Copy feed URL")
                .class(buttonClass({ variant: "outline", size: "icon" }))
                .children(isCopied ? Icon.check(h) : Icon.copy(h)),
            ),
    })

    return h.div.children(
      h.form.on("submit", SettingsFormMessage.SubmittedSettings()).class("flex flex-col gap-4").children(
        h.div.class("flex flex-col gap-1.5").children(
          h.label.attr("for", "settings-token").class(LABEL_CLASS).children("API token"),
          h.input
            .id("settings-token")
            .attrs({ type: "password", autocomplete: "off", autofocus: "" })
            .value(Redacted.value(model.tokenDraft))
            .on("input", ({ value }) => SettingsFormMessage.UpdatedTokenDraft({ value: apiToken(value) }))
            .class(INPUT_CLASS),
        ),
        h.div.class("flex flex-col gap-1.5").children(
          h.label.attr("for", "settings-server").class(LABEL_CLASS).children("Server"),
          h.input
            .id("settings-server")
            .attrs({ type: "url", inputmode: "url", placeholder: defaultOriginPlaceholder() })
            .value(model.originDraft)
            .on("input", ({ value }) => SettingsFormMessage.UpdatedOriginDraft({ value }))
            .class(INPUT_CLASS),
        ),
        Button(h, { props: { type: "submit" } })
          .class(buttonClass({ variant: "primary" }, "self-end"))
          .children("Save"),
      ),
      h.div.class("mt-5 border-t border-border pt-4").children(
        h.div.class("mb-1.5 text-[13px] text-muted-foreground").children("Podcast feed"),
        feedRow,
      ),
    )
  },
}).pipe(Component.provide(FeedQuery.layer))

// --- Settings dialog wrapper ---

export const SettingsDialogProps = Schema.Struct({
  open: Schema.Boolean,
  openId: Schema.Number,
  connection: Connection,
  connectionGeneration: Schema.Number,
})
export type SettingsDialogProps = typeof SettingsDialogProps.Type

export const SettingsDialogMessage = UiSchema.TaggedEnum({
  RequestedOpenDialog: {},
  RequestedCloseDialog: {},
  SavedSettingsForm: { connection: Connection },
})
export type SettingsDialogMessage = typeof SettingsDialogMessage.Type

export const SettingsDialogEvents = UiSchema.TaggedEnum({
  RequestedOpen: {},
  RequestedClose: {},
  Saved: { connection: Connection },
})
export type SettingsDialogEvents = typeof SettingsDialogEvents.Type

/**
 * Header trigger button + headless `@effect/ui-kit` `Dialog` for Settings.
 * Mounting `SettingsForm` inside `dialog.portal` resets the draft and refetches `FeedQuery` on each open.
 */
export const SettingsDialog = Html.component({
  name: "SettingsDialog",
  props: SettingsDialogProps,
  model: Schema.Null,
  message: SettingsDialogMessage,
  events: SettingsDialogEvents,
}).make({
  init: () => null,
  update: {
    RequestedOpenDialog: ($) => $.emit(SettingsDialogEvents.RequestedOpen()),
    RequestedCloseDialog: ($) => $.emit(SettingsDialogEvents.RequestedClose()),
    SavedSettingsForm: ($, { connection }) => $.emit(SettingsDialogEvents.Saved({ connection })),
  },
  view: (h) =>
    Dialog(h, {
      props: { open: h.props.open, id: "settings" },
      onEmit: {
        RequestedOpen: () => SettingsDialogMessage.RequestedOpenDialog(),
        RequestedClose: () => SettingsDialogMessage.RequestedCloseDialog(),
        Settled: () => undefined,
      },
      view: (dialog) =>
        h.span.class("contents").children(
          dialog
            .trigger(
              h.button.attr("aria-label", "Settings").class(buttonClass({ size: "icon-sm" })),
            )
            .children(Icon.settings(h)),
          dialog.portal(h.dialog)?.children(
            dialog.backdrop(
              h.div.class(
                "fixed inset-0 z-50 bg-black/60 transition-opacity duration-200 data-[starting-style]:opacity-0",
              ),
            ),
            dialog
              .popup(
                h.div.class(
                  "fixed top-1/2 left-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-popover p-5 text-foreground shadow-[0_16px_48px_rgb(0_0_0/0.45)] outline-none transition-[opacity,scale] duration-200 ease-out data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                ),
              )
              .children(
                h.div.class("mb-4 flex items-center justify-between").children(
                  dialog.title(h.h2.class("text-base font-semibold")).children("Settings"),
                  dialog
                    .close(h.button.attr("aria-label", "Close").class(buttonClass({ size: "icon-sm" })))
                    .children(Icon.x(h)),
                ),
                SettingsForm(h, {
                  key: String(h.props.openId),
                  props: {
                    initialConnection: h.props.connection,
                    connectionGeneration: h.props.connectionGeneration,
                    openId: h.props.openId,
                  },
                  onEmit: {
                    Saved: ({ connection }) => SettingsDialogMessage.SavedSettingsForm({ connection }),
                  },
                }),
              ),
          ),
        ),
    }),
})
