import { describe, expect, it } from "vitest";
import { captureAppState } from "./copilot-app-ui.js";

describe("captureAppState", () => {
  it("saves both diagnostics", async () => {
    const saved: string[] = [];
    const warnings: string[] = [];
    await captureAppState(
      {
        screenshot: async () => Buffer.from("image"),
        ariaSnapshot: async () => "tree"
      },
      "app",
      async (name) => {
        saved.push(name);
      },
      (message) => warnings.push(message)
    );
    expect(saved.sort()).toEqual(["app.aria.yml", "app.png"]);
    expect(warnings).toEqual([]);
  });

  it("reports both capture failures without replacing the primary failure", async () => {
    const warnings: string[] = [];
    await captureAppState(
      {
        screenshot: async () => {
          throw new Error("page closed");
        },
        ariaSnapshot: async () => {
          throw new Error("frame detached");
        }
      },
      "app",
      async () => {
        throw new Error("must not save");
      },
      (message) => warnings.push(message)
    );
    expect(warnings).toEqual([
      "Could not capture app screenshot: page closed",
      "Could not capture app accessibility tree: frame detached"
    ]);
  });

  it("reports a failed write and still saves the other diagnostic", async () => {
    const saved: string[] = [];
    const warnings: string[] = [];
    await captureAppState(
      {
        screenshot: async () => Buffer.from("image"),
        ariaSnapshot: async () => "tree"
      },
      "app",
      async (name) => {
        if (name.endsWith(".png")) throw new Error("disk full");
        saved.push(name);
      },
      (message) => warnings.push(message)
    );
    expect(saved).toEqual(["app.aria.yml"]);
    expect(warnings).toEqual(["Could not capture app screenshot: disk full"]);
  });
});
