# Changelog

This package is versioned independently from Little Legends through the repository's
Release Please manifest.

## 0.2.0

- Conformed Vite peers and generated configurations to Vite 8.2.1 and current
  Rolldown code-splitting groups.
- Added a provider-wired, headed-only Vitest browser contract with the
  `--mute-audio` process backstop and explicit hidden-headless rejection.
- Added jsdom origin defaults, absolute-alias validation, deterministic named-group
  override behavior, and non-Three browser support.
- Expanded the packed-consumer gate across ESM, CJS, declarations, CLI, Vite build,
  and an optional real headed-browser launch for anonymous registry verification.

## 0.1.1

- Added a non-Three browser-test option.
- Preserved the executable CLI entry in packed artifacts.
- Declared the Node type dependency used by the package build.

## 0.1.0

- Extracted the shared Vite, Vitest, Capacitor, TypeScript, and Biome configuration
  boundaries from Little Legends.
