import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build, normalizePath, type Plugin, version as viteVersion } from "vite";
import { describe, expect, it } from "vitest";
import { defineGamePreset } from "../src/vite.js";

async function writeFixturePackage(
  root: string,
  name: string,
  exportName: string,
  value: string,
): Promise<void> {
  const packageRoot = path.join(root, "node_modules", ...name.split("/"));
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name, version: "1.0.0", type: "module", exports: "./index.js" }),
  );
  await writeFile(
    path.join(packageRoot, "index.js"),
    `export const ${exportName} = ${JSON.stringify(value)};\n`,
  );
}

async function writeEntry(root: string, source: string): Promise<void> {
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "index.html"),
    '<div id="app"></div><script type="module" src="/src/main.js"></script>\n',
  );
  await writeFile(path.join(root, "src/main.js"), source);
}

async function builtJavaScript(root: string): Promise<string> {
  const assetsRoot = path.join(root, "dist/assets");
  const assets = await readdir(assetsRoot);
  return (
    await Promise.all(
      assets
        .filter((name) => name.endsWith(".js"))
        .map((name) => readFile(path.join(assetsRoot, name), "utf8")),
    )
  ).join("\n");
}

function fixtureBuild(root: string) {
  return {
    root,
    logLevel: "silent" as const,
    build: { outDir: "dist", emptyOutDir: true },
  };
}

describe("Vite conformance", () => {
  it("executes against a Vite release the peer range accepts", () => {
    const range = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
    ).peerDependencies.vite;
    const floor = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range)?.slice(1).map(Number);
    expect(floor, `peer range ${range} must be a caret range`).toBeDefined();
    const [major, minor, patch] = (floor ?? []) as [number, number, number];
    const [actualMajor, actualMinor, actualPatch] = viteVersion.split(".").map(Number) as [
      number,
      number,
      number,
    ];
    expect(actualMajor).toBe(major);
    expect(actualMinor > minor || (actualMinor === minor && actualPatch >= patch)).toBe(true);
  });

  it("builds a default-root fixture without inventing an @ alias", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-preset-vite82-default-"));
    try {
      await writeEntry(
        root,
        'import { message } from "./message.js"; document.querySelector("#app").textContent = message;\n',
      );
      await writeFile(
        path.join(root, "src/message.js"),
        'export const message = "default-root";\n',
      );

      await build(
        defineGamePreset({
          appName: "fixture",
          overrides: fixtureBuild(root),
        }),
      );

      expect(await builtJavaScript(root)).toContain("default-root");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds from a custom root through an explicit absolute source alias", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-preset-vite82-root-"));
    try {
      const sourceRoot = path.join(root, "authored-source");
      await mkdir(sourceRoot, { recursive: true });
      await writeEntry(
        root,
        'import { message } from "@/message.js"; document.querySelector("#app").textContent = message;\n',
      );
      await writeFile(
        path.join(sourceRoot, "message.js"),
        'export const message = "custom-root";\n',
      );

      await build(
        defineGamePreset({
          appName: "fixture",
          srcDir: sourceRoot,
          overrides: fixtureBuild(root),
        }),
      );

      expect(await builtJavaScript(root)).toContain("custom-root");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("carries a Windows absolute alias through a real Vite build", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-preset-vite82-windows-"));
    try {
      const realMessage = path.join(root, "windows-message.js");
      const windowsSource = "C:\\fixtures\\example-game\\src";
      const normalizedMessage = `${windowsSource.replaceAll("\\", "/")}/message.js`;
      const observedIds: string[] = [];
      const windowsFixtureResolver: Plugin = {
        name: "windows-fixture-resolver",
        enforce: "pre",
        resolveId(id) {
          const normalizedId = normalizePath(id).replaceAll("\\", "/");
          observedIds.push(normalizedId);
          if (normalizedId === normalizedMessage) return realMessage;
          return null;
        },
      };
      await writeEntry(
        root,
        'import { message } from "@/message.js"; document.querySelector("#app").textContent = message;\n',
      );
      await writeFile(realMessage, 'export const message = "windows-alias";\n');

      await build(
        defineGamePreset({
          appName: "fixture",
          srcDir: windowsSource,
          plugins: [windowsFixtureResolver],
          overrides: fixtureBuild(root),
        }),
      );

      expect(observedIds).toContain(normalizedMessage);
      expect(await builtJavaScript(root)).toContain("windows-alias");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds heavy dependencies into named Rolldown code-splitting groups", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-preset-vite82-"));
    try {
      await writeFixturePackage(root, "three", "threeValue", "three");
      await writeFixturePackage(root, "phaser", "phaserValue", "phaser");
      await writeEntry(
        root,
        [
          'import { threeValue } from "three";',
          'import { phaserValue } from "phaser";',
          'document.querySelector("#app").textContent = threeValue + ":" + phaserValue;',
          "",
        ].join("\n"),
      );

      await build(
        defineGamePreset({
          appName: "fixture",
          srcDir: path.join(root, "src"),
          heavyDeps: { three: true, phaser: true },
          overrides: fixtureBuild(root),
        }),
      );

      const assets = await readdir(path.join(root, "dist/assets"));
      expect(assets.some((name) => /^three-vendor-.*\.js$/.test(name))).toBe(true);
      expect(assets.some((name) => /^phaser-vendor-.*\.js$/.test(name))).toBe(true);

      const threeChunk = assets.find((name) => /^three-vendor-.*\.js$/.test(name));
      const phaserChunk = assets.find((name) => /^phaser-vendor-.*\.js$/.test(name));
      if (!threeChunk || !phaserChunk) throw new Error("expected both named vendor chunks");
      expect(await readFile(path.join(root, "dist/assets", threeChunk), "utf8")).toContain("three");
      expect(await readFile(path.join(root, "dist/assets", phaserChunk), "utf8")).toContain(
        "phaser",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
