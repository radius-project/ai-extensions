import { describe, it, expect } from "vitest";
import {
  appParams,
  autogenValue,
  resolveDeployParams,
  partitionParams,
  buildDeployRadCommand
} from "./bicep.js";

describe("autogenValue", () => {
  it.each([
    ["int", /^\d+$/],
    ["INT", /^\d+$/],
    ["bool", /^false$/],
    [undefined, /^[A-Za-z0-9_-]{24}$/],
    ["string", /^[A-Za-z0-9_-]{24}$/]
  ])("generates a valid %s value", (type, expected) => {
    expect(autogenValue(type)).toMatch(expected);
  });
});

describe("Canvas parameter compatibility", () => {
  const source = `param environment string
param application string
param image string
param registryUsername string
@secure()
param registryPassword string
@secure()
param password string
param replicas int
param enabled bool
param region string = 'westus'`;

  it("injects host generation without exposing managed or secret parameters", () => {
    const params = appParams(source);
    const resolved = resolveDeployParams(params);
    expect(resolved.password).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(resolved.replicas).toMatch(/^\d+$/);
    expect(resolved.enabled).toBe("false");
    expect(Object.keys(resolved)).toEqual(["password", "replicas", "enabled"]);
    const values = partitionParams(params, resolved);
    expect(values.secret).toEqual({ password: resolved.password });
    expect(
      buildDeployRadCommand(".radius/app.bicep", "prod", values.public)
    ).toBe(
      `deploy .radius/app.bicep --environment prod --parameters replicas=${resolved.replicas} --parameters enabled=false`
    );
  });

  it("keeps supplied values and the optional-values calling convention", () => {
    const params = appParams("param region string = 'westus'");
    expect(resolveDeployParams(params)).toEqual({});
    expect(resolveDeployParams(params, { region: "  eastus  " })).toEqual({
      region: "eastus"
    });
  });
});
