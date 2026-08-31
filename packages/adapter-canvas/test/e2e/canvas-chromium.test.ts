import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import {
  azureDiscoveryCommands,
  baseCanvasState,
  CREDENTIAL_SENTINEL,
  defaultFakeCliScenario,
  expect,
  PLACEHOLDER_SECRET,
  PROFILE_NAME,
  PROFILE_SUBSCRIPTION_ID,
  REPOSITORY,
  test,
  WORKTREE_BRANCH,
  type CanvasHarness,
  type FakeCliCommand
} from "./support/canvas-harness.js";
import type { Locator, Page } from "@playwright/test";
import { COMMAND_RUN_LABEL } from "../../src/browser/command-action.js";
// Bound to the production constants so the retry cadence is exercised at the
// value the compiled browser bundle actually schedules, not a copy of it.
import { DIFF_RETRY_MS } from "../../src/browser/pages/graph-diff-page.js";
import { GRAPH_RETRY_MS } from "../../src/browser/pages/graph-page.js";
import { PLAN_RETRY_MS } from "../../src/browser/pages/planned-graph-page.js";

const VALID_TENANT_ID = "11111111-1111-1111-1111-111111111111";
const SOURCE_FILE = "src/web/app.ts";
const SOURCE_LINE = 12;
const REMOVED_SOURCE_FILE = "src/web/worker.ts";
const DIFF_BASE_BRANCH = "main";

async function filesContainingText(
  directory: string,
  text: string
): Promise<string[]> {
  const matches: string[] = [];
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(directory, {
      recursive: true,
      withFileTypes: true,
      encoding: "utf8"
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return matches;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(entry.parentPath, entry.name);
    const content = await fs.readFile(filePath);
    if (content.includes(Buffer.from(text))) matches.push(filePath);
  }
  return matches;
}

// The environment-deletion route refuses (409 app-deployed) while an
// application is still deployed to the environment, and only deletes
// Azure-backed environments (it reads AZURE_CLIENT_ID / AZURE_TENANT_ID to plan
// the credential and app-registration cleanup). The default fixture has an
// active deployment (dep-1) and no Azure identity variables, so the deletion
// journeys start from a scenario where the environment has no active app and is
// classified Azure: the two deployment-list lookups the active-app guard runs
// return empty, the environment's variable listing carries the Azure identity,
// and the repository-id lookup the target discovery makes resolves.
async function setScenarioWithoutActiveDeployment(
  canvas: CanvasHarness
): Promise<void> {
  const argsOf = (command: FakeCliCommand): string[] => command.args ?? [];
  await canvas.setScenarioOverrides(
    defaultFakeCliScenario(),
    [
      (command) => {
        const listsEnvironmentDeployments =
          command.tool === "gh" &&
          argsOf(command).some(
            (arg) =>
              arg.includes("/deployments?") &&
              arg.includes("environment=fixture-environment")
          );
        if (listsEnvironmentDeployments) return { ...command, stdout: "" };
        return command;
      },
      (command) => {
        const listsEnvironmentVariablesWithValues =
          command.tool === "gh" &&
          argsOf(command).some((arg) =>
            arg.includes("/environments/fixture-environment/variables")
          ) &&
          argsOf(command).some((arg) => arg.includes(".value"));
        if (!listsEnvironmentVariablesWithValues) return command;
        return {
          ...command,
          stdout: [
            command.stdout ?? "",
            "AZURE_CLIENT_ID\tfixture-client-id",
            "AZURE_TENANT_ID\tfixture-tenant-id"
          ]
            .filter((line) => line.length > 0)
            .join("\n")
        };
      }
    ],
    [
      {
        tool: "gh",
        args: ["api", `/repos/${REPOSITORY}`, "--jq", ".id"],
        stdout: "101\n"
      }
    ]
  );
}

async function waitForOperationState(
  page: Page,
  operationId: string,
  state: string
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const response = await fetch(`/api/operations/${id}`);
        const payload = (await response.json()) as {
          operation?: { state?: string };
        };
        return payload.operation?.state;
      }, operationId)
    )
    .toBe(state);
}

async function seed(canvas: CanvasHarness): Promise<void> {
  await fs.mkdir(path.join(canvas.workspacePath, "src", "web"), {
    recursive: true
  });
  await fs.writeFile(
    path.join(canvas.workspacePath, SOURCE_FILE),
    `${"// fixture source\n".repeat(SOURCE_LINE + 2)}`,
    "utf8"
  );
  await fs.writeFile(
    path.join(canvas.workspacePath, ".radius", "app.bicep"),
    [
      "extension radius",
      "",
      "resource app 'Applications.Core/applications@2023-10-01-preview' = {",
      "  name: 'radius-app'",
      "}"
    ].join("\n"),
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

async function expectNoWcagViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target.join(" "))
    }))
  ).toEqual([]);
}

async function expectVerticallyAligned(
  first: Locator,
  second: Locator
): Promise<void> {
  const firstBox = await first.boundingBox();
  const secondBox = await second.boundingBox();
  if (firstBox === null || secondBox === null) {
    throw new Error("Expected both elements to have layout boxes.");
  }
  expect(
    Math.abs(
      firstBox.y + firstBox.height / 2 - (secondBox.y + secondBox.height / 2)
    )
  ).toBeLessThanOrEqual(1);
}

function bodyFor(canvas: CanvasHarness, pathName: string): unknown {
  return canvas.requests.find(
    (request) => request.method === "POST" && request.path === pathName
  )?.body;
}

async function routeDeployedPage(
  page: Page,
  deploymentStatus: () => string,
  abandon?: (body: unknown, nonce: string) => void
): Promise<void> {
  await page.route("**/api/list-applications**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ applications: [{ name: "radius-app" }] })
    });
  });
  await page.route("**/api/list-environments**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        environments: [
          {
            name: "fixture-environment",
            provider: "azure",
            status: "success"
          }
        ]
      })
    });
  });
  await page.route("**/api/list-deployments**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        deployments: [
          {
            app: "radius-app",
            environment: "fixture-environment",
            status: deploymentStatus()
          }
        ]
      })
    });
  });
  await page.route("**/api/deployed-graph**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ resources: [], mode: "greyed" })
    });
  });
  await page.route("**/api/deploy-status**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "pending", logTotal: 0 })
    });
  });
  await page.route("**/api/abandon-deployment", async (route) => {
    abandon?.(
      route.request().postDataJSON(),
      route.request().headers()["x-radius-mutation-nonce"] ?? ""
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ outcome: "abandoned" })
    });
  });
}

// Environment creation is a two-step wizard: step 1 picks the cloud credential
// profile, step 2 holds the environment name and the GitHub identity block.
// Step 2 is hidden until a profile is chosen, so any journey that asserts on
// step 2 has to pass through step 1 first. Driven entirely by keyboard, so this
// also exercises the credential-selection listbox rather than skipping it.
async function openEnvironmentWizard(page: Page): Promise<void> {
  const newEnvironment = page.locator("#new-env-btn");
  await newEnvironment.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#env-form")).toBeVisible();

  // The wizard hands focus to the profile control, since that is the only
  // decision available on step 1.
  const profile = page.locator("#env-profile-button");
  await expect(profile).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(profile).toHaveAttribute("aria-expanded", "true");

  const option = page
    .locator("#env-profile-menu")
    .getByRole("option", { name: new RegExp(PROFILE_NAME) });
  await option.focus();
  await page.keyboard.press("Enter");
  await expect(profile).toBeFocused();

  const next = page.locator("#env-step1-next");
  await expect(next).toBeEnabled();
  await next.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#env-step-details")).toBeVisible();
}

test.describe("Radius Canvas in Chromium", () => {
  test.beforeEach(async ({ canvas }) => {
    await seed(canvas);
  });

  test("deletes an Azure environment through the tracked operation and keeps a dismissed panel gone across a reload @safety", async ({
    page,
    canvas
  }) => {
    await setScenarioWithoutActiveDeployment(canvas);
    // Drive the real delete OperationRecord to a clean terminal exactly as the
    // production runner does (environment-deletion.ts): walk every delete stage
    // to succeeded and finish the operation. The server owns the record for the
    // life of the process, so its settled state — and the dismissal recorded
    // against it — is what a reload re-fetches, rather than the browser
    // re-deriving it.
    const deletion = canvas.driveEnvironmentDeletion({ state: "succeeded" });

    await gotoCanvas(page, canvas, "environment");
    const deleteEnvironment = page.locator(".js-delete-env").first();
    await expect(deleteEnvironment).toBeVisible();
    await deleteEnvironment.click();

    // The destructive confirm dialog is the pre-existing environment confirm
    // modal driven with the deletion copy.
    const confirmTitle = page.locator("#env-confirm-title");
    await expect(confirmTitle).toHaveText("Delete environment?");
    const deleteAccepted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/delete-environment" &&
        response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Delete environment" }).click();
    const { operationId } = (await (await deleteAccepted).json()) as {
      operationId: string;
    };
    expect(operationId).toMatch(/^op_/);

    const panel = page.locator("#env-progress-panel");
    await expect(panel).toBeVisible();
    await expect(page.locator("#env-progress-activity")).toHaveAttribute(
      "aria-live",
      "polite"
    );

    await waitForOperationState(page, operationId, "running");
    await deletion.release();

    // A clean Azure deletion acknowledges through the shared confirm dialog.
    // The settled operation remains until the progress panel is dismissed.
    await expect(confirmTitle).toHaveText("Environment deleted");
    await expectNoWcagViolations(page);
    const done = page.getByRole("button", { name: "Done" });
    await expect(done).toBeFocused();
    await done.click();
    const dismissRequest = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith("/dismiss") &&
        response.request().method() === "POST"
    );
    await page.locator("#env-progress-dismiss").click();
    // The dismissal must target the very operation the delete route created, not
    // merely some `/dismiss` POST, or a stray dismissal would pass this assertion.
    const dismissal = await dismissRequest;
    expect(new URL(dismissal.url()).pathname).toBe(
      `/api/operations/${operationId}/dismiss`
    );
    await expect(panel).toBeHidden();

    // The key server round trip: the dismissal was recorded against the record,
    // so the panel does NOT reappear when the environments page is revisited.
    // jsdom cannot prove this because it never reloads against the real server.
    await gotoCanvas(page, canvas, "environment");
    await expect(page.locator(".js-delete-env").first()).toBeVisible();
    await expect(page.locator("#env-progress-panel")).toBeHidden();
  });

  test("surfaces a partial deletion failure with the Retry deletion action @safety", async ({
    page,
    canvas
  }) => {
    await setScenarioWithoutActiveDeployment(canvas);
    // Drive the delete operation to failed_partial with the first stage failed,
    // mirroring environment-deletion.ts: a terminal partial failure keeps the
    // completed stages recorded and offers a resume rather than restarting.
    const deletion = canvas.driveEnvironmentDeletion({
      state: "failed_partial",
      failure: {
        code: "radius-env-delete-failed",
        stepSeq: null,
        message:
          "Radius could not confirm the environment was deleted from the cluster.",
        classification: "user-fixable",
        evidence: null
      }
    });

    await gotoCanvas(page, canvas, "environment");
    await page.locator(".js-delete-env").first().click();
    const deleteAccepted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/delete-environment" &&
        response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Delete environment" }).click();
    const { operationId } = (await (await deleteAccepted).json()) as {
      operationId: string;
    };

    const panel = page.locator("#env-progress-panel");
    await expect(panel).toBeVisible();
    await waitForOperationState(page, operationId, "running");
    await deletion.release();
    await expect(panel).toContainText(
      "Deletion stopped before all stages completed. Completed stages remain recorded and will not be repeated."
    );
    const retry = panel.getByRole("button", { name: "Retry deletion" });
    await expect(retry).toBeVisible();

    const resumedDeletion = canvas.driveEnvironmentDeletion({
      state: "succeeded"
    });
    const retryAccepted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/operations/${operationId}/retry/deletion` &&
        response.request().method() === "POST"
    );
    await retry.click();
    expect((await retryAccepted).status()).toBe(202);
    await waitForOperationState(page, operationId, "running");
    await resumedDeletion.release();
    await waitForOperationState(page, operationId, "succeeded");
    await expect(retry).toBeHidden();
    await expect(page.locator("#env-progress-dismiss")).toBeVisible();
  });

  test("refuses to delete an environment that still has a deployed application @safety", async ({
    page,
    canvas
  }) => {
    // The default fixture keeps an active deployment, so the delete route's
    // active-app guard (routes/environments.ts) answers 409 app-deployed and
    // nothing is scheduled. The browser converts that refusal into a redirect
    // prompt instead of opening the progress panel.
    await canvas.setScenario(defaultFakeCliScenario());
    const refusal = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/delete-environment" &&
        response.request().method() === "POST"
    );

    await gotoCanvas(page, canvas, "environment");
    await page.locator(".js-delete-env").first().click();
    const confirmTitle = page.locator("#env-confirm-title");
    await expect(confirmTitle).toHaveText("Delete environment?");
    await page.getByRole("button", { name: "Delete environment" }).click();

    expect((await refusal).status()).toBe(409);
    await expect(confirmTitle).toHaveText("Delete the application first");
    await expect(
      page.getByRole("button", { name: "Go to Deployments" })
    ).toBeVisible();
    // No tracked deletion was started: the guard ran before any operation.
    await expect(page.locator("#env-progress-panel")).toBeHidden();
  });

  test("does not expose a pre-existing credential cache in browser state, requests, logs, or artifacts @safety", async ({
    page,
    canvas
  }, testInfo) => {
    await gotoCanvas(page, canvas, "credentials");

    await expect(page.locator("body")).not.toContainText(CREDENTIAL_SENTINEL);
    await expect(
      page.locator("#cred-table-body").getByText(PROFILE_NAME)
    ).toBeVisible();
    await expect(page.locator("#cred-table-body")).not.toContainText(
      CREDENTIAL_SENTINEL
    );
    expect(JSON.stringify(canvas.requests)).not.toContain(CREDENTIAL_SENTINEL);
    expect(JSON.stringify(await canvas.cliCalls())).not.toContain(
      CREDENTIAL_SENTINEL
    );
    expect(
      await filesContainingText(canvas.rootDir, CREDENTIAL_SENTINEL)
    ).toEqual([]);
    expect(
      await filesContainingText(testInfo.outputDir, CREDENTIAL_SENTINEL)
    ).toEqual([]);
  });

  test("loads graph data through the real route table and keeps the worktree branch in the request body @safety", async ({
    page,
    canvas
  }) => {
    await gotoCanvas(page, canvas, "graph");

    await expect(page.getByLabel("Branch")).toHaveValue(WORKTREE_BRANCH);
    await page.getByRole("button", { name: "Plan Deployment" }).focus();
    await page.getByLabel("Branch").selectOption(WORKTREE_BRANCH);
    await expect
      .poll(() =>
        canvas.requests.some(
          (request) =>
            request.method === "POST" && request.path === "/api/load-graph"
        )
      )
      .toBe(true);
    expect(bodyFor(canvas, "/api/load-graph")).toEqual({
      repo: REPOSITORY,
      branch: WORKTREE_BRANCH,
      restartWait: true
    });
    await expect
      .poll(async () =>
        (await canvas.cliCalls()).some(
          (call) => call.tool === "rad" && call.args[0] === "app"
        )
      )
      .toBe(true);
    await expect(page.locator(".rad-node")).toHaveCount(3);
    await expect(page.locator(".rad-node__title")).toHaveText([
      "web",
      "demo-cluster",
      "db"
    ]);
  });

  test("keeps the document canvas dark while navigating between top-level panes", async ({
    page,
    canvas
  }) => {
    await gotoCanvas(page, canvas, "graph");
    await page.evaluate(`
      document.documentElement.style.setProperty("--color-scheme", "dark");
      document.documentElement.style.setProperty(
        "--background-color-default",
        "#0d1117"
      );
      document.documentElement.style.setProperty(
        "--text-color-default",
        "#e6edf3"
      );
    `);
    let documentNavigations = 0;
    page.on("request", (request) => {
      if (request.isNavigationRequest()) documentNavigations += 1;
    });
    let environmentRequests = 0;
    let releaseEnvironment = (): void => undefined;
    const environmentGate = new Promise<void>((resolve) => {
      releaseEnvironment = resolve;
    });
    const environmentRoute = /\/\?page=environment$/;
    await page.route(environmentRoute, async (route) => {
      environmentRequests += 1;
      await environmentGate;
      if (route.request().failure() === null) await route.continue();
    });

    try {
      await page.evaluate(`
        document.querySelector('a[href="/?page=environment"]').click();
      `);
      await expect.poll(() => environmentRequests).toBe(1);
      // The outgoing pane stays mounted while the request is in flight, so the
      // webview never unloads and exposes the host surface.
      await expect(page.locator("#radius-main-content")).toHaveAttribute(
        "aria-busy",
        "true"
      );
      await expect(page.locator("#graph-page-content")).toBeVisible();
      await expect(page.locator("#env-subtabs")).toHaveCount(0);
      await page.evaluate(`
        document.querySelector('a[href="/?page=deploying"]').click();
      `);
      await expect(page).toHaveURL(/page=deploying/);
      await expect(page.locator("#deploy-table-body")).toBeVisible();
    } finally {
      releaseEnvironment();
    }
    await page.unroute(environmentRoute);

    const panes = [
      ["environment", "Environments"],
      ["deploying", "Deployments"],
      ["graph", "Applications"]
    ] as const;

    for (const [canvasPage, linkName] of panes) {
      await page.getByRole("link", { name: linkName }).click();
      await expect(page).toHaveURL(new RegExp(`page=${canvasPage}`));
      await expect(page.locator("html")).toHaveCSS(
        "background-color",
        "rgb(13, 17, 23)"
      );
      await expect(page.locator("body")).toHaveCSS(
        "background-color",
        "rgb(13, 17, 23)"
      );
    }
    const backPanes = [
      ["deploying", "#deploy-table-body"],
      ["environment", "#env-subtabs"],
      ["deploying", "#deploy-table-body"],
      ["graph", "#graph-page-content"]
    ] as const;
    for (const [canvasPage, selector] of backPanes) {
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`page=${canvasPage}`));
      await expect(page.locator(selector)).toBeVisible();
      await expect(page.locator("html")).toHaveCSS(
        "background-color",
        "rgb(13, 17, 23)"
      );
    }
    expect(documentNavigations).toBe(0);
  });

  test("swaps sub-tabs in place and preserves keyboard-only graph focus", async ({
    page,
    canvas
  }) => {
    await gotoCanvas(page, canvas, "graph");
    let documentNavigations = 0;
    page.on("request", (request) => {
      if (request.isNavigationRequest()) documentNavigations += 1;
    });

    await page.getByRole("link", { name: "Environments" }).first().click();
    await expect(page.locator("#env-subtabs")).toBeVisible();
    await expect(page).toHaveTitle(/Environments/);

    const subtabs = page.locator("#env-subtabs");
    await subtabs.getByRole("link", { name: "Credentials" }).click();
    await expect(page).toHaveURL(/page=credentials/);
    await expect(page.locator("#cred-table-body")).toBeVisible();
    await expect(subtabs.locator("a.rad-subtab--active")).toHaveText(
      "Credentials"
    );
    await expect(page.locator("#graph-page-content")).toHaveCount(0);

    await page.getByRole("link", { name: "Applications" }).click();
    await expect(page.locator("#graph-nav")).toBeVisible();

    // Graph sub-tabs carry data-radius-graph-page and stay owned by the graph
    // navigator, so pane navigation must not also handle the click.
    const planned = page.locator(
      '#graph-nav a[data-radius-graph-page="planned"]'
    );
    await planned.click();
    await expect(page).toHaveURL(/page=planned/);
    await expect(page.locator("#graph-page-content")).toBeVisible();
    await expect(page.locator("#graph-nav a.rad-subtab--active")).toHaveText(
      "Planned"
    );
    await expect(planned).not.toBeFocused();

    const modeled = page.locator(
      '#graph-nav a[data-radius-graph-page="graph"]'
    );
    await modeled.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/page=graph/);
    await expect(modeled).toBeFocused();

    expect(documentNavigations).toBe(0);
  });

  test("ignores a click on the pane already on screen", async ({
    page,
    canvas
  }) => {
    await gotoCanvas(page, canvas, "graph");
    let documentNavigations = 0;
    page.on("request", (request) => {
      if (request.isNavigationRequest()) documentNavigations += 1;
    });

    await page.getByRole("link", { name: "Environments" }).first().click();
    await expect(page.locator("#env-subtabs")).toBeVisible();
    const paneRequests = () =>
      canvas.requests.filter((request) => request.path.includes("environment"))
        .length;
    const before = paneRequests();

    await page.getByRole("link", { name: "Environments" }).first().click();
    await expect(page).toHaveURL(/page=environment/);
    await expect(page.locator("#radius-main-content")).not.toHaveAttribute(
      "aria-busy",
      "true"
    );
    expect(paneRequests()).toBe(before);

    // The skipped click pushed no history entry, so Back lands on the graph.
    await page.goBack();
    await expect(page).toHaveURL(/page=graph/);
    await expect(page.locator("#graph-page-content")).toBeVisible();
    expect(documentNavigations).toBe(0);
  });

  test("opens node details from the card by keyboard and returns focus when the panel closes", async ({
    page,
    canvas
  }) => {
    await gotoCanvas(page, canvas, "graph");
    await page.selectOption("#graph-branch", WORKTREE_BRANCH);
    await expect(page.locator(".rad-node")).toHaveCount(3);

    const panel = page.locator("#node-popup");
    await expect(panel).toBeHidden();

    const webCard = page
      .locator(".rad-node")
      .filter({ hasText: "web" })
      .first();
    const details = webCard.getByRole("button", { name: "Show details" });
    await details.focus();
    await expect(details).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(panel).toBeVisible();
    await expect(
      panel.getByRole("link", { name: "View source code" })
    ).toHaveCount(1);
    await expect(
      panel.getByRole("link", { name: "demo-cluster in Azure portal" })
    ).toHaveAttribute("href", /portal\.azure\.com/);
    await expect(details).toBeFocused();

    // Clicking the empty pane closes the panel and hands focus back to the
    // control the keyboard user opened it from.
    await page.locator("#graph-container").click({ position: { x: 4, y: 4 } });
    await expect(panel).toBeHidden();
    await expect(details).toBeFocused();
    await expectNoWcagViolations(page);
  });

  test("opens a node source reference through the real open-source route instead of leaving the workspace @safety", async ({
    page,
    canvas
  }) => {
    await gotoCanvas(page, canvas, "graph");
    await page.selectOption("#graph-branch", WORKTREE_BRANCH);
    await expect(page.locator(".rad-node")).toHaveCount(3);

    const webCard = page
      .locator(".rad-node")
      .filter({ hasText: "web" })
      .first();
    const sourceLink = webCard.getByRole("link", { name: "View source code" });
    await expect(sourceLink).toHaveAttribute(
      "href",
      `https://github.com/${REPOSITORY}/blob/${WORKTREE_BRANCH}/${SOURCE_FILE}#L${SOURCE_LINE}`
    );

    await sourceLink.focus();
    await expect(sourceLink).toBeFocused();
    await page.keyboard.press("Enter");

    await expect
      .poll(() => bodyFor(canvas, "/api/open-source"))
      .toEqual({ path: SOURCE_FILE, line: SOURCE_LINE });
    // The click is handled in-canvas, so the page must not navigate away.
    await expect(page.locator(".rad-node")).toHaveCount(3);
  });

  test("routes each graph diff source link by the branch that node lives on @safety", async ({
    page,
    canvas
  }) => {
    // The worktree is checked out on the head branch, so a head-side node must
    // reach the real open-source route while a removed node -- whose file lives
    // on the base branch and may not exist locally at all -- stays external.
    await canvas.seedState({
      ...baseCanvasState(canvas.workspacePath),
      diffTargetRepo: REPOSITORY,
      diffBase: DIFF_BASE_BRANCH,
      diffHead: WORKTREE_BRANCH,
      branches: [DIFF_BASE_BRANCH, WORKTREE_BRANCH],
      diffResources: [
        {
          id: "app/web",
          name: "web",
          type: "Radius.Compute/containers",
          codeReference: `${SOURCE_FILE}#L${SOURCE_LINE}`,
          diffStatus: "added"
        },
        {
          id: "app/old-worker",
          name: "old-worker",
          type: "Radius.Compute/containers",
          codeReference: `${REMOVED_SOURCE_FILE}#L${SOURCE_LINE}`,
          diffStatus: "removed"
        }
      ]
    });
    await gotoCanvas(page, canvas, "graph-diff");
    await expect(page.locator(".rad-node")).toHaveCount(2);

    const removedLink = page
      .locator(".rad-node")
      .filter({ hasText: "old-worker" })
      .first()
      .getByRole("link", { name: "View source code" });
    await expect(removedLink).toHaveAttribute(
      "href",
      `https://github.com/${REPOSITORY}/blob/${DIFF_BASE_BRANCH}/${REMOVED_SOURCE_FILE}#L${SOURCE_LINE}`
    );
    // A remote link is a real target="_blank" anchor the host opens.
    await expect(removedLink).toHaveAttribute("target", "_blank");

    const headLink = page
      .locator(".rad-node")
      .filter({ hasText: "web" })
      .first()
      .getByRole("link", { name: "View source code" });
    await expect(headLink).not.toHaveAttribute("target", "_blank");

    // Activating the remote link is deliberately not exercised here: it is a real
    // target="_blank" anchor, so the host would open github.com and the harness
    // must stay offline. The component suite clicks it against the real DOM and
    // asserts it reaches openExternal rather than the workspace opener.
    expect(bodyFor(canvas, "/api/open-source")).toBeUndefined();

    await headLink.focus();
    await expect(headLink).toBeFocused();
    await page.keyboard.press("Enter");

    await expect
      .poll(() => bodyFor(canvas, "/api/open-source"))
      .toEqual({ path: SOURCE_FILE, line: SOURCE_LINE });
    await expect(page.locator(".rad-node")).toHaveCount(2);
  });

  test("does not let a late real graph response mutate a page that was already torn down @safety", async ({
    page,
    canvas
  }) => {
    const releaseResponse: { current: (() => void) | null } = { current: null };
    let requestStarted = false;
    await page.route("**/api/load-graph", async (route) => {
      requestStarted = true;
      await new Promise<void>((resolve) => {
        releaseResponse.current = resolve;
      });

      await route.continue();
    });

    await gotoCanvas(page, canvas, "graph");
    await page.getByLabel("Branch").selectOption(WORKTREE_BRANCH);
    await expect.poll(() => requestStarted).toBe(true);

    await gotoCanvas(page, canvas, "credentials");
    const releaseLateGraphResponse = releaseResponse.current;
    if (releaseLateGraphResponse) releaseLateGraphResponse();

    await expect(page).toHaveURL(/page=credentials/);
    await expect(page.locator("#cred-landing")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(
      "Application graph ready"
    );
  });

  test("cancels an in-flight graph when the branch selection changes @safety", async ({
    page,
    canvas
  }) => {
    let releaseFirst: (() => void) | undefined;
    const branches: string[] = [];
    await page.route("**/api/load-graph", async (route) => {
      const body = route.request().postDataJSON() as { branch?: string };
      branches.push(body.branch || "");
      if (branches.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        await route.abort().catch(() => undefined);
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ resources: [] })
      });
    });

    await gotoCanvas(page, canvas, "graph");
    await expect.poll(() => branches).toEqual([WORKTREE_BRANCH]);
    await page.getByLabel("Branch").selectOption("release");

    await expect.poll(() => branches).toEqual([WORKTREE_BRANCH, "release"]);
    await expect(
      page.locator("#graph-status, #graph-refresh-status")
    ).toContainText("Application graph ready");
    releaseFirst?.();
  });

  test("keeps the modeling status stable while the graph automatically polls", async ({
    page,
    canvas
  }) => {
    await page.clock.install();
    let requests = 0;
    let releaseRetry: (() => void) | undefined;
    await page.route("**/api/load-graph", async (route) => {
      requests++;
      if (requests > 1) {
        await new Promise<void>((resolve) => {
          releaseRetry = resolve;
        });
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ needsAppBicep: true })
      });
    });

    await gotoCanvas(page, canvas, "graph");
    const status = page.locator("#graph-status, #graph-refresh-status");
    await expect(status).toContainText(
      "Copilot is generating .radius/app.bicep"
    );
    const stableMessage = await status.textContent();

    await page.clock.fastForward(10_000);
    await expect.poll(() => requests).toBe(2);
    await expect(status).toHaveText(stableMessage ?? "");

    releaseRetry?.();
  });

  // The Modeled poll above proves `/api/load-graph` retries. Planned and Diff
  // each schedule their own retry from their own compiled entry bundle, so
  // neither is covered by that test: a broken timer or a mis-read payload in
  // either bundle would ship green. These two journeys close that gap by
  // driving the real browser code through wait, retry, and recovery.
  test("retries the planned graph in the real browser until the model appears", async ({
    page,
    canvas
  }) => {
    await page.clock.install();
    let requests = 0;
    await page.route("**/api/plan-graph", async (route) => {
      requests++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        // The retry must observe a changed answer, so the second reply reports
        // a current model rather than repeating the wait.
        body: JSON.stringify(
          requests === 1 ? { needsAppBicep: true } : { refreshed: true }
        )
      });
    });

    await gotoCanvas(page, canvas, "planned");
    const status = page.locator("#plan-status");
    await expect(status).toContainText(
      "Copilot is generating .radius/app.bicep"
    );

    // Nothing announces the model's arrival, so only the scheduled retry can
    // move the page off the wait.
    await page.clock.fastForward(PLAN_RETRY_MS);
    await expect.poll(() => requests).toBe(2);
    await expect(status).toContainText("The planned deployment is current.");
  });

  test("retries the graph diff in the real browser until the model appears", async ({
    page,
    canvas
  }) => {
    await page.clock.install();
    let requests = 0;
    await page.route("**/api/diff-branches", async (route) => {
      requests++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          requests === 1 ? { needsAppBicep: true } : { refreshed: true }
        )
      });
    });

    await gotoCanvas(page, canvas, "graph-diff");
    const status = page.locator("#diff-status");
    await expect(status).toContainText(
      "Copilot is generating .radius/app.bicep"
    );

    await page.clock.fastForward(DIFF_RETRY_MS);
    await expect.poll(() => requests).toBe(2);
    await expect(status).toContainText("The graph comparison is current.");
  });

  test("stops the modeled graph after a terminal modeling refusal @safety", async ({
    page,
    canvas
  }) => {
    await canvas.seedState({
      ...baseCanvasState(canvas.workspacePath),
      graphLoaded: true,
      graphResources: [{ id: "app/web" }]
    });
    await page.clock.install();
    let requests = 0;
    const refusal = `${REPOSITORY} has no Dockerfile on ${WORKTREE_BRANCH}.`;
    await page.route("**/api/load-graph", async (route) => {
      requests++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          appBicepUnsupported: true,
          error: refusal
        })
      });
    });

    await gotoCanvas(page, canvas, "graph");

    await expect(page.locator("#graph-container .status.error")).toHaveText(
      `Unable to refresh the application graph: ${refusal}`
    );
    await expect(
      page.locator("#graph-container .status.error")
    ).toHaveAttribute("role", "alert");
    await expect(page.locator("#graph-refresh-status")).toBeHidden();
    await expect(page.locator("#graph-guidance")).toBeHidden();
    await expect(page.locator("#deploy-app-btn")).toBeDisabled();
    await expect(page.locator("#progress-steps")).toHaveCount(0);
    await page.clock.fastForward(GRAPH_RETRY_MS * 2);
    expect(requests).toBe(1);
  });

  test("clears active modeled progress when a terminal refusal arrives @safety", async ({
    page,
    canvas
  }) => {
    await page.clock.install();
    let releaseRefusal!: () => void;
    const refusalGate = new Promise<void>((resolve) => {
      releaseRefusal = resolve;
    });
    let reportRequestReached!: () => void;
    const requestReached = new Promise<void>((resolve) => {
      reportRequestReached = resolve;
    });
    await page.route("**/api/load-graph", async (route) => {
      reportRequestReached();
      await refusalGate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          appBicepUnsupported: true,
          error: `${REPOSITORY} has no Dockerfile on ${WORKTREE_BRANCH}.`
        })
      });
    });

    await gotoCanvas(page, canvas, "graph");
    await requestReached;
    await expect(page.locator("#graph-status")).toBeVisible();
    await expect(page.locator("#progress-steps")).toBeVisible();
    await expect(page.locator("#progress-steps")).toContainText(
      "Check for an application model"
    );

    releaseRefusal();
    await expect(page.locator("#graph-container .status.error")).toBeVisible();
    await expect(page.locator("#graph-status")).toBeHidden();
    await expect(page.locator("#progress-steps")).toHaveCount(0);
  });

  test("stops the planned graph after a terminal modeling refusal @safety", async ({
    page,
    canvas
  }) => {
    await page.clock.install();
    let requests = 0;
    const refusal = `${REPOSITORY} has no Dockerfile on ${WORKTREE_BRANCH}.`;
    await page.route("**/api/plan-graph", async (route) => {
      requests++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          appBicepUnsupported: true,
          error: refusal
        })
      });
    });

    await gotoCanvas(page, canvas, "planned");

    await expect(page.locator("#graph-container .status.error")).toHaveText(
      refusal
    );
    await expect(page.locator("#plan-status")).toBeHidden();
    await expect(page.locator("#plan-btn")).toBeDisabled();
    await expect(page.locator("#progress-steps")).toHaveCount(0);
    await page.clock.fastForward(PLAN_RETRY_MS * 2);
    expect(requests).toBe(1);
  });

  test("stops the graph diff and hides stale summaries after a terminal modeling refusal @safety", async ({
    page,
    canvas
  }) => {
    await canvas.seedState({
      ...baseCanvasState(canvas.workspacePath),
      diffTargetRepo: REPOSITORY,
      diffBase: DIFF_BASE_BRANCH,
      diffHead: WORKTREE_BRANCH,
      diffResources: [{ id: "app/web", diffStatus: "unchanged" }],
      branches: [DIFF_BASE_BRANCH, WORKTREE_BRANCH]
    });
    await page.clock.install();
    let requests = 0;
    const refusal = `${REPOSITORY} has no Dockerfile on ${WORKTREE_BRANCH}.`;
    await page.route("**/api/diff-branches", async (route) => {
      requests++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          appBicepUnsupported: true,
          error: refusal
        })
      });
    });

    await gotoCanvas(page, canvas, "graph-diff");

    await expect(page.locator("#graph-container .status.error")).toHaveText(
      refusal
    );
    await expect(page.locator("#diff-status")).toBeHidden();
    await expect(page.locator("#graph-diff-summary")).toBeHidden();
    await expect(page.locator("#diff-progress-steps")).toBeEmpty();
    await page.clock.fastForward(DIFF_RETRY_MS * 2);
    expect(requests).toBe(1);
  });

  // A retry that re-armed the expired wait would loop forever, so the request
  // that follows the wait must not ask the server to restart it.
  test("does not restart an expired model wait from a diff retry @safety", async ({
    page,
    canvas
  }) => {
    await page.clock.install();
    const restartFlags: unknown[] = [];
    await page.route("**/api/diff-branches", async (route) => {
      const body = route.request().postDataJSON() as { restartWait?: unknown };
      restartFlags.push(body.restartWait);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ needsAppBicep: true })
      });
    });

    await gotoCanvas(page, canvas, "graph-diff");
    await expect.poll(() => restartFlags.length).toBe(1);

    await page.clock.fastForward(DIFF_RETRY_MS);
    await expect.poll(() => restartFlags.length).toBe(2);
    expect(restartFlags).toEqual([true, false]);
  });

  test("reports GitHub account mismatch accessibly without leaking raw CLI output @safety", async ({
    page,
    canvas
  }) => {
    await canvas.seedState({
      ...baseCanvasState(canvas.workspacePath),
      ghCommandPresentation: {
        kind: "absolute",
        shell: "posix",
        executablePath: "/opt/Copilot Tools/gh",
        installationNote: "Install GitHub CLI system-wide."
      }
    });
    // No account can supply the workflow scope, so the injected token stays in
    // effect and the acting account is the one the warning must name.
    await canvas.setGitHubKeyringScopes(["repo"]);
    await gotoCanvas(page, canvas, "environment");
    await openEnvironmentWizard(page);

    const note = page.locator("#env-gh-identity-note");
    await expect(note).toBeVisible();
    await expect(note).toContainText("Additional GitHub access is required");
    await expect(page.locator("#env-gh-technical-details")).toContainText(
      "workflow: missing"
    );
    await expect(page.locator("#env-gh-technical-details")).toContainText(
      "packages: missing"
    );
    await expect(page.locator("body")).not.toContainText(PLACEHOLDER_SECRET);
    await expect(page.locator("#env-gh-account-button")).toHaveAccessibleName(
      "@acting-user"
    );
    await expectNoWcagViolations(page);

    // The fix is offered directly, not tucked inside the technical-details
    // disclosure, and it is reachable by keyboard.
    const repair = page.locator("#env-gh-repair");
    await expect(repair).toBeVisible();
    await expect(repair).toContainText("'/opt/Copilot Tools/gh' auth switch");
    await expect(note).toContainText("Install GitHub CLI system-wide.");
    const runButton = repair.getByRole("button", { name: COMMAND_RUN_LABEL });
    await expect(repair.getByRole("button", { name: "Copy" })).toBeVisible();
    await runButton.focus();
    await expect(runButton).toBeFocused();
    await canvas.expectCliInvoked("gh");
  });

  test("surfaces escaped server errors when environment loading fails @safety", async ({
    page,
    canvas
  }) => {
    await page.route("**/api/list-environments**", async (route) => {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Repository <strong>administrator access</strong> is required."
        })
      });
    });

    await gotoCanvas(page, canvas, "environment");

    const table = page.locator("#env-table-body");
    await expect(table).toContainText(
      "Repository <strong>administrator access</strong> is required."
    );
    await expect(table.locator("strong")).toHaveCount(0);
    await expectNoWcagViolations(page);
  });

  test("plans a deployment for an existing environment from its row", async ({
    page,
    canvas
  }) => {
    await page.route("**/api/list-environments**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          environments: [
            {
              name: "fixture-environment",
              provider: "azure",
              status: "success"
            }
          ]
        })
      });
    });
    await gotoCanvas(page, canvas, "environment");

    const row = page
      .getByRole("row")
      .filter({ hasText: "fixture-environment" });
    const plan = row.getByRole("button", { name: "Plan Deployment" });
    await expect(plan).toBeVisible();
    await expect(row.getByRole("button", { name: "Deploy Apps" })).toHaveCount(
      0
    );
    await expectNoWcagViolations(page);

    await plan.focus();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/page=planned&env=fixture-environment(?:&|$)/);
    await expect(page.locator("#planned-env")).toHaveValue(
      "fixture-environment"
    );
  });

  test("recovers from the scope warning when Re-check is activated by keyboard", async ({
    page,
    canvas
  }) => {
    await canvas.setGitHubKeyringScopes(["repo"]);
    await gotoCanvas(page, canvas, "environment");
    await openEnvironmentWizard(page);

    const note = page.locator("#env-gh-identity-note");
    const recheck = page.getByRole("button", { name: "Re-check" });
    await expect(note).toContainText("Additional GitHub access is required");
    await expect(recheck).toBeVisible();

    // The keyring account now carries the scopes setup needs.
    await canvas.setGitHubKeyringScopes(["repo", "workflow", "write:packages"]);
    await recheck.focus();
    await expect(recheck).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(note).toContainText("Ready to configure deployments");
    await expect(recheck).toBeVisible();
    await expect(page.locator("body")).not.toContainText(PLACEHOLDER_SECRET);
    await expectNoWcagViolations(page);
  });

  test("checks GitHub accounts through the real listbox and returns focus to the combo", async ({
    page,
    canvas
  }) => {
    await gotoCanvas(page, canvas, "environment");
    await openEnvironmentWizard(page);

    const combo = page.locator("#env-gh-account-button");
    // Without an injected token the keyring's active account is the acting one.
    await expect(combo).toHaveAccessibleName("@repo-user");
    await expect(combo).toHaveAttribute("aria-expanded", "false");

    await combo.focus();
    await page.keyboard.press("Enter");
    await expect(combo).toHaveAttribute("aria-expanded", "true");
    const menu = page.locator("#env-gh-account-menu");
    await expect(menu).toHaveRole("listbox");

    const other = menu.getByRole("option", { name: /acting-user/ });
    await expect(other).toBeVisible();
    await other.focus();
    await page.keyboard.press("Enter");

    await expect(combo).toHaveAttribute("aria-expanded", "false");
    await expect(combo).toBeFocused();
    await expect
      .poll(
        () =>
          canvas.requests
            .filter(
              (request) =>
                request.method === "POST" &&
                request.path === "/api/github-account"
            )
            .at(-1)?.body
      )
      .toMatchObject({
        login: "acting-user",
        repo: REPOSITORY
      });
    expect(
      (await canvas.cliCalls()).some(
        (call) =>
          call.tool === "gh" &&
          call.args.includes("switch") &&
          call.args.includes("acting-user")
      )
    ).toBe(false);
    await expectNoWcagViolations(page);
  });

  test("queries namespaces from the selected AKS cluster and surfaces refresh failure", async ({
    page,
    canvas
  }) => {
    const scenario = defaultFakeCliScenario();
    const selected = {
      id: "aks-selected",
      name: "AKS Selected",
      resourceGroup: "rg-selected"
    };
    const resourceCommands: FakeCliCommand[] = azureDiscoveryCommands({
      subscriptionId: PROFILE_SUBSCRIPTION_ID,
      clusters: [
        { id: "aks-first", name: "AKS First", resourceGroup: "rg-first" },
        selected
      ],
      selected,
      namespaces: ["default", "selected-team"]
    });
    scenario.commands.push(...resourceCommands);
    await canvas.setScenario(scenario);
    await gotoCanvas(page, canvas, "environment");
    await openEnvironmentWizard(page);

    const resourceGroup = page.getByLabel("Resource Group", { exact: true });
    const cluster = page.getByLabel("Cluster", { exact: true });
    const namespace = page.locator("#azure-namespace-select");
    await expect(resourceGroup).toContainText(selected.resourceGroup);
    await resourceGroup.selectOption(selected.resourceGroup);
    await expect(cluster.locator("option")).toHaveText([
      "Select AKS cluster…",
      selected.name,
      "+ Enter custom..."
    ]);
    await expect(cluster).toHaveValue(selected.id);
    await expect(namespace).toBeDisabled();
    await expect(namespace).toContainText("selected-team");
    await expect(namespace).toBeEnabled();
    await expect(namespace).toHaveValue("default");
    await namespace.selectOption("selected-team");

    await expect
      .poll(async () =>
        (await canvas.cliCalls()).some(
          (call) =>
            call.tool === "az" &&
            call.args.includes("get-credentials") &&
            call.args.includes("aks-selected") &&
            call.args.includes("rg-selected") &&
            call.args.includes("--file") &&
            call.args.includes("--overwrite-existing") &&
            call.args.includes(PROFILE_SUBSCRIPTION_ID)
        )
      )
      .toBe(true);
    expect(
      (await canvas.cliCalls()).some(
        (call) =>
          call.tool === "az" &&
          call.args.includes("get-credentials") &&
          call.args.includes("aks-first")
      )
    ).toBe(false);

    // Second to last by construction: the factory appends the credential and
    // namespace commands in the order discovery issues them. Throwing rather
    // than skipping keeps a shape change here from silently turning the refresh
    // failure below into an assertion about a scenario that never changed.
    const credentials = resourceCommands.at(-2);
    if (!credentials?.argsPrefix?.includes("get-credentials")) {
      throw new Error("discovery stubs no longer end with the namespace step");
    }
    credentials.exitCode = 1;
    credentials.stderr = "selected cluster unavailable";
    await canvas.setScenario(scenario);
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(namespace).toBeDisabled();
    await expect(namespace).toHaveValue("");
    await expect(namespace.locator("option")).toHaveText(
      "Discovering namespaces…"
    );

    await expect(page.locator("#azure-discover-status")).toContainText(
      "Discovery failed: az aks get-credentials failed: selected cluster unavailable"
    );
    await expect(namespace).toBeEnabled();
    await expect(namespace.locator("option")).toHaveCount(2);
    await expect(namespace).not.toContainText("default");
    await expect(namespace).not.toContainText("selected-team");
    await namespace.selectOption("__custom__");
    await expect(page.locator("#azure-namespace-custom")).toBeVisible();
  });

  test("verifies Azure credentials through the fake az boundary and keeps secret-shaped stderr out of the page @safety", async ({
    page,
    canvas
  }) => {
    const scenario = defaultFakeCliScenario();
    const azAccount = scenario.commands.find(
      (command) =>
        command.tool === "az" &&
        JSON.stringify(command.args) ===
          JSON.stringify(["account", "show", "-o", "json"])
    );
    if (azAccount) {
      azAccount.exitCode = 1;
      azAccount.stdout = "";
      azAccount.stderr = `AADSTS: ${PLACEHOLDER_SECRET}`;
    }
    await canvas.setScenario(scenario);

    await gotoCanvas(page, canvas, "credentials");
    await page.getByRole("button", { name: "New Credential Profile" }).click();
    await page.getByLabel("Profile Name").fill("failing-azure");
    await page.getByLabel("Tenant ID").fill(VALID_TENANT_ID);
    await page.getByLabel("Subscription ID").fill(PROFILE_SUBSCRIPTION_ID);
    const verifyResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/verify-azure-login" &&
        response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Verify Credentials" }).click();
    const verifyPayload = await (await verifyResponse).text();

    const remediation = page.locator("#cred-verify-action");
    await expect(remediation).toContainText("Sign in to Azure CLI");
    await expect(remediation).toContainText(
      `az login --use-device-code --tenant ${VALID_TENANT_ID}`
    );
    await expect(
      remediation.getByRole("button", { name: "Run with Copilot" })
    ).toBeVisible();

    // The guidance remains server-authored while the action is rebuilt from the
    // structured remediation reference rather than duplicated in a modal.
    await expect(page.locator("#cred-verify-status")).toContainText(
      'Run "az login --use-device-code" in your terminal, then click Verify Credentials again.'
    );
    await expect(
      page.getByRole("button", { name: "Verify Credentials" })
    ).toBeEnabled();
    expect(bodyFor(canvas, "/api/verify-azure-login")).toEqual({
      tenantId: VALID_TENANT_ID,
      subscriptionId: PROFILE_SUBSCRIPTION_ID
    });
    expect(verifyPayload).not.toContain(PLACEHOLDER_SECRET);
    await expect(page.locator("body")).not.toContainText(PLACEHOLDER_SECRET);
    // Any `az` call would satisfy expectCliInvoked, including the unmodeled
    // `az account set` the route makes first and swallows. Pin the command that
    // actually produces the secret-shaped stderr under test.
    await expect
      .poll(async () =>
        (await canvas.cliCalls()).some(
          (call) =>
            call.tool === "az" &&
            JSON.stringify(call.args) ===
              JSON.stringify(["account", "show", "-o", "json"])
        )
      )
      .toBe(true);
    await expectNoWcagViolations(page);
  });

  test("validates credential form requirements before any external command runs @safety", async ({
    page,
    canvas
  }) => {
    await gotoCanvas(page, canvas, "credentials");
    await page.getByRole("button", { name: "New Credential Profile" }).click();
    await page.getByRole("button", { name: "Verify Credentials" }).click();

    await expect(page.locator("#cred-verify-status")).toContainText(
      "Please enter a Profile Name"
    );
    await expectNoWcagViolations(page);
    expect(
      canvas.requests.some(
        (request) =>
          request.method === "POST" &&
          request.path === "/api/verify-azure-login"
      )
    ).toBe(false);
  });

  test("keeps server-owned setup durable across navigation and downloads redacted diagnostics by keyboard @safety", async ({
    page,
    canvas
  }) => {
    const finishOperation: { current: (() => void) | null } = { current: null };
    canvas.setEnvironmentOperationRunner(async () => {
      await new Promise<void>((resolve) => {
        finishOperation.current = resolve;
      });
      throw new Error("The controlled setup failed safely.");
    });

    await gotoCanvas(page, canvas, "environment");
    await openEnvironmentWizard(page);
    const githubReadiness = page.locator("#env-gh-identity-note");
    await expect(githubReadiness).toContainText(
      "Ready to configure deployments"
    );
    await page.getByLabel("Environment name").fill("fixture-environment");
    await page.getByRole("button", { name: "Re-check" }).click();
    await expect(githubReadiness).toContainText(
      "Ready to configure deployments"
    );
    await page
      .getByLabel("Resource Group", { exact: true })
      .selectOption("__custom__");
    await page
      .getByLabel("Resource Group (custom)")
      .fill("fixture-resource-group");
    await page
      .getByLabel("Cluster", { exact: true })
      .selectOption("__custom__");
    await page
      .getByLabel("Cluster (custom)", { exact: true })
      .fill("fixture-cluster");

    const operationResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/operations" &&
        response.request().method() === "POST"
    );
    const createEnvironment = page.locator("#deploy-btn:not([disabled])");
    await expect(createEnvironment).toHaveText("Create Environment");
    await createEnvironment.click();
    const result = (await (await operationResponse).json()) as {
      operationId: string;
    };
    expect(result.operationId).toMatch(/^op_/);
    await expect(page.locator("body")).not.toContainText(PLACEHOLDER_SECRET);

    await page.goto(
      `${canvas.baseUrl}/?page=environment&operationId=${result.operationId}`
    );
    await expect(page.locator("#env-progress-panel")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Download diagnostic snapshot" })
    ).toBeHidden();
    const activity = page.locator("#env-progress-activity");
    await expect(activity).toHaveAttribute("aria-live", "polite");
    await gotoCanvas(page, canvas, "credentials");
    await expect(page.locator("#cred-landing")).toBeVisible();
    const finishServerOperation = finishOperation.current;
    if (finishServerOperation) finishServerOperation();
    await expect
      .poll(
        async () =>
          await page.evaluate(async (operationId) => {
            const response = await fetch(`/api/operations/${operationId}`);
            const payload = (await response.json()) as {
              operation?: { state?: string };
            };
            return payload.operation?.state;
          }, result.operationId)
      )
      .toBe("failed");
    await page.goto(
      `${canvas.baseUrl}/?page=environment&operationId=${result.operationId}`
    );
    // Resuming shows the durable server outcome, never a browser-cancellation
    // story, even though the page that started it was torn down twice. The
    // resumed panel is what narrates it: the top-nav chip defers to the inline
    // panel whenever the panel is on screen, so asserting the chip here would
    // be asserting that the panel failed to come back.
    const resumedPanel = page.locator("#env-progress-panel");
    await expect(resumedPanel).toBeVisible();
    await expect(resumedPanel).toContainText(
      'Creating environment "fixture-environment" failed.'
    );
    await expect(page.locator("body")).not.toContainText("cancelled");
    await expect(page.locator("body")).not.toContainText("Cancelled");
    await resumedPanel.locator("#env-progress-details > summary").click();
    const diagnosticButton = page.getByRole("button", {
      name: "Download diagnostic snapshot"
    });
    await expect(diagnosticButton).toBeVisible();
    await expectVerticallyAligned(
      diagnosticButton,
      page.locator("#env-progress-diagnostics-note")
    );
    await diagnosticButton.focus();
    await page.keyboard.press("Enter");
    const diagnosticDialog = page.getByRole("dialog", {
      name: "Download diagnostic snapshot"
    });
    await expect(diagnosticDialog).toBeVisible();
    await expect(
      diagnosticDialog.getByLabel("Include contextual identifiers")
    ).not.toBeChecked();
    const includeCheckbox = diagnosticDialog.getByLabel(
      "Include contextual identifiers"
    );
    const includeLabel = diagnosticDialog.locator(
      'label[for="env-diagnostics-include-identifiers"]'
    );
    await expectVerticallyAligned(includeCheckbox, includeLabel);
    await expectNoWcagViolations(page);
    const diagnosticLink = diagnosticDialog.getByRole("link", {
      name: "Download snapshot"
    });
    await diagnosticLink.focus();
    await expect(diagnosticLink).toBeFocused();
    const downloadStarted = page.waitForEvent("download");
    await page.keyboard.press("Enter");
    const download = await downloadStarted;
    expect(download.suggestedFilename()).toBe(
      "radius-environment-operation-diagnostics.json"
    );
    const diagnosticPath = await download.path();
    if (diagnosticPath === null) {
      throw new Error("Playwright did not retain the diagnostic download.");
    }
    const diagnosticText = await fs.readFile(diagnosticPath, "utf8");
    expect(diagnosticText).not.toContain(REPOSITORY);
    expect(diagnosticText).not.toContain("fixture-environment");
    expect(diagnosticText).not.toContain(PLACEHOLDER_SECRET);
    expect(JSON.parse(diagnosticText)).toMatchObject({
      diagnosticSchemaVersion: 2,
      identifierProfile: "support_safe",
      contextualIdentifiers: null,
      operation: {
        operationId: result.operationId,
        lifecycle: { state: "failed" }
      }
    });
    await expect(diagnosticDialog).toBeHidden();
    await expect(diagnosticButton).toBeFocused();
    await expect(page.locator("#env-progress-diagnostics-status")).toHaveText(
      "Diagnostic snapshot download started."
    );

    await diagnosticButton.click();
    await expect(diagnosticDialog).toBeVisible();
    await diagnosticDialog.getByLabel("Include contextual identifiers").check();
    await expect(diagnosticDialog.getByText(REPOSITORY)).toBeVisible();
    await expect(
      diagnosticDialog.getByText("fixture-environment", { exact: true })
    ).toBeVisible();
    await expect(diagnosticDialog.getByText("repo-user")).toBeVisible();
    const reviewedCheckbox = diagnosticDialog.getByLabel(
      "I reviewed these identifiers"
    );
    const reviewedLabel = diagnosticDialog.locator(
      'label[for="env-diagnostics-reviewed-identifiers"]'
    );
    await expectVerticallyAligned(reviewedCheckbox, reviewedLabel);
    await expectNoWcagViolations(page);
    await diagnosticDialog.getByLabel("I reviewed these identifiers").check();
    const contextualDownloadStarted = page.waitForEvent("download");
    await diagnosticLink.click();
    const contextualDownload = await contextualDownloadStarted;
    const contextualPath = await contextualDownload.path();
    if (contextualPath === null) {
      throw new Error(
        "Playwright did not retain the contextual diagnostic download."
      );
    }
    const contextualText = await fs.readFile(contextualPath, "utf8");
    expect(contextualText).not.toContain(PLACEHOLDER_SECRET);
    expect(JSON.parse(contextualText)).toMatchObject({
      diagnosticSchemaVersion: 2,
      identifierProfile: "support_safe_with_identifiers",
      contextualIdentifiers: {
        repository: REPOSITORY,
        branch: WORKTREE_BRANCH,
        environment: "fixture-environment",
        githubLogin: "repo-user",
        omittedFieldCount: 0
      }
    });
    await expect(diagnosticDialog).toBeHidden();
    await expect(diagnosticButton).toBeFocused();
    await expect(page.locator("#env-progress-diagnostics-status")).toHaveText(
      "Diagnostic snapshot download started."
    );

    await page.route(
      `**/api/operations/${result.operationId}/diagnostics`,
      async (route) => {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"code":"diagnostic-export-unavailable"}'
        });
      }
    );
    await diagnosticButton.click();
    await diagnosticLink.click();
    await expect(diagnosticDialog).toBeVisible();
    await expect(diagnosticDialog.getByRole("alert")).toContainText(
      "could not download the support-safe diagnostic snapshot"
    );
    await page.unroute(`**/api/operations/${result.operationId}/diagnostics`);
    await diagnosticDialog.getByRole("button", { name: "Cancel" }).click();

    expect(bodyFor(canvas, "/api/operations")).toMatchObject({
      repo: REPOSITORY,
      environment: "fixture-environment",
      branch: WORKTREE_BRANCH,
      resourceGroup: "fixture-resource-group",
      cluster: "fixture-cluster"
    });
    await expect(page.locator("body")).not.toContainText(PLACEHOLDER_SECRET);
  });

  test("follows the latest setup detail until the user scrolls up", async ({
    page,
    canvas
  }) => {
    await page.clock.install();
    let stepCount = 12;
    const operationPayload = (stepCount: number) => ({
      operation: {
        operationId: "op_scroll_follow",
        environment: "fixture-environment",
        provider: "azure",
        state: "running",
        terminalState: null,
        summary: "Creating fixture-environment…",
        currentStage: "provision",
        stages: [{ state: "running", label: "Provision" }],
        steps: Array.from({ length: stepCount }, (_, index) => ({
          state: index === stepCount - 1 ? "running" : "succeeded",
          label: `Setup detail ${index + 1}`
        })),
        failure: null,
        cleanup: null,
        verification: null,
        inputRequired: null,
        startedAt: new Date(0).toISOString(),
        endedAt: null,
        terminal: null
      }
    });
    await page.route("**/api/operations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(operationPayload(stepCount))
      });
    });

    await gotoCanvas(page, canvas, "environment");
    const details = page.locator("#env-progress-details");
    const steps = page.locator("#env-progress-steps");
    await expect(details).toBeVisible();
    await steps.evaluate((element) => {
      Reflect.set(Reflect.get(element, "style"), "maxHeight", "48px");
    });
    await details.locator("summary").click();
    await expect
      .poll(() =>
        steps.evaluate(
          (element) =>
            Number(Reflect.get(element, "scrollHeight")) -
            Number(Reflect.get(element, "scrollTop")) -
            Number(Reflect.get(element, "clientHeight"))
        )
      )
      .toBeLessThanOrEqual(4);

    await steps.hover();
    await page.mouse.wheel(0, -1000);
    await expect
      .poll(() =>
        steps.evaluate((element) => Number(Reflect.get(element, "scrollTop")))
      )
      .toBe(0);
    stepCount = 13;
    await page.clock.fastForward(1500);
    await expect(steps).toContainText("Setup detail 13");
    await expect
      .poll(() =>
        steps.evaluate((element) => Number(Reflect.get(element, "scrollTop")))
      )
      .toBe(0);

    await steps.hover();
    await page.mouse.wheel(0, 1000);
    await expect
      .poll(() =>
        steps.evaluate(
          (element) =>
            Number(Reflect.get(element, "scrollHeight")) -
            Number(Reflect.get(element, "scrollTop")) -
            Number(Reflect.get(element, "clientHeight"))
        )
      )
      .toBeLessThanOrEqual(4);
    stepCount = 14;
    await page.clock.fastForward(1500);
    await expect(steps).toContainText("Setup detail 14");
    await expect
      .poll(() =>
        steps.evaluate(
          (element) =>
            Number(Reflect.get(element, "scrollHeight")) -
            Number(Reflect.get(element, "scrollTop")) -
            Number(Reflect.get(element, "clientHeight"))
        )
      )
      .toBeLessThanOrEqual(4);
  });

  test("retries verification through the selected account and returned run URL @safety", async ({
    page,
    canvas
  }) => {
    const operationId = await canvas.seedRestartedVerificationFailure();
    const exactCreatedAt = new Date().toISOString();
    const decoyCreatedAt = new Date(Date.now() + 1000).toISOString();
    const scenario = defaultFakeCliScenario();
    scenario.commands.push(
      {
        tool: "gh",
        args: [
          "run",
          "list",
          "--workflow=radius-verify-credentials.yml",
          "--limit",
          "1",
          "--json",
          "databaseId",
          "--repo",
          REPOSITORY
        ],
        env: { GH_TOKEN: "fixture-repo-token" },
        stdout: '[{"databaseId":40}]'
      },
      {
        tool: "gh",
        args: [
          "workflow",
          "run",
          "radius-verify-credentials.yml",
          "-f",
          "environment=fixture-environment",
          "-f",
          `radius_operation=${operationId}`,
          "--repo",
          REPOSITORY,
          "--ref",
          WORKTREE_BRANCH
        ],
        env: { GH_TOKEN: "fixture-repo-token" },
        stdout: `https://github.com/${REPOSITORY}/actions/runs/41`
      },
      {
        tool: "gh",
        args: [
          "run",
          "list",
          "--workflow=radius-verify-credentials.yml",
          "--limit",
          "10",
          "--json",
          "databaseId,createdAt,displayTitle,event,headBranch",
          "--repo",
          REPOSITORY
        ],
        env: { GH_TOKEN: "fixture-repo-token" },
        stdout: JSON.stringify([
          {
            databaseId: 42,
            createdAt: decoyCreatedAt,
            displayTitle:
              "Radius verify fixture-environment [another-operation]",
            event: "workflow_dispatch",
            headBranch: WORKTREE_BRANCH
          },
          {
            databaseId: 41,
            createdAt: exactCreatedAt,
            displayTitle: `Radius verify fixture-environment [${operationId}]`,
            event: "workflow_dispatch",
            headBranch: WORKTREE_BRANCH
          }
        ])
      },
      {
        tool: "gh",
        args: [
          "run",
          "view",
          "41",
          "--json",
          "status,conclusion,jobs",
          "--repo",
          REPOSITORY
        ],
        env: { GH_TOKEN: "fixture-repo-token" },
        stdout: JSON.stringify({
          status: "completed",
          conclusion: "success",
          jobs: []
        })
      }
    );
    await canvas.setScenario(scenario);
    await gotoCanvas(page, canvas, "environment");

    const retry = page.locator("#env-progress-command-retry-verification");
    await expect(retry).toBeVisible();
    await expect(retry).toHaveText("Retry verification");
    await retry.click();

    await expect
      .poll(async () =>
        (await canvas.cliCalls()).some(
          (call) =>
            call.tool === "gh" &&
            call.args[0] === "workflow" &&
            call.args.includes(`radius_operation=${operationId}`)
        )
      )
      .toBe(true);
    await expect
      .poll(async () => (await canvas.operationRecord(operationId))["state"], {
        timeout: 15_000
      })
      .toBe("succeeded");

    const record = await canvas.operationRecord(operationId);
    expect(record["verification"]).toMatchObject({
      baselineRunId: 40,
      runId: "41",
      runUrl: `https://github.com/${REPOSITORY}/actions/runs/41`,
      operationMarker: operationId
    });
    expect(record["providerRecovery"]).toMatchObject({
      mutations: [
        expect.objectContaining({
          kind: "github_workflow.dispatch_retry",
          status: "confirmed",
          providerIdempotencyKey: operationId
        })
      ]
    });
    expect(
      (await canvas.cliCalls()).filter(
        (call) =>
          call.tool === "gh" &&
          call.args[0] === "run" &&
          call.args.includes(
            "databaseId,createdAt,displayTitle,event,headBranch"
          )
      )
    ).toEqual([]);
    await expect(page.locator("body")).toContainText("Environment created");
    await page.locator("#env-progress-details > summary").click();
    await expect(
      page.getByRole("button", { name: "Download diagnostic snapshot" })
    ).toBeHidden();
    await expectNoWcagViolations(page);
  });

  test("stops an interrupted setup before offering exact-run cancellation by keyboard @safety", async ({
    page,
    canvas
  }) => {
    const operationId = await canvas.seedInterruptedVerification();
    const scenario = defaultFakeCliScenario();
    scenario.commands.push(
      {
        tool: "gh",
        args: ["run", "view", "39", "--json", "status", "--repo", REPOSITORY],
        env: { GH_TOKEN: "fixture-repo-token" },
        stdout: '{"status":"in_progress"}'
      },
      {
        tool: "gh",
        args: [
          "api",
          "--method",
          "POST",
          `repos/${REPOSITORY}/actions/runs/39/cancel`
        ],
        env: { GH_TOKEN: "fixture-repo-token" },
        stdout: ""
      }
    );
    await canvas.setScenario(scenario);
    await page.goto(
      `${canvas.baseUrl}/?page=environment&operationId=${operationId}`
    );

    await expect(page.locator("#env-progress-title")).toContainText(
      "Environment setup was interrupted"
    );
    await expect(
      page.getByRole("button", { name: "Continue setup" })
    ).toBeVisible();
    const stop = page.getByRole("button", { name: "Stop setup" });
    await expect(stop).toBeVisible();
    await expect(stop).toHaveAttribute(
      "title",
      "Radius stops this setup. If its exact GitHub Actions run is still active, you can cancel it next."
    );
    await expect(stop).toHaveAccessibleDescription(
      "Radius stops this setup. If its exact GitHub Actions run is still active, you can cancel it next."
    );
    await expect(
      page.getByRole("button", { name: "Cancel workflow" })
    ).toHaveCount(0);
    await stop.focus();
    await page.keyboard.press("Enter");

    await page.locator("#env-progress-details > summary").click();
    await expect(
      page.getByRole("button", { name: "Download diagnostic snapshot" })
    ).toBeVisible();
    const cancelWorkflow = page.getByRole("button", {
      name: "Cancel workflow"
    });
    await expect(cancelWorkflow).toBeVisible();
    await expect(cancelWorkflow).toHaveAccessibleDescription(
      "Radius cancels only the exact GitHub Actions run recorded for this setup."
    );
    await expect(
      page.getByRole("button", { name: "Roll back created resources" })
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Exit setup" })).toHaveCount(
      0
    );
    await expect(
      page.getByRole("button", { name: "Abandon setup" })
    ).toHaveAccessibleDescription(
      "Radius closes this setup without deleting resources that may still be used by external work. You can start Create Environment again, but you may need to remove or reuse the remaining resources manually."
    );
    await cancelWorkflow.focus();
    await page.keyboard.press("Enter");

    const dialog = page.locator("#env-rollback-modal");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName(
      "Cancel the verification workflow?"
    );
    await expectNoWcagViolations(page);
    const confirm = dialog.getByRole("button", { name: "Cancel workflow" });
    await confirm.focus();
    await page.keyboard.press("Enter");

    await expect
      .poll(async () =>
        (await canvas.cliCalls()).some(
          (call) =>
            call.tool === "gh" &&
            JSON.stringify(call.args) ===
              JSON.stringify([
                "api",
                "--method",
                "POST",
                `repos/${REPOSITORY}/actions/runs/39/cancel`
              ])
        )
      )
      .toBe(true);
    await expect(
      page.getByRole("button", { name: "Check workflow status" })
    ).toBeVisible({ timeout: 15_000 });
  });

  test("abandons an interrupted setup without waiting for the active workflow @safety", async ({
    page,
    canvas
  }) => {
    const operationId = await canvas.seedInterruptedVerification();
    const scenario = defaultFakeCliScenario();
    scenario.commands.push({
      tool: "gh",
      args: ["run", "view", "39", "--json", "status", "--repo", REPOSITORY],
      env: { GH_TOKEN: "fixture-repo-token" },
      stdout: '{"status":"in_progress"}'
    });
    await canvas.setScenario(scenario);
    await page.goto(
      `${canvas.baseUrl}/?page=environment&operationId=${operationId}`
    );

    await page.getByRole("button", { name: "Stop setup" }).click();
    const abandon = page.getByRole("button", { name: "Abandon setup" });
    await expect(abandon).toBeVisible();
    await abandon.click();

    const dialog = page.locator("#env-rollback-modal");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName(
      "Abandon setup and leave remaining resources?"
    );
    await expect(dialog).toContainText("Radius will keep");
    await expect(dialog).toContainText(
      "the command you are confirming leaves it in place"
    );
    await expectNoWcagViolations(page);
    await dialog.getByRole("button", { name: "Abandon setup" }).click();

    await expect(page.locator("#env-progress-panel")).toBeHidden();
    await expect(page.locator("#new-env-btn")).toBeVisible();
    expect(
      (await canvas.cliCalls()).some(
        (call) =>
          call.tool === "gh" &&
          call.args.some((arg) => arg.endsWith("/actions/runs/39/cancel"))
      )
    ).toBe(false);
  });

  test("sends the worktree branch the page selected when Deploy is activated @safety", async ({
    page,
    canvas
  }) => {
    const scenario = defaultFakeCliScenario();
    const deploymentCommand = scenario.commands.find(
      (command) =>
        command.tool === "gh" &&
        command.args?.[1] ===
          `/repos/${REPOSITORY}/deployments?per_page=100&environment=fixture-environment`
    );
    if (deploymentCommand) {
      deploymentCommand.exitCode = 1;
      deploymentCommand.stderr = "gh: unavailable (HTTP 503)";
      deploymentCommand.stdout = "";
    }
    await canvas.setScenario(scenario);

    await gotoCanvas(page, canvas, "deploying");

    // The branch the page offers must be the session worktree branch. A
    // regression to an implicit "main" would deploy the wrong ref, so this is
    // read from the real select rather than supplied by the test.
    const branchSelect = page.locator("#deploy-branch-select");
    await expect(branchSelect).toHaveValue(WORKTREE_BRANCH);

    // This control doubles as "Create Application" / "Create Environment"
    // navigation until the real listings load, and it is enabled in those
    // modes too, so waiting only for "enabled" can click a navigation control
    // instead of Deploy. Match the enabled control and its Deploy label in one
    // retried assertion so there is no window between the two conditions.
    const deployNow = page.locator("#deploy-now-btn:not([disabled])");
    await expect(deployNow).toHaveText("Deploy");
    await deployNow.click();

    // The dispatch is refused because the fake deployments lookup fails, and
    // the page has to surface that rather than leaving the control spinning.
    await expect
      .poll(() => bodyFor(canvas, "/api/deploy"), { timeout: 15_000 })
      .toEqual({
        environment: "fixture-environment",
        provider: "azure",
        targetRepo: REPOSITORY,
        branch: WORKTREE_BRANCH,
        appFile: ".radius/app.bicep"
      });
    await expect(page.locator("body")).toContainText(/could not verify/i);
  });

  test("disables Planned deployment for the selected app and environment while it is pending @safety", async ({
    page,
    canvas
  }) => {
    const scenario = defaultFakeCliScenario();
    const deploymentStatus = scenario.commands.find(
      (command) =>
        command.tool === "gh" &&
        command.args?.[1] ===
          `/repos/${REPOSITORY}/deployments/dep-1/statuses?per_page=1`
    );
    if (deploymentStatus) {
      deploymentStatus.stdout = `pending\thttps://github.com/${REPOSITORY}/actions/runs/1`;
    }
    const deploymentWorkflow = scenario.commands.find(
      (command) =>
        command.tool === "gh" &&
        command.args?.[1] === `/repos/${REPOSITORY}/actions/runs/1`
    );
    if (deploymentWorkflow) {
      deploymentWorkflow.stdout =
        ".github/workflows/run-rad-commands.yml\tin_progress\t";
    }
    await canvas.setScenario(scenario);

    await gotoCanvas(page, canvas, "planned");

    await expect(page.locator("#planned-app")).toHaveValue("radius-app");
    await expect(page.locator("#planned-env")).toHaveValue(
      "fixture-environment"
    );
    const deploy = page.getByRole("button", { name: "Deploy Application" });
    await expect(deploy).toBeDisabled();
    await expect(deploy).toHaveAttribute(
      "title",
      'A deployment of application "radius-app" to environment "fixture-environment" is already in progress. Wait for it to finish before deploying again.'
    );
  });

  test("shows deployment-started notification only after workflow confirmation in Chromium", async ({
    page,
    canvas
  }) => {
    let workflowConfirmed = false;
    let statusPolls = 0;
    await page.route("**/api/deploy", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true })
      });
    });
    await page.route("**/api/deploy-status", async (route) => {
      statusPolls++;
      const payload =
        workflowConfirmed ?
          {
            status: "in_progress",
            deployRunUrl: "https://example.test/run/1"
          }
        : { status: "in_progress" };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(payload)
      });
    });

    await gotoCanvas(page, canvas, "deploying");
    const deployNow = page.locator("#deploy-now-btn:not([disabled])");
    await expect(deployNow).toHaveText("Deploy");
    await deployNow.click();

    await expect.poll(() => statusPolls).toBeGreaterThan(0);
    const inlineStatus = page.locator("#deploy-inline-status");
    // Waiting for a status request makes this absence cover the old eager
    // notification path rather than merely asserting the initial page state.
    await expect(inlineStatus).not.toContainText("has started");
    await expect(page.locator("#deploy-progress-modal")).toBeVisible();

    workflowConfirmed = true;
    await expect.poll(() => statusPolls).toBeGreaterThan(1);
    await expect(inlineStatus).toContainText("has started");
    await expect(page.locator("#deploy-progress-modal")).toBeHidden();
  });

  test("does not show deployment-started notification when workflow startup fails in Chromium", async ({
    page,
    canvas
  }) => {
    let statusPolls = 0;
    await page.route("**/api/deploy", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true })
      });
    });
    await page.route("**/api/deploy-status", async (route) => {
      statusPolls++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "failed",
          error: "workflow startup failed",
          deployRunUrl: "https://example.test/run/1"
        })
      });
    });

    await gotoCanvas(page, canvas, "deploying");
    const deployNow = page.locator("#deploy-now-btn:not([disabled])");
    await expect(deployNow).toHaveText("Deploy");
    await deployNow.click();

    await expect.poll(() => statusPolls).toBeGreaterThan(0);
    await expect(page.locator("#deploy-inline-status")).not.toContainText(
      "has started"
    );
    await expect(page.locator("#deploy-progress-subtitle")).toContainText(
      "workflow startup failed"
    );
  });

  test("opens destructive deployment confirmation with keyboard focus and returns focus on Escape @safety", async ({
    page,
    canvas
  }) => {
    await gotoCanvas(page, canvas, "deploying");
    const deleteButton = page.getByRole("button", {
      name: "Delete Deployment"
    });
    await expect(deleteButton).toBeVisible();
    await deleteButton.focus();
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName(/Delete deployment/i);
    const step1 = page.getByRole("button", {
      name: "I want to delete this deployment"
    });
    await expect(step1).toBeFocused();
    await expectNoWcagViolations(page);

    // The trap must keep Tab inside the modal instead of dropping the user onto
    // the page behind it.
    await page.keyboard.press("Tab");
    await expect(page.locator("#deploy-delete-close")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(step1).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator("#deploy-delete-close")).toBeFocused();

    await step1.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: /have read and understand/i })
    ).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(deleteButton).toBeFocused();
  });

  test("requires every confirmation step and the exact typed token before the real delete request @safety", async ({
    page,
    canvas
  }) => {
    await gotoCanvas(page, canvas, "deploying");
    await page.getByRole("button", { name: "Delete Deployment" }).click();

    await page
      .getByRole("button", { name: "I want to delete this deployment" })
      .click();
    await page
      .getByRole("button", { name: /have read and understand/i })
      .click();

    const input = page.locator("#del-confirm-input");
    const confirm = page.locator("#del-confirm-btn");
    await expect(input).toBeFocused();
    await expect(confirm).toBeDisabled();
    await expectNoWcagViolations(page);

    const token = await input.getAttribute("placeholder");
    expect(token).toBe("radius-app/fixture-environment");
    const near = (token ?? "").slice(0, -1);

    // A near-miss must not arm the destructive action.
    await page.keyboard.type(near);
    await expect(confirm).toBeDisabled();
    await page.keyboard.press("Enter");
    expect(bodyFor(canvas, "/api/delete-deployment")).toBeUndefined();

    await page.keyboard.type((token ?? "").slice(-1));
    await expect(confirm).toBeEnabled();
    await page.keyboard.press("Enter");

    await expect
      .poll(() => bodyFor(canvas, "/api/delete-deployment"))
      .toMatchObject({ environment: "fixture-environment" });
  });

  test("offers stop tracking only after teardown fails in Chromium @safety", async ({
    page,
    canvas
  }) => {
    let status = "success";
    await routeDeployedPage(page, () => status);
    await gotoCanvas(page, canvas, "deployed");

    await expect(
      page.getByRole("button", { name: "Delete Deployment" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Stop tracking deployment" })
    ).toHaveCount(0);

    status = "failed";
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Delete Deployment" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Stop tracking deployment" })
    ).toHaveCount(0);

    status = "delete-failed";
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Retry Delete" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Stop tracking deployment" })
    ).toBeVisible();
  });

  test("confirms stop-tracking recovery by keyboard and sends the failed teardown identity @safety", async ({
    page,
    canvas
  }) => {
    const requests: Array<{ body: unknown; nonce: string }> = [];
    await routeDeployedPage(
      page,
      () => "delete-failed",
      (body, nonce) => {
        requests.push({ body, nonce });
      }
    );
    await gotoCanvas(page, canvas, "deployed");

    const action = page.getByRole("button", {
      name: "Stop tracking deployment"
    });
    await action.focus();
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog", {
      name: "Stop Tracking Deployment"
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("does not delete cloud resources");
    const intent = page.getByRole("button", {
      name: "I want to stop tracking this deployment"
    });
    await expect(intent).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toContainText(
      "Resources created before the deployment failed may remain"
    );
    await page.keyboard.press("Enter");

    const input = page.locator("#del-confirm-input");
    await expect(input).toBeFocused();
    await expectNoWcagViolations(page);
    await page.keyboard.type("radius-app/fixture-environment");
    await page.keyboard.press("Enter");

    await expect.poll(() => requests).toHaveLength(1);
    expect(requests[0].body).toEqual({
      repo: REPOSITORY,
      environment: "fixture-environment",
      application: "radius-app"
    });
    expect(requests[0].nonce).not.toBe("");
    await expect(page.locator("#deployed-inline-status")).toContainText(
      "Cloud resources were not deleted"
    );
    await expect(page.locator("#deployed-delete-btn")).toHaveText(
      "Deploy Application"
    );
  });

  test("reveals the environment form by keyboard and returns focus to the reveal control", async ({
    page,
    canvas
  }) => {
    await gotoCanvas(page, canvas, "environment");
    const newEnvironment = page.locator("#new-env-btn");
    // Walks both wizard steps by keyboard, asserting focus placement at each
    // hand-off: reveal control → profile combo → listbox option → combo →
    // Continue → environment name.
    await openEnvironmentWizard(page);
    await expect(page.getByLabel("Environment name")).toBeFocused();
    await expectNoWcagViolations(page);

    const back = page.locator("#cancel-env-btn");
    await back.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#env-form")).toBeHidden();
    await expect(newEnvironment).toBeFocused();
  });

  test("drives heartbeat to recovery threshold and reloads only after recovery", async ({
    page,
    canvas
  }) => {
    let pingStatus = 200;
    let navigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations += 1;
    });
    const heartbeatUrl = `${canvas.baseUrl}/api/ping`;
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    // Counting pings at the Playwright route handler is what made this test
    // flaky (#541): route.fulfill() resolves once Chromium has been handed the
    // response, not once the page has finished handling it, so the next focus
    // could still hit the in-flight guard (heartbeat.ts:61) and be dropped.
    // These browser-side counters bracket the real promise chain instead.
    await page.addInitScript((url: string) => {
      const originalFetch = globalThis.fetch;
      let startedPings = 0;
      let observedPings = 0;
      let completedPings = 0;
      const publish = (name: string, read: () => number): void => {
        Object.defineProperty(globalThis, name, { get: read });
      };
      publish("__radiusStartedHeartbeatPings", () => startedPings);
      publish("__radiusObservedHeartbeatPings", () => observedPings);
      publish("__radiusCompletedHeartbeatPings", () => completedPings);
      globalThis.fetch = async (...args): Promise<Response> => {
        const input = args[0];
        // A Request input stringifies to "[object Request]", which resolves
        // against the base instead of throwing, so the wrapper would silently
        // stop matching and every counter would flatline. Read the URL off
        // each input shape explicitly.
        const rawUrl =
          typeof input === "string" ? input
          : input instanceof URL ? input.href
          : input.url;
        if (new URL(rawUrl, url).href !== url) return originalFetch(...args);

        startedPings += 1;
        const response = await originalFetch(...args);
        const ok = response.ok;
        let observed = false;
        Object.defineProperty(response, "ok", {
          configurable: true,
          get() {
            if (!observed) {
              observed = true;
              observedPings += 1;
              // `ok` is read first by isHttpResponse (context.ts:142) and again
              // by heartbeat.ts:82. Everything left in the chain after those
              // reads -- the .then, the .catch, and the .finally that clears
              // the in-flight guard (heartbeat.ts:107-111) -- is a microtask,
              // so a macrotask queued here cannot run before the guard is
              // clear. If either reader stops touching `ok`, this counter stays
              // at 0 and the polls below time out instead of passing by luck.
              setTimeout(() => {
                completedPings += 1;
              }, 0);
            }
            return ok;
          }
        });
        return response;
      };
    }, heartbeatUrl);
    await page.route(heartbeatUrl, async (route) => {
      await route.fulfill({
        status: pingStatus,
        contentType: "application/json",
        body: "{}"
      });
    });
    await gotoCanvas(page, canvas, "planned");
    await expectNoWcagViolations(page);
    // Load-bearing, not a duplicated line: the first load and the axe scan run
    // on a live clock and consume an unpredictable share of the 5s heartbeat
    // interval, so a ping can still be outstanding here. Reloading restarts the
    // interval from a known point before the clock is frozen.
    await gotoCanvas(page, canvas, "planned");
    const currentTime = await page.evaluate<number>("Date.now()");
    // pauseAt rejects a non-future time ("Cannot fast-forward to the past")
    // because real time advances between the read above and this call, so the
    // offset cannot be dropped. pauseAt also runs the timers it crosses, which
    // can start an interval ping; settleHeartbeat below drains it before any
    // baseline is read.
    await page.clock.pauseAt(currentTime + 1_000);

    const readCounter = async (name: string): Promise<number> =>
      page.evaluate<number>(`window.${name}`);
    // Quiescent means every started ping has also completed, i.e. heartbeat.ts
    // has cleared `inFlight`. Pumping the paused clock lets the completion
    // markers, which are macrotasks, run.
    const settleHeartbeat = async (): Promise<void> => {
      await expect
        .poll(async () => {
          await page.clock.runFor(0);
          const started = await readCounter("__radiusStartedHeartbeatPings");
          const completed = await readCounter(
            "__radiusCompletedHeartbeatPings"
          );
          return started - completed;
        })
        .toBe(0);
    };
    await settleHeartbeat();

    const overlay = page.locator("#radius-reconnect-overlay");
    const initialNavigations = navigations;
    const baselinePings = await readCounter("__radiusStartedHeartbeatPings");
    const focusForPing = async (): Promise<void> => {
      const beforeObserved = await readCounter(
        "__radiusObservedHeartbeatPings"
      );
      const beforeCompleted = await readCounter(
        "__radiusCompletedHeartbeatPings"
      );
      await page.evaluate("window.dispatchEvent(new Event('focus'))");
      await expect
        .poll(() => readCounter("__radiusObservedHeartbeatPings"))
        .toBe(beforeObserved + 1);
      await settleHeartbeat();
      expect(await readCounter("__radiusCompletedHeartbeatPings")).toBe(
        beforeCompleted + 1
      );
    };

    pingStatus = 503;
    await focusForPing();
    await expect(overlay).toBeHidden();
    await focusForPing();
    await expect(overlay).toBeVisible();
    expect(navigations - initialNavigations).toBe(0);
    // Absolute, not a delta: with the clock paused these two focus pings are
    // the only ones that may exist. A delta check absorbs a ping the test never
    // asked for, which is the class of failure #541 started as.
    expect(await readCounter("__radiusStartedHeartbeatPings")).toBe(
      baselinePings + 2
    );

    pingStatus = 200;
    // Dispatching from a timer keeps page.evaluate from racing the execution
    // context teardown that the recovery reload causes. The clock is paused, so
    // the runFor(0) on the next line is what actually fires that timer; the two
    // lines have to stay together.
    await page.evaluate(
      "setTimeout(() => window.dispatchEvent(new Event('focus')), 0)"
    );
    await page.clock.runFor(0);
    await page.waitForURL(`${canvas.baseUrl}/?page=planned`);
    await expect.poll(() => navigations - initialNavigations).toBe(1);
  });
});
