/** `m:ss` under an hour, `h:mm:ss` above. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`
}

/** `1 h 12 min`, `24 min`, `40 s`. */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))} s`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

export function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}×`
}
