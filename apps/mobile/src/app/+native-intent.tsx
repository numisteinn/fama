import { routeSystemPath } from "../lib/pairing"

// A pairing link (`fama://connect?...`) never reaches the router. See src/lib/pairing.ts.
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string | null {
  try {
    return routeSystemPath(path, initial)
  } catch {
    return initial ? "/" : null
  }
}
