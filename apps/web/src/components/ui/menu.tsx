import { Menu } from "@base-ui/react/menu"
import { Check } from "lucide-react"
import type { ReactElement, ReactNode } from "react"
import { cn } from "~/lib/utils"

export interface PickerOption<A> {
  value: A
  label: ReactNode
  /** Starts a new group with this heading. */
  group?: string
}

/** A trigger that opens a single-choice list. */
export function Picker<A>({
  trigger,
  value,
  options,
  onChange,
  side = "bottom",
  align = "start",
  label,
}: {
  trigger: ReactElement
  value: A
  options: ReadonlyArray<PickerOption<A>>
  onChange: (value: A) => void
  side?: "top" | "bottom"
  align?: "start" | "center" | "end"
  label: string
}) {
  const index = options.findIndex((option) => Object.is(option.value, value))
  return (
    <Menu.Root>
      <Menu.Trigger render={trigger} aria-label={label} />
      <Menu.Portal>
        <Menu.Positioner side={side} align={align} sideOffset={6} className="z-50 outline-none">
          <Menu.Popup
            className={cn(
              "max-h-[min(24rem,var(--available-height))] min-w-40 origin-[var(--transform-origin)] overflow-y-auto rounded-xl border border-border bg-popover p-1 text-sm shadow-[0_8px_24px_rgb(0_0_0/0.35)] outline-none",
              "transition-[opacity,scale] duration-150 ease-out data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            )}
          >
            <Menu.RadioGroup
              value={String(index)}
              onValueChange={(next: string) => {
                const option = options[Number(next)]
                if (option) onChange(option.value)
              }}
            >
              {options.map((option, i) => (
                <div key={i}>
                  {option.group !== undefined && (
                    <div className="px-2.5 pt-2 pb-1 text-xs text-muted-foreground first:pt-1">
                      {option.group}
                    </div>
                  )}
                  <Menu.RadioItem
                    value={String(i)}
                    closeOnClick
                    className="relative flex h-8 cursor-default items-center gap-2 rounded-lg pr-8 pl-2.5 outline-none select-none data-[highlighted]:bg-accent"
                  >
                    <span className="flex-1 truncate">{option.label}</span>
                    <Menu.RadioItemIndicator className="absolute right-2.5">
                      <Check className="size-3.5" />
                    </Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                </div>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
