import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ADD_TEXT_ID, FILE_INPUT_ID } from "~/command"
import { formatRate } from "~/lib/format"
import { Message } from "~/message"
import { ACCEPT, type Model, SPEEDS, languageName, selectedVoice, sortedVoices, toDraft } from "~/model"
import { pickerCheckedIndex } from "~/update"
import { buttonClass, cx } from "~/view/button"
import * as Icon from "~/view/icon"
import { type PickerOption, picker } from "~/view/picker"

const voiceOptions = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<PickerOption> => {
  const voices = sortedVoices(model.voices)
  return [
    { label: "Auto" },
    ...voices.map((voice, index) => {
      const language = languageName(voice.language)
      const previous = index === 0 ? undefined : languageName(voices[index - 1]!.language)
      return language === previous ? { label: voice.name } : { label: voice.name, group: language }
    }),
  ]
}

/** Paste a link or text, or attach a file, then add it. */
export const addBar = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const draft = toDraft(model)
  const voiceName = Option.match(selectedVoice(model), { onNone: () => "Auto", onSome: (voice) => voice.name })
  const isDragging = model.fileDragDepth > 0

  const input = Option.match(model.maybeAttachedFile, {
    onSome: (file) =>
      h.div(
        [h.Class("flex items-center gap-3 px-4 pt-4 pb-2")],
        [
          Icon.fileText("size-5 shrink-0 text-muted-foreground"),
          h.span([h.Class("min-w-0 flex-1 truncate text-[15px]")], [file.name]),
          h.button(
            [
              h.Type("button"),
              h.AriaLabel("Remove file"),
              h.OnClick(Message.ClickedRemoveFile()),
              h.Class(buttonClass({ size: "icon-sm" })),
            ],
            [Icon.x()],
          ),
        ],
      ),
    onNone: () =>
      h.textarea(
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
      ),
  })

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
          h.button(
            [
              h.Type("button"),
              h.AriaLabel("Attach file"),
              h.OnClick(Message.ClickedAttachFile()),
              h.Class(buttonClass({ size: "icon-sm" })),
            ],
            [Icon.paperclip()],
          ),
          h.input([
            h.Id(FILE_INPUT_ID),
            h.Type("file"),
            h.Accept(ACCEPT),
            h.Hidden(true),
            h.OnFileChange((files) => Message.ChangedFileInput({ files })),
          ]),
          ...picker(model, h, {
            pickerId: "Voice",
            label: `Voice: ${voiceName}`,
            triggerClass: buttonClass({ size: "sm" }, "max-w-48"),
            triggerContent: [h.span([h.Class("truncate")], [voiceName]), Icon.chevronDown("size-3.5")],
            options: voiceOptions(model, h),
            checkedIndex: pickerCheckedIndex(model, "Voice"),
          }),
          ...picker(model, h, {
            pickerId: "VoiceSpeed",
            label: `Voice speed: ${formatRate(model.speed)}`,
            triggerClass: buttonClass({ size: "sm" }),
            triggerContent: [Icon.gauge(), h.span([h.Class("tabular-nums")], [formatRate(model.speed)])],
            options: SPEEDS.map((value) => ({ label: formatRate(value) })),
            checkedIndex: pickerCheckedIndex(model, "VoiceSpeed"),
          }),
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
            [model.isAdding ? Icon.loaderCircle("animate-spin") : Icon.arrowUp()],
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
