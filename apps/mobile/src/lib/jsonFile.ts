import { File, Paths } from "expo-file-system"

/** A small JSON document in the app's documents folder. Reads fall back on a missing or broken file. */
export function jsonFile<T>(name: string, fallback: T) {
  const file = new File(Paths.document, name)
  return {
    read(): T {
      try {
        return file.exists ? (JSON.parse(file.textSync()) as T) : fallback
      } catch {
        return fallback
      }
    },
    write(value: T): void {
      try {
        if (!file.exists) file.create()
        file.writeSync(JSON.stringify(value))
      } catch (error) {
        console.warn(`Could not write ${name}`, error)
      }
    },
  }
}
