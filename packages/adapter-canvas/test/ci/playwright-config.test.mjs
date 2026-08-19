import { describe, expect, it } from "vitest";
import chromiumConfig from "../../playwright.config.ts";
import reliabilityConfig from "../../playwright.reliability.config.ts";
import visualConfig from "../../playwright.visual.config.ts";

describe("Playwright retry policy", () => {
  it("fails retry-only Chromium passes instead of reporting them green", () => {
    expect(chromiumConfig.failOnFlakyTests).toBe(true);
    expect(reliabilityConfig.failOnFlakyTests).toBe(true);
    expect(reliabilityConfig.retries).toBe(1);
  });

  it("requires exact visual pixels without retry acceptance", () => {
    expect(visualConfig.failOnFlakyTests).toBe(true);
    expect(visualConfig.retries).toBe(0);
    expect(visualConfig.expect?.toHaveScreenshot).toMatchObject({
      animations: "disabled",
      caret: "hide",
      maxDiffPixels: 0,
      scale: "css"
    });
  });
});
