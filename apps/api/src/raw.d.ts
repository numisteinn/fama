declare module "*?raw" {
  const value: string
  export default value
}

interface ImportMeta {
  /** Vite's glob import, as the tests read the migration files. */
  glob(pattern: string, options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>
}
