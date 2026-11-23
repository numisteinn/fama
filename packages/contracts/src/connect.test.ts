import { describe, expect, it } from "vitest"
import { connectUrl, isConnectLink, isLocalHost, parseConnectLink, parseServerUrl } from "./index.ts"

const ok = (serverUrl: string, token: string) => ({ _tag: "Ok", link: { serverUrl, token } })
const invalid = (reason: string) => ({ _tag: "Invalid", reason })

describe("connectUrl", () => {
  it("encodes the server and the token", () => {
    expect(connectUrl("https://fama.example.com", "tok_1")).toBe(
      "fama://connect?server=https%3A%2F%2Ffama.example.com&token=tok_1",
    )
  })

  it("round-trips through parseConnectLink, characters that need escapes included", () => {
    for (const token of ["dev-api-token", "a+b/c=d", "~!*()'", "x".repeat(512)]) {
      expect(parseConnectLink(connectUrl("https://fama.example.com", token))).toEqual(ok("https://fama.example.com", token))
    }
  })
})

describe("parseConnectLink", () => {
  it("reads the setup link", () => {
    expect(parseConnectLink("fama://connect?server=https%3A%2F%2Ffama-home.example.workers.dev&token=client-tok_123")).toEqual(
      ok("https://fama-home.example.workers.dev", "client-tok_123"),
    )
  })

  it("accepts the forms a router may hand over, and keys in any order", () => {
    const expected = ok("https://fama.example.com", "t")
    for (const link of [
      "fama://connect?token=t&server=https://fama.example.com",
      "fama:///connect?server=https%3A%2F%2Ffama.example.com&token=t",
      "FAMA://connect/?server=https%3A%2F%2Ffama.example.com&token=t",
      "/connect?server=https%3A%2F%2Ffama.example.com&token=t",
      "connect?server=https%3A%2F%2Ffama.example.com&token=t#x",
    ]) {
      expect(parseConnectLink(link), link).toEqual(expected)
    }
  })

  it("normalizes the server: lowercase scheme and host, no trailing slash, path kept", () => {
    expect(parseConnectLink("fama://connect?server=HTTPS%3A%2F%2FFama.Example.com%2Ffama%2F&token=t")).toEqual(
      ok("https://fama.example.com/fama", "t"),
    )
  })

  it("takes the first value of a repeated key", () => {
    expect(parseConnectLink("fama://connect?server=https%3A%2F%2Fa.example&server=https%3A%2F%2Fb.example&token=t")).toEqual(
      ok("https://a.example", "t"),
    )
  })

  it("refuses other links", () => {
    for (const link of ["fama://expo-sharing", "https://fama.example.com/connect?server=x&token=t", "fama://connector?server=x", ""]) {
      expect(isConnectLink(link), link).toBe(false)
      expect(parseConnectLink(link)).toEqual(invalid("This is not a Fama connect link."))
    }
  })

  it("refuses a missing server or token", () => {
    expect(parseConnectLink("fama://connect?token=t")).toEqual(invalid("The link has no server."))
    expect(parseConnectLink("fama://connect?server=&token=t")).toEqual(invalid("The link has no server."))
    expect(parseConnectLink("fama://connect?server=https%3A%2F%2Fa.example")).toEqual(invalid("The link has no token."))
    expect(parseConnectLink("fama://connect?server=https%3A%2F%2Fa.example&token=%20")).toEqual(invalid("The link has no token."))
    expect(isConnectLink("fama://connect")).toBe(true)
    expect(parseConnectLink("fama://connect")).toEqual(invalid("The link has no server."))
  })

  it("refuses a bad token, and never puts the token in the reason", () => {
    const secret = "secret-token-value"
    for (const token of [`${secret}%20space`, "x".repeat(513), "%E0%A4%A", `${secret}%C3%A9`]) {
      const result = parseConnectLink(`fama://connect?server=https%3A%2F%2Fa.example&token=${token}`)
      expect(result, token).toEqual(invalid("The token in the link is not valid."))
      expect(JSON.stringify(result)).not.toContain(secret)
    }
  })

  it("refuses a server that is not https, unless it is local", () => {
    expect(parseConnectLink("fama://connect?server=http%3A%2F%2Ffama.example.com&token=t")).toEqual(
      invalid("The server must use https."),
    )
    expect(parseConnectLink("fama://connect?server=http%3A%2F%2Flocalhost%3A8788&token=t")).toEqual(
      ok("http://localhost:8788", "t"),
    )
  })
})

describe("parseServerUrl", () => {
  const reason = (input: string) => {
    const result = parseServerUrl(input)
    return result._tag === "Invalid" ? result.reason : result.serverUrl
  }

  it("refuses what is not an http(s) server address", () => {
    for (const input of [
      "fama.example.com",
      "ftp://fama.example.com",
      "javascript:alert(1)",
      "https://",
      "https://user:pass@fama.example.com",
      "https://fama.example.com?x=1",
      "https://fama.example.com#x",
      "https://fama.example.com:0",
      "https://fama.example.com:70000",
      "https://-bad.example.com",
      "https://fama example.com",
    ]) {
      expect(reason(input), input).toBe("The server address is not valid.")
    }
  })

  it("allows plain http only on local hosts", () => {
    for (const input of [
      "http://localhost:8788",
      "http://127.0.0.1:8787",
      "http://10.0.0.5",
      "http://172.16.0.1",
      "http://172.31.255.255",
      "http://192.168.0.5:8787",
      "http://169.254.1.1",
      "http://100.100.1.2",
      "http://[::1]:8788",
      "http://[fd7a:115c:a1e0::1]",
      "http://mac-mini:8787",
      "http://mac-mini.local:8787",
      "http://nas.home.arpa",
      "http://fama.localhost",
    ]) {
      expect(parseServerUrl(input), input).toEqual({ _tag: "Ok", serverUrl: input })
    }
    for (const input of [
      "http://fama.example.com",
      "http://8.8.8.8",
      "http://172.32.0.1",
      "http://192.169.0.1",
      "http://100.128.0.1",
      "http://[2001:db8::1]",
      "http://256.1.1.1",
      "http://local.example.com",
    ]) {
      expect(reason(input), input).toBe("The server must use https.")
    }
  })

  it("allows https anywhere", () => {
    expect(parseServerUrl("https://fama-home.example.workers.dev/")).toEqual({ _tag: "Ok", serverUrl: "https://fama-home.example.workers.dev" })
    expect(parseServerUrl("https://8.8.8.8:8443")).toEqual({ _tag: "Ok", serverUrl: "https://8.8.8.8:8443" })
  })

  it("isLocalHost names local hosts only", () => {
    expect(isLocalHost("LOCALHOST")).toBe(true)
    expect(isLocalHost("fama.example.com")).toBe(false)
  })
})
