import { expect, it } from "vitest";
import { portSuccess } from "@radius-project/core/lifecycle";
import { createDeployedApplicationRead } from "@radius-project/adapter-shared";
import { createCanvasDiscoveryContext } from "./create-discovery-context.js";
import { createDiscoveryGitHubRead } from "./discovery-github-read.js";
it("rejects incomplete production read dependencies before registering capabilities", () => {
  for (const deps of [undefined, {}, { authority: {} }])
    expect(() =>
      Reflect.apply(createCanvasDiscoveryContext, undefined, [deps])
    ).toThrow("requires");
  for (const deps of [
    undefined,
    {},
    { verify: async () => portSuccess(undefined) }
  ])
    expect(() =>
      Reflect.apply(createDiscoveryGitHubRead, undefined, [deps])
    ).toThrow("requires");
  for (const deps of [undefined, {}, { get: async () => portSuccess([]) }])
    expect(() =>
      Reflect.apply(createDeployedApplicationRead, undefined, [deps])
    ).toThrow("require");
});
