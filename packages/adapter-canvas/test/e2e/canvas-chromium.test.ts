import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import {
  baseCanvasState,
  CREDENTIAL_SENTINEL,
  defaultFakeCliScenario,
  expect,
  PLACEHOLDER_SECRET,
  PROFILE_NAME,
  REPOSITORY,
  test,
  WORKTREE_BRANCH,
  type CanvasHarness
} from "./support/canvas-harness.js";
import type { Page } from "@playwright/test";

const VALID_TENANT_ID = "11111111-1111-1111-1111-111111111111";
const VALID_SUBSCRIPTION_ID = "22222222-2222-2222-2222-222222222222";
const SOURCE_FILE = "src/web/app.ts";
const SOURCE_LINE = 12;

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
      branch: WORKTREE_BRANCH
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

  test("reports GitHub account mismatch accessibly without leaking raw CLI output @safety", async ({
    page,
    canvas
  }) => {
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
    const showHowToFix = page.getByRole("button", {
      name: "Show how to fix"
    });
    await expect(showHowToFix).toBeVisible();
    await showHowToFix.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#env-gh-details-panel")).toHaveAttribute(
      "open",
      ""
    );
    await canvas.expectCliInvoked("gh");
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
    await page.getByLabel("Subscription ID").fill(VALID_SUBSCRIPTION_ID);
    const verifyResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/verify-azure-login" &&
        response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Verify Credentials" }).click();
    const verifyPayload = await (await verifyResponse).text();

    const assistDialog = page.getByRole("dialog", {
      name: "Start Azure login?"
    });
    await expect(assistDialog).toBeVisible();
    await assistDialog.getByRole("button", { name: "Cancel" }).click();

    // The guidance half of the message is authored only by the server. The
    // dialog's own copy also opens with "No active Azure session", so asserting
    // that prefix alone would still pass if the cancel path stopped carrying
    // the server's error through to the status line.
    await expect(page.locator("#cred-verify-status")).toContainText(
      'Run "az login --use-device-code" in your terminal, then click Verify Credentials again.'
    );
    await expect(
      page.getByRole("button", { name: "Verify Credentials" })
    ).toBeEnabled();
    expect(bodyFor(canvas, "/api/verify-azure-login")).toEqual({
      tenantId: VALID_TENANT_ID,
      subscriptionId: VALID_SUBSCRIPTION_ID
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

  test("keeps server-owned setup durable across navigation without reporting browser cancellation @safety", async ({
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
    expect(bodyFor(canvas, "/api/operations")).toMatchObject({
      repo: REPOSITORY,
      environment: "fixture-environment",
      branch: WORKTREE_BRANCH,
      resourceGroup: "fixture-resource-group",
      cluster: "fixture-cluster"
    });
    await expect(page.locator("body")).not.toContainText(PLACEHOLDER_SECRET);
  });

  test("retries restored verification through the selected account and exact run identity @safety", async ({
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
          "10",
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
        stdout: ""
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
    await expect(page.locator("body")).toContainText("Environment created");
    await expectNoWcagViolations(page);
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
    let pings = 0;
    let navigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations += 1;
    });
    await page.route("**/api/ping", async (route) => {
      pings += 1;
      await route.fulfill({
        status: pings <= 2 ? 503 : 200,
        contentType: "application/json",
        body: "{}"
      });
    });

    await gotoCanvas(page, canvas, "planned");
    await expectNoWcagViolations(page);
    const initialNavigations = navigations;
    await page.evaluate("window.dispatchEvent(new Event('focus'))");
    await expect.poll(() => pings).toBe(1);
    await expect(page.locator("#radius-reconnect-overlay")).toBeHidden();
    await page.evaluate("window.dispatchEvent(new Event('focus'))");
    await expect.poll(() => pings).toBe(2);
    await expect(page.locator("#radius-reconnect-overlay")).toBeVisible();
    await page.evaluate("window.dispatchEvent(new Event('focus'))");
    await expect.poll(() => pings).toBe(3);
    await expect.poll(() => navigations - initialNavigations).toBe(1);
    await expect(page).toHaveURL(/page=planned/);
  });
});
