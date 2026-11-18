import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "~/lib/utils"

export const buttonVariants = cva(
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border text-sm font-medium outline-none transition-[background-color,color,scale,opacity] duration-150 select-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11",
  {
    defaultVariants: { size: "default", variant: "ghost" },
    variants: {
      variant: {
        primary: "border-transparent bg-foreground text-background hover:opacity-90",
        outline: "border-input bg-transparent text-foreground hover:bg-accent",
        ghost:
          "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground data-[popup-open]:bg-accent data-[popup-open]:text-foreground",
        destructive: "border-transparent bg-destructive/15 text-destructive hover:bg-destructive/25",
      },
      size: {
        default: "h-9 px-3",
        sm: "h-8 px-2.5 text-[13px]",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-lg": "size-11 rounded-full [&_svg:not([class*='size-'])]:size-5",
      },
    },
  },
)

export interface ButtonProps
  extends useRender.ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, render, ...props }: ButtonProps) {
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      {
        className: cn(buttonVariants({ variant, size }), className),
        type: render ? undefined : "button",
      },
      props,
    ),
    render,
  })
}
