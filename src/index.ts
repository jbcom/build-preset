// Barrel export kept intentionally thin — prefer the subpath imports
// (`build-preset/vite`, `/capacitor`, `/vitest`, `/tsup`) so bundlers only pull
// in the pieces actually used. This barrel exists for convenience / re-export
// scenarios (e.g. testing the whole package at once). `/tsup` is not in the
// barrel: tsup is an optional peer, and only a library build config needs it.

export * from "./capacitor.js";
export * from "./vite.js";
export * from "./vitest.js";
