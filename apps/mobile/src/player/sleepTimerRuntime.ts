import { useEffect, useState, useSyncExternalStore } from "react"
import { getPlayerState, player, subscribePlayer } from "./player"
import {
  accessibilityLabel,
  createSleepTimerController,
  formatRemaining,
  type SleepTimerMode,
} from "./sleepTimer"

// Module-level driver: stays alive when the PlayerScreen modal unmounts (MiniPlayer / background).
let countdownInterval: ReturnType<typeof setInterval> | null = null

function syncInterval(mode: SleepTimerMode) {
  if (mode._tag === "Countdown") {
    if (countdownInterval !== null) return
    countdownInterval = setInterval(() => {
      const { status, episode } = getPlayerState()
      sleepTimer.check(status, Date.now(), episode)
    }, 1_000)
  } else if (countdownInterval !== null) {
    clearInterval(countdownInterval)
    countdownInterval = null
  }
}

export const sleepTimer = createSleepTimerController(
  {
    pause: () => player.pause(),
    seek: (position) => player.seek(position, false, true),
  },
  syncInterval,
)

subscribePlayer((kind, targetPositionSec) => {
  const { status, episode } = getPlayerState()
  if (kind === "seek" && targetPositionSec !== undefined) {
    sleepTimer.onManualSeek(episode, targetPositionSec)
    return
  }
  sleepTimer.check(status, Date.now(), episode)
})

/** Display-only hook for the active sleep timer state and live countdown label. */
export function useSleepTimer(): {
  readonly mode: SleepTimerMode
  readonly remaining: string | null
  readonly a11yLabel: string
} {
  const snapshot = useSyncExternalStore(sleepTimer.subscribe, sleepTimer.getSnapshot, sleepTimer.getSnapshot)
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    setNowMs(Date.now())
    if (snapshot.mode._tag !== "Countdown") return
    const interval = setInterval(() => setNowMs(Date.now()), 1_000)
    return () => clearInterval(interval)
  }, [snapshot.mode])

  return {
    mode: snapshot.mode,
    remaining: formatRemaining(snapshot.mode, nowMs),
    a11yLabel: accessibilityLabel(snapshot.mode, nowMs),
  }
}
