// Barrel export kept intentionally thin — prefer the subpath imports
// (`@arcade-cabinet/build-preset/vite`, `/capacitor`, `/vitest`) so bundlers
// only pull in the pieces actually used. This barrel exists for convenience
// / re-export scenarios (e.g. testing the whole package at once).

export * from "./capacitor.js";
export * from "./vite.js";
export * from "./vitest.js";
