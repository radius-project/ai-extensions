import { promises as fs } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { CanvasGraphResource, CanvasState } from "../../src/shared.js";
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

const THEMES: readonly ColorScheme[] = ["light", "dark"];
type ColorScheme = "light" | "dark";

const HOST_THEME_TOKENS: Record<ColorScheme, string> = {
  light: [
    "--color-scheme: light",
    "--background-color-default: #ffffff",
    "--text-color-default: #1f2328",
    "--text-color-muted: #656d76",
    "--border-color-default: #d0d7de",
    "--text-color-accent: #0969da",
    "--text-color-accent-emphasis: #0550ae",
    "--text-color-success: #1a7f37",
    "--text-color-warning: #9a6700",
    "--text-color-danger: #cf222e"
  ].join(";"),
  dark: [
    "--color-scheme: dark",
    "--background-color-default: #0d1117",
    "--text-color-default: #e6edf3",
    "--text-color-muted: #8b949e",
    "--border-color-default: #30363d",
    "--text-color-accent: #58a6ff",
    "--text-color-accent-emphasis: #79c0ff",
    "--text-color-success: #3fb950",
    "--text-color-warning: #d29922",
    "--text-color-danger: #f85149"
  ].join(";")
};

function modeledResources(): CanvasGraphResource[] {
  return [
    {
      id: "app/web",
      name: "web",
      type: "Radius.Compute/containers",
      codeReference: "src/web/app.ts#L12",
      connections: [{ id: "app/db" }],
      outputResources: [
        {
          id: "azure/cluster",
          name: "demo-cluster",
          type: "Microsoft.ContainerService/managedClusters"
        }
      ]
    },
    {
      id: "app/db",
      name: "db",
      type: "Radius.Data/redisCaches",
      connections: []
    }
  ];
}

function diffResources(): CanvasGraphResource[] {
  return [
    {
      id: "app/web",
      name: "web",
      type: "Radius.Compute/containers",
      diffStatus: "modified",
      codeReference: "src/web/app.ts#L12",
      connections: [{ id: "app/db", diffStatus: "unchanged" }]
    },
    {
      id: "app/db",
      name: "db",
      type: "Radius.Data/redisCaches",
      diffStatus: "unchanged",
      connections: []
    },
    {
      id: "app/worker",
      name: "worker",
      type: "Radius.Compute/containers",
      diffStatus: "added",
      connections: [{ id: "app/db", diffStatus: "added" }]
    },
    {
      id: "app/queue",
      name: "queue",
      type: "Radius.Messaging/rabbitMQQueues",
      diffStatus: "removed",
      connections: []
    }
  ];
}

async function seed(canvas: CanvasHarness, state: CanvasState): Promise<void> {
  await fs.mkdir(path.join(canvas.workspacePath, "src", "web"), {
    recursive: true
  });
  await fs.writeFile(
    path.join(canvas.workspacePath, "src", "web", "app.ts"),
    "// fixed visual fixture\n".repeat(16),
    "utf8"
  );
  await fs.writeFile(
    path.join(canvas.workspacePath, ".radius", "app.bicep"),
    [
      "extension radius",
      "",
      "resource app 'Applications.Core/applications@2023-10-01-preview' = {",
      "  name: 'fixture-store'",
      "}"
    ].join("\n"),
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
  theme: ColorScheme
): Promise<void> {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.goto(`${canvas.baseUrl}/?page=${canvasPage}`);
  await page.waitForLoadState("domcontentloaded");
  await page.addStyleTag({
    content: `:root { ${HOST_THEME_TOKENS[theme]}; } html { font-family: "DejaVu Sans", sans-serif; } *, *::before, *::after { caret-color: transparent !important; }`
  });
  await page.evaluate("document.fonts.ready");
}

async function screenshot(page: Page, name: string): Promise<void> {
  await expect(page).toHaveScreenshot(name, { fullPage: true });
}

async function openEnvironmentDetails(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New Environment" }).click();
  const profile = page.locator("#env-profile-button");
  await profile.click();
  await page
    .locator("#env-profile-menu")
    .getByRole("option", { name: new RegExp(PROFILE_NAME) })
    .click();
  await page.locator("#env-step1-next").click();
  await expect(page.locator("#env-step-details")).toBeVisible();
}

test.describe("P2-A Radius Canvas visual baselines", () => {
  test("VI-01 modeled graph with details closed in light and dark themes", async ({
    page,
    canvas
  }) => {
    await seed(canvas, {
      graphResources: modeledResources(),
      graphLoaded: true,
      graphFromWorkspace: true
    });

    for (const theme of THEMES) {
      await gotoVisual(page, canvas, "graph", theme);
      await expect(page.locator(".rad-node")).toHaveCount(3);
      await expect(page.locator("#graph-app")).toContainText("radius-app");
      await expect(page.locator("#node-popup")).toBeHidden();
      await screenshot(page, `vi-01-modeled-graph-${theme}.png`);
    }
  });

  test("VI-02 modeled graph details in light theme", async ({
    page,
    canvas
  }) => {
    await seed(canvas, {
      graphResources: modeledResources(),
      graphLoaded: true,
      graphFromWorkspace: true
    });
    await gotoVisual(page, canvas, "graph", "light");
    await expect(page.locator(".rad-node")).toHaveCount(3);
    await expect(page.locator("#graph-app")).toContainText("radius-app");
    await page
      .locator(".rad-node")
      .filter({ hasText: "web" })
      .getByRole("button", { name: "Show details" })
      .click();
    await expect(page.locator("#node-popup")).toBeVisible();

    await screenshot(page, "vi-02-modeled-graph-details-light.png");
  });

  test("VI-03 planned graph with an unresolved recipe pack in light and dark themes", async ({
    page,
    canvas
  }) => {
    await seed(canvas, {
      plannedResources: [],
      plannedEnvironment: "fixture-environment",
      plannedProvider: "azure",
      plannedFromWorkspace: true
    });
    await page.route("**/api/plan-graph", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          error:
            "No recipe pack providing Radius.Data/redisCaches is registered in fixture-environment."
        })
      });
    });

    for (const theme of THEMES) {
      await gotoVisual(page, canvas, "planned", theme);
      await expect(page.locator("#plan-status")).toContainText(
        "No recipe pack providing Radius.Data/redisCaches is registered in fixture-environment."
      );
      await expect(page.locator("#planned-app")).toContainText("radius-app");
      await expect(page.getByText("Generating Application Graph")).toHaveCount(
        0
      );
      await expect(page.locator(".rad-node")).toHaveCount(0);
      await screenshot(page, `vi-03-planned-unresolved-recipe-${theme}.png`);
    }
  });

  test("VI-04 graph diff with every status in light and dark themes", async ({
    page,
    canvas
  }) => {
    await seed(canvas, {
      diffResources: diffResources(),
      diffTargetRepo: REPOSITORY,
      diffBase: "main",
      diffHead: WORKTREE_BRANCH,
      branches: ["main", WORKTREE_BRANCH],
      branchShas: { main: "1111111", [WORKTREE_BRANCH]: "2222222" }
    });
    const diffScenario = defaultFakeCliScenario();
    for (const command of diffScenario.commands) {
      if (
        command.tool === "gh" &&
        command.args?.[0] === "api" &&
        command.args?.[1] === "--paginate" &&
        command.args?.[2]?.includes("/branches?per_page=100")
      ) {
        command.stdout =
          command.args.includes("--jq") ?
            `main\n${WORKTREE_BRANCH}\n`
          : JSON.stringify([
              { name: "main", commit: { sha: "1111111" } },
              { name: WORKTREE_BRANCH, commit: { sha: "2222222" } }
            ]);
      }
    }
    await canvas.setScenario(diffScenario);

    for (const theme of THEMES) {
      await gotoVisual(page, canvas, "graph-diff", theme);
      await expect(page.locator(".rad-node")).toHaveCount(4);
      await expect(page.locator("#diff-app")).toContainText("radius-app");
      await expect(page.locator("#base-branch")).toHaveValue("main");
      await expect(page.locator("#head-branch")).toHaveValue(WORKTREE_BRANCH);
      await expect(page.getByText("+1 added")).toBeVisible();
      await expect(page.getByText("-1 removed")).toBeVisible();
      await expect(page.getByText("~1 modified")).toBeVisible();
      await screenshot(page, `vi-04-graph-diff-all-statuses-${theme}.png`);
    }
  });

  test("VI-05 credential profile list and form in light theme", async ({
    page,
    canvas
  }) => {
    await seed(canvas, { activeSubtab: "credentials" });
    await gotoVisual(page, canvas, "credentials", "light");
    await expect(page.getByText(PROFILE_NAME)).toBeVisible();
    await screenshot(page, "vi-05-credential-profile-list-light.png");

    await page.getByRole("button", { name: "New Credential Profile" }).click();
    await expect(page.locator("#cred-form")).toBeVisible();
    await expect(page.locator("#cred-ghcr-status")).toContainText(
      "GitHub Packages access verified"
    );
    await screenshot(page, "vi-05-credential-profile-form-light.png");
  });

  test("VI-06 environment list and create form in light and dark themes", async ({
    page,
    canvas
  }) => {
    await seed(canvas, { activeSubtab: "environments" });
    await page.route("**/api/github-identity?repo=**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          actingLogin: "repo-user",
          displayLogin: "repo-user",
          mismatch: false,
          actingHasWorkflow: true,
          actingHasPackages: true,
          accounts: [
            {
              login: "repo-user",
              active: true,
              hasWorkflow: true,
              hasPackages: true,
              switchable: true
            }
          ]
        })
      });
    });
    await page.route("**/api/discover", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          clusters: [
            {
              id: "fixture-cluster",
              name: "fixture-cluster",
              resourceGroup: "fixture-rg"
            }
          ],
          resourceGroups: [
            { id: "fixture-rg", name: "fixture-rg", resourceGroup: "" }
          ],
          namespaces: ["default", "radius-system"],
          vpcs: [],
          subnets: []
        })
      });
    });

    for (const theme of THEMES) {
      await gotoVisual(page, canvas, "environment", theme);
      await expect(page.getByText("fixture-environment")).toBeVisible();
      await screenshot(page, `vi-06-environment-list-${theme}.png`);

      await openEnvironmentDetails(page);
      await expect(page.locator("#env-gh-account-value")).toHaveText(/^@/);
      await expect(page.locator("#env-gh-identity-note")).toContainText(
        "Acts as"
      );
      await expect(page.locator("#azure-discover-status")).toHaveText(
        "Found 1 cluster(s), 1 resource group(s)"
      );
      await expect(
        page.locator('#azure-rg-select option[value="fixture-rg"]')
      ).toHaveText("fixture-rg");
      await screenshot(page, `vi-06-environment-create-form-${theme}.png`);
    }
  });

  test("VI-07 deployment success and failure in light theme", async ({
    page,
    canvas
  }) => {
    await seed(canvas, {
      deployResult: {
        message: "Deployment started for fixture-store in fixture-environment.",
        workflowUrl: "https://github.com/fixture/radius-app/actions/runs/1001"
      }
    });
    await gotoVisual(page, canvas, "environment", "light");
    await expect(page.getByText("Deployment Initiated")).toBeVisible();
    await screenshot(page, "vi-07-deploy-success-light.png");

    await canvas.seedState({
      ...baseCanvasState(canvas.workspacePath),
      deployResult: {
        error:
          "The deployment workflow failed before provisioning any resources."
      }
    });
    await gotoVisual(page, canvas, "environment", "light");
    await expect(page.getByText("Deployment Failed")).toBeVisible();
    await screenshot(page, "vi-07-deploy-failure-light.png");
  });
});
