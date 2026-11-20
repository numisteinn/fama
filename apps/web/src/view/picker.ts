import { Effect, Option, Schema } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"

type Child = Html | string
import { pickerItemId, pickerMenuId, pickerTriggerId } from "~/command"
import { Message } from "~/message"
import { type Model, type PickerId, type PickerItem, pickerItems } from "~/model"
import { isTypeAheadKey } from "~/update"
import * as Icon from "~/view/icon"

/**
 * A single-choice menu: a trigger button and a `role=menu` popup of `menuitemradio` items.
 * Same roles and names as the base-ui `Menu.RadioGroup` it replaces.
 */

export interface PickerConfig {
  readonly pickerId: PickerId
  /** Accessible name of the trigger and the menu. */
  readonly label: string
  readonly triggerClass: string
  readonly triggerContent: ReadonlyArray<Child>
  readonly checkedIndex: number
  readonly side?: "Top" | "Bottom"
  readonly align?: "Start" | "End"
}

const GAP_PX = 6
const EDGE_PX = 8

/** Places the popup next to its trigger, like base-ui's positioner, and follows scroll and resize. */
export const AnchorPicker = Mount.define("AnchorPicker", {
  args: { triggerId: Schema.String, side: Schema.Literals(["Top", "Bottom"]), align: Schema.Literals(["Start", "End"]) },
  messages: [Message.CompletedAnchorPicker],
  execute: ({ element, triggerId, side, align }) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const place = () => {
          const trigger = document.getElementById(triggerId)
          if (!trigger || !(element instanceof HTMLElement)) return
          const rect = trigger.getBoundingClientRect()
          const style = element.style
          style.position = "fixed"
          if (side === "Bottom") {
            style.top = `${rect.bottom + GAP_PX}px`
            style.bottom = ""
            style.setProperty("--available-height", `${window.innerHeight - rect.bottom - GAP_PX - EDGE_PX}px`)
          } else {
            style.bottom = `${window.innerHeight - rect.top + GAP_PX}px`
            style.top = ""
            style.setProperty("--available-height", `${rect.top - GAP_PX - EDGE_PX}px`)
          }
          if (align === "Start") {
            style.left = `${Math.max(EDGE_PX, rect.left)}px`
            style.right = ""
          } else {
            style.right = `${Math.max(EDGE_PX, window.innerWidth - rect.right)}px`
            style.left = ""
          }
          style.setProperty("--transform-origin", `${align === "Start" ? "left" : "right"} ${side === "Bottom" ? "top" : "bottom"}`)
        }
        place()
        window.addEventListener("resize", place)
        window.addEventListener("scroll", place, true)
        return place
      }),
      (place) =>
        Effect.sync(() => {
          window.removeEventListener("resize", place)
          window.removeEventListener("scroll", place, true)
        }),
    ).pipe(Effect.as(Message.CompletedAnchorPicker())),
})

const POPUP_CLASS =
  "fixed z-50 max-h-[min(24rem,var(--available-height))] min-w-40 origin-[var(--transform-origin)] overflow-y-auto rounded-xl border border-border bg-popover p-1 text-sm shadow-[0_8px_24px_rgb(0_0_0/0.35)] outline-none transition-[opacity,scale] duration-150 ease-out starting:scale-95 starting:opacity-0"
const ITEM_CLASS =
  "relative flex h-8 cursor-default items-center gap-2 rounded-lg pr-8 pl-2.5 outline-none select-none hover:bg-accent data-[highlighted]:bg-accent"
const HEADING_CLASS = "px-2.5 pt-2 pb-1 text-xs text-muted-foreground first:pt-1"

const triggerKey = (pickerId: PickerId) => (key: string) =>
  key === "ArrowDown" || key === "ArrowUp"
    ? Option.some(Message.PressedPickerTriggerKey({ pickerId, key }))
    : Option.none()

/**
 * An item's label. A chapter number sits in its own column; the space between the columns is a text
 * node, so the DOM text and the accessible name read `2 Evening`, which is the text type-ahead matches.
 */
const itemLabel = (item: PickerItem, h: HtmlBuilder<Message>): Child =>
  item.number === undefined
    ? item.name
    : h.span(
        [h.Class("flex gap-3")],
        [
          h.span([h.Class("w-5 text-right text-muted-foreground tabular-nums")], [String(item.number)]),
          " ",
          h.span([h.Class("truncate")], [item.name]),
        ],
      )

const MENU_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", "Escape", "Tab"])

/** The trigger, then (while open) the backdrop and the popup, as siblings so no wrapper enters the tree. */
export const picker = (model: Model, h: HtmlBuilder<Message>, config: PickerConfig): ReadonlyArray<Html> => {
  const { pickerId, label, checkedIndex } = config
  const maybeOpen = model.picker._tag === "Open" && model.picker.pickerId === pickerId ? Option.some(model.picker) : Option.none()
  const isOpen = Option.isSome(maybeOpen)
  const maybeActiveIndex = Option.flatMap(maybeOpen, (open) => open.maybeActiveIndex)
  const triggerId = pickerTriggerId(pickerId)

  const trigger = h.button(
    [
      h.Id(triggerId),
      h.Type("button"),
      h.AriaHasPopup("menu"),
      h.AriaExpanded(isOpen),
      h.AriaLabel(label),
      ...(isOpen ? [h.AriaControls(pickerMenuId(pickerId)), h.DataAttribute("popup-open", "")] : []),
      h.OnClick(Message.ClickedPickerTrigger({ pickerId })),
      h.OnKeyDownPreventDefault(triggerKey(pickerId)),
      h.Class(config.triggerClass),
    ],
    config.triggerContent,
  )
  if (!isOpen) return [trigger]

  const items = pickerItems(model, pickerId).map((option, index) => {
    const isChecked = index === checkedIndex
    const isActive = Option.exists(maybeActiveIndex, (active) => active === index)
    const item = h.div(
      [
        h.Id(pickerItemId(pickerId, index)),
        h.Role("menuitemradio"),
        h.AriaChecked(isChecked),
        h.Tabindex(-1),
        ...(isActive ? [h.DataAttribute("highlighted", "")] : []),
        h.OnClick(Message.ClickedPickerItem({ pickerId, index })),
        h.Class(ITEM_CLASS),
      ],
      [
        h.span([h.Class("flex-1 truncate")], [itemLabel(option, h)]),
        ...(isChecked ? [h.span([h.Class("absolute right-2.5")], [Icon.check("size-3.5")])] : []),
      ],
    )
    return h.keyed("div")(
      `${pickerId}-${index}`,
      [],
      option.group === undefined ? [item] : [h.div([h.Class(HEADING_CLASS)], [option.group]), item],
    )
  })

  return [
    trigger,
    h.div([h.Class("fixed inset-0 z-40"), h.OnClick(Message.ClickedPickerBackdrop())], []),
    h.div(
      [
        h.Id(pickerMenuId(pickerId)),
        h.Role("menu"),
        h.AriaLabelledBy(triggerId),
        h.Tabindex(-1),
        ...Option.match(maybeActiveIndex, {
          onNone: () => [],
          onSome: (index) => [h.AriaActiveDescendant(pickerItemId(pickerId, index))],
        }),
        h.OnKeyDownPreventDefault((key, modifiers) =>
          MENU_KEYS.has(key) ||
          (isTypeAheadKey(key) && !modifiers.metaKey && !modifiers.ctrlKey && !modifiers.altKey)
            ? Option.some(Message.PressedPickerKey({ key }))
            : Option.none(),
        ),
        h.OnMount(AnchorPicker({ triggerId, side: config.side ?? "Bottom", align: config.align ?? "Start" })),
        h.Class(POPUP_CLASS),
      ],
      [h.div([h.Role("group")], items)],
    ),
  ]
}
