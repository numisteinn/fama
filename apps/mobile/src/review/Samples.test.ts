import type { Sample, Voice, VoiceRef } from "@fama/contracts"
import { expect, test, vi } from "vitest"
import { applySampleStatus, hasPending, sampleTapAction, voiceLabel } from "./Samples"

// The helpers are pure; the UI around them needs React Native, which Vitest does not load.
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn<() => void>() },
  ActivityIndicator: () => null,
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
  StyleSheet: { create: (styles: unknown) => styles },
  Text: () => null,
  View: () => null,
}))
vi.mock("../components/ui", () => ({ Button: () => null, Icon: () => null, Label: () => null, Tap: () => null }))
vi.mock("../player/native", () => ({ FamaPlayer: { addListener: () => ({ remove: () => {} }) } }))

const voice = (id: string) => id as Sample["voice"]
const requested = (id: string): Sample => ({ voice: voice(id), state: { _tag: "Requested" } })
const ready = (id: string): Sample => ({ voice: voice(id), state: { _tag: "Ready", url: `/media/t/episodes/e/samples/${id}.m4a` } })
const failed = (id: string): Sample => ({ voice: voice(id), state: { _tag: "Failed", reason: "no model" } })

test("hasPending is true only while a clip is still requested", () => {
  expect(hasPending([])).toBe(false)
  expect(hasPending([ready("piper:is_IS-salka-medium"), failed("piper:is_IS-steinn-medium")])).toBe(false)
  expect(hasPending([ready("piper:is_IS-salka-medium"), requested("piper:is_IS-steinn-medium")])).toBe(true)
})

test("voiceLabel names the voice, and falls back to the ID the server has not named", () => {
  const salka = voice("piper:is_IS-salka-medium")
  const steinn: Voice = { id: "piper:is_IS-steinn-medium" as VoiceRef, engine: "piper", name: "Steinn", language: "is", gender: "male", previewUrl: null }
  expect(voiceLabel(salka, [steinn])).toBe("piper:is_IS-salka-medium")
  expect(voiceLabel(voice("piper:is_IS-steinn-medium"), [steinn])).toBe("Steinn")
})

test("applySampleStatus keeps the clip that plays and clears it when it stops", () => {
  const first = "/media/t/episodes/e/samples/one.m4a"
  const second = "/media/t/episodes/e/samples/two.m4a"
  expect(applySampleStatus(null, { url: first, playing: true })).toBe(first)
  // Another clip takes over: only one sample plays at a time.
  expect(applySampleStatus(first, { url: second, playing: true })).toBe(second)
  // The end or pause of the clip that plays clears it. Another clip's end does not.
  expect(applySampleStatus(second, { url: second, playing: false })).toBeNull()
  expect(applySampleStatus(first, { url: second, playing: false })).toBe(first)
  // A clip that fails to play clears its button too.
  expect(applySampleStatus(first, { url: first, playing: false, error: "Playback failed" })).toBeNull()
})

test("sampleTapAction compares absolute native URL against resolved mediaUrl so Pause actually pauses", () => {
  const mediaUrl = (path: string) => `http://localhost:8788${path}`
  const relative = "/media/t/episodes/e/samples/piper%3Ais_IS-salka-medium.m4a"
  const absolute = mediaUrl(relative)
  expect(sampleTapAction(null, relative, mediaUrl)).toEqual({ action: "play", url: absolute })
  expect(sampleTapAction(absolute, relative, mediaUrl)).toEqual({ action: "pause" })
  expect(sampleTapAction("http://localhost:8788/other.m4a", relative, mediaUrl)).toEqual({ action: "play", url: absolute })
})
