import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RADIUS_ACTION_DECLARATIONS,
  RADIUS_TOOL_DECLARATIONS
} from "./declarations.js";

interface DeclarationFixture {
  acceptedSurface: {
    actions: string[];
    tools: string[];
    removedActions: string[];
    removedTools: string[];
  };
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../../test/fixtures/runtime-compatibility.json", import.meta.url),
    "utf8"
  )
) as DeclarationFixture;

describe("RU-04: current action/tool declaration fixture baseline", () => {
  it("keeps exactly the retained actions matching the accepted fixture", () => {
    const currentNames = RADIUS_ACTION_DECLARATIONS.map(
      (action) => action.name
    );
    expect(currentNames).toEqual(fixture.acceptedSurface.actions);
    expect(currentNames).not.toEqual(
      expect.arrayContaining(fixture.acceptedSurface.removedActions)
    );
  });

  it("keeps exactly the retained tools matching the accepted fixture", () => {
    const currentNames = RADIUS_TOOL_DECLARATIONS.map((tool) => tool.name);
    expect(currentNames).toEqual(fixture.acceptedSurface.tools);
    expect(currentNames).not.toEqual(
      expect.arrayContaining(fixture.acceptedSurface.removedTools)
    );
  });
});
