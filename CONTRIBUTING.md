# Contributing

Thanks for taking the time to contribute.

## Getting set up

With [mise](https://mise.jdx.dev) (recommended — installs the Node and pnpm
versions pinned in `mise.toml`):

```sh
mise install
pnpm install
pnpm exec playwright install --with-deps --no-shell chromium   # once, for the browser smoke
pnpm verify   # lint, typecheck, test, build, package checks, packed-consumer smoke
```

Without mise, use `corepack` so pnpm matches the version pinned in
`package.json#packageManager`, on any Node release in the `engines.node`
range (`>=24`; CI verifies 24 and 26 with the official
`actions/setup-node` + `pnpm/action-setup`):

```sh
corepack enable
pnpm install
pnpm verify
```

`pnpm verify` runs the packed-consumer smoke without a browser. To also launch
real headed Chromium against the packed tarball, set `BUILD_PRESET_RUN_BROWSER=1`
(Linux needs a display; CI uses `xvfb-run`). Set `BUILD_PRESET_CONSUMER_VITEST=4`
to run the consumer on the Vitest 4 line instead of Vitest 5.

## Making a change

1. Branch off `main`.
2. Write the test first. A bug fix should come with a test that fails without it.
3. Run `pnpm verify`. A change is not ready while any part of that is red.
4. Commit with [Conventional Commits](https://www.conventionalcommits.org):
   `fix:`, `feat:`, `docs:`, `refactor:`, `test:`, `chore:`. Release Please uses
   these commits to drive the changelog and next version number.
5. Open a pull request describing what changed and why.

## What gets reviewed

- Does it do what it says, and is there a test proving it?
- Does it keep the public API honest? A breaking change needs a `!` or a
  `BREAKING CHANGE:` footer.
- Are the types right for consumers? CI runs `publint` and
  `arethetypeswrong` because broken types only surface at integration time.
- Does a config change work with every supported peer range (Vite 8.2 and
  newer, Vitest 4 and 5, Playwright 1.62.1 and newer)?
- Does the browser-test fragment stay headed-only and muted?

## Releases

Releases are automated. Merging a conventional commit to `main` opens a
release pull request; merging that publishes to npm with provenance. Do not
hand-edit versions or the changelog.
