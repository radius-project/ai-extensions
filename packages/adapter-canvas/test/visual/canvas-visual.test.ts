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
import type { CanvasGraphResource, CanvasState } from "../../src/shared.js";

type Theme = "dark" | "light";

type GraphRequestBody = { branch: string; repo: string };

type GraphRequests = { loadGraph: GraphRequestBody[] };

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
  { ...GRAPH_RESOURCES[0], diffStatus: "modified" },
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
  await fs.mkdir(path.join(canvas.workspacePath, "src", "web"), {
    recursive: true
  });
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
  await canvas.setScenario(defaultFakeCliScenario());
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
  const visualFont = await fs.readFile(VISUAL_FONT_PATH, "base64");
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
  await page.waitForFunction(
    "document.readyState === 'complete' && document.fonts.status === 'loaded'"
  );
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
}

async function routeDeployments(
  page: Page,
  status: "failed" | "success"
): Promise<void> {
  await page.route("**/api/list-deployments?*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        deployments: [
          {
            app: "radius-app",
            environment: "fixture-environment",
            status,
            runUrl: `https://github.com/${REPOSITORY}/actions/runs/1`
          }
        ]
      })
    });
  });
}

async function routeGraphControls(page: Page): Promise<GraphRequests> {
  const loadGraph: GraphRequestBody[] = [];
  await page.route("**/api/load-graph", async (route) => {
    const body: unknown = route.request().postDataJSON();
    if (isGraphRequestBody(body)) loadGraph.push(body);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ resources: GRAPH_RESOURCES })
    });
  });
  await page.route("**/api/list-applications?*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ applications: [{ name: "radius-app" }] })
    });
  });
  await page.route("**/api/discover-branches", async (route) => {
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
  await page.route("**/api/list-environments?*", async (route) => {
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
  });
  return { loadGraph };
}

async function expectWorktreeBranchRequests(
  requests: GraphRequests
): Promise<void> {
  await expect
    .poll(() => requests.loadGraph.map((request) => request.branch))
    .toContain(WORKTREE_BRANCH);
  expect(
    requests.loadGraph.every((request) => request.branch === WORKTREE_BRANCH)
  ).toBe(true);
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
    const requests = await routeGraphControls(page);
    await gotoVisual(page, canvas, "graph", "light");
    await expect(page.locator(".rad-node")).toHaveCount(4);
    await expect(page.locator("#graph-app")).toHaveValue("radius-app");
    await expect(page.locator("#graph-branch")).toHaveValue(WORKTREE_BRANCH);
    await expectWorktreeBranchRequests(requests);
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
    await routeGraphControls(page);
    await gotoVisual(page, canvas, "graph", "dark");
    await expect(page.locator(".rad-node")).toHaveCount(4);
    await expect(page.locator("#graph-app")).toHaveValue("radius-app");
    await expect(page.locator("#node-popup")).toBeHidden();
    await screenshot(page, "vi-01-modeled-graph-dark.png");
  });

  test("VI-02 modeled graph details in light", async ({ page, canvas }) => {
    await seed(canvas, {
      graphResources: GRAPH_RESOURCES,
      graphLoaded: true,
      graphFromWorkspace: true
    });
    await routeGraphControls(page);
    await gotoVisual(page, canvas, "graph", "light");
    await expect(page.locator("#graph-app")).toHaveValue("radius-app");
    await page
      .locator(".rad-node")
      .filter({ hasText: "web" })
      .getByRole("button", { name: "Show details" })
      .click();
    await expect(page.locator("#node-popup")).toBeVisible();
    await screenshot(page, "vi-02-modeled-graph-details-light.png");
  });

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
      await routeGraphControls(page);
      await gotoVisual(page, canvas, "planned", theme);
      await expect(page.locator(".rad-node")).toHaveCount(2);
      await expect(page.locator("#planned-app")).toHaveValue("radius-app");
      await expect(page.locator("#planned-branch")).toHaveValue(
        WORKTREE_BRANCH
      );
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
      await routeGraphControls(page);
      await gotoVisual(page, canvas, "graph-diff", theme);
      await expect(page.locator(".rad-node")).toHaveCount(5);
      await expect(page.locator("#base-branch")).toHaveValue("main");
      await expect(page.locator("#head-branch")).toHaveValue(WORKTREE_BRANCH);
      await expect(page.getByText("+1 added")).toBeVisible();
      await screenshot(page, `vi-04-graph-diff-all-statuses-${theme}.png`);
    });
  }

  test("VI-05 credential profile list in light", async ({ page, canvas }) => {
    await seed(canvas, { activeSubtab: "credentials" });
    await gotoVisual(page, canvas, "credentials", "light");
    await expect(page.getByText(PROFILE_NAME)).toBeVisible();
    await screenshot(page, "vi-05-credential-profile-list-light.png");
  });

  test("VI-05 credential profile form in light", async ({ page, canvas }) => {
    await seed(canvas, { activeSubtab: "credentials" });
    await gotoVisual(page, canvas, "credentials", "light");
    await page.getByRole("button", { name: "New Credential Profile" }).click();
    await expect(page.locator("#cred-form")).toBeVisible();
    await screenshot(page, "vi-05-credential-profile-form-light.png");
  });

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
      await seed(canvas, { activeSubtab: "environments" });
      await gotoVisual(page, canvas, "environment", theme);
      await openEnvironmentCreateForm(page);
      await screenshot(page, `vi-06-environment-create-${theme}.png`);
    });
  }

  for (const status of ["success", "failed"] as const) {
    test(`VI-07 deploy ${status} in light`, async ({ page, canvas }) => {
      await seed(canvas);
      await routeDeployments(page, status);
      await gotoVisual(page, canvas, "deploying", "light");
      await expect(
        page
          .locator("#deploy-table-body")
          .getByText(status === "success" ? "Success" : "Failed", {
            exact: true
          })
      ).toBeVisible();
      await screenshot(page, `vi-07-deploy-${status}-light.png`);
    });
  }
});
