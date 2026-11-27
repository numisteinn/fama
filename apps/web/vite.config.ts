import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

const api = process.env.FAMA_API_URL ?? "http://localhost:8787"

export default defineConfig({
  plugins: [tailwindcss()],
  resolve: { alias: { "~": new URL("./src", import.meta.url).pathname } },
  optimizeDeps: { entries: ["src/entry.ts"] },
  server: {
    port: Number(process.env.PORT ?? 5173),
    proxy: { "/api": api, "/feed": api, "/media": api },
  },
  build: { outDir: "dist", emptyOutDir: true },
})
