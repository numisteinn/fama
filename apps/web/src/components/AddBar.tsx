import type { Episode, Voice, VoiceRef } from "@fama/contracts"
import { ArrowUp, ChevronDown, FileText, Gauge, LoaderCircle, Paperclip, X } from "lucide-react"
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react"
import { api } from "~/api"
import { toApiError } from "~/library"
import { formatRate } from "~/lib/format"
import { cn } from "~/lib/utils"
import { lastSpeed, lastVoice } from "~/settings"
import { Button } from "./ui/button"
import { Picker, type PickerOption } from "./ui/menu"

const ACCEPT = ".pdf,.epub,.txt,.md,.markdown,.html,.htm"
const SPEEDS = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.5] as const

/** What the add bar will submit. */
type Draft =
  | { _tag: "Empty" }
  | { _tag: "Url"; url: string }
  | { _tag: "Text"; text: string }
  | { _tag: "File"; file: File }

function toDraft(text: string, file: File | null): Draft {
  if (file) return { _tag: "File", file }
  const trimmed = text.trim()
  if (!trimmed) return { _tag: "Empty" }
  if (!/\s/.test(trimmed) && /^https?:\/\//i.test(trimmed) && URL.canParse(trimmed)) {
    return { _tag: "Url", url: trimmed }
  }
  return { _tag: "Text", text: trimmed }
}

function submitDraft(draft: Draft, voice: VoiceRef | null, speed: number): Promise<Episode> {
  switch (draft._tag) {
    case "Url":
      return api.create({ source: { _tag: "Url", url: draft.url }, voice, speed })
    case "Text":
      return api.create({ source: { _tag: "Text", title: null, text: draft.text }, voice, speed })
    case "File":
      return api.upload(draft.file, voice, speed)
    case "Empty":
      return Promise.reject(new Error("Nothing to add"))
  }
}

export function AddBar({ onAdded }: { onAdded: (episode: Episode) => void }) {
  const [text, setText] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const voice = lastVoice.use()
  const speed = lastSpeed.use()
  const voices = useVoices()
  const fileInput = useRef<HTMLInputElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const dragging = useWindowDrop((dropped) => {
    setFile(dropped)
    setError(null)
  })

  const draft = toDraft(text, file)

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    if (draft._tag === "Empty" || busy) return
    setBusy(true)
    setError(null)
    try {
      onAdded(await submitDraft(draft, voice, speed))
      setText("")
      setFile(null)
      textarea.current?.focus()
    } catch (cause) {
      setError(toApiError(cause).message)
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
    }
  }

  return (
    <>
      <form
        onSubmit={submit}
        className={cn(
          "rounded-2xl border border-input bg-surface transition-[border-color,box-shadow] duration-200 focus-within:border-ring/60",
          dragging && "border-foreground/60",
        )}
      >
        {file ? (
          <div className="flex items-center gap-3 px-4 pt-4 pb-2">
            <FileText className="size-5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-[15px]">{file.name}</span>
            <Button size="icon-sm" aria-label="Remove file" onClick={() => setFile(null)}>
              <X />
            </Button>
          </div>
        ) : (
          <textarea
            ref={textarea}
            value={text}
            onChange={(event) => {
              setText(event.target.value)
              setError(null)
            }}
            onKeyDown={onKeyDown}
            placeholder="Paste a link or text"
            aria-label="Link or text"
            rows={1}
            autoFocus
            className="field-sizing-content block max-h-60 min-h-14 w-full resize-none bg-transparent px-4 pt-4 pb-2 text-base outline-none placeholder:text-muted-foreground sm:text-[15px]"
          />
        )}
        <div className="flex items-center gap-1 p-2">
          <Button size="icon-sm" aria-label="Attach file" onClick={() => fileInput.current?.click()}>
            <Paperclip />
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            hidden
            onChange={(event) => {
              const picked = event.target.files?.[0]
              if (picked) setFile(picked)
              event.target.value = ""
            }}
          />
          <VoicePicker voices={voices} value={voice} />
          <Picker
            label="Voice speed"
            value={speed}
            onChange={lastSpeed.set}
            options={SPEEDS.map((value) => ({ value, label: formatRate(value) }))}
            trigger={
              <Button size="sm">
                <Gauge />
                <span className="tabular-nums">{formatRate(speed)}</span>
              </Button>
            }
          />
          {error && (
            <p role="alert" className="ml-2 min-w-0 flex-1 truncate text-[13px] text-destructive">
              {error}
            </p>
          )}
          <Button
            type="submit"
            variant="primary"
            size="icon-sm"
            aria-label="Add"
            disabled={draft._tag === "Empty" || busy}
            className="ml-auto rounded-full"
          >
            {busy ? <LoaderCircle className="animate-spin" /> : <ArrowUp />}
          </Button>
        </div>
      </form>
      {dragging && (
        <div className="pointer-events-none fixed inset-3 z-40 grid place-items-center rounded-3xl border-2 border-dashed border-foreground/40 bg-background/80 backdrop-blur-sm">
          <span className="text-lg font-medium">Drop to add</span>
        </div>
      )}
    </>
  )
}

function VoicePicker({ voices, value }: { voices: ReadonlyArray<Voice>; value: VoiceRef | null }) {
  const options: Array<PickerOption<VoiceRef | null>> = [{ value: null, label: "Auto" }]
  let group: string | undefined
  for (const voice of sortVoices(voices)) {
    const language = languageName(voice.language)
    options.push({ value: voice.id, label: voice.name, ...(language !== group && { group: language }) })
    group = language
  }
  const selected = voices.find((voice) => voice.id === value)
  return (
    <Picker
      label="Voice"
      value={selected ? value : null}
      onChange={lastVoice.set}
      options={options}
      trigger={
        <Button size="sm" className="max-w-48">
          <span className="truncate">{selected?.name ?? "Auto"}</span>
          <ChevronDown className="size-3.5" />
        </Button>
      }
    />
  )
}

function sortVoices(voices: ReadonlyArray<Voice>): Array<Voice> {
  return [...voices].sort(
    (a, b) =>
      languageName(a.language).localeCompare(languageName(b.language)) ||
      a.name.localeCompare(b.name),
  )
}

const languageNames = new Intl.DisplayNames(undefined, { type: "language" })
function languageName(code: string): string {
  try {
    return languageNames.of(code) ?? code
  } catch {
    return code
  }
}

function useVoices(): ReadonlyArray<Voice> {
  const [voices, setVoices] = useState<ReadonlyArray<Voice>>([])
  useEffect(() => {
    let live = true
    api.voices().then(
      (list) => live && setVoices(list),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [])
  return voices
}

/** True while a file is dragged over the window. Calls `onDrop` with the first dropped file. */
function useWindowDrop(onDrop: (file: File) => void): boolean {
  const [dragging, setDragging] = useState(false)
  const callback = useRef(onDrop)
  callback.current = onDrop
  useEffect(() => {
    let depth = 0
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth += 1
      setDragging(true)
    }
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const over = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault()
    }
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth = 0
      setDragging(false)
      const file = event.dataTransfer?.files[0]
      if (file) callback.current(file)
    }
    window.addEventListener("dragenter", enter)
    window.addEventListener("dragleave", leave)
    window.addEventListener("dragover", over)
    window.addEventListener("drop", drop)
    return () => {
      window.removeEventListener("dragenter", enter)
      window.removeEventListener("dragleave", leave)
      window.removeEventListener("dragover", over)
      window.removeEventListener("drop", drop)
    }
  }, [])
  return dragging
}
