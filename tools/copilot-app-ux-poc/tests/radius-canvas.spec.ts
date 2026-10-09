import { isRadiusCanvasTitle } from "../fixtures/cdp.ts";
import { expect, test } from "../fixtures/radius-canvas.ts";

// Opens the Radius canvas in the selected session with Add tab > Canvas >
// Radius. No prompt is sent. If the test opened the tab, the fixture closes
// it at teardown.
test.describe("Radius canvas", () => {
  test("opens from the Add tab menu and shows a Radius page", async ({
    appPage,
    radiusCanvas
  }, testInfo) => {
    const { tab, target, openedByTest } = radiusCanvas;
    testInfo.annotations.push(
      { type: "canvas-url", description: target.url() },
      {
        type: "radius-tab",
        description: openedByTest ? "Opened by the test" : "Already open"
      }
    );

    await expect(tab).toHaveAttribute("aria-selected", "true");
    expect(isRadiusCanvasTitle(await target.title())).toBe(true);
    await expect(target.locator("h1").first()).toBeVisible();

    await testInfo.attach("radius-canvas", {
      body: await target.locator("body").screenshot(),
      contentType: "image/png"
    });
    await testInfo.attach("copilot-app-window", {
      body: await appPage.screenshot(),
      contentType: "image/png"
    });
  });
});
