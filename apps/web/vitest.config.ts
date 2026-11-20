import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: { alias: { "~": new URL("./src", import.meta.url).pathname } },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "happy-dom",
    setupFiles: ["./src/vitest-setup.ts"],
    server: { deps: { inline: ["foldkit", "@foldkit/ui"] } },
  },
})
