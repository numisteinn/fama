// QR pairing (D7). The setup QR code holds `fama://connect?server=<url>&token=<token>`. The router never sees that
// link: `redirectSystemPath` hands it to the slot below, so the token stays out of navigation state and history.
// `PairingHandler` takes it once, checks `GET /api/me`, and saves the connection only on success.
import { isConnectLink, parseConnectLink, parseServerUrl, type ConnectLinkResult } from "@fama/contracts"

let pending: ConnectLinkResult | null = null
const listeners = new Set<() => void>()

/** Puts a parsed link in the slot. A newer link replaces one not yet taken. */
export function offerPairing(result: ConnectLinkResult): void {
  pending = result
  for (const listener of listeners) listener()
}

/** Takes the link from the slot, at most once. */
export function takePairing(): ConnectLinkResult | null {
  const result = pending
  pending = null
  return result
}

export function onPairing(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The `redirectSystemPath` of `+native-intent`. A connect link goes to the slot: at launch the app opens at `/`,
 * while running it stays where it is. Every other link passes through unchanged.
 */
export function routeSystemPath(path: string, initial: boolean): string | null {
  if (!isConnectLink(path)) return path
  offerPairing(parseConnectLink(path))
  return initial ? "/" : null
}

/** The connection the app has now. `userId` is null until the server named the token's user. */
export type CurrentAccount = { readonly serverUrl: string; readonly userId: string | null } | null

/** What to do with a link whose token the server accepted: connect at once, or ask before switching. */
export type PairingStep = "Connect" | "Ask"

const sameServer = (a: string, b: string) => {
  const key = (url: string) => {
    const parsed = parseServerUrl(url)
    return parsed._tag === "Ok" ? parsed.serverUrl : url.trim().replace(/\/+$/, "")
  }
  return key(a) === key(b)
}

/** Connect when nothing is connected or the link names the same server and user. Otherwise ask once. */
export function pairingStep(current: CurrentAccount, incoming: { readonly serverUrl: string; readonly userId: string }): PairingStep {
  if (current === null) return "Connect"
  return sameServer(current.serverUrl, incoming.serverUrl) && current.userId === incoming.userId ? "Connect" : "Ask"
}
