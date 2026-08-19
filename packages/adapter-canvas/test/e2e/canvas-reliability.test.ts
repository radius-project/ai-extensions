import { promises as fs } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import {
  baseCanvasState,
  defaultFakeCliScenario,
  expect,
  test,
  type CanvasHarness
} from "./support/canvas-harness.js";

const RACE_REPETITIONS = 8;

async function seed(canvas: CanvasHarness): Promise<void> {
  await fs.writeFile(
    path.join(canvas.workspacePath, ".radius", "app.bicep"),
    "extension radius\n",
    "utf8"
  );
  await canvas.setScenario(defaultFakeCliScenario());
  await canvas.seedState(baseCanvasState(canvas.workspacePath));
}

async function gotoCanvas(
  page: Page,
  canvas: CanvasHarness,
  canvasPage: string
): Promise<void> {
  await page.goto(`${canvas.baseUrl}/?page=${canvasPage}`);
  await page.waitForLoadState("domcontentloaded");
}

test.describe("P2-B Canvas resilience", () => {
  test("repeated cancellation races never let abandoned graph responses mutate a newer page", async ({
    page,
    canvas
  }) => {
    await seed(canvas);
    const releases: Array<() => void> = [];
    let started = 0;
    await page.route("**/api/load-graph", async (route) => {
      started++;
      await new Promise<void>((resolve) => releases.push(resolve));
      await route.continue();
    });

    for (let index = 0; index < RACE_REPETITIONS; index++) {
      const previousStarted = started;
      await gotoCanvas(page, canvas, "graph");
      await expect.poll(() => started).toBeGreaterThan(previousStarted);

      await gotoCanvas(page, canvas, "credentials");
      for (const release of releases.splice(0)) release();
      await expect(page.locator("#cred-landing")).toBeVisible();
      await expect(page.locator("body")).not.toContainText(
        "Application graph ready"
      );
    }

    await expect(page).toHaveURL(/page=credentials/);
    expect(canvas.externalRequests).toEqual([]);
  });
});
