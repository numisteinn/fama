import { Effect, Option } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ADD_TEXT_ID, FILE_INPUT_ID } from "~/command"
import { formatRate } from "~/lib/format"
import { Message } from "~/message"
import { ACCEPT, type BatchFile, isSending } from "~/batch"
import { type Model, selectedVoice, toDraft } from "~/model"
import { reviewSwitch } from "~/review/view"
import { pickerCheckedIndex } from "~/update"
import { buttonClass, cx } from "~/view/button"
import * as Icon from "~/view/icon"
import { picker } from "~/view/picker"

/**
 * Enter and Space on the Attach file label open the file picker, as a click on it does.
 * The picker opens inside the key event, so the browser sees the user's activation.
 */
export const OpenFilePickerOnKey = Mount.define("OpenFilePickerOnKey", {
  messages: [Message.CompletedMountFilePickerKeys],
  execute: ({ element }) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const onKeyDown = (event: Event) => {
          if (!(event instanceof KeyboardEvent) || (event.key !== "Enter" && event.key !== " ")) return
          event.preventDefault()
          const control = element instanceof HTMLLabelElement ? element.control : null
          ;(control ?? document.getElementById(FILE_INPUT_ID))?.click()
        }
        element.addEventListener("keydown", onKeyDown)
        return onKeyDown
      }),
      (onKeyDown) => Effect.sync(() => element.removeEventListener("keydown", onKeyDown)),
    ).pipe(Effect.as(Message.CompletedMountFilePickerKeys())),
})

/** One file of the batch: its name, where it is, and why it failed. */
const fileRow = ({ key, file, state }: BatchFile, h: HtmlBuilder<Message>): Html => {
  const reason = state._tag === "Failed" ? state.reason : state._tag === "Refused" ? "Unsupported type" : undefined
  const icon =
    state._tag === "Uploading"
      ? Icon.loaderCircle("size-5 shrink-0 animate-spin text-muted-foreground")
      : state._tag === "Done"
        ? Icon.check("size-5 shrink-0 text-muted-foreground")
        : Icon.fileText(cx("size-5 shrink-0", reason ? "text-destructive" : "text-muted-foreground"))
  const button = (label: string, message: Message, content: Html) =>
    h.button(
      [h.Type("button"), h.AriaLabel(label), h.OnClick(message), h.Class(buttonClass({ size: "icon-sm" }))],
      [content],
    )
  return h.li(
    [h.Class("flex min-h-10 items-center gap-3 pl-2")],
    [
      icon,
      h.span([h.Class(cx("min-w-0 flex-1 truncate text-[15px]", state._tag === "Pending" && "text-muted-foreground"))], [file.name]),
      ...(reason ? [h.span([h.Role("alert"), h.Class("max-w-1/2 truncate text-[13px] text-destructive")], [reason])] : []),
      ...(state._tag === "Failed" ? [button(`Retry ${file.name}`, Message.ClickedRetryFile({ key }), Icon.rotateCcw())] : []),
      ...(state._tag === "Uploading" || state._tag === "Done"
        ? []
        : [button(`Remove ${file.name}`, Message.ClickedRemoveFile({ key }), Icon.x())]),
    ],
  )
}

/** Paste a link or text, or attach files, then add them. */
export const addBar = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const draft = toDraft(model)
  const voiceName = Option.match(selectedVoice(model), { onNone: () => "Auto", onSome: (voice) => voice.name })
  const isDragging = model.fileDragDepth > 0

  const input =
    model.batch.length > 0
      ? h.ul([h.Class("max-h-60 overflow-y-auto px-2 pt-2")], model.batch.map((item) => fileRow(item, h)))
      : h.textarea(
          [
            h.Id(ADD_TEXT_ID),
            h.Value(model.addText),
            h.OnInput((value) => Message.UpdatedAddText({ value })),
            h.OnKeyDownPreventDefault((key, modifiers) =>
              key === "Enter" && !modifiers.shiftKey ? Option.some(Message.PressedEnterInAddText()) : Option.none(),
            ),
            h.Placeholder("Paste a link or text"),
            h.AriaLabel("Link or text"),
            h.Rows(1),
            h.Class(
              "field-sizing-content block max-h-60 min-h-14 w-full resize-none bg-transparent px-4 pt-4 pb-2 text-base outline-none placeholder:text-muted-foreground sm:text-[15px]",
            ),
          ],
        )
  const isBusy = model.isAdding || isSending(model.batch)

  const form = h.form(
    [
      h.OnSubmit(Message.SubmittedAddForm()),
      h.Class(
        cx(
          "rounded-2xl border border-input bg-surface transition-[border-color,box-shadow] duration-200 focus-within:border-ring/60",
          isDragging && "border-foreground/60",
        ),
      ),
    ],
    [
      input,
      h.div(
        [h.Class("flex items-center gap-1 p-2")],
        [
          h.label(
            [
              h.For(FILE_INPUT_ID),
              h.Role("button"),
              h.Tabindex(0),
              h.AriaLabel("Attach file"),
              h.OnMount(OpenFilePickerOnKey()),
              h.Class(buttonClass({ size: "icon-sm" })),
            ],
            [Icon.paperclip()],
          ),
          h.input([
            h.Id(FILE_INPUT_ID),
            h.Type("file"),
            h.Accept(ACCEPT),
            h.Multiple(true),
            h.Hidden(true),
            h.OnFileChange((files) => Message.ChangedFileInput({ files })),
          ]),
          ...picker(model, h, {
            pickerId: "Voice",
            label: `Voice: ${voiceName}`,
            triggerClass: buttonClass({ size: "sm" }, "max-w-48"),
            triggerContent: [h.span([h.Class("truncate")], [voiceName]), Icon.chevronDown("size-3.5")],
            checkedIndex: pickerCheckedIndex(model, "Voice"),
          }),
          ...picker(model, h, {
            pickerId: "VoiceSpeed",
            label: `Voice speed: ${formatRate(model.speed)}`,
            triggerClass: buttonClass({ size: "sm" }),
            triggerContent: [Icon.gauge(), h.span([h.Class("tabular-nums")], [formatRate(model.speed)])],
            checkedIndex: pickerCheckedIndex(model, "VoiceSpeed"),
          }),
          reviewSwitch(model, h),
          ...Option.match(model.maybeAddError, {
            onNone: () => [],
            onSome: (error) => [
              h.p([h.Role("alert"), h.Class("ml-2 min-w-0 flex-1 truncate text-[13px] text-destructive")], [error]),
            ],
          }),
          h.button(
            [
              h.Type("submit"),
              h.AriaLabel("Add"),
              h.Disabled(draft._tag === "Empty" || model.isAdding),
              h.Class(buttonClass({ variant: "primary", size: "icon-sm" }, "ml-auto rounded-full")),
            ],
            [isBusy ? Icon.loaderCircle("animate-spin") : Icon.arrowUp()],
          ),
        ],
      ),
    ],
  )

  if (!isDragging) return [form]
  return [
    form,
    h.div(
      [
        h.Class(
          "pointer-events-none fixed inset-3 z-40 grid place-items-center rounded-3xl border-2 border-dashed border-foreground/40 bg-background/80 backdrop-blur-sm",
        ),
      ],
      [h.span([h.Class("text-lg font-medium")], ["Drop to add"])],
    ),
  ]
}
