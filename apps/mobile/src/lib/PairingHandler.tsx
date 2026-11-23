import type { ConnectLink, ConnectLinkResult, Me } from "@fama/contracts"
import * as Haptics from "expo-haptics"
import { useRouter } from "expo-router"
import { useEffect, useRef, useState } from "react"
import { Alert } from "react-native"
import { ApiError, createApi } from "./api"
import { onPairing, pairingStep, takePairing } from "./pairing"
import { useSettings } from "./settings"

/**
 * Takes a pairing link from the slot, checks its token with `GET /api/me`, and connects only on success. A switch to
 * another server or user asks first. On failure the current connection stays. Never logs the link or the token.
 */
export function PairingHandler() {
  const settings = useSettings()
  const router = useRouter()
  const [offers, setOffers] = useState(0)
  const latest = useRef({ settings, router })
  latest.current = { settings, router }

  useEffect(() => onPairing(() => setOffers((count) => count + 1)), [])

  useEffect(() => {
    // Wait for secure storage, so the current connection is known before the decision.
    if (!settings.ready) return
    const offered = takePairing()
    if (offered !== null) void pair(offered, () => latest.current)
  }, [settings.ready, offers])

  return null
}

type Context = { settings: ReturnType<typeof useSettings>; router: ReturnType<typeof useRouter> }

async function pair(offered: ConnectLinkResult, context: () => Context) {
  if (offered._tag === "Invalid") return failed(offered.reason)
  const link = offered.link
  let me: Me
  try {
    me = await createApi(link).me()
  } catch (error) {
    return failed(error instanceof ApiError ? error.message : "Could not reach the server.")
  }
  const { connection, account } = context().settings
  const current = connection ? { serverUrl: connection.serverUrl, userId: account?.userId ?? null } : null
  if (pairingStep(current, { serverUrl: link.serverUrl, userId: me.userId }) === "Connect") return connect(link, me, context)
  Alert.alert("Switch account?", `${link.serverUrl}\n${me.userId}`, [
    { text: "Cancel", style: "cancel" },
    { text: "Switch", onPress: () => void connect(link, me, context) },
  ])
}

async function connect(link: ConnectLink, me: Me, context: () => Context) {
  await context().settings.save({ serverUrl: link.serverUrl, token: link.token }, me.userId)
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
  context().router.navigate("/library")
}

function failed(reason: string) {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)
  Alert.alert("Could not connect", reason)
}
