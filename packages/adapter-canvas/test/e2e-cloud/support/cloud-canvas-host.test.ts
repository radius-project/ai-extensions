import { describe, expect, it } from "vitest";
import {
  CLOUD_CANVAS_HOST_ENV,
  resolveCloudCanvasHost
} from "./cloud-canvas-host.js";

describe("resolveCloudCanvasHost", () => {
  it.each([undefined, "", "   "])(
    "selects the harness when the value is %j",
    (value) => {
      expect(resolveCloudCanvasHost(value)).toBe("harness");
    }
  );

  it.each([
    ["harness", "harness"],
    ["copilot-app", "copilot-app"],
    [" Copilot-App ", "copilot-app"],
    ["HARNESS", "harness"]
  ] as const)("reads %j as %s", (value, expected) => {
    expect(resolveCloudCanvasHost(value)).toBe(expected);
  });

  it.each(["copilot", "app", "chromium", "copilot-app-x"])(
    "rejects the unknown host %j",
    (value) => {
      expect(() => resolveCloudCanvasHost(value)).toThrow(
        `${CLOUD_CANVAS_HOST_ENV} must be one of harness, copilot-app; got "${value}".`
      );
    }
  );
});
