import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const readJson = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
const packageJson = readJson("package.json");

describe("repository contract", () => {
  it("keeps the package and the release manifest on the same version", () => {
    expect(readJson(".release-please-manifest.json")["."]).toBe(packageJson.version);
  });

  it("compiles with the installed TypeScript, never through npx", () => {
    const source = readFileSync(path.join(root, "scripts/build.mjs"), "utf8");
    expect(source).toContain('require.resolve("typescript/package.json")');
    expect(source).toContain('"bin/tsc"');
    expect(source).toContain("execFileSync(process.execPath, [tscBin");
    expect(source).not.toMatch(/execFileSync\(["']npx["']/);
  });

  it("ships no runtime dependencies", () => {
    expect(packageJson.dependencies).toBeUndefined();
  });

  it("exports one subpath per source module, with import and require conditions", () => {
    const modules = readdirSync(path.join(root, "src"))
      .map((name) => name.replace(/\.ts$/, ""))
      .filter((name) => name !== "index" && !name.startsWith("cli"))
      .sort();
    const subpaths = Object.keys(packageJson.exports)
      .filter((key) => /^\.\/[a-z]+$/.test(key))
      .map((key) => key.slice(2))
      .sort();
    expect(subpaths).toEqual(modules);
    for (const key of ["."].concat(subpaths.map((name) => `./${name}`))) {
      const entry = packageJson.exports[key];
      expect(entry.import.default).toMatch(/^\.\/dist\/esm\/.+\.js$/);
      expect(entry.require.default).toMatch(/^\.\/dist\/cjs\/.+\.cjs$/);
      expect(entry.require.types).toMatch(/\.d\.cts$/);
    }
  });

  it("points the bin at the built ESM CLI", () => {
    expect(packageJson.bin["build-preset"]).toBe("./dist/esm/cli.js");
  });

  it("requires Vitest and its browser provider on the same majors", () => {
    expect(packageJson.peerDependencies.vitest).toBe(
      packageJson.peerDependencies["@vitest/browser-playwright"],
    );
  });

  it("keeps tsup an optional peer, because only a library build needs it", () => {
    expect(packageJson.peerDependenciesMeta.tsup).toEqual({ optional: true });
    const barrel = readFileSync(path.join(root, "src/index.ts"), "utf8");
    expect(barrel).not.toMatch(/^export .* from ["']\.\/tsup/m);
  });
});
