import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  baseCanvasState,
  defaultFakeCliScenario,
  expect,
  PROFILE_NAME,
  REPOSITORY,
  test,
  WORKTREE_BRANCH,
  type CanvasHarness
} from "../e2e/support/canvas-harness.js";
import type { Page } from "@playwright/test";
import { COMMAND_RUN_LABEL } from "../../src/browser/command-action.js";
import type { CanvasGraphResource, CanvasState } from "../../src/shared.js";

type Theme = "dark" | "light";

type GraphRequestBody = { branch: string; repo: string; refresh?: boolean };

type GraphRequests = {
  loadGraph: GraphRequestBody[];
  planGraph: GraphRequestBody[];
};

function isGraphRequestBody(value: unknown): value is GraphRequestBody {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.branch === "string" && typeof candidate.repo === "string"
  );
}

const require = createRequire(import.meta.url);
const VISUAL_FONT_PATH =
  require.resolve("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2");
const VISUAL_FONT = fs.readFile(VISUAL_FONT_PATH, "base64");
const AZURE_SUBSCRIPTION_ID = "22222222-2222-2222-2222-222222222222";
const AZURE_RESOURCE_GROUP = "fixture-resource-group";
const AZURE_CLUSTER = "fixture-aks";

const GRAPH_RESOURCES: CanvasGraphResource[] = [
  {
    id: "app/web",
    name: "web",
    type: "Radius.Compute/containers",
    codeReference: "src/web/app.ts#L12",
    connections: [{ id: "app/cache", direction: "outbound" }],
    outputResources: [
      {
        id: "azure/cluster",
        name: "demo-cluster",
        type: "Microsoft.ContainerService/managedClusters",
        portalUrl: "https://portal.azure.com/fixture"
      }
    ]
  },
  {
    id: "app/cache",
    name: "cache",
    type: "Radius.Data/redisCaches",
    connections: []
  },
  {
    id: "azure/database",
    name: "orders-db",
    type: "Microsoft.DBforPostgreSQL/flexibleServers",
    connections: []
  }
];

const DIFF_RESOURCES: CanvasGraphResource[] = [
  {
    ...GRAPH_RESOURCES[0],
    connections: [{ id: "app/new-cache", direction: "Outbound" }],
    diffStatus: "modified"
  },
  { ...GRAPH_RESOURCES[1], id: "app/new-cache", diffStatus: "added" },
  { ...GRAPH_RESOURCES[2], diffStatus: "unchanged" },
  {
    id: "app/old-worker",
    name: "old-worker",
    type: "Radius.Compute/containers",
    connections: [],
    diffStatus: "removed"
  }
];

const THEMES: Record<Theme, Record<string, string>> = {
  light: {
    "--background-color-default": "#ffffff",
    "--border-color-default": "#d0d7de",
    "--border-color-muted": "#afb8c1",
    "--color-scheme": "light",
    "--font-sans": '"Phase 7 Inter", sans-serif',
    "--text-color-accent": "#0969da",
    "--text-color-accent-emphasis": "#0550ae",
    "--text-color-danger": "#cf222e",
    "--text-color-default": "#1f2328",
    "--text-color-muted": "#656d76",
    "--text-color-success": "#1a7f37",
    "--text-color-warning": "#9a6700"
  },
  dark: {
    "--background-color-default": "#0d1117",
    "--border-color-default": "#30363d",
    "--border-color-muted": "#484f58",
    "--color-scheme": "dark",
    "--font-sans": '"Phase 7 Inter", sans-serif',
    "--text-color-accent": "#58a6ff",
    "--text-color-accent-emphasis": "#79c0ff",
    "--text-color-danger": "#ff7b72",
    "--text-color-default": "#e6edf3",
    "--text-color-muted": "#8b949e",
    "--text-color-success": "#3fb950",
    "--text-color-warning": "#d29922"
  }
};

async function seed(
  canvas: CanvasHarness,
  state: CanvasState = {}
): Promise<void> {
  await Promise.all([
    fs.mkdir(path.join(canvas.workspacePath, ".radius"), { recursive: true }),
    fs.mkdir(path.join(canvas.workspacePath, "src", "web"), {
      recursive: true
    })
  ]);
  await fs.writeFile(
    path.join(canvas.workspacePath, ".radius", "app.bicep"),
    "extension radius\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(canvas.workspacePath, "src", "web", "app.ts"),
    "export const fixture = true;\n",
    "utf8"
  );
  const fakeCli = defaultFakeCliScenario();
  fakeCli.commands.push(
    {
      tool: "az",
      args: ["account", "set", "--subscription", AZURE_SUBSCRIPTION_ID],
      stdout: ""
    },
    {
      tool: "az",
      args: [
        "aks",
        "list",
        "--query",
        "[].{id:name, name:name, resourceGroup:resourceGroup}",
        "-o",
        "json",
        "--subscription",
        AZURE_SUBSCRIPTION_ID
      ],
      stdout: JSON.stringify([
        {
          id: AZURE_CLUSTER,
          name: AZURE_CLUSTER,
          resourceGroup: AZURE_RESOURCE_GROUP
        }
      ])
    },
    {
      tool: "az",
      args: [
        "group",
        "list",
        "--query",
        "[].{id:name, name:name}",
        "-o",
        "json",
        "--subscription",
        AZURE_SUBSCRIPTION_ID
      ],
      stdout: JSON.stringify([
        { id: AZURE_RESOURCE_GROUP, name: AZURE_RESOURCE_GROUP }
      ])
    },
    {
      tool: "az",
      args: [
        "aks",
        "get-credentials",
        "--name",
        AZURE_CLUSTER,
        "--resource-group",
        AZURE_RESOURCE_GROUP,
        "--overwrite-existing"
      ],
      stdout: ""
    },
    {
      tool: "kubectl",
      args: ["get", "namespaces", "-o", "jsonpath={.items[*].metadata.name}"],
      stdout: "default radius-system"
    }
  );
  await canvas.setScenario(fakeCli);
  await canvas.seedState({
    ...baseCanvasState(canvas.workspacePath),
    ...state
  });
}

async function gotoVisual(
  page: Page,
  canvas: CanvasHarness,
  canvasPage: string,
  theme: Theme
): Promise<void> {
  const visualFont = await VISUAL_FONT;
  await page.goto(`${canvas.baseUrl}/?page=${canvasPage}`);
  await page.waitForLoadState("domcontentloaded");
  const themeVariables = Object.entries(THEMES[theme])
    .map(([name, value]) => `${name}: ${value};`)
    .join("\n");
  await page.addStyleTag({
    content: `
      @font-face {
        font-family: "Phase 7 Inter";
        font-style: normal;
        font-weight: 100 900;
        src: url("data:font/woff2;base64,${visualFont}") format("woff2");
      }
      :root {
        ${themeVariables}
      }
      *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        caret-color: transparent !important;
        transition: none !important;
      }
      html { scroll-behavior: auto !important; }
      body { font-family: "Phase 7 Inter", sans-serif !important; }
    `
  });
  await page.waitForFunction("document.readyState === 'complete'");
  await page.evaluate(`(async () => {
    await Promise.all(
      ["300", "400", "500", "600", "700"].map((weight) =>
        document.fonts.load(weight + ' 16px "Phase 7 Inter"')
      )
    );
    await document.fonts.ready;
  })()`);
  const fontApplied = await page.evaluate(
    `document.fonts.check('400 16px "Phase 7 Inter"')`
  );
  expect(
    fontApplied,
    "the bundled visual font must be loaded before capturing a baseline"
  ).toBe(true);
}

async function screenshot(page: Page, name: string): Promise<void> {
  await expect(page).toHaveScreenshot(name, {
    fullPage: true
  });
}

async function openEnvironmentCreateForm(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New Environment" }).click();
  await page.locator("#env-profile-button").click();
  await page
    .locator("#env-profile-menu")
    .getByRole("option", { name: new RegExp(PROFILE_NAME) })
    .click();
  await page.locator("#env-step1-next").click();
  await expect(page.locator("#env-step-details")).toBeVisible();
  const recheck = page.locator("#env-gh-recheck");
  await expect(page.locator("#env-gh-account-button")).toHaveAccessibleName(
    "@repo-user"
  );
  await expect(page.locator("#env-gh-identity-note")).toHaveText(
    "Ready to configure deployments"
  );
  await expect(page.locator("#env-gh-technical-details")).toContainText(
    "credential source: keyring"
  );
  await expect(recheck).toHaveText("Re-check");
  await expect(recheck).toBeEnabled();
  await expect(page.locator("#deploy-btn")).toBeEnabled();
}

async function routeDeployments(
  page: Page,
  canvas: CanvasHarness,
  status?: "failed" | "success"
): Promise<void> {
  await page.route(
    `${canvas.baseUrl}/api/list-deployments?*`,
    async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          deployments:
            status ?
              [
                {
                  app: "radius-app",
                  environment: "fixture-environment",
                  status,
                  runUrl: `https://github.com/${REPOSITORY}/actions/runs/1`
                }
              ]
            : []
        })
      });
    }
  );
}

async function routeGraphControls(
  page: Page,
  canvas: CanvasHarness
): Promise<GraphRequests> {
  const loadGraph: GraphRequestBody[] = [];
  const planGraph: GraphRequestBody[] = [];
  await page.route(`${canvas.baseUrl}/api/load-graph`, async (route) => {
    const body: unknown = route.request().postDataJSON();
    if (isGraphRequestBody(body)) loadGraph.push(body);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ resources: GRAPH_RESOURCES })
    });
  });
  await page.route(`${canvas.baseUrl}/api/plan-graph`, async (route) => {
    const body: unknown = route.request().postDataJSON();
    if (isGraphRequestBody(body)) planGraph.push(body);
    // The planned page reconciles freshness on mount by re-posting with
    // `refresh`. The server answers that with `refreshed` when the cached graph
    // is still current, so the fixture has to as well: replying with an error
    // would drive the page down the failure path on every load.
    const refresh = isGraphRequestBody(body) && body.refresh === true;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        refresh ? { refreshed: true } : { error: "Fixture request completed." }
      )
    });
  });
  await page.route(
    `${canvas.baseUrl}/api/list-applications?*`,
    async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ applications: [{ name: "radius-app" }] })
      });
    }
  );
  await page.route(`${canvas.baseUrl}/api/discover-branches`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        branches: [
          { name: "main", sha: "1111111" },
          { name: WORKTREE_BRANCH, sha: "2222222" }
        ],
        workspaceBranch: WORKTREE_BRANCH
      })
    });
  });
  await page.route(
    `${canvas.baseUrl}/api/list-environments?*`,
    async (route) => {
      await route.fulfill({
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
    }
  );
  // The Planned pane reads deployment states before it opens its deploy
  // action, so leaving this route to the real server would make the captured
  // button state depend on the host the run happens to use.
  await routeDeployments(page, canvas);
  return { loadGraph, planGraph };
}

async function expectWorktreeBranchRequests(
  requests: GraphRequestBody[]
): Promise<void> {
  await expect
    .poll(
      () =>
        requests.length > 0 &&
        requests.every(
          (request) =>
            request.branch === WORKTREE_BRANCH && request.repo === REPOSITORY
        )
    )
    .toBe(true);
}

test.describe("Radius Canvas visual baselines", () => {
  test("VI-01 modeled graph details closed in light", async ({
    page,
    canvas
  }) => {
    await seed(canvas, {
      graphResources: GRAPH_RESOURCES,
      graphLoaded: true,
      graphFromWorkspace: true
    });
    const requests = await routeGraphControls(page, canvas);
    await gotoVisual(page, canvas, "graph", "light");
    await expect(page.locator(".rad-node")).toHaveCount(4);
    await expect(page.locator("#graph-app")).toHaveValue("radius-app");
    await expect(page.locator("#graph-branch")).toHaveValue(WORKTREE_BRANCH);
    await expectWorktreeBranchRequests(requests.loadGraph);
    await expect(page.locator("#node-popup")).toBeHidden();
    await screenshot(page, "vi-01-modeled-graph-light.png");
  });

  test("VI-01 modeled graph details closed in dark", async ({
    page,
    canvas
  }) => {
    await seed(canvas, {
      graphResources: GRAPH_RESOURCES,
      graphLoaded: true,
      graphFromWorkspace: true
    });
    const requests = await routeGraphControls(page, canvas);
    await gotoVisual(page, canvas, "graph", "dark");
    await expect(page.locator(".rad-node")).toHaveCount(4);
    await expect(page.locator("#graph-app")).toHaveValue("radius-app");
    await expect(page.locator("#graph-branch")).toHaveValue(WORKTREE_BRANCH);
    await expectWorktreeBranchRequests(requests.loadGraph);
    await expect(page.locator("#node-popup")).toBeHidden();
    await screenshot(page, "vi-01-modeled-graph-dark.png");
  });

  for (const theme of ["light", "dark"] as const) {
    test(`VI-02 modeled graph details in ${theme}`, async ({
      page,
      canvas
    }) => {
      await seed(canvas, {
        graphResources: GRAPH_RESOURCES,
        graphLoaded: true,
        graphFromWorkspace: true
      });
      const requests = await routeGraphControls(page, canvas);
      await gotoVisual(page, canvas, "graph", theme);
      await expect(page.locator("#graph-app")).toHaveValue("radius-app");
      await expect(page.locator("#graph-branch")).toHaveValue(WORKTREE_BRANCH);
      await expectWorktreeBranchRequests(requests.loadGraph);
      await page
        .locator(".rad-node")
        .filter({ hasText: "web" })
        .getByRole("button", { name: "Show details" })
        .click();
      await expect(page.locator("#node-popup")).toBeVisible();
      await screenshot(page, `vi-02-modeled-graph-details-${theme}.png`);
    });
  }

  for (const theme of ["light", "dark"] as const) {
    test(`VI-03 planned graph unresolved recipe pack in ${theme}`, async ({
      page,
      canvas
    }) => {
      await seed(canvas, {
        plannedResources: [
          {
            ...GRAPH_RESOURCES[0],
            deployStatus: "success"
          },
          {
            ...GRAPH_RESOURCES[1],
            deployStatus: "failed",
            deployMessage:
              "No recipe pack registered in this environment resolves Radius.Data/redisCaches."
          }
        ],
        plannedProvider: "azure",
        plannedEnvironment: "fixture-environment",
        plannedFromWorkspace: true
      });
      const requests = await routeGraphControls(page, canvas);
      await gotoVisual(page, canvas, "planned", theme);
      await expect(page.locator(".rad-node")).toHaveCount(2);
      await expect(page.locator("#planned-app")).toHaveValue("radius-app");
      await expect(page.locator("#planned-branch")).toHaveValue(
        WORKTREE_BRANCH
      );
      await expect(page.locator("#plan-btn")).toBeEnabled();
      await page.locator("#planned-branch").dispatchEvent("change");
      await expect(page.locator("#plan-btn")).toBeDisabled();
      await expectWorktreeBranchRequests(requests.planGraph);
      await gotoVisual(page, canvas, "planned", theme);
      await expect(page.locator(".rad-node")).toHaveCount(2);
      await page
        .locator(".rad-node")
        .filter({ hasText: "cache" })
        .getByRole("button", { name: "Show details" })
        .click();
      await expect(page.locator("#node-popup")).toContainText(
        "No recipe pack registered in this environment resolves Radius.Data/redisCaches."
      );
      await screenshot(page, `vi-03-planned-unresolved-${theme}.png`);
    });

    test(`VI-04 graph diff with all statuses in ${theme}`, async ({
      page,
      canvas
    }) => {
      await seed(canvas, {
        diffResources: DIFF_RESOURCES,
        diffBase: "main",
        diffHead: WORKTREE_BRANCH,
        diffTargetRepo: REPOSITORY,
        branches: ["main", WORKTREE_BRANCH],
        branchShas: { main: "1111111", [WORKTREE_BRANCH]: "2222222" }
      });
      await routeGraphControls(page, canvas);
      await gotoVisual(page, canvas, "graph-diff", theme);
      await expect(page.locator(".rad-node")).toHaveCount(5);
      await expect(page.locator(".react-flow__edge")).toHaveCount(1);
      await expect(page.locator("#base-branch")).toHaveValue("main");
      await expect(page.locator("#head-branch")).toHaveValue(WORKTREE_BRANCH);
      await expect(page.getByText("+1 added")).toBeVisible();
      await screenshot(page, `vi-04-graph-diff-all-statuses-${theme}.png`);
    });
  }

  for (const theme of ["light", "dark"] as const) {
    test(`VI-05 credential profile list in ${theme}`, async ({
      page,
      canvas
    }) => {
      await seed(canvas, { activeSubtab: "credentials" });
      await gotoVisual(page, canvas, "credentials", theme);
      await expect(page.getByText(PROFILE_NAME)).toBeVisible();
      await screenshot(page, `vi-05-credential-profile-list-${theme}.png`);
    });

    test(`VI-05 credential profile form in ${theme}`, async ({
      page,
      canvas
    }) => {
      await seed(canvas, { activeSubtab: "credentials" });
      await gotoVisual(page, canvas, "credentials", theme);
      await page
        .getByRole("button", { name: "New Credential Profile" })
        .click();
      await expect(page.locator("#cred-form")).toBeVisible();
      await expect(page.locator("#cred-ghcr-status")).toContainText(
        "using the stored GitHub CLI credential"
      );
      await screenshot(page, `vi-05-credential-profile-form-${theme}.png`);
    });
  }

  for (const theme of ["light", "dark"] as const) {
    test(`VI-06 environment list in ${theme}`, async ({ page, canvas }) => {
      await seed(canvas, { activeSubtab: "environments" });
      await gotoVisual(page, canvas, "environment", theme);
      await expect(page.getByText("fixture-environment")).toBeVisible();
      await screenshot(page, `vi-06-environment-list-${theme}.png`);
    });

    test(`VI-06 environment create form in ${theme}`, async ({
      page,
      canvas
    }) => {
      test.setTimeout(45_000);
      await seed(canvas, { activeSubtab: "environments" });
      await gotoVisual(page, canvas, "environment", theme);
      await openEnvironmentCreateForm(page);
      await expect(page.locator("#azure-discover-status")).toHaveText(
        "Found 1 cluster(s), 1 resource group(s)",
        { timeout: 15_000 }
      );
      await page.locator("#azure-rg-select").selectOption(AZURE_RESOURCE_GROUP);
      await page.locator("#azure-cluster-select").selectOption(AZURE_CLUSTER);
      await expect(page.locator("#azure-rg-select")).toHaveValue(
        AZURE_RESOURCE_GROUP
      );
      await expect(page.locator("#azure-cluster-select")).toHaveValue(
        AZURE_CLUSTER
      );
      await expect(page.locator("#azure-namespace-select")).toHaveValue(
        "default"
      );
      await screenshot(page, `vi-06-environment-create-${theme}.png`);
      const deploy = page.locator("#deploy-btn");
      await deploy.scrollIntoViewIfNeeded();
      await expect(page.locator("#env-identity-section")).toBeVisible();
      await expect(page.locator("#env-infra-section")).toBeVisible();
      await expect(deploy).toBeInViewport();
      await screenshot(page, `vi-06-environment-create-lower-${theme}.png`);
    });
  }

  for (const theme of ["light", "dark"] as const) {
    for (const status of ["success", "failed"] as const) {
      test(`VI-07 deploy ${status} in ${theme}`, async ({ page, canvas }) => {
        await seed(canvas);
        await routeDeployments(page, canvas, status);
        await gotoVisual(page, canvas, "deploying", theme);
        await expect(
          page
            .locator("#deploy-table-body")
            .getByText(status === "success" ? "Success" : "Failed", {
              exact: true
            })
        ).toBeVisible();
        await screenshot(page, `vi-07-deploy-${status}-${theme}.png`);
      });
    }
  }

  for (const theme of ["light", "dark"] as const) {
    test(`VI-08 run-command callout in ${theme}`, async ({ page, canvas }) => {
      test.setTimeout(45_000);
      await seed(canvas, { activeSubtab: "credentials" });
      // Drop write:packages from the keyring account. That is what turns the
      // GitHub Packages row from a verified note into a run-command callout,
      // which is the only state that renders the callout's styling.
      await canvas.setGitHubKeyringScopes(["repo"]);
      await gotoVisual(page, canvas, "credentials", theme);
      await page
        .getByRole("button", { name: "New Credential Profile" })
        .click();
      await expect(page.locator("#cred-form")).toBeVisible();

      const row = page.locator("#cred-ghcr-command-row");
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.scrollIntoViewIfNeeded();

      // Pin the callout itself: the command text, Copy, and Run with Copilot.
      await expect(row).toContainText("gh auth refresh");
      await expect(
        row.getByRole("button", { name: COMMAND_RUN_LABEL })
      ).toBeVisible();
      await expect(row.getByRole("button", { name: "Copy" })).toBeVisible();
      await expect(page.locator("#cred-ghcr-retry")).toBeVisible();

      await screenshot(page, `vi-08-run-command-callout-${theme}.png`);
    });

    test(`VI-09 wizard github access callout in ${theme}`, async ({
      page,
      canvas
    }) => {
      test.setTimeout(45_000);
      await seed(canvas, { activeSubtab: "environments" });
      // The wizard reports its own readiness, so dropping the scopes here is
      // what turns its GitHub access warning from prose into a callout. No
      // other baseline covers this surface, which is how it shipped as plain
      // text after the rest of the run-command work landed.
      await canvas.setGitHubKeyringScopes(["repo"]);
      await gotoVisual(page, canvas, "environment", theme);
      await page.getByRole("button", { name: "New Environment" }).click();
      await page.locator("#env-profile-button").click();
      await page
        .locator("#env-profile-menu")
        .getByRole("option", { name: new RegExp(PROFILE_NAME) })
        .click();
      await page.locator("#env-step1-next").click();
      await expect(page.locator("#env-step-details")).toBeVisible();

      const repair = page.locator("#env-gh-repair");
      await expect(repair).toBeVisible({ timeout: 15_000 });
      await repair.scrollIntoViewIfNeeded();

      // The command must be an actionable callout rather than a paragraph
      // with the command buried in it.
      await expect(repair).toContainText("gh auth switch");
      await expect(repair).not.toContainText("In the terminal, run");
      await expect(
        repair.getByRole("button", { name: COMMAND_RUN_LABEL })
      ).toBeVisible();
      await expect(repair.getByRole("button", { name: "Copy" })).toBeVisible();

      await screenshot(page, `vi-09-wizard-github-callout-${theme}.png`);
    });
  }
});
