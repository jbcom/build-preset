# Decisions

## 2026-10-07: moved out of little-legends into its own repository

**Decision.** `@arcade-cabinet/build-preset` left `little-legends/packages/build-preset` for
`arcade-cabinet/build-preset`, with its history (`git filter-repo --path packages/build-preset`,
which also carried the two open pull-request branches, Vitest 5 peers and nested Capacitor
overrides). little-legends and every other fleet game consume it from the registry.

**Why.** The owner: "You shouldn't need other games as dependencies for shared packages." About
twenty games build through this package; its source, releases and open work were all gated on one
game's CI and lockfile.

## The package stays at `packages/build-preset` behind a private root harness

The package ships its own release governance, and `package-release` refuses to publish unless the
workspace root declares the package as a dependency that pnpm links to the executing package root.
A package cannot depend on itself, so a package-at-root layout would need the governance rewritten.
Keeping the package in `packages/build-preset` with a private root that depends on it keeps that
check, every `../..` path in the tests and consumer smoke, and the release config unchanged.

## The root binds the verifier as `workspace:*`

little-legends bound it as `workspace:<version>` and bumped that spec, the manifest and the package
version by hand in feature PRs. Here release-please owns the version, and a release PR that changed
the root spec would also need a lockfile change it cannot make. The verifier now also accepts
`workspace:*`. That is as exact as before: a linked verifier must still resolve to the executing
package root and carry the exact version being released. A test pins that any other workspace
range is refused.

## The release design is ported, not replaced

Other fleet packages publish with release-please plus a reconcile job. This one keeps its own
stricter pipeline, because the pipeline is the product: an exact-main, green-CI gated
`publish.yml` (workflow dispatch) runs the package's `package-release` CLI, which packs twice,
admits the SBOM, publishes, and creates the tag, release and assets itself. release-please only
plans versions, and stays closed until the current version's tag, release, assets and registry
bytes verify. Tags keep the `build-preset-v` prefix, so the lineage from little-legends continues.

## The toolchain stays Node 24.19.0 and pnpm 11.21.0 for now

The governance pins that exact toolchain (`toolchain.mjs`, `corepack-environment.mjs`, the SBOM
admission profile name), and its own tests assert it. Moving the fleet to Node 26 and pnpm 12 is
a product change to that governance, not part of a repository move; it is tracked as an issue
here.

## The SBOM admission was re-profiled

The standalone lockfile resolves the same production graph shape (32 components, 33 edges) with
fresher transitive versions, so the identity hashes changed. The admission was regenerated with
`package-release profile-sbom` on a clean HEAD, and the SBOM test now reads the committed
admission instead of keeping a second copy.

## Host-only proofs stayed in little-legends

`tests/host-dogfood.test.ts` asserted little-legends' own Vite config, and the headed runtime-mute
browser contract tests little-legends' audio engine. Both test the host, so they remain there
against the registry package. The package's own fresh anonymous headed consumer smoke runs in this
repository's CI.

## A root LICENSE is a release input

`package-release` binds the root `LICENSE` as a release input. The package is `UNLICENSED`, and the
repository carries the same proprietary notice little-legends did.
