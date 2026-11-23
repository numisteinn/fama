// The pairing link (D7): `fama://connect?server=<url>&token=<client token>`. `fama setup` prints it as a QR code, the
// iOS Camera opens it, and the phone app parses it here. Plain string code, no `URL`: React Native's `URL` is partial.

/** A pairing link that passed every check. The app still asks `GET /api/me` before it switches. */
export type ConnectLink = { readonly serverUrl: string; readonly token: string }

export type ConnectLinkResult =
  | { readonly _tag: "Ok"; readonly link: ConnectLink }
  | { readonly _tag: "Invalid"; readonly reason: string }

const MAX_TOKEN_LENGTH = 512

/** The pairing link for a server and a client token. */
export const connectUrl = (server: string, token: string): string =>
  `fama://connect?server=${encodeURIComponent(server)}&token=${encodeURIComponent(token)}`

const CONNECT = /^(?:fama:\/\/\/?connect|\/?connect)\/?(?:\?([^#]*))?(?:#.*)?$/i

/** True for a pairing link, valid or not. Other `fama://` links (for example the share sheet) are not. */
export const isConnectLink = (link: string): boolean => CONNECT.test(link.trim())

const decode = (value: string): string | null => {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "))
  } catch {
    return null
  }
}

/** The first value of each query key. A malformed escape makes the value null. */
const queryOf = (query: string): Map<string, string | null> => {
  const values = new Map<string, string | null>()
  for (const part of query.split("&")) {
    if (part === "") continue
    const eq = part.indexOf("=")
    const key = decode(eq === -1 ? part : part.slice(0, eq))
    if (key === null || values.has(key)) continue
    values.set(key, eq === -1 ? "" : decode(part.slice(eq + 1)))
  }
  return values
}

const octets = (host: string): ReadonlyArray<number> | null => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (match === null) return null
  const parts = match.slice(1).map(Number)
  return parts.every((part) => part <= 255) ? parts : null
}

/**
 * Hosts a dev or home server can use over plain HTTP: loopback, private and link-local IPv4, the Tailscale range
 * (100.64.0.0/10), IPv6 loopback, unique-local and link-local, `localhost`, single-label LAN names, `.local` and
 * `.home.arpa`.
 */
export const isLocalHost = (host: string): boolean => {
  const name = host.toLowerCase()
  if (name.startsWith("[")) {
    const ip = name.slice(1, -1)
    return ip === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(ip) || /^fe[89ab][0-9a-f]?:/.test(ip)
  }
  const ip = octets(name)
  if (ip !== null) {
    const [a, b] = ip as [number, number, number, number]
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    )
  }
  return (
    name === "localhost" ||
    name.endsWith(".localhost") ||
    !name.includes(".") ||
    name.endsWith(".local") ||
    name.endsWith(".home.arpa")
  )
}

const SERVER = /^(https?):\/\/([^/?#]*)(\/[^?#]*)?$/i
const HOST = /^(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::(\d{1,5}))?$/i

/**
 * Checks a server URL from a pairing link and returns it in the form the app stores: lowercase scheme and host, no
 * trailing slash. It must be `https`, or `http` on a local host. No user name, query or fragment.
 */
export const parseServerUrl = (input: string): { readonly _tag: "Ok"; readonly serverUrl: string } | { readonly _tag: "Invalid"; readonly reason: string } => {
  const match = SERVER.exec(input.trim())
  if (match === null) return { _tag: "Invalid", reason: "The server address is not valid." }
  const [, scheme, authority, path = ""] = match as unknown as [string, string, string, string | undefined]
  const host = HOST.exec(authority)
  if (host === null) return { _tag: "Invalid", reason: "The server address is not valid." }
  const [, hostname, port] = host as unknown as [string, string, string | undefined]
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) {
    return { _tag: "Invalid", reason: "The server address is not valid." }
  }
  const protocol = scheme.toLowerCase()
  if (protocol === "http" && !isLocalHost(hostname)) {
    return { _tag: "Invalid", reason: "The server must use https." }
  }
  const origin = `${protocol}://${hostname.toLowerCase()}${port === undefined ? "" : `:${port}`}`
  return { _tag: "Ok", serverUrl: origin + path.replace(/\/+$/, "") }
}

/** Parses and checks a pairing link. The reason is plain text for the user and never holds the token. */
export const parseConnectLink = (link: string): ConnectLinkResult => {
  const match = CONNECT.exec(link.trim())
  if (match === null) return { _tag: "Invalid", reason: "This is not a Fama connect link." }
  const query = queryOf(match[1] ?? "")
  const server = query.get("server")
  const rawToken = query.get("token")
  if (server === undefined || server === null || server.trim() === "") {
    return { _tag: "Invalid", reason: "The link has no server." }
  }
  const parsed = parseServerUrl(server)
  if (parsed._tag === "Invalid") return parsed
  if (rawToken === null) return { _tag: "Invalid", reason: "The token in the link is not valid." }
  if (rawToken === undefined || rawToken.trim() === "") return { _tag: "Invalid", reason: "The link has no token." }
  const token = rawToken.trim()
  if (token.length > MAX_TOKEN_LENGTH || !/^[\x21-\x7e]+$/.test(token)) {
    return { _tag: "Invalid", reason: "The token in the link is not valid." }
  }
  return { _tag: "Ok", link: { serverUrl: parsed.serverUrl, token } }
}
