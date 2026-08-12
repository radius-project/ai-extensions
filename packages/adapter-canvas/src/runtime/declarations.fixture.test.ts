import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RADIUS_ACTION_DECLARATIONS,
  RADIUS_TOOL_DECLARATIONS
} from "./declarations.js";

interface DeclarationFixture {
  actions: string[];
  tools: string[];
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../../test/fixtures/runtime-declarations.json", import.meta.url),
    "utf8"
  )
) as DeclarationFixture;

describe("RU-04: current action/tool declaration fixture baseline", () => {
  it("keeps exactly 6 actions matching the baseline fixture", () => {
    const currentNames = RADIUS_ACTION_DECLARATIONS.map(
      (action) => action.name
    ).sort();
    expect(currentNames).toEqual(fixture.actions);
  });

  it("keeps exactly 10 tools matching the baseline fixture", () => {
    const currentNames = RADIUS_TOOL_DECLARATIONS.map(
      (tool) => tool.name
    ).sort();
    expect(currentNames).toEqual(fixture.tools);
  });
});
