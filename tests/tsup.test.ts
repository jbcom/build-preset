import { describe, expect, it } from "vitest";
import { libraryBuild } from "../src/tsup.js";

describe("libraryBuild", () => {
  it("derives the banner from the package name", () => {
    const config = libraryBuild({ name: "@scope/renderer" });
    expect(config.banner).toEqual({ js: "/* @scope/renderer - ESM Build */" });
  });

  it("ships ESM with declarations, sourcemaps and no minification", () => {
    const config = libraryBuild({ name: "pkg" });
    expect(config).toMatchObject({
      format: ["esm"],
      target: "es2022",
      dts: true,
      clean: true,
      sourcemap: true,
      splitting: false,
      treeshake: true,
      minify: false,
      keepNames: true,
    });
  });

  it("defaults the entry to src/index.ts and the externals to none", () => {
    const config = libraryBuild({ name: "pkg" });
    expect(config.entry).toEqual(["src/index.ts"]);
    expect(config.external).toEqual([]);
  });

  it("passes entry and externals through unchanged", () => {
    const external = ["three", /^react/];
    const config = libraryBuild({ name: "pkg", entry: ["src/a.ts", "src/b.ts"], external });
    expect(config.entry).toEqual(["src/a.ts", "src/b.ts"]);
    expect(config.external).toBe(external);
  });

  it("sets no esbuildOptions hook when jsx is omitted", () => {
    expect(libraryBuild({ name: "pkg" }).esbuildOptions).toBeUndefined();
  });

  it.each(["automatic", "preserve", "transform"] as const)(
    "routes jsx %s through esbuildOptions, never a top-level field",
    (jsx) => {
      const config = libraryBuild({ name: "pkg", jsx });
      expect("jsx" in config).toBe(false);
      const esbuild: { jsx?: string } = {};
      // The hook's second argument is tsup's build context; it is unused here.
      config.esbuildOptions?.(esbuild as never, {} as never);
      expect(esbuild.jsx).toBe(jsx);
    },
  );

  it("lets overrides win over every default, including the banner", () => {
    const config = libraryBuild({
      name: "pkg",
      overrides: { target: "es2020", splitting: true, banner: { js: "/* custom */" } },
    });
    expect(config.target).toBe("es2020");
    expect(config.splitting).toBe(true);
    expect(config.banner).toEqual({ js: "/* custom */" });
    expect(config.dts).toBe(true);
  });
});
