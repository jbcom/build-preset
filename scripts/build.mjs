#!/usr/bin/env node
// Minimal tsc-only build: ESM (with .d.ts) to dist/, plus a CJS mirror to
// dist/cjs/ that gets renamed to .cjs so the package.json `exports` map can
// serve both module systems without a bundler.
import { execFileSync } from "node:child_process";
import { chmodSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");
const require = createRequire(import.meta.url);
const typescriptRoot = path.dirname(require.resolve("typescript/package.json"));
const typescriptCli = path.join(typescriptRoot, "bin/tsc");

rmSync(dist, { recursive: true, force: true });

function run(args) {
  execFileSync(process.execPath, [typescriptCli, ...args], { cwd: root, stdio: "inherit" });
}

// 1. ESM + declarations
run(["-p", "tsconfig.json"]);

// 2. CJS mirror
run(["-p", "tsconfig.cjs.json"]);

// 3. Rename dist/cjs/*.js -> dist/*.cjs, rewrite intra-package require("./x.js")
// specifiers to require("./x.cjs") (tsc always emits the source's own .js
// extension regardless of --module CommonJS), then drop dist/cjs.
const cjsDir = path.join(dist, "cjs");
const REQUIRE_RE = /require\("(\.\/[^"]+)\.js"\)/g;

function walk(dir, base) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = path.join(base, entry);
    if (statSync(full).isDirectory()) {
      walk(full, rel);
      continue;
    }
    if (entry.endsWith(".js")) {
      const target = path.join(dist, rel.replace(/\.js$/, ".cjs"));
      const contents = readFileSync(full, "utf8").replace(REQUIRE_RE, 'require("$1.cjs")');
      writeFileSync(target, contents);
    }
  }
}
walk(cjsDir, "");
rmSync(cjsDir, { recursive: true, force: true });

// 4. Mark the CLI entry executable (tsc preserves the shebang but not the
// +x bit; npm's bin validation rejects a non-executable bin script at
// publish time otherwise — silently auto-stripping the `bin` field).
chmodSync(path.join(dist, "cli.js"), 0o755);

console.log("build-preset: built dist/ (ESM .js + CJS .cjs + .d.ts)");
