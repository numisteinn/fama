import { describe, expect, it } from "vitest"
import { isProd, resourceNames, stageProblem } from "./names.ts"

describe("resourceNames", () => {
  it("keeps the fixed names of the existing deployment on prod", () => {
    expect(resourceNames("prod")).toEqual({ worker: "fama", database: "fama", bucket: "fama-media" })
    expect(isProd("prod")).toBe(true)
  })

  it("puts the stage in every name on other stages", () => {
    expect(resourceNames("home")).toEqual({ worker: "fama-home", database: "fama-home", bucket: "fama-home-media" })
    expect(resourceNames("pr-12")).toEqual({ worker: "fama-pr-12", database: "fama-pr-12", bucket: "fama-pr-12-media" })
    expect(isProd("home")).toBe(false)
  })

  it("never gives two stages the same name", () => {
    const stages = ["prod", "home", "media", "fama", "pr-1", "pr-12"]
    for (const kind of ["worker", "database", "bucket"] as const) {
      const names = stages.map((stage) => resourceNames(stage)[kind])
      expect(new Set(names).size).toBe(stages.length)
    }
  })

  it("rejects stage names Cloudflare or Alchemy cannot use", () => {
    for (const bad of ["", "Home", "live_sam", "-home", "home-", "a--b", "x".repeat(41), "my stage"]) {
      expect(stageProblem(bad)).toBeTypeOf("string")
      expect(() => resourceNames(bad)).toThrow()
    }
    expect(stageProblem("x".repeat(40))).toBeUndefined()
  })

  it("keeps every name within the 63-character limit", () => {
    const longest = resourceNames("x".repeat(40))
    for (const name of Object.values(longest)) expect(name.length).toBeLessThanOrEqual(63)
  })
})
