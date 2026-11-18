import * as SecureStore from "expo-secure-store"
import { createContext, use, useEffect, useMemo, useState, type ReactNode } from "react"
import { createApi, normalizeServerUrl, type Api, type Connection } from "./api"

const SERVER_KEY = "fama.serverUrl"
const TOKEN_KEY = "fama.apiToken"

type Settings = {
  /** False until secure storage has been read. */
  readonly ready: boolean
  readonly connection: Connection | null
  /** Null until the server URL and token are set. */
  readonly api: Api | null
  save(connection: Connection): Promise<void>
}

const SettingsContext = createContext<Settings | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [connection, setConnection] = useState<Connection | null>(null)

  useEffect(() => {
    void Promise.all([SecureStore.getItemAsync(SERVER_KEY), SecureStore.getItemAsync(TOKEN_KEY)]).then(([serverUrl, token]) => {
      if (serverUrl && token) setConnection({ serverUrl, token })
      setReady(true)
    })
  }, [])

  const value = useMemo<Settings>(
    () => ({
      ready,
      connection,
      api: connection ? createApi(connection) : null,
      async save(next) {
        const normalized = { serverUrl: normalizeServerUrl(next.serverUrl), token: next.token.trim() }
        await SecureStore.setItemAsync(SERVER_KEY, normalized.serverUrl)
        await SecureStore.setItemAsync(TOKEN_KEY, normalized.token)
        setConnection(normalized.serverUrl && normalized.token ? normalized : null)
      },
    }),
    [ready, connection],
  )

  return <SettingsContext value={value}>{children}</SettingsContext>
}

export function useSettings(): Settings {
  const settings = use(SettingsContext)
  if (!settings) throw new Error("useSettings needs SettingsProvider")
  return settings
}
