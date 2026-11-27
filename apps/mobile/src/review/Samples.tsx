import type { Sample, Voice, VoiceRef } from "@fama/contracts"
import { useEffect, useRef, useState } from "react"
import { ActivityIndicator, Alert, AppState, StyleSheet, Text, View } from "react-native"
import { Button, Icon, Label, Tap } from "../components/ui"
import type { Api } from "../lib/api"
import { FamaPlayer, type SampleStatus } from "../player/native"
import { colors, fonts, radius, space } from "../theme"

const POLL_MS = 2_000

const message = (cause: unknown) => (cause instanceof Error ? cause.message : "Request failed")

/** True while the worker has not finished every clip. */
export const hasPending = (samples: ReadonlyArray<Sample>): boolean =>
  samples.some((sample) => sample.state._tag === "Requested")

/** The human-readable name of a voice, or its ID when the server has not named it. */
export function voiceLabel(voice: Sample["voice"], voices: ReadonlyArray<Voice>): string {
  return voices.find((known) => known.id === voice)?.name ?? voice
}

/** One sample-clip status event folds into the clip that plays now, if any. */
export function applySampleStatus(current: string | null, event: SampleStatus): string | null {
  return event.playing ? event.url : current === event.url ? null : current
}

/** Resolves a tap on a Ready sample's play/pause button against the native player's active absolute URL. */
export function sampleTapAction(
  playing: string | null,
  sampleUrl: string,
  mediaUrl: (path: string) => string,
): { readonly action: "pause" } | { readonly action: "play"; readonly url: string } {
  const absolute = mediaUrl(sampleUrl)
  return playing === absolute ? { action: "pause" } : { action: "play", url: absolute }
}

/** The voices of the episode's language, each reading the start of the stored Document. Pick one by ear. */
export function Samples(props: { id: string; api: Api; selected: VoiceRef | null; onSelect: (voice: VoiceRef) => void }) {
  const { id, api, selected, onSelect } = props
  const [samples, setSamples] = useState<ReadonlyArray<Sample> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [voices, setVoices] = useState<ReadonlyArray<Voice>>([])
  const [playing, setPlaying] = useState<string | null>(null)
  const listGen = useRef(0)
  const pollInFlight = useRef(false)

  // Human-readable voice names.
  useEffect(() => {
    let live = true
    api.listVoices().then((list) => live && setVoices(list), () => {})
    return () => {
      live = false
    }
  }, [api])

  // The samples of this episode. None were ever asked for: ask for every voice of the language.
  useEffect(() => {
    let live = true
    const gen = ++listGen.current
    setError(null)
    const isCurrent = () => live && gen === listGen.current
    const load = async () => {
      try {
        const list = await api.samples(id)
        if (!isCurrent()) return
        const next = list.length === 0 ? await api.requestSamples(id, null) : list
        if (isCurrent()) {
          setSamples(next)
          setError(null)
        }
      } catch (cause) {
        if (isCurrent()) setError(message(cause))
      }
    }
    void load()
    return () => {
      live = false
    }
  }, [api, id, attempt])

  // A clip is still being made: watch for it while the app is active.
  const pending = samples !== null && hasPending(samples)
  useEffect(() => {
    if (!pending) return
    let live = true
    let timer: ReturnType<typeof setInterval> | null = null
    const poll = () => {
      if (pollInFlight.current) return
      pollInFlight.current = true
      const gen = ++listGen.current
      api.samples(id).then(
        (list) => {
          pollInFlight.current = false
          if (live && gen === listGen.current) {
            setSamples(list)
            setError(null)
          }
        },
        (cause: unknown) => {
          pollInFlight.current = false
          if (live && gen === listGen.current) setError(message(cause))
        },
      )
    }
    const start = () => {
      if (!timer) timer = setInterval(poll, POLL_MS)
    }
    const stop = () => {
      if (timer) clearInterval(timer)
      timer = null
    }
    if (AppState.currentState === "active") start()
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        poll()
        start()
      } else {
        stop()
      }
    })
    return () => {
      live = false
      pollInFlight.current = false
      stop()
      subscription.remove()
    }
  }, [pending, api, id])

  // Clip playback. Another clip stops the one that plays; leaving Review stops it too.
  useEffect(() => {
    const subscription = FamaPlayer.addListener("onSampleStatus", (status: SampleStatus) => {
      setPlaying((current) => applySampleStatus(current, status))
      if (status.error) Alert.alert("Sample", status.error)
    })
    return () => {
      subscription.remove()
      void FamaPlayer.stopSample().catch(() => {})
    }
  }, [])

  const retry = (voice: Sample["voice"]) => {
    const gen = ++listGen.current
    setError(null)
    api.requestSamples(id, [voice]).then(
      (list) => {
        if (gen === listGen.current) {
          setSamples(list)
          setError(null)
        }
      },
      (cause: unknown) => {
        if (gen === listGen.current) setError(message(cause))
      },
    )
  }

  const toggle = (url: string) => {
    const next = sampleTapAction(playing, url, api.mediaUrl)
    const call = next.action === "pause" ? FamaPlayer.pauseSample() : FamaPlayer.playSample(next.url)
    void call.catch((cause: unknown) => Alert.alert("Sample", message(cause)))
  }

  if (samples === null)
    return <View style={styles.section}>
      <Label>Voice samples</Label>
      {error ? <>
        <Text accessibilityRole="alert" style={styles.error}>{error}</Text>
        <Button variant="secondary" title="Try again" onPress={() => setAttempt(attempt + 1)} />
      </> : <View style={styles.row}>
        <ActivityIndicator accessibilityLabel="Loading voice samples" size="small" color={colors.textSecondary} />
      </View>}
    </View>

  if (samples.length === 0) return null
  return <View style={styles.section} accessibilityRole="radiogroup">
    <Label>Voice samples</Label>
    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {samples.map((sample) => <SampleRow
      key={sample.voice}
      sample={sample}
      label={voiceLabel(sample.voice, voices)}
      selected={selected === sample.voice}
      playing={playing !== null && sample.state._tag === "Ready" && playing === api.mediaUrl(sample.state.url)}
      onSelect={() => onSelect(sample.voice)}
      onToggle={() => sample.state._tag === "Ready" && toggle(sample.state.url)}
      onRetry={() => retry(sample.voice)}
    />)}
  </View>
}

function SampleRow(props: {
  sample: Sample
  label: string
  selected: boolean
  playing: boolean
  onSelect: () => void
  onToggle: () => void
  onRetry: () => void
}) {
  const { sample, label, selected, playing, onSelect, onToggle, onRetry } = props
  const failed = sample.state._tag === "Failed"
  const choiceLabel = failed ? `Choose ${label}, sample failed: ${sample.state.reason}` : `Choose ${label}`
  return <View style={styles.row}>
    {sample.state._tag === "Requested" ? <View style={styles.control}>
        <ActivityIndicator accessibilityLabel={`Generating sample, ${label}`} size="small" color={colors.textSecondary} />
      </View>
      : failed ? <Tap accessibilityRole="button" accessibilityLabel={`Retry sample, ${label}`} style={styles.control} onPress={onRetry}>
          <Icon name="arrow.clockwise" color={colors.textSecondary} />
        </Tap>
      : <Tap accessibilityRole="button" accessibilityLabel={`${playing ? "Pause" : "Play"} sample, ${label}`} style={styles.control} onPress={onToggle}>
          <Icon name={playing ? "pause.fill" : "play.fill"} color={colors.text} />
        </Tap>}
    <Tap accessibilityRole="radio" accessibilityLabel={choiceLabel} accessibilityState={{ checked: selected }} style={styles.choice} onPress={onSelect}>
      <Text style={styles.name} numberOfLines={2}>{failed ? `${label} — ${sample.state.reason}` : label}</Text>
      {selected && <Icon name="checkmark.circle.fill" color={colors.accent} />}
    </Tap>
  </View>
}

const styles = StyleSheet.create({
  section: { gap: space.sm },
  row: { flexDirection: "row", alignItems: "center", backgroundColor: colors.surface, borderRadius: radius.md, minHeight: 52 },
  control: { width: 48, minHeight: 52, alignItems: "center", justifyContent: "center" },
  choice: { flex: 1, flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.md },
  name: { flex: 1, color: colors.text, fontFamily: fonts.regular, fontSize: 18 },
  error: { color: colors.danger, fontFamily: fonts.regular, fontSize: 16 },
})
