import { renderUnicodeCompact } from "uqr"

/** The pairing link the phone app opens (D7): `fama://connect?server=<url>&token=<token>`. */
export const connectUrl = (server: string, token: string) => {
  const url = new URL("fama://connect")
  url.searchParams.set("server", server)
  url.searchParams.set("token", token)
  return url.href
}

/** The pairing link as a QR code drawn with Unicode half blocks, for a terminal. */
export const connectQr = (server: string, token: string) => renderUnicodeCompact(connectUrl(server, token), { border: 2 })
