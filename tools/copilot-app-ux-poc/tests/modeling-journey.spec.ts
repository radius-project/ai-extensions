import { existsSync } from "node:fs";
import path from "node:path";
import type { Frame, Page, Response } from "@playwright/test";
import { test, expect } from "../fixtures/app.ts";
import {
  readSessionInfo,
  startSessionFromNewPage
} from "../fixtures/app-ui.ts";
import { runCommand, runOrThrow } from "../fixtures/commands.ts";
import {
  MODEL_FILES,
  canvasPageUrl,
  classifyBaselineModel,
  classifyModelProgress,
  findDeleteRefusalProblems,
  generateEnvironmentName,
  hasDeployment,
  modelingPrompt,
  readDeployStatus,
  readDeploymentRows,
  readJourneyConfig,
  readOperationId,
  readOperationSnapshot,
  readSingleApplicationName,
  repositoryListingPath,
  type JourneyConfig
} from "../fixtures/journey.ts";
import {
  attachRadiusCanvas,
  type AttachedRadiusCanvas,
  type CanvasTarget
} from "../fixtures/radius-canvas.ts";

// Opt-in. This journey sends a prompt, pushes to the fixture repository, and
// creates and deletes real Azure and GitHub resources. See README.md.
const setup = readJourneyConfig(process.env, () =>
  generateEnvironmentName(Date.now(), Math.random())
);

const MINUTE = 60_000;
const MODEL_TIMEOUT_MS = 30 * MINUTE;
const GRAPH_TIMEOUT_MS = 3 * MINUTE;
const CREDENTIAL_VERIFY_TIMEOUT_MS = 2 * MINUTE;
const CREATE_OPERATION_TIMEOUT_MS = 20 * MINUTE;
const DEPLOY_TIMEOUT_MS = 45 * MINUTE;
const LISTING_TIMEOUT_MS = 10 * MINUTE;
const DELETE_DEPLOYMENT_TIMEOUT_MS = 45 * MINUTE;
const DELETE_ENVIRONMENT_TIMEOUT_MS = 31 * MINUTE;
const JOURNEY_TIMEOUT_MS = 4 * 60 * MINUTE;

function pageOf(target: CanvasTarget): Page {
  return "parentFrame" in target ? (target as Frame).page() : target;
}

async function gotoCanvasPage(
  target: CanvasTarget,
  page: string
): Promise<void> {
  await target.goto(canvasPageUrl(target.url(), page));
  await target.waitForLoadState("domcontentloaded");
}

function waitForPost(target: CanvasTarget, route: string): Promise<Response> {
  return pageOf(target).waitForResponse(
    (response) =>
      new URL(response.url()).pathname === route &&
      response.request().method() === "POST",
    { timeout: 2 * MINUTE }
  );
}

async function fetchJson(
  target: CanvasTarget,
  route: string
): Promise<{ status: number; body: unknown }> {
  return target.evaluate(async (url) => {
    const response = await fetch(url);
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Keep the raw text; the caller's parser reports it.
    }
    return { status: response.status, body };
  }, route);
}

async function pollOperation(
  target: CanvasTarget,
  operationId: string,
  timeout: number
): Promise<ReturnType<typeof readOperationSnapshot>> {
  let last = readOperationSnapshot({ operation: { state: "pending" } });
  await expect
    .poll(
      async () => {
        const { status, body } = await fetchJson(
          target,
          `/api/operations/${encodeURIComponent(operationId)}`
        );
        if (status !== 200) {
          throw new Error(
            `Operation ${operationId} returned HTTP ${status}: ${JSON.stringify(body)}`
          );
        }
        last = readOperationSnapshot(body);
        return last.terminal;
      },
      { timeout, intervals: [5_000] }
    )
    .toBe(true);
  return last;
}

/**
 * Reads a value that the product itself retries. A failed read returns
 * `undefined`, so polling continues; the last failure goes into the timeout
 * message.
 */
function tolerant<T>(read: () => Promise<T>): {
  read: () => Promise<T | undefined>;
  last: () => string;
} {
  let failure = "";
  return {
    read: async () => {
      try {
        const value = await read();
        failure = "";
        return value;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        return undefined;
      }
    },
    last: () => failure || "<no failure>"
  };
}

/**
 * Polls until `read` returns `expected`. On timeout, the error also has the
 * detail from `describe`, because `expect.poll` takes only a fixed message.
 */
async function pollUntil<T>(
  read: () => Promise<T>,
  expected: T,
  options: { describe: () => string; timeout: number; intervals: number[] }
): Promise<void> {
  try {
    await expect
      .poll(read, { timeout: options.timeout, intervals: options.intervals })
      .toBe(expected);
  } catch (error) {
    throw new Error(
      `${options.describe()}\n${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

async function readRemoteHead(config: JourneyConfig): Promise<string> {
  return runOrThrow("gh", [
    "api",
    `repos/${config.repository}/git/ref/heads/${config.defaultBranch}`,
    "--jq",
    ".object.sha"
  ]);
}

async function githubEnvironmentExists(
  config: JourneyConfig
): Promise<boolean> {
  const result = await runCommand("gh", [
    "api",
    `repos/${config.repository}/environments/${config.environmentName}`
  ]);
  if (result.code === 0) return true;
  if (/HTTP 404|Not Found/i.test(result.stderr)) return false;
  throw new Error(
    `Could not read GitHub environment ${config.environmentName}: ${result.stderr.trim()}`
  );
}

async function ensureCredentialProfile(
  target: CanvasTarget,
  config: JourneyConfig
): Promise<void> {
  await gotoCanvasPage(target, "environment");
  await target.locator("#new-env-btn").click();
  await expect(target.locator("#env-form")).toBeVisible();
  await target.locator("#env-profile-button").click();
  const existing = target
    .locator("#env-profile-menu")
    .getByRole("option", { name: new RegExp(config.credentialProfile) });
  if ((await existing.count()) > 0) {
    return;
  }

  await gotoCanvasPage(target, "credentials");
  await target.getByRole("button", { name: "New Credential Profile" }).click();
  await target.getByLabel("Profile Name").fill(config.credentialProfile);
  await target.getByLabel("Tenant ID").fill(config.tenantId);
  await target.getByLabel("Subscription ID").fill(config.subscriptionId);
  await target.getByRole("button", { name: "Verify Credentials" }).click();
  await expect(target.locator("#cred-verify-status")).toBeVisible({
    timeout: CREDENTIAL_VERIFY_TIMEOUT_MS
  });
  const save = target.locator("#save-cred-btn:not([disabled])");
  await expect(save).toBeVisible({ timeout: CREDENTIAL_VERIFY_TIMEOUT_MS });
  await save.click();
  await expect(target.locator("#cred-landing")).toBeVisible();

  await gotoCanvasPage(target, "environment");
  await target.locator("#new-env-btn").click();
  await expect(target.locator("#env-form")).toBeVisible();
  await target.locator("#env-profile-button").click();
}

test.describe("modeling journey (opt-in, changes cloud state)", () => {
  test.skip(!setup.enabled, setup.enabled ? "" : setup.reason);

  test("models a clean fixture, then deploys and deletes it through the Radius canvas", async ({
    appBrowser,
    appPage,
    cdpUrl
  }, testInfo) => {
    if (!setup.enabled) return;
    const config = setup.config;
    testInfo.setTimeout(JOURNEY_TIMEOUT_MS);
    const note = (type: string, description: string) =>
      testInfo.annotations.push({ type, description });
    note("fixture", `${config.repository} @ ${config.baselineSha}`);
    note("environment", config.environmentName);

    let canvas: AttachedRadiusCanvas | undefined;
    let pushedToDefaultBranch = false;
    let environmentCreated = false;
    let environmentDeleted = false;
    let deployment: { app: string; deleted: boolean } | undefined;

    try {
      await test.step("check that the fixture is clean", async () => {
        expect(
          await readRemoteHead(config),
          `${config.repository}@${config.defaultBranch} must be at the baseline. Reset it before the run.`
        ).toBe(config.baselineSha);
        const model = classifyBaselineModel(
          await runCommand("gh", [
            "api",
            `repos/${config.repository}/contents/.radius/app.bicep?ref=${config.baselineSha}`
          ])
        );
        expect(
          model,
          "The fixture baseline must not contain .radius/app.bicep"
        ).toBe("absent");
      });

      const session =
        await test.step("start a session and run the app-modeling skill", async () => {
          const sessionId = await startSessionFromNewPage(appPage, {
            projectName: config.projectName,
            prompt: modelingPrompt()
          });
          note("session", sessionId);
          const info = await readSessionInfo(appPage);
          expect(info.sessionId).toBe(sessionId);
          expect(info.baseBranch).toBe(config.defaultBranch);
          note("worktree", `${info.branch} at ${info.path}`);
          return info;
        });

      await test.step("wait until app.bicep is ready", async () => {
        let progress = classifyModelProgress(new Set(), "");
        await pollUntil(
          async () => {
            const existing = new Set(
              MODEL_FILES.filter((file) =>
                existsSync(path.join(session.path, file))
              )
            );
            const staged = await runOrThrow(
              "git",
              ["diff", "--cached", "--name-only"],
              { cwd: session.path }
            );
            progress = classifyModelProgress(existing, staged);
            return progress.ready;
          },
          true,
          {
            describe: () =>
              `The model is not ready. Missing: ${progress.missingFiles.join(", ") || "none"}. Not staged: ${progress.unstagedFiles.join(", ") || "none"}.`,
            timeout: MODEL_TIMEOUT_MS,
            intervals: [10_000]
          }
        );
        await testInfo.attach("app.bicep", {
          path: path.join(session.path, ".radius", "app.bicep"),
          contentType: "text/plain"
        });
      });

      await test.step("render the application graph", async () => {
        canvas = await attachRadiusCanvas(appBrowser, appPage, cdpUrl);
        await gotoCanvasPage(canvas.target, "graph");
        await expect(
          canvas.target.locator(".react-flow__node").first()
        ).toBeVisible({ timeout: GRAPH_TIMEOUT_MS });
        await testInfo.attach("graph", {
          body: await appPage.screenshot(),
          contentType: "image/png"
        });
      });

      await test.step("publish the model to the fixture default branch", async () => {
        const cwd = session.path;
        await runOrThrow(
          "git",
          [
            "commit",
            "-m",
            "Add Radius application model (copilot-app-ux-poc journey)"
          ],
          { cwd }
        );
        expect(
          await runOrThrow("git", ["rev-parse", "HEAD~1"], { cwd }),
          "The session branch must start at the fixture baseline, so the push is a fast-forward."
        ).toBe(config.baselineSha);
        await runOrThrow(
          "git",
          ["push", "origin", `HEAD:refs/heads/${config.defaultBranch}`],
          { cwd }
        );
        pushedToDefaultBranch = true;
      });

      const target = (): CanvasTarget => {
        if (!canvas) throw new Error("The Radius canvas is not attached.");
        return canvas.target;
      };

      await test.step("create the environment", async () => {
        await ensureCredentialProfile(target(), config);
        await target()
          .locator("#env-profile-menu")
          .getByRole("option", { name: new RegExp(config.credentialProfile) })
          .click();
        await target().locator("#env-step1-next").click();
        await expect(target().locator("#env-step-details")).toBeVisible();
        await target()
          .getByLabel("Environment name")
          .fill(config.environmentName);
        await target()
          .getByLabel("Resource Group", { exact: true })
          .selectOption(config.resourceGroup);
        await target()
          .getByLabel("Cluster", { exact: true })
          .selectOption(config.clusterName);
        await target()
          .locator("#azure-namespace-select")
          .selectOption(config.namespace);

        const response = waitForPost(target(), "/api/operations");
        const create = target().locator("#deploy-btn:not([disabled])");
        await expect(create).toHaveText("Create Environment");
        await create.click();
        const created = await response;
        expect(
          created.ok(),
          `POST /api/operations returned ${created.status()}`
        ).toBe(true);
        environmentCreated = true;
        const operationId = readOperationId(await created.json());
        const finished = await pollOperation(
          target(),
          operationId,
          CREATE_OPERATION_TIMEOUT_MS
        );
        expect(
          finished.state,
          `Environment creation ended ${finished.state}: ${finished.error || "no error"}`
        ).toBe("succeeded");
        expect(await githubEnvironmentExists(config)).toBe(true);
      });

      await test.step("deploy the application", async () => {
        await gotoCanvasPage(target(), "deploying");
        const listing = await fetchJson(
          target(),
          repositoryListingPath("/api/list-applications", config.repository)
        );
        const app = readSingleApplicationName(listing.body);
        note("application", app);
        await target().locator("#deploy-app-select").selectOption(app);
        await target()
          .locator("#deploy-env-select")
          .selectOption(config.environmentName);
        await target()
          .locator("#deploy-branch-select")
          .selectOption(config.defaultBranch);

        const response = waitForPost(target(), "/api/deploy");
        const deploy = target().locator("#deploy-now-btn:not([disabled])");
        await expect(deploy).toHaveText("Deploy");
        await deploy.click();
        const started = await response;
        expect(
          started.ok(),
          `POST /api/deploy returned ${started.status()}`
        ).toBe(true);
        deployment = { app, deleted: false };

        let status = readDeployStatus({ status: "pending" });
        await expect
          .poll(
            async () => {
              status = readDeployStatus(
                (await fetchJson(target(), "/api/deploy-status")).body
              );
              return status.terminal;
            },
            { timeout: DEPLOY_TIMEOUT_MS, intervals: [10_000] }
          )
          .toBe(true);
        if (status.runUrl) note("deploy-run", status.runUrl);
        expect(
          status.succeeded,
          `Deploy ended "${status.status}": ${status.error || "no error"}`
        ).toBe(true);

        const presence = tolerant(async () =>
          hasDeployment(
            readDeploymentRows(
              (
                await fetchJson(
                  target(),
                  repositoryListingPath(
                    "/api/list-deployments",
                    config.repository,
                    true
                  )
                )
              ).body
            ),
            app,
            config.environmentName
          )
        );
        await pollUntil(presence.read, true, {
          describe: () =>
            `The deployment row did not appear. Last failure: ${presence.last()}`,
          timeout: LISTING_TIMEOUT_MS,
          intervals: [5_000]
        });
      });

      await test.step("refuse to delete an environment that has a deployment", async () => {
        if (!deployment) throw new Error("No deployment was recorded.");
        await gotoCanvasPage(target(), "environment");
        const deleteButton = target().locator(
          `.js-delete-env[data-env="${config.environmentName}"]`
        );
        await expect(deleteButton).toBeVisible({ timeout: LISTING_TIMEOUT_MS });
        await deleteButton.click();
        const response = waitForPost(target(), "/api/delete-environment");
        await target().locator("#env-confirm-ok").click();
        const refused = await response;
        const problems = findDeleteRefusalProblems({
          status: refused.status(),
          payload: (await refused.json()) as unknown,
          application: deployment.app
        });
        expect(problems, problems.join("\n")).toEqual([]);
        expect(await githubEnvironmentExists(config)).toBe(true);
      });

      await test.step("delete the deployment", async () => {
        if (!deployment) throw new Error("No deployment was recorded.");
        const app = deployment.app;
        await gotoCanvasPage(target(), "deploying");
        const deleteButton = target().locator(
          `.js-del-dep[data-app="${app}"][data-env="${config.environmentName}"]`
        );
        await expect(deleteButton).toBeVisible({ timeout: LISTING_TIMEOUT_MS });
        await deleteButton.click();
        await target()
          .getByRole("button", { name: "I want to delete this deployment" })
          .click();
        await target()
          .getByRole("button", { name: /have read and understand/i })
          .click();
        await target()
          .locator("#del-confirm-input")
          .fill(`${app}/${config.environmentName}`);
        const response = waitForPost(target(), "/api/delete-deployment");
        await target().locator("#del-confirm-btn").click();
        const deleted = await response;
        expect(
          deleted.ok(),
          `POST /api/delete-deployment returned ${deleted.status()}`
        ).toBe(true);

        const presence = tolerant(async () =>
          hasDeployment(
            readDeploymentRows(
              (
                await fetchJson(
                  target(),
                  repositoryListingPath(
                    "/api/list-deployments",
                    config.repository,
                    true
                  )
                )
              ).body
            ),
            app,
            config.environmentName
          )
        );
        await pollUntil(presence.read, false, {
          describe: () =>
            `The deployment row is still present. Last failure: ${presence.last()}`,
          timeout: DELETE_DEPLOYMENT_TIMEOUT_MS,
          intervals: [10_000]
        });
        deployment.deleted = true;
        await gotoCanvasPage(target(), "deploying");
        await expect(deleteButton).toHaveCount(0, {
          timeout: LISTING_TIMEOUT_MS
        });
      });

      await test.step("delete the environment", async () => {
        await gotoCanvasPage(target(), "environment");
        const deleteButton = target().locator(
          `.js-delete-env[data-env="${config.environmentName}"]`
        );
        await expect(deleteButton).toBeVisible({ timeout: LISTING_TIMEOUT_MS });
        await deleteButton.click();
        await expect(target().locator("#env-confirm-title")).toHaveText(
          "Delete environment?"
        );
        await expect(target().locator("#env-confirm-message")).toContainText(
          config.environmentName
        );
        const response = waitForPost(target(), "/api/delete-environment");
        await target().locator("#env-confirm-ok").click();
        const accepted = await response;
        expect(accepted.status()).toBe(202);
        const operationId = readOperationId(await accepted.json());
        const finished = await pollOperation(
          target(),
          operationId,
          DELETE_ENVIRONMENT_TIMEOUT_MS
        );
        expect(
          finished.state,
          `Environment delete ended ${finished.state}: ${finished.error || "no error"}`
        ).toBe("succeeded");
        environmentDeleted = true;
        await expect(target().locator("#env-confirm-title")).toHaveText(
          "Environment deleted",
          { timeout: LISTING_TIMEOUT_MS }
        );
        expect(await githubEnvironmentExists(config)).toBe(false);
      });
    } finally {
      await canvas?.dispose((description) =>
        note("cleanup-warning", description)
      );

      if (deployment && !deployment.deleted) {
        note(
          "manual-cleanup",
          `Deployment "${deployment.app}" in environment "${config.environmentName}" may still exist. Delete it in the Radius canvas.`
        );
      }
      if (environmentCreated && !environmentDeleted) {
        note(
          "manual-cleanup",
          `Environment "${config.environmentName}" may still exist (GitHub environment and Azure federated credential). Delete it in the Radius canvas.`
        );
      }
      const cloudStateRemains =
        (deployment !== undefined && !deployment.deleted) ||
        (environmentCreated && !environmentDeleted);
      if (pushedToDefaultBranch && cloudStateRemains) {
        // The canvas delete flows dispatch workflows from the default branch,
        // so keep them there until the manual cleanup is done.
        note(
          "manual-cleanup",
          `${config.repository}@${config.defaultBranch} was not reset, so the canvas can still delete the leftovers. After that, reset it to ${config.baselineSha}.`
        );
      } else if (pushedToDefaultBranch) {
        // Environment creation also publishes workflow files to the default
        // branch, so reset it to the baseline, not to the model commit.
        const reset = await runCommand("gh", [
          "api",
          "-X",
          "PATCH",
          `repos/${config.repository}/git/refs/heads/${config.defaultBranch}`,
          "-f",
          `sha=${config.baselineSha}`,
          "-F",
          "force=true"
        ]);
        if (reset.code !== 0) {
          note(
            "manual-cleanup",
            `Could not reset ${config.repository}@${config.defaultBranch} to ${config.baselineSha}: ${reset.stderr.trim()}`
          );
        }
      }
    }
  });
});
