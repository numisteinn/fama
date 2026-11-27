import { Component, Mount, UiSchema } from "@effect/ui"
import { Switch } from "@effect/ui-kit"
import type { Html } from "@effect/ui/html"
import { Effect, Option, Schema } from "effect"
import { ACCEPT, type BatchFile, isSending } from "~/core/batch"
import { SPEEDS } from "~/core/voices"
import { formatRate } from "~/lib/format"
import { Picker, type PickerOption } from "~/ui/Picker"
import { buttonClass, cx } from "~/ui/button"
import * as Icon from "~/ui/icon"
import { ADD_TEXT_ID, AddTextRef, FILE_INPUT_ID } from "~/ui/refs"

/** What the add bar asks the App for. Narrow data, computed by the App. */
export interface AddBarProps {
  readonly addText: string
  readonly batch: ReadonlyArray<BatchFile>
  readonly isAdding: boolean
  readonly maybeAddError: Option.Option<string>
  readonly isReviewOn: boolean
  readonly isDragging: boolean
  readonly canSubmit: boolean
  readonly speed: number
  readonly voiceName: string
  readonly selectedVoiceId: string
  readonly voiceOptions: ReadonlyArray<PickerOption>
}

export const AddBarEvents = UiSchema.TaggedEnum({
  UpdatedText: { value: Schema.String },
  PressedEnter: {},
  Submitted: {},
  ToggledReview: { checked: Schema.Boolean },
  ChangedFiles: { files: Schema.Array(Schema.instanceOf(File)) },
  RemovedFile: { key: Schema.Number },
  RetriedFile: { key: Schema.Number },
  PickedVoice: { value: Schema.String },
  PickedVoiceSpeed: { value: Schema.String },
})
export type AddBarEvents = typeof AddBarEvents.Type

/**
 * Enter and Space on the Attach file label open the file picker, as a click on it does.
 * The picker opens inside the key event, so the browser sees the user's activation.
 */
export const OpenFilePickerOnKey = Mount.make(
  "app/OpenFilePickerOnKey",
  { args: {} },
  (element: HTMLLabelElement) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const onKeyDown = (event: KeyboardEvent) => {
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          const control = element.control
          ;(control ?? document.getElementById(FILE_INPUT_ID))?.click()
        }
        element.addEventListener("keydown", onKeyDown)
        return onKeyDown
      }),
      (onKeyDown) => Effect.sync(() => element.removeEventListener("keydown", onKeyDown)),
    ).pipe(Effect.andThen(Effect.never), Effect.as(Component.noop)),
)

const speedOptions: ReadonlyArray<PickerOption> = SPEEDS.map((speed) => ({
  value: String(speed),
  name: formatRate(speed),
}))

const fileRow = <M>({ key, file, state }: BatchFile, h: Html.H<M>, emit: (e: AddBarEvents) => M) => {
  const reason = state._tag === "Failed" ? state.reason : state._tag === "Refused" ? "Unsupported type" : undefined
  const icon =
    state._tag === "Uploading"
      ? Icon.loaderCircle(h, "size-5 shrink-0 animate-spin text-muted-foreground")
      : state._tag === "Done"
        ? Icon.check(h, "size-5 shrink-0 text-muted-foreground")
        : Icon.fileText(h, cx("size-5 shrink-0", reason ? "text-destructive" : "text-muted-foreground"))

  const rowButton = (label: string, message: M, content: ReturnType<typeof Icon.x<M>>) =>
    h.button
      .attrs({ type: "button", "aria-label": label })
      .on("click", message)
      .class(buttonClass({ size: "icon-sm" }))
      .children(content)

  return h.li
    .key(String(key))
    .class("flex min-h-10 items-center gap-3 pl-2")
    .children(
      icon,
      h.span
        .class(cx("min-w-0 flex-1 truncate text-[15px]", state._tag === "Pending" && "text-muted-foreground"))
        .children(file.name),
      reason && h.span.attr("role", "alert").class("max-w-1/2 truncate text-[13px] text-destructive").children(reason),
      state._tag === "Failed" && rowButton(`Retry ${file.name}`, emit(AddBarEvents.RetriedFile({ key })), Icon.rotateCcw(h)),
      state._tag !== "Uploading" &&
        state._tag !== "Done" &&
        rowButton(`Remove ${file.name}`, emit(AddBarEvents.RemovedFile({ key })), Icon.x(h)),
    )
}

/** Paste a link or text, or attach files, then add them. */
export const AddBar = <M>(props: AddBarProps, h: Html.H<M>, emit: (e: AddBarEvents) => M) => {
  const isBusy = props.isAdding || isSending(props.batch)

  const input =
    props.batch.length > 0
      ? h.ul
          .class("max-h-60 overflow-y-auto px-2 pt-2")
          .children(...props.batch.map((item) => fileRow(item, h, emit)))
      : h.textarea
          .ref(AddTextRef)
          .attrs({
            id: ADD_TEXT_ID,
            placeholder: "Paste a link or text",
            "aria-label": "Link or text",
            rows: "1",
          })
          .value(props.addText)
          .on("input", ({ value }) => emit(AddBarEvents.UpdatedText({ value })))
          .on(
            "keydown",
            ({ key, shift, composing }) =>
              key === "Enter" && !shift && !composing ? emit(AddBarEvents.PressedEnter()) : undefined,
            { preventDefault: true },
          )
          .class(
            "field-sizing-content block max-h-60 min-h-14 w-full resize-none bg-transparent px-4 pt-4 pb-2 text-base outline-none placeholder:text-muted-foreground sm:text-[15px]",
          )

  const form = h.form
    .on("submit", emit(AddBarEvents.Submitted()))
    .class(
      cx(
        "rounded-2xl border border-input bg-surface transition-[border-color,box-shadow] duration-200 focus-within:border-ring/60",
        props.isDragging && "border-foreground/60",
      ),
    )
    .children(
      input,
      h.div.class("flex items-center gap-1 p-2").children(
        h.label
          .attrs({
            for: FILE_INPUT_ID,
            role: "button",
            tabindex: "0",
            "aria-label": "Attach file",
          })
          .onMount(OpenFilePickerOnKey())
          .class(buttonClass({ size: "icon-sm" }))
          .children(Icon.paperclip(h)),
        h.input
          .attrs({
            id: FILE_INPUT_ID,
            type: "file",
            accept: ACCEPT,
            multiple: "",
            hidden: "",
          })
          .value("")
          .on("change", ({ files }) => emit(AddBarEvents.ChangedFiles({ files }))),
        Picker(h, {
          key: "voice",
          props: {
            label: `Voice: ${props.voiceName}`,
            triggerText: props.voiceName,
            triggerKind: "voice",
            triggerClass: buttonClass({ size: "sm" }, "max-w-48"),
            selectedValue: props.selectedVoiceId,
            items: props.voiceOptions,
          },
          onEmit: {
            Picked: ({ value }) => emit(AddBarEvents.PickedVoice({ value })),
          },
        }),
        Picker(h, {
          key: "voice-speed",
          props: {
            label: `Voice speed: ${formatRate(props.speed)}`,
            triggerText: formatRate(props.speed),
            triggerKind: "voiceSpeed",
            triggerClass: buttonClass({ size: "sm" }),
            selectedValue: String(props.speed),
            items: speedOptions,
          },
          onEmit: {
            Picked: ({ value }) => emit(AddBarEvents.PickedVoiceSpeed({ value })),
          },
        }),
        Switch(h, {
          props: { checked: props.isReviewOn },
          onToggle: ({ checked }) => emit(AddBarEvents.ToggledReview({ checked })),
          view: (parts) =>
            parts
              .root(
                h.button.class(
                  buttonClass(
                    { size: "sm" },
                    "gap-2 aria-checked:border-input aria-checked:bg-accent aria-checked:text-foreground",
                  ),
                ),
              )
              .children(
                h.span
                  .attr("aria-hidden", "true")
                  .class(
                    cx(
                      "inline-flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors duration-150",
                      parts.checked ? "bg-foreground" : "bg-faint",
                    ),
                  )
                  .children(
                    parts.thumb(
                      h.span.class(
                        cx(
                          "size-3 rounded-full bg-background transition-transform duration-150",
                          parts.checked && "translate-x-3",
                        ),
                      ),
                    ),
                  ),
                "Review",
              ),
        }),
        Option.match(props.maybeAddError, {
          onNone: () => null,
          onSome: (error) =>
            h.p
              .attr("role", "alert")
              .class("ml-2 min-w-0 flex-1 truncate text-[13px] text-destructive")
              .children(error),
        }),
        h.button
          .attrs({ type: "submit", "aria-label": "Add" })
          .disabled(!props.canSubmit || props.isAdding)
          .class(buttonClass({ variant: "primary", size: "icon-sm" }, "ml-auto rounded-full"))
          .children(isBusy ? Icon.loaderCircle(h, "animate-spin") : Icon.arrowUp(h)),
      ),
    )

  return [
    form,
    props.isDragging &&
      h.div
        .class(
          "pointer-events-none fixed inset-3 z-40 grid place-items-center rounded-3xl border-2 border-dashed border-foreground/40 bg-background/80 backdrop-blur-sm",
        )
        .children(h.span.class("text-lg font-medium").children("Drop to add")),
  ]
}
