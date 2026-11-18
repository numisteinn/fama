import { useSyncExternalStore } from "react"

/** A typed localStorage value that React components can subscribe to. */
export interface Stored<A> {
  get: () => A
  set: (value: A) => void
  use: () => A
}

export function stored<A>(key: string, fallback: A, parse: (raw: unknown) => A | undefined): Stored<A> {
  const listeners = new Set<() => void>()
  let cache: { raw: string | null; value: A } | undefined

  const get = (): A => {
    const raw = readRaw(key)
    if (cache && cache.raw === raw) return cache.value
    let value = fallback
    if (raw !== null) {
      try {
        value = parse(JSON.parse(raw)) ?? fallback
      } catch {
        value = fallback
      }
    }
    cache = { raw, value }
    return value
  }

  const set = (value: A) => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Storage full or blocked: keep the value for this session only.
      cache = { raw: readRaw(key), value }
    }
    for (const listener of listeners) listener()
  }

  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) listener()
    }
    window.addEventListener("storage", onStorage)
    return () => {
      listeners.delete(listener)
      window.removeEventListener("storage", onStorage)
    }
  }

  return { get, set, use: () => useSyncExternalStore(subscribe, get) }
}

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export const asString = (raw: unknown) => (typeof raw === "string" ? raw : undefined)
export const asNumber = (raw: unknown) =>
  typeof raw === "number" && Number.isFinite(raw) ? raw : undefined
