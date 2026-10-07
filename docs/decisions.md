---
title: Decisions
description: Why the package is shaped the way it is, with the reasoning behind each choice.
---

## 2026-10-07: open source, unscoped on npm, single package at the root

**Decision.** The package publishes to npmjs as `build-preset` from `github.com/jbcom/build-preset`,
MIT licensed, as a single package at the repository root. The first npm release is `0.4.0`.

**Why.** The name was free on npmjs, and a scoped name would tie a general-purpose build preset to
one organisation. The previous layout kept the package in `packages/build-preset` behind a private
root harness that installed the package as its own verifier. That harness existed only to satisfy
the old release tool, so a plain root package is simpler to read, build, pack and contribute to.

## The private-registry release governance was dropped

**Decision.** The private-package-release verifier, its SBOM admission profile, the release
attestation scripts, the manually dispatched publish workflow, and the `package-release` and
`dependency-current` commands and exports were removed. Publishing is now Release Please plus a
`publish` job that runs `npm publish --provenance` from GitHub Actions with npm trusted publishing
(OIDC).

**Why.** The verifier solved publishing to a private registry safely: exact-source fingerprints,
reproducible packs, a normalized CycloneDX admission, and idempotent retry of tag, release and
registry state. On npmjs, provenance attestation binds each tarball to the workflow run and commit
that built it, which is the same guarantee from the registry's side, with no token to protect. The
verifier also pinned an exact Node and pnpm patch version and refused any other toolchain, which
conflicts with a CI matrix over Node 24 and 26 and with a package any contributor can build.
`dependency-current` was tied to the same design (private scopes, a fixed private registry route,
a bespoke token variable), pulled ten runtime dependencies into a configuration package, and has no
meaning outside that registry. Removing both leaves the package with no runtime dependencies.

**Consequence.** Existing users of the `build-preset package-release` or `build-preset
dependency-current` commands must keep the last version that shipped them. The configuration
entry points (`vite`, `vitest`, `capacitor`, the base configs, `init-android`) are unchanged apart
from the package name and the `dist` layout.

## The `tsup` entry point was folded in from a duplicate preset

**Decision.** `build-preset/tsup` exports `libraryBuild`, and `tsup` is an optional peer.

**Why.** A second, unpublished preset package carried the same Vite, Vitest, tsconfig and Biome
code (the Vite module was byte-identical and its Vitest module was an older copy of this one) plus
one thing this package lacked: a tsup library build whose banner is derived from the package name and
which routes JSX through `esbuildOptions`. That is a real capability, so it moved here with tests
and the duplicate has no reason to exist. The entry point stays out of the barrel so that a project
that never builds a library does not need tsup's types.

## The toolchain is Node 26, pnpm 12, TypeScript 7

**Decision.** `.nvmrc` and `mise.toml` pin Node 26 and pnpm 12, TypeScript is 7, and `engines.node`
is `>=24`. CI verifies Node 24 and 26 on Linux and Node 26 on Windows (the package normalizes
Windows paths).

**Why.** Node 24 is the oldest line still in maintenance, and a preset that cannot be built on the
current line has nothing to offer. TypeScript 7 removed `node10` module resolution, so the
CommonJS build uses `moduleResolution: bundler`. Dev dependencies track current releases rather than
exact old pins; the peer ranges (Vite `^8.2.1`, Vitest 4 or 5, Playwright `>=1.62.1 <2`) are the
compatibility promise and the packed-consumer smoke checks both Vitest majors.

## The dual build matches the house layout

**Decision.** `dist/esm` (ESM and `.d.ts`) and `dist/cjs` (`.cjs` and `.d.cts`), a `typesVersions`
fallback, and a `{ "type": "commonjs" }` manifest inside `dist/cjs`.

**Why.** The earlier flat layout pointed the `require` condition at an ESM-typed declaration file,
which Are The Types Wrong reports as masquerading as ESM. Separate declarations per format fix it,
and the layout now matches the sibling packages so one build script serves all of them.

## The headed-browser consumer smoke stays

**Decision.** `scripts/consumer-smoke.mjs` installs the packed tarball into an empty project against
the public registry only, loads every entry point under ESM and CommonJS, type-checks, builds with
Vite, and with `BUILD_PRESET_RUN_BROWSER=1` launches real headed Chromium and checks the process
arguments (`--mute-audio` present, `--headless` absent). CI runs it once per Vitest major.

**Why.** The browser fragment's whole value is a contract about how Chromium is launched. Unit tests
of the returned object cannot prove the launched process honours it. CI installs Chromium with
`playwright install --with-deps --no-shell chromium` and runs the headed smoke under `xvfb-run`.

## Commits dated before a release can be missed by Release Please

Release Please walks commits newest-first by date and stops at the last release commit. A branch
started before a release but merged after it can fall outside that walk and be omitted from the
release notes. Rebase such a branch before merging; the rebase refreshes the committer dates.
