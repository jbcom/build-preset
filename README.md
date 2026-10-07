# build-preset

The home of [`@arcade-cabinet/build-preset`](packages/build-preset/README.md): the fleet's shared
Vite, tsconfig, Biome, Capacitor and Vitest conventions, and its private-package release governance
(the `build-preset package-release` and `dependency-current` CLIs).

The package lives in `packages/build-preset`. The repository root is a private release harness, not
a second package: it installs the package as its own verifier (`"@arcade-cabinet/build-preset":
"workspace:*"`), which `package-release` requires before it will publish anything, and it holds the
workflows and release-please files. See [docs/decisions.md](docs/decisions.md) for why.

## Install (consumers)

```sh
pnpm add -D @arcade-cabinet/build-preset
```

with the fleet scope mapped (reads are anonymous on a private network):

```ini
@arcade-cabinet:registry=https://registry.npmjs.org/
```

## Develop

The release governance pins an exact toolchain: Node 24.19.0 (`.node-version`) and pnpm 11.21.0
(`packageManager`, through Corepack).

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm verify   # the package: Biome, tsc, Vitest, build, pack, fresh anonymous consumer
pnpm lint     # the harness scripts
```

## Release

1. Conventional Commits on `main`. release-please (`.gitea/workflows/release.yml`) keeps a release pull
   request with the next version, but planning stays closed until the current version is really
   released: its `build-preset-v<version>` tag, Gitea release, attested assets and anonymous registry
   bytes all verify.
2. Merge the release pull request.
3. Dispatch `.gitea/workflows/publish.yml` with the exact green `main` commit. It re-verifies the
   source and dependency currency, packs twice, admits the CycloneDX SBOM against the profile committed
   in `packages/build-preset/private-package-release.json`, publishes to the registry, creates the tag
   and release with the archive, SBOM and checksums, and proves the published version from a fresh
   anonymous headed consumer.

Nobody edits a version by hand. A change to the production dependency graph changes the SBOM admission;
re-profile it with `build-preset package-release profile-sbom` (see the package README).
