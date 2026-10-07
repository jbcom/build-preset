# Changelog

## [0.4.1](https://github.com/jbcom/build-preset/compare/v0.4.0...v0.4.1) (2026-10-07)


### Bug Fixes

* support every maintained Node line (22, 24 and 26) ([a8cf554](https://github.com/jbcom/build-preset/commit/a8cf554de18f058ee63c12e8ae3a52e3c819e1e2))
* support maintained Node lines and conform repository CI ([61e0f78](https://github.com/jbcom/build-preset/commit/61e0f78ed61e2f20e6a645c93628665d1f0e1a2a))

## [0.4.0](https://github.com/jbcom/build-preset/releases/tag/v0.4.0) (2026-10-07)

First release on npmjs, as the unscoped `build-preset`. Earlier versions were published as
`@arcade-cabinet/build-preset` to a private registry and are listed below for history.

### Features

* accept Vitest 5 alongside Vitest 4 for the browser fragments and the peers
* add `build-preset/tsup` (`libraryBuild`), folded in from a duplicate preset; `tsup` is an optional peer
* ship with npm provenance, published from GitHub Actions through npm trusted publishing

### Bug Fixes

* merge nested Capacitor overrides (`server`, `android`, `ios` and per-plugin options) instead of replacing them

### Breaking Changes

* the package is named `build-preset`; the `@arcade-cabinet/build-preset` name is not published to npmjs
* the `private-package-release` and `dependency-current` exports and the `package-release` and
  `dependency-current` CLI commands are removed, together with their ten runtime dependencies
* `dist` is split into `dist/esm` and `dist/cjs` with format-correct declarations; use the
  documented `exports` entry points rather than deep paths
* the package is MIT licensed

## 0.3.0

- Added the ESM-only `private-package-release` verifier with strict declarative
  multi-package configs, exact Git/source/config/verifier receipt binding,
  reproducible clean builds and tarballs, native pnpm CycloneDX admission, and
  idempotent registry/tag/release retry handling.
- Added the ESM-only `dependency-current` policy engine and CLI for public runtime
  closures and exact private/framework boundaries, with frozen per-owner install
  proof, canonical JSON evidence, graph/body limits, no redirects, and narrowly
  scoped authentication.
- Hardened release filesystem paths, clean generated-output reconstruction,
  immutable Git source checks, regular-blob common inputs, exact pack
  membership, create-release responses and annotated-tag resolution, npm
  `latest` publication, script suppression, anonymous evidence generation, and
  packed-consumer coverage for the new API and CLI surfaces.
- Made anonymous builds and SBOM profiling export the already-selected exact pnpm
  into a verifier-owned Corepack cache, then execute with Corepack networking and
  ambient home/config overrides disabled.

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
  boundaries from the project that first used them.
