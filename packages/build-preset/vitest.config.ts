import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The host-dogfood regression imports the real Little Legends Vite
      // config. Point its package subpath back at the candidate source so a
      // stale ignored dist/ tree cannot make source tests pass accidentally.
      "@arcade-cabinet/build-preset/vite": path.resolve(import.meta.dirname, "src/vite.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
