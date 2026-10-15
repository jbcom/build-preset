import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build, type InlineConfig, type Plugin, resolveConfig, type UserConfig } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { staticRouteExport as routes } from "../src/vite.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "route-export-"));
  roots.push(root);
  await writeFile(
    path.join(root, "index.html"),
    '<main></main><script type="module" src="/main.js"></script>',
  );
  await writeFile(
    path.join(root, "main.js"),
    'document.querySelector("main").textContent="ready";',
  );
  return root;
}

function config(root: string, plugins: Plugin[], extra: UserConfig = {}): InlineConfig {
  return {
    root,
    configFile: false,
    logLevel: "silent",
    plugins,
    build: { outDir: "web-output" },
    ...extra,
  };
}

describe("static route export", () => {
  it("copies the final transformed index to declared nested routes in the configured output", async () => {
    const root = await fixture();
    await build(
      config(root, [routes({ routes: ["/", "/play", "guide/topic/", "play/"] })], {
        base: "/example/",
      }),
    );
    const index = await readFile(path.join(root, "web-output/index.html"), "utf8");
    expect(index).toMatch(/src="\/example\/assets\/[^"]+\.js"/);
    expect(index).not.toContain("/main.js");
    for (const route of ["play", "guide/topic"])
      expect(await readFile(path.join(root, "web-output", route, "index.html"), "utf8")).toBe(
        index,
      );
    const asset = /src="\/example\/([^"]+)"/.exec(index)?.[1];
    expect(asset).toBeDefined();
    expect(await readFile(path.join(root, "web-output", asset ?? ""), "utf8")).toContain("ready");
  });

  it("refreshes aliases from the new build rather than retaining previous transformed bytes", async () => {
    const root = await fixture();
    const plugin = routes({ routes: ["play"] });
    await build(config(root, [plugin]));
    const first = await readFile(path.join(root, "web-output/play/index.html"), "utf8");
    await writeFile(
      path.join(root, "main.js"),
      'document.querySelector("main").textContent="updated";',
    );
    await build(config(root, [plugin]));
    const next = await readFile(path.join(root, "web-output/index.html"), "utf8");
    expect(next).not.toBe(first);
    expect(await readFile(path.join(root, "web-output/play/index.html"), "utf8")).toBe(next);
  });

  it.each([{ native: true, routes: ["play"] }, { enabled: false, routes: ["play"] }, {}])(
    "has no route output when disabled or undeclared: %j",
    async (options) => {
      const root = await fixture();
      await build(config(root, [routes(options)]));
      expect(await readdir(path.join(root, "web-output"))).toEqual(
        expect.not.arrayContaining(["play"]),
      );
    },
  );

  it("skips declared routes for native mode and in-memory builds", async () => {
    const root = await fixture();
    vi.stubEnv("CAPACITOR", "true");
    await build(config(root, [routes({ routes: ["play"] })]));
    expect(await readdir(path.join(root, "web-output"))).not.toContain("play");
    vi.stubEnv("CAPACITOR", "false");
    await rm(path.join(root, "web-output"), { recursive: true });
    await build(
      config(root, [routes({ routes: ["play"] })], {
        build: { outDir: "web-output", write: false },
      }),
    );
    await expect(readdir(path.join(root, "web-output"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "",
    "../outside",
    "a/../b",
    "a//b",
    "//host/x",
    "a\\b",
    "a?x",
    "a#x",
    "a%2fb",
    "C:/x",
    "a/index.html",
    "CON",
    "a/NUL",
    "./x",
  ])("rejects unsafe or nonportable route %j", (route) => {
    expect(() => routes({ routes: [route] })).toThrow(/route/i);
  });

  it("rejects case collisions and relative asset bases", async () => {
    expect(() => routes({ routes: ["Play", "play"] })).toThrow(/route/i);
    const root = await fixture();
    await expect(
      build(config(root, [routes({ routes: ["play"] })], { base: "./" })),
    ).rejects.toThrow(/base/i);
  });

  it("uses an absolute output directory and HTTP asset base, preserving identical existing aliases", async () => {
    const root = await fixture();
    const outDir = path.join(root, "release");
    const options = config(root, [routes({ routes: ["play"] })], {
      base: "https://cdn.example.test/app/",
      build: { outDir, emptyOutDir: false },
    });
    await build(options);
    await build(options);
    expect(await readFile(path.join(outDir, "play/index.html"), "utf8")).toBe(
      await readFile(path.join(outDir, "index.html"), "utf8"),
    );
  });

  it("does not participate in serve, SSR or library output", async () => {
    const root = await fixture();
    const serve = await resolveConfig(config(root, [routes({ routes: ["play"] })]), "serve");
    expect(serve.plugins.map((plugin) => plugin.name)).not.toContain(
      "build-preset:static-route-export",
    );
    for (const buildOptions of [
      { ssr: path.join(root, "main.js") },
      { lib: { entry: path.join(root, "main.js"), formats: ["es"] } },
    ] satisfies NonNullable<UserConfig["build"]>[]) {
      await build(
        config(root, [routes({ routes: ["play"] })], {
          build: { ...buildOptions, outDir: "web-output" },
        }),
      );
      expect(await readdir(path.join(root, "web-output"))).not.toContain("play");
    }
  });

  it("requires an index document for an active HTML export", async () => {
    const root = await fixture();
    await expect(
      build(
        config(root, [routes({ routes: ["play"] })], {
          build: { outDir: "web-output", rolldownOptions: { input: path.join(root, "main.js") } },
        }),
      ),
    ).rejects.toThrow(/index.html/);
  });

  it("does not export a stale root index when the current build fails before writing", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "web-output"));
    await writeFile(path.join(root, "web-output/index.html"), "old build");
    await writeFile(path.join(root, "main.js"), "export const broken = ;");
    await expect(
      build(
        config(root, [routes({ routes: ["play"] })], {
          build: { outDir: "web-output", emptyOutDir: false },
        }),
      ),
    ).rejects.toThrow();
    expect(await readdir(path.join(root, "web-output"))).not.toContain("play");
  });

  it("rejects files and directory links along an alias path without writing through them", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "public"));
    await writeFile(path.join(root, "public/play"), "occupied");
    await expect(build(config(root, [routes({ routes: ["play/topic"] })]))).rejects.toThrow(
      /plain directory/,
    );
    await rm(path.join(root, "public/play"));
    await mkdir(path.join(root, "outside"));
    await build(config(root, []));
    await symlink(path.join(root, "outside"), path.join(root, "web-output/play"), "junction");
    await expect(
      build(
        config(root, [routes({ routes: ["play"] })], {
          build: { outDir: "web-output", emptyOutDir: false },
        }),
      ),
    ).rejects.toThrow(/plain directory/);
    expect(await readdir(path.join(root, "outside"))).toEqual([]);
  });

  it("rejects a directory or link at the index destination", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "public/play/index.html"), { recursive: true });
    await expect(build(config(root, [routes({ routes: ["play"] })]))).rejects.toThrow(/overwrite/);
    await rm(path.join(root, "public/play"), { recursive: true });
    await mkdir(path.join(root, "outside"));
    await build(config(root, []));
    await mkdir(path.join(root, "web-output/play"));
    await symlink(
      path.join(root, "outside"),
      path.join(root, "web-output/play/index.html"),
      "junction",
    );
    await expect(
      build(
        config(root, [routes({ routes: ["play"] })], {
          build: { outDir: "web-output", emptyOutDir: false },
        }),
      ),
    ).rejects.toThrow(/overwrite/);
  });

  it("does not replace a separately authored route index", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "public/play"), { recursive: true });
    await writeFile(path.join(root, "public/play/index.html"), "separate document");
    await expect(build(config(root, [routes({ routes: ["play"] })]))).rejects.toThrow(
      /existing|overwrite/i,
    );
    expect(await readFile(path.join(root, "web-output/play/index.html"), "utf8")).toBe(
      "separate document",
    );
  });
});
