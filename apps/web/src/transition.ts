import type { Command, Component } from "@effect/ui"
import type { AppCommandServices } from "~/command"
import type { AudioCommandServices } from "~/core/audio"
import type { AppMessage } from "~/message"
import type { AppModel } from "~/model"

type AppServices = AppCommandServices | AudioCommandServices
export type AppCommand = Command.Command<AppMessage | Component.Noop, AppServices>
export type UpdateResult = {
  readonly model: AppModel
  readonly commands: ReadonlyArray<AppCommand>
}
export type StepReturn = {
  readonly model: AppModel
  readonly commands?: ReadonlyArray<AppCommand>
}
export type Step = (model: AppModel) => StepReturn

export const combine = (model: AppModel, steps: ReadonlyArray<Step>): UpdateResult => {
  let currentModel = model
  const commands: Array<AppCommand> = []
  for (const step of steps) {
    const next = step(currentModel)
    currentModel = next.model
    if (next.commands) commands.push(...next.commands)
  }
  return { model: currentModel, commands }
}
