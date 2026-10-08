import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import {
  countTestAttributes,
  probeCdpEndpoint,
  resolveCdpUrl,
  selectMainPage,
  type TestAttributeCounts
} from "../fixtures/cdp.ts";

// Read-only: attaches over CDP, reads the DOM, and disconnects.

const outputDir = new URL("../output/", import.meta.url);
const outputFile = new URL("a11y-dump.json", outputDir);

async function main(): Promise<void> {
  const cdpUrl = resolveCdpUrl(process.env.COPILOT_APP_CDP_URL);
  const probe = await probeCdpEndpoint(cdpUrl, fetch, 3_000);
  if (!probe.ok) {
    throw new Error(
      `${probe.reason}. Quit the app fully and run scripts/launch-app.ps1 first.`
    );
  }

  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 15_000 });
  try {
    const page = selectMainPage(
      browser.contexts().flatMap((context) => context.pages())
    );
    const ariaSnapshot = await page.locator("body").ariaSnapshot();
    const frames: Array<
      | { url: string; testAttributes: TestAttributeCounts }
      | { url: string; error: string }
    > = [];
    for (const frame of page.frames()) {
      try {
        const attributes = await frame.evaluate(() =>
          Array.from(document.querySelectorAll("*")).flatMap((element) =>
            Array.from(element.attributes)
              .filter((attribute) => attribute.name.startsWith("data-test"))
              .map((attribute) => [attribute.name, attribute.value] as const)
          )
        );
        frames.push({
          url: frame.url(),
          testAttributes: countTestAttributes(attributes)
        });
      } catch (error) {
        // A frame can detach or navigate while we read it; record and go on.
        frames.push({
          url: frame.url(),
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const dump = {
      capturedAt: new Date().toISOString(),
      cdpUrl,
      browser: probe.browser,
      page: { url: page.url(), title: await page.title() },
      ariaSnapshot,
      frames
    };
    await mkdir(outputDir, { recursive: true });
    await writeFile(outputFile, `${JSON.stringify(dump, null, 2)}\n`, "utf8");
    console.log(`Wrote ${fileURLToPath(outputFile)}`);
  } finally {
    // Disconnect only; the Copilot app keeps running.
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
