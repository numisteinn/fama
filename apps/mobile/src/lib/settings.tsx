import { UserId } from "@fama/contracts"
import * as SecureStore from "expo-secure-store"
import { createContext, use, useEffect, useMemo, useState, type ReactNode } from "react"
import { AppState } from "react-native"
import { ApiError, createApi, normalizeServerUrl, type Api, type Connection } from "./api"

const SERVER_KEY = "fama.serverUrl"
const TOKEN_KEY = "fama.apiToken"
/** The user of the saved connection, from `GET /api/me`. Cleared when the connection changes. */
const USER_KEY = "fama.userId"

/** Who the app acts as: one user on one server. Caches and downloads are kept apart by `key`. */
export type Account = { readonly serverUrl: string; readonly userId: UserId; readonly key: string }

type Settings = {
  /** False until secure storage has been read. */
  readonly ready: boolean
  readonly connection: Connection | null
  /** Null until the server URL and token are set. */
  readonly api: Api | null
  /** Null until the server named the token's user once. Kept offline after that. */
  readonly account: Account | null
  /** Why the server could not name the token's user. Null while the app asks, and when the account is known. */
  readonly accountError: string | null
  /** Saves a new connection. With `userId` (already checked with `GET /api/me`) the account is known at once. */
  save(connection: Connection, userId?: UserId): Promise<void>
}

const SettingsContext = createContext<Settings | null>(null)

/** A file-name-safe key that no two accounts share. */
const accountKey = (serverUrl: string, userId: string) => `${encodeURIComponent(serverUrl)}~${encodeURIComponent(userId)}`

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [connection, setConnection] = useState<Connection | null>(null)
  const [userId, setUserId] = useState<UserId | null>(null)
  const [accountError, setAccountError] = useState<string | null>(null)

  useEffect(() => {
    void Promise.all([
      SecureStore.getItemAsync(SERVER_KEY),
      SecureStore.getItemAsync(TOKEN_KEY),
      SecureStore.getItemAsync(USER_KEY),
    ]).then(([serverUrl, token, storedUser]) => {
      if (serverUrl && token) setConnection({ serverUrl, token })
      if (storedUser) setUserId(UserId.make(storedUser))
      setReady(true)
    })
  }, [])

  const api = useMemo(() => (connection ? createApi(connection) : null), [connection])

  // Ask the server who the token belongs to, at start and after every change. Offline, the stored user stays.
  useEffect(() => {
    setAccountError(null)
    if (!api) return
    let live = true
    const ask = () =>
      api.me().then(
        (me) => {
          if (!live) return
          setUserId(me.userId)
          setAccountError(null)
          void SecureStore.setItemAsync(USER_KEY, me.userId)
        },
        (error: unknown) => {
          if (live) setAccountError(error instanceof ApiError ? error.message : "Could not connect.")
        },
      )
    void ask()
    // A server that was out of reach at start can be back when the app comes to the front.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void ask()
    })
    return () => {
      live = false
      subscription.remove()
    }
  }, [api])

  const account = useMemo<Account | null>(
    () => (connection && userId ? { serverUrl: connection.serverUrl, userId, key: accountKey(connection.serverUrl, userId) } : null),
    [connection, userId],
  )

  const value = useMemo<Settings>(
    () => ({
      ready,
      connection,
      api,
      account,
      // With a stored user the app works offline, so a failed check is not an error to show.
      accountError: account ? null : accountError,
      async save(next, checkedUser) {
        const normalized = { serverUrl: normalizeServerUrl(next.serverUrl), token: next.token.trim() }
        await SecureStore.setItemAsync(SERVER_KEY, normalized.serverUrl)
        await SecureStore.setItemAsync(TOKEN_KEY, normalized.token)
        if (checkedUser === undefined) await SecureStore.deleteItemAsync(USER_KEY)
        else await SecureStore.setItemAsync(USER_KEY, checkedUser)
        setUserId(checkedUser ?? null)
        setConnection(normalized.serverUrl && normalized.token ? normalized : null)
      },
    }),
    [ready, api, connection, account, accountError],
  )

  return <SettingsContext value={value}>{children}</SettingsContext>
}

export function useSettings(): Settings {
  const settings = use(SettingsContext)
  if (!settings) throw new Error("useSettings needs SettingsProvider")
  return settings
}
