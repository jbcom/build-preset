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

  describe("vendor chunks", () => {
    // Fixture packages and the value each exports; the value is how a built chunk is identified.
    const PACKAGES = [
      ["three", "threeValue"],
      ["@react-three/fiber", "fiberValue"],
      ["@react-three/drei", "dreiValue"],
      ["@react-three/rapier", "rapierValue"],
      ["@dimforge/rapier3d-compat", "wasmValue"],
      ["@react-three/postprocessing", "postValue"],
      ["postprocessing", "postCoreValue"],
      ["tone", "toneValue"],
    ] as const;

    async function buildFixture(
      options: Partial<Parameters<typeof defineGamePreset>[0]>,
    ): Promise<{ chunks: Map<string, string>; cleanup: () => Promise<void> }> {
      const root = await mkdtemp(path.join(tmpdir(), "build-preset-chunks-"));
      for (const [name, exportName] of PACKAGES) {
        await writeFixturePackage(root, name, exportName, exportName);
      }
      await writeEntry(
        root,
        [
          ...PACKAGES.map(([name, exportName]) => `import { ${exportName} } from "${name}";`),
          `document.querySelector("#app").textContent = [${PACKAGES.map(([, e]) => e).join(", ")}].join();`,
          "",
        ].join("\n"),
      );
      await build(
        defineGamePreset({
          appName: "fixture",
          srcDir: path.join(root, "src"),
          overrides: fixtureBuild(root),
          ...options,
        }),
      );
      // chunk name (the file's name without its hash) -> contents
      const chunks = new Map<string, string>();
      for (const file of await readdir(path.join(root, "dist/assets"))) {
        const match = /^(.*)-[\w-]{8}\.js$/.exec(file);
        if (match?.[1]) {
          chunks.set(match[1], await readFile(path.join(root, "dist/assets", file), "utf8"));
        }
      }
      return { chunks, cleanup: () => rm(root, { recursive: true, force: true }) };
    }

    // Will It Blow?'s split: what loads with the title is separate from what loads with the room.
    const WHEN_IT_LOADS = {
      three: ["three"],
      rapier: ["@react-three/rapier", "@dimforge/rapier3d-compat"],
      post: ["@react-three/postprocessing", "postprocessing"],
      drei: ["@react-three/drei"],
      r3f: ["@react-three/fiber"],
      tone: ["tone"],
    };

    it("builds the chunks a game names, each holding exactly its own packages", async () => {
      const { chunks, cleanup } = await buildFixture({ chunks: WHEN_IT_LOADS });
      try {
        const holding = (chunk: string) =>
          PACKAGES.map(([, value]) => value).filter((value) => chunks.get(chunk)?.includes(value));
        expect(holding("three")).toEqual(["threeValue"]);
        expect(holding("rapier")).toEqual(["rapierValue", "wasmValue"]);
        expect(holding("post")).toEqual(["postValue", "postCoreValue"]);
        expect(holding("drei")).toEqual(["dreiValue"]);
        expect(holding("r3f")).toEqual(["fiberValue"]);
        expect(holding("tone")).toEqual(["toneValue"]);
      } finally {
        await cleanup();
      }
    });

    it("gives a module two chunks match to the first-declared chunk", async () => {
      const everyReactThree = /node_modules[\\/]@react-three[\\/]/;
      const specificFirst = await buildFixture({
        chunks: { rapier: ["@react-three/rapier"], r3f: [everyReactThree] },
      });
      const broadFirst = await buildFixture({
        chunks: { r3f: [everyReactThree], rapier: ["@react-three/rapier"] },
      });
      try {
        expect(specificFirst.chunks.get("rapier")).toContain("rapierValue");
        expect(specificFirst.chunks.get("r3f")).not.toContain("rapierValue");
        expect(specificFirst.chunks.get("r3f")).toContain("fiberValue");
        // Declared second, the specific chunk is left with nothing to claim and is not emitted.
        expect(broadFirst.chunks.get("r3f")).toContain("rapierValue");
        expect(broadFirst.chunks.has("rapier")).toBe(false);
      } finally {
        await specificFirst.cleanup();
        await broadFirst.cleanup();
      }
    });

    it("outranks the heavyDeps groups it overlaps and leaves the others alone", async () => {
      const { chunks, cleanup } = await buildFixture({
        heavyDeps: { three: true, rapier: true, tone: true },
        chunks: { three: ["three"], rapier: ["@dimforge/rapier3d-compat"] },
      });
      try {
        expect(chunks.get("three")).toContain("threeValue");
        expect(chunks.get("rapier")).toContain("wasmValue");
        // three-vendor would hold both; the chunks took them first, so it has nothing left.
        expect(chunks.has("three-vendor")).toBe(false);
        // tone is only named by heavyDeps, which still applies.
        expect(chunks.get("tone-vendor")).toContain("toneValue");
      } finally {
        await cleanup();
      }
    });
  });
});
