import { describe, it, expect } from "vitest";
import { parseBicepParams } from "@radius-project/core";
import { autogenValue, resolveDeployParams } from "./deployment-parameters.js";

describe("deployment parameter generation", () => {
  it.each([
    ["int", /^\d+$/],
    ["INT", /^\d+$/],
    ["bool", /^false$/],
    [undefined, /^[A-Za-z0-9_-]{24}$/],
    ["string", /^[A-Za-z0-9_-]{24}$/]
  ])("generates a valid %s value", (type, expected) => {
    expect(autogenValue(type)).toMatch(expected);
  });

  it("binds generation for missing values without replacing user values", () => {
    const parameters = parseBicepParams("param value string");
    expect(resolveDeployParams(parameters).value).toMatch(
      /^[A-Za-z0-9_-]{24}$/
    );
    expect(resolveDeployParams(parameters, { value: "chosen" })).toEqual({
      value: "chosen"
    });
  });
});
