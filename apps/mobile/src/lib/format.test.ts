import { JobState, WorkerId } from "@fama/contracts"
import { describe, expect, it } from "vitest"
import { jobLabel } from "./format"

const running = (remainingMs: number | null) =>
  JobState.cases.Running.make({
    workerId: WorkerId.make("w"),
    stage: "synthesizing",
    done: 3,
    total: 6,
    heartbeatAt: "2026-11-24T12:00:00.000Z",
    remainingMs,
  })

describe("jobLabel", () => {
  it("shows the time left next to the stage once the worker has an estimate", () => {
    expect(jobLabel(running(130_000))).toBe("Narrating · 2 min left")
    expect(jobLabel(running(45_000))).toBe("Narrating · 45 sec left")
  })

  it("shows the count without an estimate", () => {
    expect(jobLabel(running(null))).toBe("Narrating 3/6")
  })
})
