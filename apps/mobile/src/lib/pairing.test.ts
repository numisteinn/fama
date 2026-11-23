import { describe, expect, it } from "vitest"
import { offerPairing, onPairing, pairingStep, routeSystemPath, takePairing } from "./pairing"

const link = "fama://connect?server=http%3A%2F%2Flocalhost%3A8788&token=dev-api-token"

describe("routeSystemPath", () => {
  it("keeps a connect link from the router and puts it in the slot once", () => {
    let offers = 0
    const stop = onPairing(() => offers++)
    expect(routeSystemPath(link, false)).toBeNull()
    expect(offers).toBe(1)
    expect(takePairing()).toEqual({ _tag: "Ok", link: { serverUrl: "http://localhost:8788", token: "dev-api-token" } })
    expect(takePairing()).toBeNull()
    stop()
  })

  it("opens the app at / when a connect link launched it", () => {
    expect(routeSystemPath(link, true)).toBe("/")
    takePairing()
  })

  it("offers a bad link too, so the app can show the reason", () => {
    expect(routeSystemPath("fama://connect?server=http%3A%2F%2Ffama.example.com&token=t", false)).toBeNull()
    expect(takePairing()).toEqual({ _tag: "Invalid", reason: "The server must use https." })
  })

  it("passes other links through and offers nothing", () => {
    for (const path of ["fama://expo-sharing", "/library", "fama://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"]) {
      expect(routeSystemPath(path, true)).toBe(path)
    }
    expect(takePairing()).toBeNull()
  })

  it("a newer link replaces one not yet taken", () => {
    offerPairing({ _tag: "Invalid", reason: "first" })
    offerPairing({ _tag: "Invalid", reason: "second" })
    expect(takePairing()).toEqual({ _tag: "Invalid", reason: "second" })
  })
})

describe("pairingStep", () => {
  const incoming = { serverUrl: "https://fama.example.com", userId: "user-a" }

  it("connects at once when nothing is connected", () => {
    expect(pairingStep(null, incoming)).toBe("Connect")
  })

  it("connects at once for the same server and user, a new token included", () => {
    expect(pairingStep({ serverUrl: "https://fama.example.com", userId: "user-a" }, incoming)).toBe("Connect")
    expect(pairingStep({ serverUrl: "https://Fama.Example.com/", userId: "user-a" }, incoming)).toBe("Connect")
  })

  it("asks before it switches to another server or another user", () => {
    expect(pairingStep({ serverUrl: "http://localhost:8787", userId: "user-a" }, incoming)).toBe("Ask")
    expect(pairingStep({ serverUrl: "https://fama.example.com", userId: "user-b" }, incoming)).toBe("Ask")
  })

  it("asks when the current user is not known yet", () => {
    expect(pairingStep({ serverUrl: "https://fama.example.com", userId: null }, incoming)).toBe("Ask")
  })
})
