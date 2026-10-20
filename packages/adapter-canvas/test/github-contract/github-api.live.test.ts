import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  selectedCreateBranchRef,
  selectedGetBranchHeadSha,
  type SelectedGhCommandResult,
  type SelectedGhExecutor
} from "../../src/gh.js";
import {
  createWorkflowFileCommitter,
  isProtectedBranchFailure
} from "../../src/server/routes/create-environment-workflow-committer.js";
import { needsWorkflowScope } from "../../src/server/services/workflow-credential-fallback.js";
import { deleteGitHubEnvironmentIdempotent } from "../../src/server/services/github-environment.js";
import { runVerificationDispatch } from "../../src/server/services/verification-dispatch.js";
import {
  readContractConfig,
  withAppExecutor,
  withCleanup,
  type ContractConfig
} from "./support.js";

const WORKFLOW = "radius-contract-dispatch.yml";
const INERT_WORKFLOW = [
  "name: Radius contract dispatch",
  "on: workflow_dispatch",
  "permissions: {}",
  "jobs:",
  "  inert:",
  "    if: ${{ false }}",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: exit 0",
  ""
].join("\n");

function run(executor: SelectedGhExecutor, args: string[]) {
  return executor.run(args, { timeout: 20_000 });
}

async function mustRun(
  executor: SelectedGhExecutor,
  args: string[]
): Promise<string> {
  return (
    await executor.runOrThrow(args, "Live GitHub sandbox operation failed", {
      timeout: 20_000
    })
  ).stdout.trim();
}

async function preflight(config: ContractConfig, setup: SelectedGhExecutor) {
  const details = await mustRun(setup, [
    "api",
    `repos/${config.repo}`,
    "--jq",
    '[.full_name, (.private | tostring), .default_branch] | join("\\n")'
  ]);
  const [repo, visibility, branch] = details.split("\n");
  expect(repo.toLowerCase()).toBe(config.repo.toLowerCase());
  expect(visibility, "Sandbox must be private").toBe("true");
  if (!branch) throw new Error("Sandbox has no default branch.");
  const marker = await mustRun(setup, [
    "api",
    `repos/${config.repo}/contents/.radius-github-contract-sandbox`,
    "--jq",
    ".content"
  ]);
  expect(Buffer.from(marker, "base64").toString("utf8")).toBe(
    "radius-github-contract-sandbox-v1\n"
  );
  const rules = await mustRun(setup, [
    "api",
    `repos/${config.repo}/rules/branches/${encodeURIComponent(branch)}`,
    "--jq",
    ".[].type"
  ]);
  expect(
    rules.split("\n"),
    "Sandbox default branch needs an active PR rule"
  ).toContain("pull_request");
  return branch;
}

describe.skipIf(process.env.RUN_LIVE_GITHUB_API_TESTS !== "1")(
  "real GitHub API permission contracts",
  () => {
    it("does not treat a permission-masked Environment-delete 404 as absence", async () => {
      const config = readContractConfig(process.env);
      await withAppExecutor(config, config.setupToken, async (setup) => {
        await preflight(config, setup);
        const name = `radius-contract-${randomUUID()}`;
        const endpoint = `repos/${config.repo}/environments/${name}`;
        await withCleanup(
          async () => {
            await mustRun(setup, ["api", "--method", "PUT", endpoint]);
            await withAppExecutor(
              config,
              config.maskedToken,
              async (masked) => {
                let invalidated = false;
                const results: SelectedGhCommandResult[] = [];
                const outcome = await deleteGitHubEnvironmentIdempotent(
                  config.repo,
                  name,
                  {
                    runGh: async (args) => {
                      const result = await run(masked, args);
                      results.push(result);
                      return result;
                    },
                    invalidateEnvListCache: () => {
                      invalidated = true;
                    }
                  }
                );
                expect(
                  results[0]?.stderr,
                  "Must observe a real masked 404"
                ).toMatch(/HTTP 404/i);
                expect(results).toHaveLength(2);
                const listing = results[1];
                if (!listing) throw new Error("Absence was not checked.");
                if (listing.code === 0) {
                  expect(listing.stdout.split(/\r?\n/)).toContain(name);
                } else {
                  expect(listing.stderr).toMatch(/HTTP 40[34]/i);
                }
                expect(outcome.outcome).toBe("failed");
                expect(invalidated).toBe(false);
              }
            );
            await mustRun(setup, ["api", endpoint]);
          },
          async () => {
            const cleanup = await deleteGitHubEnvironmentIdempotent(
              config.repo,
              name,
              {
                runGh: (args) => run(setup, args),
                invalidateEnvListCache: () => {}
              }
            );
            if (cleanup.outcome === "failed") {
              throw new Error(
                `Environment cleanup failed for ${name}: ${cleanup.detail}`
              );
            }
          }
        );
      });
    });

    it.each(["workflows-permission", "branch-rules"] as const)(
      "classifies a real %s write refusal through the workflow committer",
      async (contract) => {
        const config = readContractConfig(process.env);
        await withAppExecutor(config, config.setupToken, async (setup) => {
          const base = await preflight(config, setup);
          const name = `radius-contract-${randomUUID()}`;
          const path = `.github/workflows/${name}.yml`;
          const directory = mkdtempSync(
            join(tmpdir(), "radius-contract-body-")
          );
          const branches = new Set<string>();
          const refusals: SelectedGhCommandResult[] = [];
          await withCleanup(
            async () => {
              const token =
                contract === "branch-rules" ?
                  config.setupToken
                : config.restrictedToken;
              await withAppExecutor(config, token, async (executor) => {
                const committer = createWorkflowFileCommitter(
                  {
                    runGh: (args) => run(executor, args),
                    runGhWorkflow: async (args) => {
                      const result = await run(executor, args);
                      if (result.code !== 0) refusals.push(result);
                      return result;
                    },
                    getDefaultBranch: async () => base,
                    getBranchHeadSha: (repo, branch) =>
                      selectedGetBranchHeadSha(executor, repo, branch),
                    createBranchRef: async (repo, branch, sha) => {
                      branches.add(branch);
                      return selectedCreateBranchRef(
                        executor,
                        repo,
                        branch,
                        sha
                      );
                    },
                    tempFile: {
                      write: (contents) => {
                        const file = join(directory, `${randomUUID()}.json`);
                        writeFileSync(file, contents);
                        return file;
                      },
                      remove: (file) => rmSync(file)
                    },
                    errorMessage: executor.errorMessage,
                    pushStep: () => {},
                    now: Date.now
                  },
                  { targetRepo: config.repo, envName: name }
                );
                const outcome = await committer.commitWorkflowFileSmart(
                  path,
                  Buffer.from(INERT_WORKFLOW).toString("base64"),
                  `Live contract ${name}`
                );
                expect(refusals.length).toBeGreaterThan(0);
                const first = refusals[0];
                if (!first) throw new Error("No real GitHub refusal recorded.");
                expect(first.timedOut).not.toBe(true);
                if (contract === "workflows-permission") {
                  expect(first.stderr).toMatch(/HTTP 40[34]/);
                  expect(needsWorkflowScope(first.stderr)).toBe(true);
                  expect(isProtectedBranchFailure(first.stderr)).toBe(false);
                  expect(outcome.ok).toBe(false);
                  expect(outcome.viaPr).toBe(false);
                  expect(branches.size).toBe(0);
                } else {
                  expect(first.stderr).toMatch(
                    /repository rule|protected branch|through a pull request|GH00[36]|GH013|branch protection/i
                  );
                  expect(isProtectedBranchFailure(first.stderr)).toBe(true);
                  expect(outcome.ok).toBe(true);
                  expect(outcome.viaPr).toBe(true);
                  expect(branches.size).toBe(1);
                  const branch = committer.pullRequestState()?.branch;
                  expect(branch).toBeTruthy();
                  const content = await mustRun(setup, [
                    "api",
                    `repos/${config.repo}/contents/${path}?ref=${encodeURIComponent(branch || "")}`,
                    "--jq",
                    ".content"
                  ]);
                  expect(Buffer.from(content, "base64").toString("utf8")).toBe(
                    INERT_WORKFLOW
                  );
                }
              });
            },
            async () => {
              await withCleanup(
                async () => {
                  for (const branch of branches) {
                    const matching = await mustRun(setup, [
                      "api",
                      `repos/${config.repo}/git/matching-refs/heads/${branch}`,
                      "--jq",
                      ".[].ref"
                    ]);
                    if (
                      !matching.split("\n").includes(`refs/heads/${branch}`)
                    ) {
                      continue;
                    }
                    await mustRun(setup, [
                      "api",
                      "--method",
                      "DELETE",
                      `repos/${config.repo}/git/refs/heads/${branch}`
                    ]);
                  }
                  const unexpected = await run(setup, [
                    "api",
                    `repos/${config.repo}/contents/${path}`
                  ]);
                  if (unexpected.code === 0) {
                    throw new Error(
                      `Unexpected default-branch write: inspect ${config.repo}:${path}. Branch rules failed; manual cleanup is required.`
                    );
                  }
                  expect(unexpected.stderr).toMatch(/HTTP 404/);
                },
                async () => rmSync(directory, { recursive: true, force: true })
              );
            }
          );
        });
      }
    );

    it("returns a rejected verification dispatch for a real Actions-write denial", async () => {
      const config = readContractConfig(process.env);
      await withAppExecutor(config, config.setupToken, async (setup) => {
        const branch = await preflight(config, setup);
        const content = await mustRun(setup, [
          "api",
          `repos/${config.repo}/contents/.github/workflows/${WORKFLOW}`,
          "--jq",
          ".content"
        ]);
        expect(Buffer.from(content, "base64").toString("utf8")).toBe(
          INERT_WORKFLOW
        );
        await withAppExecutor(
          config,
          config.restrictedToken,
          async (executor) => {
            let dispatch: SelectedGhCommandResult | undefined;
            let dispatchCount = 0;
            const operation: {
              operationId: string;
              verification?: unknown;
            } = { operationId: `op_${randomUUID()}` };
            const outcome = await runVerificationDispatch({
              operation,
              kind: "github_workflow.dispatch",
              target: `${config.repo}:${WORKFLOW}`,
              repo: config.repo,
              workflowPath: `.github/workflows/${WORKFLOW}`,
              workflowFile: WORKFLOW,
              environment: "contract",
              ref: branch,
              operationMarker: "",
              allowRegistrationRetry: false,
              ports: {
                runGh: (args) => run(executor, args),
                sendDispatch: async () => {
                  dispatchCount += 1;
                  dispatch = await run(executor, [
                    "workflow",
                    "run",
                    WORKFLOW,
                    "--repo",
                    config.repo,
                    "--ref",
                    branch
                  ]);
                  return dispatch;
                },
                persist: async () => {},
                stopBoundary: async () => false,
                applyIdentity: () => {},
                terminalizeManualRequired: () => {},
                now: Date.now,
                sleep: async () => {
                  throw new Error("Permission denial must not poll or retry.");
                }
              }
            });
            expect(dispatch?.stderr).toMatch(/HTTP 403/);
            expect(dispatch?.stderr).toMatch(/Resource not accessible/i);
            expect(outcome.state).toBe("rejected");
            expect(dispatchCount).toBe(1);
          }
        );
      });
    });
  }
);
