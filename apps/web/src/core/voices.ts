import type { Voice } from "@fama/contracts"

/** Synthesis speeds of the add bar. */
export const SPEEDS = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.5] as const

/** Base language tag (`en-US` / `is_IS` -> `en` / `is`), matching the API's sample language filter. */
export const languageOf = (language: string): string => language.toLowerCase().split(/[-_]/)[0] ?? language.toLowerCase()

const languageNames = new Intl.DisplayNames(undefined, { type: "language" })

/** A readable name for a language code, falling back to the code itself. */
export function languageName(code: string): string {
  try {
    return languageNames.of(code) ?? code
  } catch {
    return code
  }
}

/** Voices in menu order: by language name, then by name. */
export const sortedVoices = (voices: ReadonlyArray<Voice>): Array<Voice> =>
  [...voices].sort(
    (a, b) =>
      languageName(a.language).localeCompare(languageName(b.language)) || a.name.localeCompare(b.name),
  )
