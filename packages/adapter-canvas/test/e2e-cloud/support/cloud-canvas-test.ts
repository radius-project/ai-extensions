// The Playwright test object for the cloud journey. It gives every test one
// `cloudCanvas` fixture, and the selected host decides what that fixture
// drives:
//
// - "harness" (the default) creates a CanvasHarness per test over this
//   checkout's server and drives it in headless Chromium, as the production
//   workflow has always done.
// - "copilot-app" starts the GitHub Copilot desktop app once per worker and
//   drives the Radius canvas inside it over CDP. The canvas opens only after
//   the modeling test calls `attach()`.
//
// The spec stays one file. Each test asks for `cloudCanvas` and never for
// `page`, so the app host never launches a Chromium that it does not use.

import { test as base } from "@playwright/test";
import { CanvasHarness } from "../../e2e/support/canvas-harness.js";
import { observeCloudDiscovery } from "./cloud-discovery-diagnostics.js";
import {
  CLOUD_CANVAS_HOST_ENV,
  resolveCloudCanvasHost,
  type CloudCanvasHost
} from "./cloud-canvas-host.js";
import {
  test as copilotAppTest,
  type CopilotAppSession
} from "./copilot-app-test.js";
import {
  attachAppState,
  attachRadiusCanvas,
  gotoCanvasPage,
  testInfoSink,
  type AttachedRadiusCanvas,
  type CanvasTarget
} from "./copilot-app-ui.js";
import {
  cloudCanvasState,
  runCleanupSteps
} from "./create-environment-journey.js";

export type CloudCanvasPage =
  "credentials" | "environment" | "deploying" | "graph";

export interface OpenCloudCanvasOptions {
  readonly title: string;
  readonly initialPage: CloudCanvasPage;
  readonly repository: string;
  readonly branch: string;
  readonly workspacePath: string;
}

/** One test's view of the Radius canvas. */
export interface CloudCanvasSession {
  /** The page or frame that renders the canvas. */
  readonly target: CanvasTarget;
  goto(page: CloudCanvasPage): Promise<void>;
  /** Loads the current canvas page again. */
  reload(): Promise<void>;
  cleanup(): Promise<void>;
  guardDiscovery<T>(action: () => Promise<T>): Promise<T>;
}

interface CloudCanvasOpener {
  open(options: OpenCloudCanvasOptions): Promise<CloudCanvasSession>;
}

export interface HarnessCloudCanvas extends CloudCanvasOpener {
  readonly host: "harness";
}

export interface CopilotAppCloudCanvas extends CloudCanvasOpener {
  readonly host: "copilot-app";
  readonly app: CopilotAppSession;
  /** Opens the Radius canvas in the current app session for later tests. */
  attach(): Promise<CanvasTarget>;
}

export type CloudCanvas = HarnessCloudCanvas | CopilotAppCloudCanvas;

interface CloudCanvasFixtures {
  cloudCanvas: CloudCanvas;
}

interface CanvasSlot {
  current: AttachedRadiusCanvas | undefined;
}

export const cloudCanvasHost: CloudCanvasHost = resolveCloudCanvasHost(
  process.env[CLOUD_CANVAS_HOST_ENV]
);

const harnessTest = base.extend<CloudCanvasFixtures>({
  cloudCanvas: async ({ page }, use, testInfo) => {
    const observers: Awaited<ReturnType<typeof observeCloudDiscovery>>[] = [];
    try {
      await use({
        host: "harness",
        async open(options) {
          const harness = await CanvasHarness.create({
            page,
            title: options.title,
            mode: "cloud",
            workspacePath: options.workspacePath,
            initialPage: options.initialPage
          });
          let diagnostics:
            Awaited<ReturnType<typeof observeCloudDiscovery>> | undefined;
          const cleanup = (): Promise<void> =>
            runCleanupSteps([
              {
                label: "save discovery diagnostics",
                run: async () => {
                  await diagnostics?.dispose();
                }
              },
              { label: "clean up Canvas harness", run: () => harness.cleanup() }
            ]);
          try {
            await harness.seedState(
              cloudCanvasState({
                repository: options.repository,
                branch: options.branch,
                workspacePath: options.workspacePath
              })
            );
            diagnostics = await observeCloudDiscovery(page, testInfo, [
              process.env.GH_TOKEN,
              process.env.GITHUB_TOKEN,
              process.env.GH_PACKAGES_TOKEN,
              process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
              process.env.AZURE_CLIENT_SECRET
            ]);
            observers.push(diagnostics);
          } catch (error) {
            await runCleanupSteps(
              [{ label: "clean up Canvas harness", run: cleanup }],
              error
            );
            throw error;
          }
          return {
            target: page,
            guardDiscovery: diagnostics.guard,
            async goto(name) {
              await page.goto(`${harness.baseUrl}/?page=${name}`);
              await page.waitForLoadState("domcontentloaded");
            },
            async reload() {
              await page.reload();
              await page.waitForLoadState("domcontentloaded");
            },
            cleanup
          };
        }
      });
    } finally {
      await runCleanupSteps(
        observers.map((observer) => ({
          label: "save discovery diagnostics",
          run: () => observer.dispose()
        }))
      );
    }
  }
});

const appTest = copilotAppTest.extend<
  CloudCanvasFixtures,
  { radiusCanvasSlot: CanvasSlot }
>({
  radiusCanvasSlot: [
    // Depends on `copilotApp` so the canvas closes before the app stops.
    async ({ copilotApp: _copilotApp }, use) => {
      const slot: CanvasSlot = { current: undefined };
      try {
        await use(slot);
      } finally {
        const attached = slot.current;
        slot.current = undefined;
        await attached?.dispose((message) => console.warn(message));
      }
    },
    { scope: "worker" }
  ],
  cloudCanvas: async ({ copilotApp, radiusCanvasSlot }, use, testInfo) => {
    const observers: Awaited<ReturnType<typeof observeCloudDiscovery>>[] = [];
    try {
      await use({
        host: "copilot-app",
        app: copilotApp,
        async attach() {
          const previous = radiusCanvasSlot.current;
          radiusCanvasSlot.current = undefined;
          await previous?.dispose((message) => console.warn(message));
          radiusCanvasSlot.current = await attachRadiusCanvas(
            copilotApp.browser,
            copilotApp.appPage,
            copilotApp.cdpUrl
          );
          return radiusCanvasSlot.current.target;
        },
        async open(options) {
          const attached = radiusCanvasSlot.current;
          if (!attached)
            throw new Error(
              "The Radius canvas is not open in the Copilot app. The modeling " +
                "test must pass first."
            );
          const target = attached.target;
          const diagnostics = await observeCloudDiscovery(target, testInfo, [
            process.env.GH_TOKEN,
            process.env.GITHUB_TOKEN,
            process.env.GH_PACKAGES_TOKEN,
            process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
            process.env.AZURE_CLIENT_SECRET
          ]);
          observers.push(diagnostics);
          let current = options.initialPage;
          await gotoCanvasPage(target, current);
          return {
            target,
            guardDiscovery: diagnostics.guard,
            async goto(name) {
              current = name;
              await gotoCanvasPage(target, name);
            },
            reload: () => gotoCanvasPage(target, current),
            // The canvas belongs to the worker; the slot closes it.
            cleanup: () => diagnostics.dispose()
          };
        }
      });
    } finally {
      await runCleanupSteps(
        observers.map((observer) => ({
          label: "save discovery diagnostics",
          run: () => observer.dispose()
        }))
      );
    }
    if (testInfo.status === testInfo.expectedStatus) return;
    try {
      await attachAppState(
        copilotApp.appPage,
        "copilot-app",
        testInfoSink(testInfo)
      );
    } catch (error) {
      console.warn(`Could not attach the Copilot app state: ${String(error)}`);
    }
  }
});

export const test = cloudCanvasHost === "copilot-app" ? appTest : harnessTest;

export { expect } from "@playwright/test";
