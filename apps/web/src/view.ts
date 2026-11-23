import type { Document, HtmlBuilder } from "foldkit/html"
import type { Message } from "~/message"
import { type Model, current } from "~/model"
import { Message as M } from "~/message"
import { addBar } from "~/view/addBar"
import { buttonClass } from "~/view/button"
import * as Icon from "~/view/icon"
import { library } from "~/view/library"
import { playerBar } from "~/view/playerBar"
import { settingsDialog } from "~/view/settings"
import { Option } from "effect"

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Fama",
  body: h.div(
    [h.Id("root")],
    [
      h.main(
        [
          h.Class("mx-auto w-full max-w-2xl px-4 pt-[env(safe-area-inset-top)] sm:px-6"),
          h.Style({ paddingBottom: Option.isSome(current(model)) ? "11rem" : "3rem" }),
        ],
        [
          h.header(
            [h.Class("flex h-14 items-center justify-between")],
            [
              h.span(
                [h.Class("flex items-center")],
                [
                  h.img([h.Src("/lockup-dark.svg"), h.Alt("Fama"), h.Class("logo-dark h-7 w-auto")]),
                  h.img([h.Src("/lockup-light.svg"), h.Alt("Fama"), h.Class("logo-light h-7 w-auto")]),
                ],
              ),
              h.button(
                [
                  h.Type("button"),
                  h.AriaLabel("Settings"),
                  h.OnClick(M.ClickedSettings()),
                  h.Class(buttonClass({ size: "icon-sm" })),
                ],
                [Icon.settings()],
              ),
            ],
          ),
          ...addBar(model, h),
          h.section([h.Class("mt-6")], [library(model, h)]),
        ],
      ),
      ...playerBar(model, h),
      settingsDialog(model, h),
    ],
  ),
})
