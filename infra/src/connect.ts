import { connectUrl } from "@fama/contracts"
import { renderUnicodeCompact } from "uqr"

/** The pairing link the phone app opens (D7). Built and parsed in `@fama/contracts`, so both sides agree. */
export { connectUrl }

/** The pairing link as a QR code drawn with Unicode half blocks, for a terminal. */
export const connectQr = (server: string, token: string) => renderUnicodeCompact(connectUrl(server, token), { border: 2 })
