import path from "node:path";
import { describe, expect, it } from "vitest";
import littleLegendsConfig from "../../../vite.config.js";

describe("Little Legends local package dogfood", () => {
  it("uses an absolute source alias and one definition per code-splitting group", () => {
    const alias = littleLegendsConfig.resolve?.alias as Record<string, string>;
    const aliasIsAbsolute = path.isAbsolute(alias["@"]);
    expect(aliasIsAbsolute).toBe(true);

    const output = littleLegendsConfig.build?.rolldownOptions?.output as
      | { codeSplitting?: { groups?: Array<{ name: string }> } }
      | undefined;
    const names = output?.codeSplitting?.groups?.map(({ name }) => name) ?? [];
    expect(names).toEqual([
      "three-vendor",
      "r3f-vendor",
      "audio-vendor",
      "react-vendor",
      "hex-world-vendor",
      "persistence-vendor",
    ]);
    expect(new Set(names).size).toBe(names.length);
  });
});
