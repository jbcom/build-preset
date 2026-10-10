import { describe, expect, it } from "vitest";
import { defineGamePreset, type VendorChunks } from "../src/vite.js";

interface ChunkGroup {
  name: string;
  test: (id: string) => boolean;
}

/** The Rolldown groups the preset emits for these chunks and nothing else. */
function chunkGroups(chunks: VendorChunks): ChunkGroup[] {
  const output = defineGamePreset({ appName: "example-game", chunks }).build?.rolldownOptions
    ?.output as { codeSplitting?: { groups?: ChunkGroup[] } } | undefined;
  return output?.codeSplitting?.groups ?? [];
}

/** First group (declaration order) whose test claims the id: what Rolldown does at equal priority. */
function chunkOf(groups: ChunkGroup[], id: string): string | undefined {
  return groups.find((group) => group.test(id))?.name;
}

const WHEN_IT_LOADS = {
  three: ["three"],
  rapier: ["@react-three/rapier", "@dimforge/rapier3d-compat"],
  post: ["@react-three/postprocessing", "postprocessing", "n8ao"],
  drei: ["@react-three/drei"],
  r3f: ["@react-three/fiber"],
  tone: ["tone"],
};

describe("chunkGroups", () => {
  it("emits one named group per chunk, in declaration order", () => {
    const groups = chunkGroups(WHEN_IT_LOADS);
    expect(groups.map(({ name }) => name)).toEqual([
      "three",
      "rapier",
      "post",
      "drei",
      "r3f",
      "tone",
    ]);
  });

  it("emits nothing for no chunks", () => {
    expect(chunkGroups({})).toEqual([]);
  });

  describe("package names", () => {
    const groups = chunkGroups(WHEN_IT_LOADS);

    it.each([
      ["/app/node_modules/three/build/three.module.js", "three"],
      ["/app/node_modules/@react-three/rapier/dist/index.js", "rapier"],
      ["/app/node_modules/@dimforge/rapier3d-compat/rapier.js", "rapier"],
      ["/app/node_modules/@react-three/postprocessing/dist/index.js", "post"],
      ["/app/node_modules/postprocessing/build/index.js", "post"],
      ["/app/node_modules/n8ao/dist/N8AO.js", "post"],
      ["/app/node_modules/@react-three/drei/core/Html.js", "drei"],
      ["/app/node_modules/@react-three/fiber/dist/index.js", "r3f"],
      ["/app/node_modules/tone/build/esm/index.js", "tone"],
    ])("claims %s for %s", (id, expected) => {
      expect(chunkOf(groups, id)).toBe(expected);
    });

    it("claims pnpm's nested node_modules layout by the innermost package", () => {
      const id = "/app/node_modules/.pnpm/three@0.170.0/node_modules/three/build/three.module.js";
      expect(chunkOf(groups, id)).toBe("three");
    });

    it("claims Windows paths", () => {
      expect(chunkOf(groups, "C:\\app\\node_modules\\three\\build\\three.module.js")).toBe("three");
      expect(chunkOf(groups, "C:\\app\\node_modules\\@react-three\\fiber\\dist\\index.js")).toBe(
        "r3f",
      );
    });

    it("does not claim a package whose name only contains the listed one", () => {
      // `postprocessing` is a package; `@react-three/postprocessing` is a different one, and
      // `three-stdlib` / `three-mesh-bvh` are not `three`.
      expect(
        chunkOf(
          chunkGroups({ post: ["postprocessing"] }),
          "/a/node_modules/@react-three/postprocessing/x.js",
        ),
      ).toBe(undefined);
      expect(chunkOf(groups, "/app/node_modules/three-stdlib/index.js")).toBe(undefined);
      expect(chunkOf(groups, "/app/node_modules/tone-extras/index.js")).toBe(undefined);
    });

    it("does not claim application source", () => {
      expect(chunkOf(groups, "/app/src/three/Scene.tsx")).toBe(undefined);
      expect(chunkOf(groups, "/app/src/node_modules-like/three.ts")).toBe(undefined);
    });

    it("matches a package's own entry file with nothing after the name", () => {
      expect(chunkOf(chunkGroups({ a: ["lib"] }), "/app/node_modules/lib")).toBe("a");
    });

    it("treats regular-expression characters in a name literally", () => {
      const dotted = chunkGroups({ a: ["chart.js"] });
      expect(chunkOf(dotted, "/app/node_modules/chart.js/dist/x.js")).toBe("a");
      expect(chunkOf(dotted, "/app/node_modules/chartxjs/dist/x.js")).toBe(undefined);
    });
  });

  describe("regular expressions", () => {
    it("tests the whole module id", () => {
      const groups = chunkGroups({ mid: [/[\\/]src[\\/]mid[\\/]/] });
      expect(chunkOf(groups, "/app/src/mid/a.ts")).toBe("mid");
      expect(chunkOf(groups, "/app/src/other/a.ts")).toBe(undefined);
    });

    it("mixes with package names in one chunk", () => {
      const groups = chunkGroups({ mix: ["tone", /standardized-audio-context/] });
      expect(chunkOf(groups, "/app/node_modules/tone/x.js")).toBe("mix");
      expect(chunkOf(groups, "/app/node_modules/standardized-audio-context/x.js")).toBe("mix");
    });

    it("answers the same every time it is asked", () => {
      const groups = chunkGroups({ a: [/same/i] });
      expect([1, 2, 3].map(() => groups[0]?.test("/SAME/x.js"))).toEqual([true, true, true]);
    });
  });

  describe("precedence", () => {
    it("lets the first declared chunk take a module two chunks match", () => {
      const rules = { first: [/shared/], second: [/shared/] };
      expect(chunkOf(chunkGroups(rules), "/app/shared/x.js")).toBe("first");
    });

    it("follows declaration order, not alphabetical order", () => {
      const reversed = { z: [/shared/], a: [/shared/] };
      expect(chunkOf(chunkGroups(reversed), "/app/shared/x.js")).toBe("z");
    });

    it("lets a specific chunk declared first carve its modules out of a broad one", () => {
      const groups = chunkGroups({
        rapier: ["@react-three/rapier"],
        r3f: [/node_modules[\\/]@react-three[\\/]/],
      });
      expect(chunkOf(groups, "/a/node_modules/@react-three/rapier/x.js")).toBe("rapier");
      expect(chunkOf(groups, "/a/node_modules/@react-three/fiber/x.js")).toBe("r3f");
    });

    it("lets the broad chunk win when it is declared first", () => {
      const groups = chunkGroups({
        r3f: [/node_modules[\\/]@react-three[\\/]/],
        rapier: ["@react-three/rapier"],
      });
      expect(chunkOf(groups, "/a/node_modules/@react-three/rapier/x.js")).toBe("r3f");
    });
  });

  describe("rejects the unmatchable", () => {
    it("a package named in two chunks", () => {
      expect(() => chunkGroups({ a: ["three"], b: ["three"] })).toThrow(
        /package "three" is claimed by both chunks\.a and chunks\.b/,
      );
    });

    it("a package listed twice in one chunk", () => {
      expect(() => chunkGroups({ a: ["three", "three"] })).toThrow(
        /chunks\.a lists package "three" twice/,
      );
    });

    it("a chunk with no patterns", () => {
      expect(() => chunkGroups({ a: [] })).toThrow(/chunks\.a lists no patterns/);
    });

    it("an empty or blank chunk name", () => {
      expect(() => chunkGroups({ "": ["three"] })).toThrow(/invalid chunk name ""/);
      expect(() => chunkGroups({ "  ": ["three"] })).toThrow(/invalid chunk name " {2}"/);
    });

    it("a purely numeric chunk name, which JavaScript would reorder", () => {
      expect(() => chunkGroups({ b: ["x"], "1": ["three"] })).toThrow(/invalid chunk name "1"/);
    });

    it("an empty or blank package name", () => {
      expect(() => chunkGroups({ a: [""] })).toThrow(/chunks\.a has an empty package name/);
      expect(() => chunkGroups({ a: [" "] })).toThrow(/chunks\.a has an empty package name/);
    });

    it("a global or sticky RegExp", () => {
      expect(() => chunkGroups({ a: [/x/g] })).toThrow(/chunks\.a has a RegExp with the g or y/);
      expect(() => chunkGroups({ a: [/x/y] })).toThrow(/chunks\.a has a RegExp with the g or y/);
    });
  });
});
