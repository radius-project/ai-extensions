import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { classifyDeploymentDispatchFailure } from "@radius-project/core";
import {
  appParams,
  buildAppGraphRadCommand,
  buildDeployRadCommand,
  extractAppName,
  partitionParams,
  resolveDeployParams
} from "../../../src/bicep.js";
import { latestWorkflowRunId } from "../../../src/deploy.js";
import type { SelectedGhExecutor } from "../../../src/gh.js";
import {
  DEPLOY_AZURE_FILE,
  DEPLOY_DISPATCHER_FILE,
  createWorkflowTemplateReader,
  generateDeployWorkflow,
  syncRepoWorkflows
} from "../../../src/infra.js";
import { bindDeploymentExecutor } from "../../../src/runtime/deployment-executor.js";
import { createDeploymentWorkflowPreparation } from "../../../src/runtime/deployment-workflow-preparation.js";
import { createDeploymentWorkflowPorts } from "../../../src/runtime/deployment-workflows.js";
import { createDeployDispatchService } from "../../../src/server/services/deploy-dispatch.js";
import type { CanvasState } from "../../../src/shared.js";
import { successfulSelectedGhExecutor } from "../../support/server/selected-gh.js";

const REPO = "fixture/selected";
const BRANCH = "feature/model&review=1";
const ENVIRONMENT = "Preview East";
const APP = "infra/selected.bicep";
const source = [
  "@secure()",
  "param password string",
  "param location string = 'westus'",
  "resource app 'Applications.Core/applications@2023-10-01-preview' = {",
  "  name: 'selected-app'",
  "}"
].join("\n");

type Scenario =
  | "success"
  | "source-unavailable"
  | "secret-list-malformed"
  | "secret-write-refused"
  | "publication-refused"
  | "baseline-malformed"
  | "baseline-unavailable"
  | "dispatch-refused"
  | "dispatch-timeout";
type TemplateScenario = "template-unavailable" | "template-expired";

function fixture(scenario: Scenario | TemplateScenario) {
  const files = new Map<string, string>();
  if (scenario.startsWith("template-")) {
    for (const branch of [BRANCH, "trunk"]) {
      for (const file of [DEPLOY_DISPATCHER_FILE, DEPLOY_AZURE_FILE])
        files.set(
          `/repos/${REPO}/contents/.github/workflows/${file}?ref=${encodeURIComponent(branch)}`,
          "name: stale\n"
        );
    }
  }
  let secretWritten = false;
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const refused = (stderr: string) => ({ code: 1, stdout: "", stderr });
  const run = vi.fn<SelectedGhExecutor["run"]>(async (args, options) => {
    if (args[0] === "secret") {
      expect(args).toEqual([
        "secret",
        "set",
        "RADIUS_DEPLOY_PARAMS",
        "--env",
        ENVIRONMENT,
        "--repo",
        REPO
      ]);
      expect(options?.stdin).toBe('{"password":"synthetic-parameter-value"}');
      if (scenario === "secret-write-refused")
        return refused("HTTP 403: secret write refused");
      secretWritten = true;
      return ok();
    }
    if (args[0] === "run") {
      expect(args).toEqual([
        "run",
        "list",
        "--limit",
        "20",
        "--json",
        "databaseId,createdAt",
        "--repo",
        REPO
      ]);
      if (scenario === "baseline-unavailable")
        return refused("HTTP 503: history unavailable");
      return ok(
        scenario === "baseline-malformed" ? '[{"databaseId":0}]' : (
          '[{"databaseId":81},{"databaseId":92}]'
        )
      );
    }
    if (args[0] === "workflow") {
      if (scenario === "dispatch-refused")
        return refused("HTTP 403: refusing workflow without workflow scope");
      if (scenario === "dispatch-timeout")
        return { ...refused("dispatch timed out"), timedOut: true };
      return ok();
    }
    if (args[0] !== "api") throw new Error(`Unexpected command: ${args}`);
    if (args.includes("PUT")) {
      expect(args.slice(0, 3)).toEqual(["api", "--method", "PUT"]);
      expect(args[3]).toMatch(
        /^\/repos\/fixture\/selected\/contents\/\.github\/workflows\//
      );
      const body: { branch: string; content: string } = JSON.parse(
        options?.stdin ?? "{}"
      );
      expect([BRANCH, "trunk"]).toContain(body.branch);
      expect(body.content).toBeTruthy();
      if (scenario === "publication-refused")
        return refused("HTTP 403: protected branch");
      files.set(
        `${args[3]}?ref=${encodeURIComponent(body.branch)}`,
        Buffer.from(body.content, "base64").toString("utf8")
      );
      return ok("{}");
    }
    const endpoint = args[1];
    if (endpoint === `/repos/${REPO}`) return ok('{"default_branch":"trunk"}');
    if (endpoint.startsWith(`/repos/${REPO}/git/ref/heads/`)) {
      expect([BRANCH, "trunk"]).toContain(
        decodeURIComponent(endpoint.split("/heads/")[1])
      );
      return ok(JSON.stringify({ object: { sha: "a".repeat(40) } }));
    }
    if (
      endpoint ===
      `/repos/${REPO}/environments/${encodeURIComponent(ENVIRONMENT)}/secrets`
    ) {
      expect(args.slice(2)).toEqual(["--paginate", "--slurp"]);
      if (scenario === "secret-list-malformed") return ok("[{}]");
      return ok(
        JSON.stringify([
          { secrets: secretWritten ? [{ name: "RADIUS_DEPLOY_PARAMS" }] : [] }
        ])
      );
    }
    if (endpoint.startsWith(`/repos/${REPO}/contents/`)) {
      const url = new URL(endpoint, "https://fixture.invalid");
      expect([BRANCH, "trunk"]).toContain(url.searchParams.get("ref"));
      if (url.pathname.endsWith(`/${APP}`)) {
        expect(url.searchParams.get("ref")).toBe(BRANCH);
        if (scenario === "source-unavailable")
          return refused("HTTP 403: source unavailable");
        return ok(
          JSON.stringify({
            type: "file",
            encoding: "base64",
            content: Buffer.from(source).toString("base64")
          })
        );
      }
      const content = files.get(endpoint);
      return content ?
          ok(
            JSON.stringify({
              type: "file",
              encoding: "base64",
              content: Buffer.from(content).toString("base64")
            })
          )
        : refused("HTTP 404: Not Found");
    }
    if (
      endpoint.startsWith(
        "/repos/radius-project/ai-extensions/contents/.github/extension/"
      )
    ) {
      const file = new URL(endpoint, "https://fixture.invalid").pathname
        .split("/")
        .at(-1);
      if (!file || !/^[a-z-]+\.yml$/.test(file))
        throw new Error(`Unexpected template: ${endpoint}`);
      return ok(
        readFileSync(
          new URL(`../../../../../.github/extension/${file}`, import.meta.url)
        ).toString("base64")
      );
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  });
  const executor = bindDeploymentExecutor(
    successfulSelectedGhExecutor({
      login: "selected-user",
      credentialSource: "injected",
      run
    }),
    () => true
  );
  const workflows = createDeploymentWorkflowPorts(executor);
  let now = 0;
  let preflightDone = false;
  let entered = () => {};
  const atSynchronization = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (scenario.startsWith("template-")) {
    const readTemplate = createWorkflowTemplateReader(
      async (_repo, path) => {
        if (scenario === "template-unavailable" || now > 60000)
          return { content: null, error: "HTTP 503: template unavailable" };
        return {
          content: readFileSync(
            new URL(`../../../../../${path}`, import.meta.url),
            "utf8"
          ),
          error: null
        };
      },
      () => now
    );
    workflows.generateDeployWorkflow = async (environment, appFile) => {
      const generated = await generateDeployWorkflow(
        environment,
        appFile,
        {},
        readTemplate
      );
      preflightDone = true;
      return generated;
    };
    const getDefaultBranch = workflows.getDefaultBranch;
    workflows.getDefaultBranch = async (repo) => {
      if (preflightDone) {
        entered();
        await held;
      }
      return getDefaultBranch(repo);
    };
  }
  const log = vi.fn();
  const preparation = createDeploymentWorkflowPreparation(workflows, {
    sync: syncRepoWorkflows,
    log
  });
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected external operation");
  };
  const service = createDeployDispatchService({
    isCurrent: () => true,
    deployWorkflowFile: DEPLOY_DISPATCHER_FILE,
    deployWorkflowFiles: [DEPLOY_DISPATCHER_FILE, DEPLOY_AZURE_FILE],
    branchNotPushedKind: "branch-not-pushed",
    oidcSubjectMissingKind: "oidc-subject-missing",
    oidcSubjectCaseMismatchKind: "oidc-subject-case-mismatch",
    getBranchHeadSha: workflows.getBranchHeadSha,
    getDefaultBranch: workflows.getDefaultBranch,
    runGh: (args) => executor.run(args, { timeout: 30000 }),
    runGhWithStdin: (args, stdin) =>
      executor.run(args, { stdin, timeout: 30000 }),
    runAz: unexpected,
    runGitHubJson: unexpected,
    readProcessEnv: () => ({}),
    ghCredentialSource: () => executor.credentialSource,
    fetchFileForSelection: (_entry, repo, branch, path) =>
      workflows.fetchFileFromRepo(repo, path, branch),
    appParams,
    resolveDeployParams: (params) =>
      resolveDeployParams(params, { password: "synthetic-parameter-value" }),
    partitionParams,
    extractAppName,
    buildDeployRadCommand,
    buildAppGraphRadCommand,
    ensureDeployWorkflowsOnBranch: preparation.publish,
    ensureWorkflowsCurrent: preparation.synchronize,
    sleep: async () => {},
    latestWorkflowRunId: (repo, workflow) =>
      latestWorkflowRunId(repo, workflow, executor),
    classifyDeployDispatchFailure: classifyDeploymentDispatchFailure,
    uncommittedGeneratedPaths: async () => [],
    invalidateDeployListCache: vi.fn(),
    errorMessage: executor.errorMessage,
    now: () => 1700000000000
  });
  const state: CanvasState = {
    envName: ENVIRONMENT,
    deployParams: { appFile: APP },
    workspaceRepo: "fixture/different",
    workspaceBranch: "different"
  };
  return {
    run,
    state,
    log,
    atSynchronization,
    expireCache: () => {
      now = 60001;
      release();
    },
    start: () =>
      service.prepareAndDispatch({
        entry: { state },
        repo: REPO,
        branch: BRANCH,
        provider: "aws",
        requestedEnvironment: "not-selected",
        log
      })
  };
}

describe("selected deployment preparation boundary", () => {
  it.each(["template-unavailable", "template-expired"] as const)(
    "refuses stale workflows when actual template generation is %s",
    async (scenario) => {
      const f = fixture(scenario);
      const pending = f.start();
      try {
        if (scenario === "template-expired") {
          await f.atSynchronization;
          f.expireCache();
        }
        expect(await pending).toMatchObject({ dispatched: false });
        expect(f.state.deployDispatchEvidence).toBe("refused");
        expect(f.state.deployErrorKind).toBe("dispatch-refused");
        expect(
          f.run.mock.calls.filter(([args]) => args[0] === "workflow")
        ).toEqual([]);
        expect(
          f.run.mock.calls.filter(([args]) => args.includes("PUT"))
        ).toEqual([]);
      } finally {
        f.expireCache();
        await pending;
      }
    }
  );
  it("keeps real file, template, secret, baseline and dispatch work on one selected executor", async () => {
    const f = fixture("success");
    expect(await f.start()).toMatchObject({
      dispatched: true,
      environment: ENVIRONMENT,
      baselineRunId: 92
    });
    expect(f.state.deployDispatchReference).toEqual({
      repo: REPO,
      branch: BRANCH,
      environment: ENVIRONMENT,
      workflowFile: DEPLOY_DISPATCHER_FILE,
      baselineRunId: 92,
      dispatchedAt: 1700000000000
    });
    expect(f.state.deployDispatchEvidence).toBe("accepted");
    const dispatches = f.run.mock.calls.filter(
      ([args]) => args[0] === "workflow"
    );
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0][0]).toEqual([
      "workflow",
      "run",
      DEPLOY_DISPATCHER_FILE,
      "--ref",
      BRANCH,
      "-f",
      `environment=${ENVIRONMENT}`,
      "--repo",
      REPO,
      "-f",
      expect.stringContaining(APP)
    ]);
    expect(JSON.stringify(dispatches)).not.toContain(
      "synthetic-parameter-value"
    );
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(
      "synthetic-parameter-value"
    );
    expect(
      f.run.mock.calls.filter(([args]) => args.includes("PUT"))
    ).toHaveLength(4);
    expect(
      f.run.mock.calls.filter(([args]) => args[0] === "secret")
    ).toHaveLength(1);
  });

  it.each([
    "source-unavailable",
    "secret-list-malformed",
    "secret-write-refused",
    "publication-refused",
    "baseline-malformed",
    "baseline-unavailable"
  ] as const)(
    "refuses %s without dispatch or account fallback",
    async (scenario) => {
      const f = fixture(scenario);
      expect(await f.start()).toEqual({ dispatched: false });
      expect(f.state.deployStatus).toBe("failed");
      expect(f.state.deployError).toBeTruthy();
      expect(
        f.run.mock.calls.filter(([args]) => args[0] === "workflow")
      ).toEqual([]);
      expect(
        f.run.mock.calls.every(([, options]) => options?.env === undefined)
      ).toBe(true);
      if (
        scenario === "source-unavailable" ||
        scenario === "secret-list-malformed"
      ) {
        expect(
          f.run.mock.calls.filter(
            ([args]) => args[0] === "secret" || args.includes("PUT")
          )
        ).toEqual([]);
      }
    }
  );

  it.each([
    ["dispatch-refused", "refused"],
    ["dispatch-timeout", "uncertain"]
  ] as const)(
    "records %s without retrying a selected-account mutation",
    async (scenario, evidence) => {
      const f = fixture(scenario);
      expect(await f.start()).toEqual({ dispatched: false });
      expect(f.state.deployDispatchEvidence).toBe(evidence);
      expect(f.state.deployDispatchReference).toMatchObject({
        repo: REPO,
        branch: BRANCH,
        baselineRunId: 92
      });
      expect(
        f.run.mock.calls.filter(([args]) => args[0] === "workflow")
      ).toHaveLength(1);
    }
  );
});
