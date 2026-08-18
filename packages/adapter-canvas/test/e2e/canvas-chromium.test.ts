import { promises as fs } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import {
  baseCanvasState,
  defaultFakeCliScenario,
  expect,
  PLACEHOLDER_SECRET,
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

test.describe("Radius Canvas in Chromium", () => {
  test.beforeEach(async ({ canvas }) => {
    await seed(canvas);
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
    await canvas.expectCliInvoked("rad");
    expect(
      (await canvas.cliCalls()).some(
        (call) => call.tool === "rad" && call.args[0] === "app"
      )
    ).toBe(true);
    await expect(page.locator(".rad-node")).toHaveCount(3);
    await expect(page.locator(".rad-node__title")).toHaveText([
      "web",
      "demo-cluster",
      "db"
    ]);
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
    await page.getByRole("button", { name: "New Environment" }).click();

    const note = page.locator("#env-gh-identity-note");
    await expect(note).toBeVisible();
    await expect(note).toContainText(
      "is missing the workflow and write:packages scopes"
    );
    await expect(page.locator("body")).not.toContainText(PLACEHOLDER_SECRET);
    await expect(page.locator("#env-gh-account-button")).toHaveAccessibleName(
      "@acting-user"
    );
    await expectNoWcagViolations(page);
    await canvas.expectCliInvoked("gh");
  });

  test("recovers from the scope warning when Re-check is activated by keyboard", async ({
    page,
    canvas
  }) => {
    await canvas.setGitHubKeyringScopes(["repo"]);
    await gotoCanvas(page, canvas, "environment");
    await page.getByRole("button", { name: "New Environment" }).click();

    const note = page.locator("#env-gh-identity-note");
    const recheck = page.getByRole("button", { name: "Re-check" });
    await expect(note).toContainText(
      "is missing the workflow and write:packages scopes"
    );
    await expect(recheck).toBeVisible();

    // The keyring account now carries the scopes setup needs.
    await canvas.setGitHubKeyringScopes(["repo", "workflow", "write:packages"]);
    canvas.setGitHubToken(null);
    await recheck.focus();
    await expect(recheck).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(note).toContainText("Acts as");
    await expect(note).not.toContainText(
      "is missing the workflow and write:packages scopes"
    );
    await expect(recheck).toBeHidden();
    await expect(page.locator("body")).not.toContainText(PLACEHOLDER_SECRET);
    await expectNoWcagViolations(page);
  });

  test("switches GitHub accounts through the real listbox and returns focus to the combo", async ({
    page,
    canvas
  }) => {
    canvas.setGitHubToken(null);
    await gotoCanvas(page, canvas, "environment");
    await page.locator("#new-env-btn").focus();
    await page.keyboard.press("Enter");

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
    expect(bodyFor(canvas, "/api/github-account")).toEqual({
      login: "acting-user"
    });
    await expect
      .poll(async () =>
        (await canvas.cliCalls()).some(
          (call) =>
            call.tool === "gh" &&
            JSON.stringify(call.args) ===
              JSON.stringify(["auth", "switch", "--user", "acting-user"])
        )
      )
      .toBe(true);
    await expectNoWcagViolations(page);
  });

  test("switches GitHub accounts through the real identity routes", async ({
    page,
    canvas
  }) => {
    await gotoCanvas(page, canvas, "environment");
    const result = await page.evaluate(async () => {
      const response = await fetch("/api/github-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login: "acting-user" })
      });
      return (await response.json()) as { success?: boolean };
    });
    expect(result.success).toBe(true);
    expect(bodyFor(canvas, "/api/github-account")).toEqual({
      login: "acting-user"
    });
    await expect
      .poll(async () =>
        (await canvas.cliCalls()).some(
          (call) =>
            call.tool === "gh" &&
            JSON.stringify(call.args) ===
              JSON.stringify(["auth", "switch", "--user", "acting-user"])
        )
      )
      .toBe(true);
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
    const result = await page.evaluate(
      async ({ tenantId, subscriptionId }) => {
        const response = await fetch("/api/verify-azure-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tenantId, subscriptionId })
        });
        return (await response.json()) as { error?: string };
      },
      { tenantId: VALID_TENANT_ID, subscriptionId: VALID_SUBSCRIPTION_ID }
    );
    expect(result.error).toContain("No active Azure session");
    expect(JSON.stringify(result)).not.toContain(PLACEHOLDER_SECRET);
    await expect(page.locator("body")).not.toContainText(PLACEHOLDER_SECRET);
    await canvas.expectCliInvoked("az");
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
    const result = await page.evaluate(
      async ({ repo, branch, tenantId, subscriptionId }) => {
        const response = await fetch("/api/operations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repo,
            environment: "fixture-environment",
            provider: "azure",
            branch,
            tenantId,
            subscriptionId,
            resourceGroup: "fixture-rg",
            cluster: "fixture-cluster",
            namespace: "default",
            profileName: "fixture-profile"
          })
        });
        return (await response.json()) as { operationId: string };
      },
      {
        repo: REPOSITORY,
        branch: WORKTREE_BRANCH,
        tenantId: VALID_TENANT_ID,
        subscriptionId: VALID_SUBSCRIPTION_ID
      }
    );
    expect(result.operationId).toMatch(/^op_/);

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
    // story, even though the page that started it was torn down twice.
    await expect(
      page.getByRole("link", {
        name: 'Creating environment "fixture-environment" failed.'
      })
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText("cancelled");
    await expect(page.locator("body")).not.toContainText("Cancelled");
    expect(bodyFor(canvas, "/api/operations")).toMatchObject({
      repo: REPOSITORY,
      environment: "fixture-environment",
      branch: WORKTREE_BRANCH
    });
  });

  test("dispatch refusal preserves the selected worktree branch in the real deploy request @safety", async ({
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
    const result = await page.evaluate(
      async ({ repo, branch }) => {
        const response = await fetch("/api/deploy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            environment: "fixture-environment",
            provider: "azure",
            targetRepo: repo,
            branch,
            appFile: ".radius/app.bicep"
          })
        });
        return (await response.json()) as { error?: string };
      },
      { repo: REPOSITORY, branch: WORKTREE_BRANCH }
    );
    expect(result.error).toContain("Could not verify");
    expect(bodyFor(canvas, "/api/deploy")).toEqual({
      environment: "fixture-environment",
      provider: "azure",
      targetRepo: REPOSITORY,
      branch: WORKTREE_BRANCH,
      appFile: ".radius/app.bicep"
    });
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

  test("reveals the environment form by keyboard and returns focus to the reveal control", async ({
    page,
    canvas
  }) => {
    await gotoCanvas(page, canvas, "environment");
    const newEnvironment = page.locator("#new-env-btn");
    await newEnvironment.focus();
    await expect(newEnvironment).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page.locator("#env-form")).toBeVisible();
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
