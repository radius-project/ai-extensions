import { expect, it } from "vitest";
import { getLifecycleCapabilities } from "./capabilities.js";

it("advertises only registered read contexts, not approval or provider authority", () => {
  const result = getLifecycleCapabilities({ repo: "owner/repo" }, []);
  expect(result.capabilities.map((item) => item.operation)).toEqual([
    "capabilities.get"
  ]);
  expect(result.capabilities[0]).toMatchObject({
    requiresAgent: false,
    providers: [],
    contexts: ["session"]
  });
  expect(result.limitations.join(" ")).toContain("authorization");
});
it("preserves declared context limitations without inventing provider or agent support", () => {
  const result = getLifecycleCapabilities({ repo: "owner/repo" }, [
    {
      operation: "application.inspect",
      contexts: ["workspace"],
      providers: [],
      requiresAgent: false,
      limitations: ["Remote sources unavailable."]
    }
  ]);
  expect(result.capabilities[1]).toMatchObject({
    apiVersion: "github-radius/v1",
    limitations: ["Remote sources unavailable."]
  });
});
