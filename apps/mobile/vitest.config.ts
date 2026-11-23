import { defineConfig } from "vitest/config"

// Only the pure modules run here. Anything that imports React Native is proven on the simulator.
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } })
