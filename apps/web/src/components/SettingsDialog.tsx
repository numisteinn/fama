import { Dialog } from "@base-ui/react/dialog"
import { Check, Copy, X } from "lucide-react"
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react"
import { api } from "~/api"
import { toApiError } from "~/library"
import { apiOrigin, apiToken } from "~/settings"
import { Button } from "./ui/button"

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/60 transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-popover p-5 shadow-[0_16px_48px_rgb(0_0_0/0.45)] outline-none transition-[opacity,scale] duration-200 ease-out data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold">Settings</Dialog.Title>
            <Dialog.Close render={<Button size="icon-sm" aria-label="Close" />}>
              <X />
            </Dialog.Close>
          </div>
          <SettingsForm onSaved={() => onOpenChange(false)} />
          <FeedRow />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function SettingsForm({ onSaved }: { onSaved: () => void }) {
  const [token, setToken] = useState(apiToken.get())
  const [origin, setOrigin] = useState(apiOrigin.get())
  const save = (event: FormEvent) => {
    event.preventDefault()
    apiToken.set(token.trim())
    apiOrigin.set(origin.trim().replace(/\/+$/, ""))
    onSaved()
  }
  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <Field label="API token">
        {(id) => (
          <input
            id={id}
            type="password"
            autoComplete="off"
            autoFocus
            value={token}
            onChange={(event) => setToken(event.target.value)}
            className={inputClass}
          />
        )}
      </Field>
      <Field label="Server">
        {(id) => (
          <input
            id={id}
            type="url"
            inputMode="url"
            placeholder={location.origin}
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
            className={inputClass}
          />
        )}
      </Field>
      <Button type="submit" variant="primary" className="self-end">
        Save
      </Button>
    </form>
  )
}

/** The private podcast feed, for "Add to Podcasts". */
function FeedRow() {
  const token = apiToken.use()
  const origin = apiOrigin.use()
  const [state, setState] = useState<{ _tag: "Loading" } | { _tag: "Ok"; url: string } | { _tag: "Error"; message: string }>({ _tag: "Loading" })
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let live = true
    setState({ _tag: "Loading" })
    api.feed().then(
      (url) => live && setState({ _tag: "Ok", url }),
      (cause: unknown) => {
        const error = toApiError(cause)
        if (live) setState(error.status === 401 ? { _tag: "Loading" } : { _tag: "Error", message: error.message })
      },
    )
    return () => {
      live = false
    }
  }, [token, origin])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <div className="mt-5 border-t border-border pt-4">
      <div className="mb-1.5 text-[13px] text-muted-foreground">Podcast feed</div>
      {state._tag === "Error" ? (
        <p className="text-[13px] text-destructive">{state.message}</p>
      ) : (
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-accent px-3 py-2 font-mono text-[12px] text-muted-foreground">
            {state._tag === "Ok" ? state.url : "…"}
          </code>
          <Button
            variant="outline"
            size="icon"
            aria-label={copied ? "Copied" : "Copy feed URL"}
            disabled={state._tag !== "Ok"}
            onClick={() => {
              if (state._tag !== "Ok") return
              void navigator.clipboard.writeText(state.url).then(() => setCopied(true))
            }}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
      )}
    </div>
  )
}

const inputClass =
  "h-10 w-full rounded-lg border border-input bg-transparent px-3 text-base outline-none placeholder:text-muted-foreground/60 focus:border-ring sm:h-9 sm:text-sm"

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] text-muted-foreground">
        {label}
      </label>
      {children(id)}
    </div>
  )
}
