import { Slider } from "@base-ui/react/slider"
import { Download, ListMusic, LoaderCircle, Pause, Play, RotateCcw, RotateCw } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"
import { formatClock, formatRate } from "~/lib/format"
import { RATES, usePlayer } from "~/player"
import { mediaUrl } from "~/settings"
import { Button } from "./ui/button"
import { Picker } from "./ui/menu"

export function PlayerBar() {
  const player = usePlayer()
  const { episode } = player
  useKeyboardShortcuts()
  if (!episode) return null
  const chapter = episode.chapters[player.chapter]

  return (
    <footer className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl">
      <div className="mx-auto grid max-w-5xl grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,28rem)_minmax(0,1fr)] sm:gap-x-6">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{episode.title}</div>
          {episode.chapters.length > 1 && chapter && (
            <div className="truncate text-[13px] text-muted-foreground">{chapter.title}</div>
          )}
        </div>

        <div className="contents sm:flex sm:flex-col sm:items-center sm:gap-1">
          <Transport />
          <Scrubber />
        </div>

        <div className="col-span-2 grid grid-cols-[1fr_auto_1fr] items-center gap-1 sm:col-span-1 sm:flex sm:justify-end">
          <Picker
            label={`Playback speed: ${formatRate(player.rate)}`}
            side="top"
            value={player.rate}
            onChange={player.setRate}
            options={RATES.map((value) => ({ value, label: formatRate(value) }))}
            trigger={
              <Button size="sm" className="w-14 justify-self-start tabular-nums">
                {formatRate(player.rate)}
              </Button>
            }
          />
          <div className="flex items-center gap-1 sm:hidden">
            <SkipButtons />
          </div>
          <div className="flex items-center justify-end gap-1">
            {episode.chapters.length > 1 && (
              <Picker
                label="Chapters"
                side="top"
                align="end"
                value={player.chapter}
                onChange={player.playChapter}
                options={episode.chapters.map((item) => ({
                  value: item.index,
                  label: (
                    <span className="flex gap-3">
                      <span className="w-5 text-right text-muted-foreground tabular-nums">{item.index + 1}</span>
                      <span className="truncate">{item.title}</span>
                    </span>
                  ),
                }))}
                trigger={
                  <Button size="icon-sm">
                    <ListMusic />
                  </Button>
                }
              />
            )}
            {episode.bookUrl && (
              <Button
                size="icon-sm"
                aria-label="Download"
                render={<a href={mediaUrl(episode.bookUrl)} download={`${episode.title}.m4b`} />}
              >
                <Download />
              </Button>
            )}
          </div>
        </div>
      </div>
    </footer>
  )
}

function Transport() {
  const player = usePlayer()
  return (
    <div className="col-start-2 row-start-1 flex items-center gap-1 sm:col-auto sm:row-auto">
      <div className="hidden items-center gap-1 sm:flex">
        <SkipButtons>
          <PlayButton />
        </SkipButtons>
      </div>
      <div className="sm:hidden">
        <PlayButton />
      </div>
      <span className="sr-only" aria-live="polite">
        {player.waiting ? "Waiting for the next chapter" : ""}
      </span>
    </div>
  )
}

function PlayButton() {
  const player = usePlayer()
  return (
    <Button
      variant="primary"
      size="icon-lg"
      aria-label={player.playing ? "Pause" : "Play"}
      onClick={player.toggle}
    >
      {player.waiting ? (
        <LoaderCircle className="animate-spin" />
      ) : player.playing ? (
        <Pause className="fill-current" />
      ) : (
        <Play className="translate-x-px fill-current" />
      )}
    </Button>
  )
}

function SkipButtons({ children }: { children?: ReactNode }) {
  const player = usePlayer()
  return (
    <>
      <Button size="icon" aria-label="Back 15 seconds" onClick={() => player.skip(-15_000)}>
        <SkipIcon direction="back" seconds={15} />
      </Button>
      {children}
      <Button size="icon" aria-label="Forward 30 seconds" onClick={() => player.skip(30_000)}>
        <SkipIcon direction="forward" seconds={30} />
      </Button>
    </>
  )
}

function SkipIcon({ direction, seconds }: { direction: "back" | "forward"; seconds: number }) {
  const Icon = direction === "back" ? RotateCcw : RotateCw
  return (
    <span className="relative grid size-6 place-items-center">
      <Icon className="absolute size-6 stroke-[1.5]" />
      <span className="relative text-[8.5px] leading-none font-semibold tabular-nums">{seconds}</span>
    </span>
  )
}

function Scrubber() {
  const player = usePlayer()
  const [dragMs, setDragMs] = useState<number | null>(null)
  const max = Math.max(1, player.durationMs)
  const value = Math.min(dragMs ?? player.positionMs, max)
  return (
    <div className="col-span-2 flex w-full items-center gap-3 text-xs text-muted-foreground tabular-nums sm:col-span-1">
      <span className="w-12 text-right">{formatClock(value)}</span>
      <Slider.Root
        aria-label="Position"
        min={0}
        max={max}
        step={1000}
        value={value}
        onValueChange={(next) => setDragMs(next)}
        onValueCommitted={(next) => {
          player.seek(next)
          setDragMs(null)
        }}
        className="flex-1"
      >
        <Slider.Control className="group/scrub flex h-6 w-full cursor-pointer touch-none items-center select-none">
          <Slider.Track className="relative h-1 w-full rounded-full bg-faint">
            <Slider.Indicator className="rounded-full bg-foreground" />
            <Slider.Thumb
              getAriaValueText={(_, ms) => formatClock(ms)}
              className="size-3 rounded-full bg-foreground opacity-0 shadow-[0_1px_4px_rgb(0_0_0/0.4)] transition-opacity duration-150 outline-none group-hover/scrub:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring data-[dragging]:opacity-100 pointer-coarse:opacity-100"
            />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
      <span className="w-12">{formatClock(player.durationMs)}</span>
    </div>
  )
}

const INTERACTIVE = "input, textarea, select, [contenteditable], button, a, [role=slider], [role^=menuitem]"

/** Space toggles, arrows skip. Focused controls keep their own keys. */
function useKeyboardShortcuts() {
  const player = usePlayer()
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!player.episode || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest(INTERACTIVE)) return
      if (event.key === " ") player.toggle()
      else if (event.key === "ArrowLeft") player.skip(-15_000)
      else if (event.key === "ArrowRight") player.skip(30_000)
      else return
      event.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [player])
}
