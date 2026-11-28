import { UiSchema } from "@effect/ui"
import { Menu } from "@effect/ui-kit"
import { Html } from "@effect/ui/html"
import { Schema } from "effect"
import * as Icon from "~/ui/icon"

export const PickerOption = Schema.Struct({
  value: Schema.String,
  name: Schema.String,
  number: Schema.optional(Schema.Number),
  group: Schema.optional(Schema.String),
})
export type PickerOption = typeof PickerOption.Type

export const PickerProps = Schema.Struct({
  label: Schema.String,
  triggerText: Schema.String,
  triggerKind: Schema.Literals(["voice", "voiceSpeed", "playbackSpeed", "chapters", "sleep"]),
  triggerClass: Schema.String,
  selectedValue: Schema.NullOr(Schema.String),
  items: Schema.Array(PickerOption),
  side: Schema.optional(Schema.Literals(["top", "bottom"])),
  align: Schema.optional(Schema.Literals(["start", "end"])),
})
export type PickerProps = typeof PickerProps.Type

export const PickerModel = Schema.Struct({
  open: Schema.Boolean,
})
export type PickerModel = typeof PickerModel.Type

export const PickerMessage = UiSchema.TaggedEnum({
  RequestedOpenMenu: {},
  RequestedCloseMenu: {},
  PickedMenuItem: { value: Schema.String },
})
export type PickerMessage = typeof PickerMessage.Type

export const PickerEvents = UiSchema.TaggedEnum({
  Picked: { value: Schema.String },
})
export type PickerEvents = typeof PickerEvents.Type

const POPUP_CLASS =
  "max-h-[min(24rem,var(--available-height))] min-w-40 origin-[var(--transform-origin)] overflow-y-auto rounded-xl border border-border bg-popover p-1 text-sm text-foreground shadow-[0_8px_24px_rgb(0_0_0/0.35)] outline-none transition-[opacity,scale] duration-150 ease-out data-[starting-style]:scale-95 data-[starting-style]:opacity-0"
const ITEM_CLASS =
  "relative flex h-8 cursor-default items-center gap-2 rounded-lg pr-8 pl-2.5 outline-none select-none hover:bg-accent data-[highlighted]:bg-accent"
const HEADING_CLASS = "px-2.5 pt-2 pb-1 text-xs text-muted-foreground first:pt-1"

export const pickerOptionText = (item: PickerOption): string =>
  item.number === undefined ? item.name : `${item.number} ${item.name}`

const groupOptions = (
  items: ReadonlyArray<PickerOption>,
): ReadonlyArray<{ readonly group: string | undefined; readonly items: ReadonlyArray<PickerOption> }> => {
  const sections: Array<{ readonly group: string | undefined; readonly items: Array<PickerOption> }> = []
  for (const item of items) {
    const last = sections[sections.length - 1]
    if (last && last.group === item.group) {
      last.items.push(item)
    } else {
      sections.push({ group: item.group, items: [item] })
    }
  }
  return sections
}

/**
 * Single-choice radio menu backed by `@effect/ui-kit` `Menu`.
 * Replaces the hand-rolled `AnchorPicker`, flip math, Base UI typeahead port, and root `Picker` state.
 */
export const Picker = Html.component({
  name: "Picker",
  props: PickerProps,
  model: PickerModel,
  message: PickerMessage,
  events: PickerEvents,
}).make({
  init: () => ({ open: false }),
  update: {
    RequestedOpenMenu: ($) => $.evolve({ open: true }),
    RequestedCloseMenu: ($) => $.evolve({ open: false }),
    PickedMenuItem: ($, { value }) =>
      $.evolve({ open: false }).emit(PickerEvents.Picked({ value })),
  },
  view: (h, model) => {
    const menuItems = h.props.items.map((item) => ({
      value: item.value,
      label: pickerOptionText(item),
    }))
    const sections = groupOptions(h.props.items)
    const triggerContent = () => {
      switch (h.props.triggerKind) {
        case "voice":
          return [h.span.class("truncate").children(h.props.triggerText), Icon.chevronDown(h, "size-3.5")]
        case "voiceSpeed":
          return [Icon.gauge(h), h.span.class("tabular-nums").children(h.props.triggerText)]
        case "playbackSpeed":
          return [h.props.triggerText]
        case "chapters":
          return [Icon.listMusic(h)]
        case "sleep":
          return [
            Icon.moon(h),
            ...(h.props.triggerText ? [h.span.class("text-xs font-semibold tabular-nums").children(h.props.triggerText)] : []),
          ]
      }
    }

    return Menu(h, {
      props: {
        open: model.open,
        items: menuItems,
        side: h.props.side ?? "bottom",
        align: h.props.align ?? "start",
        sideOffset: 6,
        collisionPadding: 8,
        collisionAvoidance: { side: "flip" },
      },
      onEmit: {
        RequestedOpen: () => PickerMessage.RequestedOpenMenu(),
        RequestedClose: () => PickerMessage.RequestedCloseMenu(),
        Picked: ({ value }) => PickerMessage.PickedMenuItem({ value }),
        Highlighted: () => undefined,
        RequestedQuery: () => undefined,
        Settled: () => undefined,
      },
      view: (menu) => {
        const renderItem = (item: PickerOption) =>
          menu
            .radioItem({
              element: h.div.class(ITEM_CLASS),
              value: item.value,
              closeOnClick: true,
            })
            .children(
              h.span.class("flex-1 truncate").children(
                item.number === undefined
                  ? item.name
                  : h.span.class("flex gap-3").children(
                      h.span.class("w-5 text-right text-muted-foreground tabular-nums").children(String(item.number)),
                      " ",
                      h.span.class("truncate").children(item.name),
                    ),
              ),
              menu
                .radioItemIndicator({ element: h.span.class("absolute right-2.5"), value: item.value })
                ?.children(Icon.check(h, "size-3.5")),
            )

        return h.span.class("contents").children(
          menu
            .trigger({
              element: h.button.attr("aria-label", h.props.label).class(h.props.triggerClass),
            })
            .children(...triggerContent()),
          menu.mounted &&
            menu.backdrop(h.div.class("fixed inset-0 z-40 m-0 border-0 bg-transparent p-0")),
          menu.mounted &&
            menu
              .positioner(h.div.class("z-50 m-0 overflow-visible border-0 bg-transparent p-0"))
              .children(
                menu.popup(h.div.class(POPUP_CLASS)).children(
                  menu
                    .radioGroup({ element: h.div, value: h.props.selectedValue })
                    .children(
                      ...sections.map((section) =>
                        section.group === undefined
                          ? section.items.map(renderItem)
                          : menu
                              .group({ element: h.div, group: section.group })
                              .key(section.group)
                              .children(
                                menu
                                  .groupLabel({ element: h.div.class(HEADING_CLASS), group: section.group })
                                  .children(section.group),
                                ...section.items.map(renderItem),
                              ),
                      ),
                    ),
                ),
              ),
        )
      },
    })
  },
})
