import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import { createCreateEnvironmentRoutes } from "../../../src/server/routes/create-environment.js";
import { isValidRepoSlug } from "../../../src/azure-oidc.js";
import {
  buildVerifyWorkflowDispatchArgs,
  planCredentialVerification
} from "../../../src/verification-plan.js";
import {
  guardStopBoundary,
  persistBestEffort,
  persistMutationCheckpoint
} from "../../../src/server.js";
import {
  createSetupArtifactLedger,
  prepareProviderMutation,
  promoteCreatedGitHubEnvironment,
  recordCommittedWorkflowFile,
  recordGitHubEnvironment,
  recordGitHubEnvironmentVariable,
  setCanonicalEnvironment,
  settleProviderMutation
} from "../../../src/operations.js";
import type { SetupArtifactLedger } from "../../../src/operations.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import { successfulSelectedGhExecutor } from "../../support/server/selected-gh.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";
import type { CanvasState } from "../../../src/shared.js";
import type { GhCommandPresentation } from "../../../src/gh-command-display.js";
import type {
  CreateEnvironmentDependencies,
  CreateEnvironmentInstanceEntry
} from "../../../src/server/routes/create-environment.js";
import type {
  CreateEnvironmentCommandResult,
  CreateEnvironmentOperation,
  GhcrPreflightResult
} from "../../../src/server/routes/create-environment-types.js";

let container: CanvasServerContainer | undefined;

afterEach(async () => {
  await container?.stopAll();
  container = undefined;
});

const SERVER_OWNED_TOKEN = "loopback-token-for-this-instance";
const STAGE_IDENTITY = "authorize-identity";
const STAGE_CONFIGURE = "configure-environment";
const STAGE_VERIFY = "verify";

interface GhRule {
  match: RegExp;
  result: Partial<CreateEnvironmentCommandResult>;
}

interface Script {
  ghCommandPresentation?: GhCommandPresentation;
  gh?: GhRule[];
  runListResults?: Array<Partial<CreateEnvironmentCommandResult>>;
  dispatchResults?: Array<Partial<CreateEnvironmentCommandResult>>;
  repoAdminRefusal?: string;
  ghcrPreflight?: GhcrPreflightResult;
  defaultBranch?: string | null;
  headSha?: string | null;
  createBranch?: { ok: boolean; stderr: string };
  files?: Record<string, string>;
  azureCredential?: () => Record<string, unknown>;
  pullRequest?: {
    ok: boolean;
    url?: string;
    number?: number;
    stderr?: string;
  };
  persistRejectsAfter?: number;
  statePackageError?: string;
  exerciseCleanupDelete?: boolean;
  preparedEnvironment?: {
    requestedName: string;
    canonicalName: string;
    state: "created_candidate" | "reused";
  };
}

interface Harness {
  baseUrl: string;
  journal: string[];
  setJournalHook(hook: ((entry: string) => void) | null): void;
  ghCalls: string[];
  steps: string[];
  operation: CreateEnvironmentOperation & {
    setupArtifacts: SetupArtifactLedger;
  };
  state: CanvasState;
  finished: Array<{ state: string; options: Record<string, unknown> }>;
  commitStates: Record<string, unknown>[];
  committedFiles: Array<{
    path: string;
    branch: string | null;
    mode: string;
    commitSha: string | null;
    blobSha: string | null;
    contentSha256: string | null;
    previousBlobSha: string | null;
  }>;
  failures: Array<Record<string, unknown>>;
  cleanupErrors: string[];
  /** Whether each finalizeSetupFailure was handed a pinned environment reader. */
  cleanupReaders: boolean[];
  cleanupReads: Array<{ code: number; stdout: string; stderr: string }>;
}

const TEMP_BODY_PATH = "/tmp/create-environment-body.json";

// The default script is a repository with no Radius workflows yet, an
// unprotected default branch and a healthy `gh`. Each test overrides only the
// rule it is about. Anything that would reach a real binary, the network or the
// filesystem is a scripted fake that throws on an unmodelled call; the pure
// helpers (`isValidRepoSlug`, `planCredentialVerification`,
// `buildVerifyWorkflowDispatchArgs`) are
// the real production functions, injected exactly as `server.ts` injects them.
const MARKED_VERIFY_WORKFLOW = [
  "on:",
  "  workflow_dispatch:",
  "    inputs:",
  "      environment:",
  "        required: true",
  "      radius_operation:",
  "        required: false",
  "run-name: Radius verify ${{ inputs.environment }} [${{ inputs.radius_operation }}]",
  "jobs:"
].join("\n");

// sha256 of the exact workflow bytes the generators in this harness produce.
// Derived rather than pinned, so changing a fixture cannot silently decouple
// the recorded provenance digest from the bytes actually committed.
const digestOf = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");
const DEPLOY_WORKFLOW_BODY = "on: workflow_dispatch\njobs:\n";
const WORKFLOW_CONTENT_DIGEST = digestOf(DEPLOY_WORKFLOW_BODY);
const VERIFY_CONTENT_DIGEST = digestOf(MARKED_VERIFY_WORKFLOW);
const VERIFY_OPERATION_MARKER = `radius-operation:op-http:workflow:${VERIFY_CONTENT_DIGEST.slice(0, 16)}`;

function prepareVerifyWorkflowRecovery(
  operation: CreateEnvironmentOperation
): void {
  prepareProviderMutation(operation, {
    kind: "github_workflow.put",
    target:
      "octo/app:<default>:.github/workflows/radius-verify-credentials.yml",
    intent: {
      branch: "<default>",
      path: ".github/workflows/radius-verify-credentials.yml",
      previousBlobSha: null,
      previousBlobKnown: true,
      contentSha256: VERIFY_CONTENT_DIGEST,
      operationMarker: VERIFY_OPERATION_MARKER
    }
  });
}

function recoveredVerifyWorkflowRules(): GhRule[] {
  return [
    {
      match:
        /^api \/repos\/octo\/app\/contents\/\.github\/workflows\/radius-verify-credentials\.yml$/,
      result: {
        code: 0,
        stdout: JSON.stringify({
          sha: "b".repeat(40),
          content: Buffer.from(MARKED_VERIFY_WORKFLOW).toString("base64")
        })
      }
    },
    {
      match: /^api \/repos\/octo\/app\/commits\?path=/,
      result: {
        code: 0,
        stdout: JSON.stringify([
          {
            sha: "c".repeat(40),
            commit: {
              message: `Add workflow\n\nRadius-Operation: ${VERIFY_OPERATION_MARKER}`
            }
          }
        ])
      }
    }
  ];
}

const DEFAULT_GH_RULES: GhRule[] = [
  {
    match: /^api \/repos\/octo\/app\/environments\/[^/]+\/variables\//,
    result: { code: 1, stderr: "HTTP 404: Not Found" }
  },
  {
    match: /^api \/repos\/octo\/app\/environments\/dev$/,
    result: { code: 1, stderr: "HTTP 404: Not Found" }
  },
  {
    match: /^api \/repos\/octo\/app$/,
    result: { code: 0, stdout: '{"full_name":"octo/app"}' }
  },
  {
    match: /^api --method PUT \/repos\/octo\/app\/environments\/dev$/,
    result: {
      code: 0,
      stdout: JSON.stringify({
        name: "dev",
        id: 1234567,
        created_at: "2023-11-14T22:13:20.000Z"
      })
    }
  },
  { match: /^variable set /, result: { code: 0 } },
  {
    match: /^api \/repos\/octo\/app\/contents\/.* --jq \.sha$/,
    result: { code: 1, stderr: "HTTP 404" }
  },
  {
    match: /^api --method PUT \/repos\/octo\/app\/contents\//,
    // The real contents API answers a write with the commit it created and the
    // blob it stored; the committer reads its provenance back out of this.
    result: {
      code: 0,
      stdout: JSON.stringify({
        content: { sha: "blob-sha" },
        commit: { sha: "commit-sha" }
      })
    }
  },
  {
    match: /^workflow run /,
    result: {
      code: 0,
      stdout: "https://github.com/octo/app/actions/runs/4242\n"
    }
  },
  {
    match: /^run list /,
    result: {
      code: 0,
      stdout: JSON.stringify([
        { databaseId: 4242, status: "queued", url: "ignored" }
      ])
    }
  }
];

function start(script: Script = {}): Harness {
  const journal: string[] = [];
  // Lets a test act at an exact point in the run — recording a stop while the
  // request is mid-flight, which is the only way that race happens for real.
  let journalHook: ((entry: string) => void) | null = null;
  const appendJournal = journal.push.bind(journal);
  // Defined non-enumerably so the journal still compares as a plain array.
  Object.defineProperty(journal, "push", {
    value: (...entries: string[]) => {
      const length = appendJournal(...entries);
      for (const entry of entries) journalHook?.(entry);
      return length;
    }
  });
  const ghCalls: string[] = [];
  const steps: string[] = [];
  const state: CanvasState = {};
  const finished: Harness["finished"] = [];
  const commitStates: Record<string, unknown>[] = [];
  const committedFiles: Harness["committedFiles"] = [];
  const failures: Array<Record<string, unknown>> = [];
  const cleanupErrors: string[] = [];
  const cleanupReaders: boolean[] = [];
  const cleanupReads: Array<{ code: number; stdout: string; stderr: string }> =
    [];
  let persistCalls = 0;

  // `stages` and `steps` are present because the real stop guard closes the
  // record through the production `finish`, which walks both.
  const operation: CreateEnvironmentOperation & {
    setupArtifacts: SetupArtifactLedger;
  } = {
    operationId: "op-http",
    repo: "octo/app",
    environment: "dev",
    provider: "azure",
    currentStage: STAGE_CONFIGURE,
    inputRequired: null,
    stages: [{ id: STAGE_CONFIGURE, label: "Configure", state: "running" }],
    steps: [],
    setupArtifacts: createSetupArtifactLedger()
  };
  if (script.preparedEnvironment) {
    operation.environment = script.preparedEnvironment.requestedName;
    operation.context = {
      requestedEnvironment: script.preparedEnvironment.requestedName,
      canonicalEnvironment: script.preparedEnvironment.canonicalName
    };
    operation.setupArtifacts = {
      ...createSetupArtifactLedger(),
      githubEnvironment: {
        providerId: "1234567",
        state: script.preparedEnvironment.state,
        origin:
          script.preparedEnvironment.state === "reused" ?
            "pre_existing"
          : "unknown",
        repo: "octo/app",
        name: script.preparedEnvironment.canonicalName
      }
    };
  }

  // `gh api --method PUT .../contents/...` carries its target branch in the
  // JSON body, not in argv, so the argv alone cannot tell a default-branch
  // commit from a pull-request-branch one. The fake reads the body the
  // committer just wrote and rewrites the temp-file argument to `@<branch>`
  // (or `@default`), which is the only signal `gh` itself would act on.
  let lastBodyBranch = "default";
  let defaultRunListCalls = 0;
  const runListResults = [...(script.runListResults || [])];
  const dispatchResults = [...(script.dispatchResults || [])];
  const resolveRule = (rule: GhRule): CreateEnvironmentCommandResult => ({
    code: rule.result.code ?? 0,
    stdout: rule.result.stdout ?? "",
    stderr: rule.result.stderr ?? "",
    ...(rule.result.timedOut ? { timedOut: true } : {})
  });
  const runGhArgs = (args: string[]): CreateEnvironmentCommandResult => {
    const key = args
      .map((arg) => (arg === TEMP_BODY_PATH ? `@${lastBodyBranch}` : arg))
      .join(" ");
    ghCalls.push(key);
    if (key.startsWith("workflow run ")) {
      journal.push("dispatchVerifyWorkflow");
      if (dispatchResults.length > 0) {
        const next = dispatchResults.shift() || {};
        return {
          code: next.code ?? 0,
          stdout: next.stdout ?? "",
          stderr: next.stderr ?? "",
          ...(next.timedOut ? { timedOut: true } : {})
        };
      }
    }
    if (key.startsWith("run list ") && runListResults.length > 0) {
      const next = runListResults.shift() || {};
      return {
        code: next.code ?? 0,
        stdout: next.stdout ?? "",
        stderr: next.stderr ?? "",
        ...(next.timedOut ? { timedOut: true } : {})
      };
    }
    if (
      key.startsWith("run list ") &&
      !(script.gh || []).some((rule) => rule.match.test(key))
    ) {
      defaultRunListCalls += 1;
      return {
        code: 0,
        stdout:
          defaultRunListCalls === 1 ? "[]" : (
            JSON.stringify([
              {
                databaseId: 4242,
                createdAt: "2023-11-14T22:13:20.000Z",
                displayTitle: "Radius verify dev [op-http]",
                event: "workflow_dispatch",
                headBranch: "main",
                status: "queued",
                url: "ignored"
              }
            ])
          ),
        stderr: ""
      };
    }
    for (const rule of script.gh ?? []) {
      if (rule.match.test(key)) return resolveRule(rule);
    }
    const providerId =
      (
        typeof operation.setupArtifacts.githubEnvironment.providerId ===
        "string"
      ) ?
        operation.setupArtifacts.githubEnvironment.providerId
      : "";
    if (
      providerId &&
      /^api \/repos\/octo\/app\/environments\/[^/]+$/.test(key)
    ) {
      const name = decodeURIComponent(key.split("/").at(-1) || "");
      return {
        code: 0,
        stdout: JSON.stringify({ id: providerId, name }),
        stderr: ""
      };
    }
    for (const rule of DEFAULT_GH_RULES) {
      if (rule.match.test(key)) {
        return resolveRule(rule);
      }
    }
    throw new Error(`unscripted gh call: ${key}`);
  };

  const entry: CreateEnvironmentInstanceEntry = { state };

  const dependencies: CreateEnvironmentDependencies = {
    ghCommandPresentation: script.ghCommandPresentation,
    // --- request scope: read per request, exactly as server.ts does ---
    isServerOwnedRequest: (_instanceId, request) =>
      request.headers["x-radius-server-owned"] === SERVER_OWNED_TOKEN,
    readInstanceEntry: () => entry,
    getSelectedGitHubExecutor: () =>
      successfulSelectedGhExecutor({ run: async (args) => runGhArgs(args) }),

    // --- admission ---
    isValidRepoSlug,
    getOperation: (operationId) =>
      script.preparedEnvironment && operationId === operation.operationId ?
        operation
      : null,
    isStale: () => false,
    isTerminalState: (state) => state === "failed" || state === "cancelled",
    createOperation: (input) => {
      operation.repo = input.repo;
      operation.environment = input.environment;
      operation.provider = input.provider;
      return operation;
    },
    buildStages: () => [],
    startOperation: () => ({ ok: true }),
    persistOperations: async () => {
      persistCalls += 1;
      journal.push(`persist:${persistCalls}`);
      if (
        script.persistRejectsAfter !== undefined &&
        persistCalls > script.persistRejectsAfter
      ) {
        throw new Error("operation store is read-only");
      }
    },
    reportOperationDiagnostic: (diagnostic) => {
      journal.push(`diagnostic:${diagnostic.code}`);
    },
    finishFailed: () => {
      journal.push("finishFailed");
    },
    enterStage: (_operation, stage) => {
      journal.push(`enterStage:${stage}`);
    },
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    stageAuthorizeIdentity: STAGE_IDENTITY,
    stageConfigureEnvironment: STAGE_CONFIGURE,

    // --- gh runner ---
    cliExec: (_command, args, _options, callback) => {
      let result: CreateEnvironmentCommandResult;
      try {
        result = runGhArgs(args);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
        throw error;
      }
      queueMicrotask(() =>
        callback(
          result.code === 0 ?
            null
          : Object.assign(new Error("gh failed"), { code: result.code }),
          result.stdout,
          result.stderr
        )
      );
      return { stdin: { end: () => undefined } };
    },
    readProcessEnv: () => ({}),

    // --- narration + finalization ---
    addLegacyStep: (_operation, text) => {
      steps.push(text);
    },
    finalizeSetupFailure: async (_operation, input) => {
      failures.push(input);
      journal.push(`finalizeSetupFailure:${String(input.code)}`);
      // The cleanup's identity gate cannot run without a reader, and a reader
      // that is not the operation's own account answers for the wrong login.
      cleanupReaders.push(typeof input.readEnvironment === "function");
      const readEnvironment = input.readEnvironment;
      if (
        script.exerciseCleanupDelete &&
        typeof readEnvironment === "function"
      ) {
        cleanupReads.push(
          await readEnvironment(["api", "/repos/octo/app/environments/dev"])
        );
      }
      const runDeleteEnvironment = input.runDeleteEnvironment;
      if (
        script.exerciseCleanupDelete &&
        typeof runDeleteEnvironment === "function"
      ) {
        try {
          await runDeleteEnvironment([
            "api",
            "--method",
            "DELETE",
            "/repos/octo/app/environments/dev"
          ]);
        } catch (error) {
          cleanupErrors.push(
            error instanceof Error ? error.message : String(error)
          );
        }
      }
      return {
        status: Number(input.status),
        body: { error: String(input.error), code: String(input.code) }
      };
    },
    // The real helpers, delegated to rather than reimplemented: their refusal
    // wording and their "stop making cloud changes" contract are production
    // behavior, so a hand-written double could only diverge from it. The
    // journal entry observes the call without altering it.
    persistMutationCheckpoint: (input) => {
      journal.push("checkpoint");
      return persistMutationCheckpoint(input);
    },
    persistBestEffort: (input) => {
      journal.push("persistBestEffort");
      return persistBestEffort(input);
    },
    // Also the real helper: whether a stop is honored, and what the record and
    // the response look like when it is, is production behavior this suite
    // exercises over the socket rather than restates.
    guardStopBoundary: (input) => {
      journal.push(`stopBoundary:${input.boundary}`);
      return guardStopBoundary(input);
    },
    runAzCommand: () => {
      throw new Error("unscripted az call");
    },

    // --- preflight ---
    preflightRepoAdmin: async () => {
      journal.push("preflightRepoAdmin");
      return script.repoAdminRefusal ?? "";
    },
    preflightGhcrPackageWriteAccess: async () => {
      journal.push("preflightGhcrPackageWriteAccess");
      return (
        script.ghcrPreflight ?? {
          ok: true,
          credentials: { username: "octo" }
        }
      );
    },
    readGitHubJson: async (apiPath, executor) => {
      const result =
        executor ?
          await executor.run(["api", apiPath])
        : runGhArgs(["api", apiPath]);
      let json: unknown = null;
      if (result.stdout.trim()) {
        try {
          json = JSON.parse(result.stdout);
        } catch {
          return {
            ok: false,
            status: null,
            json: null,
            stderr: "GitHub returned an invalid JSON response."
          };
        }
      }
      const statusMatch = result.stderr.match(/\bHTTP\s+(\d{3})\b/i);
      return {
        ok: result.code === 0 || result.code === "0",
        status:
          result.code === 0 || result.code === "0" ? 200
          : statusMatch ? Number(statusMatch[1])
          : null,
        json,
        stderr: result.stderr
      };
    },
    bootstrapGHCRStatePackage: async () => {
      journal.push("bootstrapGHCRStatePackage");
      if (script.statePackageError) {
        throw new Error(script.statePackageError);
      }
      return { visibility: "private" };
    },
    stateRegistryForEnvironment: (repo, environment) => {
      journal.push(`stateRegistry:${environment}`);
      return `ghcr.io/${repo}/radius-state-${environment}`;
    },

    // --- committer ports ---
    getDefaultBranch: async () =>
      "defaultBranch" in script ? script.defaultBranch : "main",
    getBranchHeadSha: async () => {
      if (!("headSha" in script))
        throw new Error("unscripted getBranchHeadSha");
      return script.headSha;
    },
    createBranchRef: async () => {
      if (!script.createBranch) throw new Error("unscripted createBranchRef");
      return script.createBranch;
    },
    tempFile: {
      write: (contents) => {
        const parsed: unknown = JSON.parse(contents);
        const branch =
          (
            typeof parsed === "object" &&
            parsed !== null &&
            "branch" in parsed &&
            typeof parsed.branch === "string"
          ) ?
            parsed.branch
          : "";
        lastBodyBranch = branch || "default";
        return TEMP_BODY_PATH;
      },
      remove: () => undefined
    },

    // --- GitHub environment ---
    setCanonicalEnvironment: (target, environment) => {
      setCanonicalEnvironment(target, environment);
    },
    // The real ledger writers, so the provenance this route records is the
    // provenance a rollback would later read. A hand-written double could only
    // restate the monotonic rule these two enforce.
    recordGitHubEnvironment: (targetOperation, patch) => {
      journal.push(`recordGitHubEnvironment:${patch.state}`);
      recordGitHubEnvironment(targetOperation, patch);
    },
    recordGitHubEnvironmentVariable: (targetOperation, entry) => {
      journal.push(`recordGitHubEnvironmentVariable:${entry.name}`);
      recordGitHubEnvironmentVariable(targetOperation, entry);
    },
    promoteCreatedGitHubEnvironment: (targetOperation, identity) => {
      const promoted = promoteCreatedGitHubEnvironment(
        targetOperation,
        identity
      );
      journal.push(`promoteCreatedGitHubEnvironment:${String(promoted)}`);
      return promoted;
    },
    envListCacheDelete: (repo) => {
      journal.push(`envListCacheDelete:${repo}`);
    },
    ociStateBackend: "oci",
    defaultStateArchive: "radius-state",

    // --- credentials ---
    azureCredential:
      script.azureCredential ??
      (() => ({ clientId: "c", tenantId: "t", subscriptionId: "s" })),
    awsCredential: () => ({}),
    optionalString: (value) => (typeof value === "string" ? value : ""),

    // --- workflow generation and commit ---
    generateVerifyWorkflow: async (environment) => {
      journal.push(`generateVerifyWorkflow:${environment}`);
      // Carries the operation marker production always injects, so the plan
      // reads marker support from a file shaped like the real one.
      return MARKED_VERIFY_WORKFLOW;
    },
    generateDeployWorkflow: async (environment) => {
      journal.push(`generateDeployWorkflow:${environment}`);
      return {
        "run-rad-commands.yml": "on: workflow_dispatch\njobs:\n"
      };
    },
    generateDeleteWorkflow: async (environment) => {
      journal.push(`generateDeleteWorkflow:${environment}`);
      return {
        "radius-delete.yml": "on: workflow_dispatch\njobs:\n"
      };
    },
    recordCommittedWorkflowFile: (target, committed) => {
      committedFiles.push(committed);
      recordCommittedWorkflowFile(target, committed);
    },
    deleteLegacyDeployWorkflow: async () => {
      journal.push("deleteLegacyDeployWorkflow");
      return true;
    },
    createPullRequestApi: async () => {
      if (!script.pullRequest)
        throw new Error("unscripted createPullRequestApi");
      journal.push("createPullRequestApi");
      return {
        ok: script.pullRequest.ok,
        url: script.pullRequest.url,
        number: script.pullRequest.number,
        stderr: script.pullRequest.stderr
      };
    },

    // --- verification ---
    planCredentialVerification,
    // The repository holds a workflow once this run has actually committed it
    // to that branch, which is what verification planning reads back. Modelling
    // that here keeps a protected default branch correctly empty while the
    // direct-commit path sees the file it just wrote. Scripts override it.
    fetchFileFromRepo: async (_repo, path, branch) =>
      script.files?.[path] ??
      ((
        committedFiles.some(
          (file) =>
            `.github/workflows/${path.split("/").pop()}` === file.path &&
            (!branch || file.branch === branch)
        )
      ) ?
        MARKED_VERIFY_WORKFLOW
      : null),
    buildVerifyWorkflowDispatchArgs,
    verifyWorkflowFile: "radius-verify-credentials.yml",
    stageVerify: STAGE_VERIFY,

    // --- terminal state ---
    recordCleanupState: (_operation, patch) => {
      journal.push(`recordCleanupState:${patch.state}`);
    },
    recordCommitState: (_operation, patch) => {
      journal.push("recordCommitState");
      commitStates.push(patch);
    },
    setStageState: (_operation, stage, stageState) => {
      journal.push(`setStageState:${stage}:${stageState}`);
    },
    finish: (_operation, finishState, options) => {
      journal.push(`finish:${finishState}`);
      finished.push({ state: finishState, options });
    },

    // --- clocks: injected so the dispatch backoff costs no wall time ---
    sleep: async () => undefined,
    now: () => 1700000000000
  };

  const routes = createTestRouteTable(
    createCreateEnvironmentRoutes(dependencies)
  );

  container = createCanvasServer({
    createHttpServer: (handler) => createServer(handler),
    createRequestHandler: ({ instanceId, instances, markActivity }) =>
      createRequestHandler({
        instanceId,
        instances,
        routes,
        markActivity,
        handleUnmatchedRequest: (_request, response) => {
          response.writeHead(404);
          response.end("unmatched");
        }
      }),
    createState: () => state,
    defaultPage: "graph",
    now: () => Date.now(),
    preferredPort: async () => 0,
    prepareIdentity: () => {}
  });

  return {
    baseUrl: "",
    journal,
    setJournalHook: (hook) => {
      journalHook = hook;
    },
    ghCalls,
    steps,
    operation,
    state,
    finished,
    commitStates,
    committedFiles,
    failures,
    cleanupErrors,
    cleanupReaders,
    cleanupReads
  };
}

async function post(
  body: unknown,
  options: { serverOwned?: boolean } = {}
): Promise<Response> {
  const entry = await container!.getOrCreate("panel-a");
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  if (options.serverOwned !== false) {
    headers["X-Radius-Server-Owned"] = SERVER_OWNED_TOKEN;
  }
  return fetch(`${entry.baseUrl}/api/create-environment`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

describe("create-environment real-loopback HIT: the server-owned gate", () => {
  it("refuses a request that arrives without the server-owned token", async () => {
    const harness = start();

    const response = await post({ repo: "octo/app" }, { serverOwned: false });

    expect(response.status).toBe(403);
    // The header is set before the status line, so it survives on the refusal.
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      error: "This endpoint is reserved for server-owned operations.",
      code: "server-owned-operation-required"
    });
    // Refused before the body is read and before any operation is touched.
    expect(harness.journal).toEqual([]);
    expect(harness.ghCalls).toEqual([]);
  });

  it("serves the same request over the same socket once it carries the token", async () => {
    const harness = start();

    const response = await post({ repo: "octo/app" });

    expect(response.status).toBe(200);
    expect(harness.journal).toContain("preflightRepoAdmin");
  });

  it("still falls through for methods the route table does not declare", async () => {
    start();
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/create-environment`, {
      method: "GET",
      headers: { "X-Radius-Server-Owned": SERVER_OWNED_TOKEN }
    });

    expect(response.status).toBe(404);
  });
});

describe("create-environment real-loopback HIT: the refusal ladder on the wire", () => {
  it("refuses 400 when no repository was supplied", async () => {
    start();

    const response = await post({});

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "No target repository specified."
    });
  });

  it("refuses 400 for a repository that is not owner/repo", async () => {
    start();

    const response = await post({ repo: "octo" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Invalid repository "octo". Expected "owner/repo".',
      code: "invalid-repo"
    });
  });

  it("answers the unhandled-error envelope when the body is not JSON", async () => {
    const harness = start();

    const response = await post("not json at all");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "create-environment-unhandled"
    });
    expect(harness.ghCalls).toEqual([]);
  });

  it("refuses with the repo-admin message before touching GitHub", async () => {
    const harness = start({
      repoAdminRefusal: "You need admin on octo/app."
    });

    const response = await post({ repo: "octo/app" });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "You need admin on octo/app.",
      code: "repo-admin-required"
    });
    expect(harness.ghCalls).toEqual([]);
  });

  it("refuses with the GHCR preflight verdict before bootstrapping the package", async () => {
    const harness = start({
      ghcrPreflight: {
        ok: false,
        status: 403,
        error: "Your token cannot write packages.",
        code: "ghcr-package-write-required"
      }
    });

    const response = await post({ repo: "octo/app" });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Your token cannot write packages.",
      code: "ghcr-package-write-required"
    });
    expect(harness.journal).not.toContain("bootstrapGHCRStatePackage");
  });

  it.each([
    {
      name: "repository administration",
      script: { repoAdminRefusal: "You need admin on octo/app." }
    },
    {
      name: "GHCR package access",
      script: {
        ghcrPreflight: {
          ok: false as const,
          status: 403 as const,
          error: "Your token cannot write packages.",
          code: "ghcr-package-write-required"
        }
      }
    }
  ])(
    "provides the GitHub environment cleanup runner to $name preflight finalization",
    async ({ script }) => {
      const harness = start({
        ...script,
        preparedEnvironment: {
          requestedName: "dev",
          canonicalName: "dev",
          state: "created_candidate"
        },
        exerciseCleanupDelete: true,
        gh: [
          {
            match:
              /^api --method DELETE \/repos\/octo\/app\/environments\/dev$/,
            result: { code: "0" }
          }
        ]
      });

      const response = await post({
        repo: "octo/app",
        environment: "dev",
        operationEnvironment: "dev",
        operationId: "op-http"
      });

      expect(response.status).toBe(403);
      expect(harness.cleanupErrors).toEqual([]);
      expect(harness.ghCalls).toContain(
        "api --method DELETE /repos/octo/app/environments/dev"
      );
      // Without a reader the cleanup's identity gate has nothing to compare
      // the recorded id against and refuses to delete at all.
      expect(harness.cleanupReaders).toEqual([true]);
    }
  );

  it("reads the environment back through the account the operation selected", async () => {
    const harness = start({
      repoAdminRefusal: "You need admin on octo/app.",
      preparedEnvironment: {
        requestedName: "dev",
        canonicalName: "dev",
        state: "created_candidate"
      },
      exerciseCleanupDelete: true,
      gh: [
        {
          match: /^api \/repos\/octo\/app\/environments\/dev$/,
          result: {
            code: 0,
            stdout: JSON.stringify({ id: 1234567, name: "dev" })
          }
        },
        {
          match: /^api --method DELETE \/repos\/octo\/app\/environments\/dev$/,
          result: { code: "0" }
        }
      ]
    });

    await post({
      repo: "octo/app",
      environment: "dev",
      operationEnvironment: "dev",
      operationId: "op-http"
    });

    // The read went through the selected executor, so it answers for the
    // account that made the environment rather than whichever login the
    // ambient CLI happens to hold.
    expect(harness.ghCalls).toContain("api /repos/octo/app/environments/dev");
    expect(harness.cleanupReads).toEqual([
      {
        code: 0,
        stdout: JSON.stringify({ id: 1234567, name: "dev" }),
        stderr: ""
      }
    ]);
  });

  it("hands an access failure to the cleanup rather than reporting absence", async () => {
    const harness = start({
      repoAdminRefusal: "You need admin on octo/app.",
      preparedEnvironment: {
        requestedName: "dev",
        canonicalName: "dev",
        state: "created_candidate"
      },
      exerciseCleanupDelete: true,
      gh: [
        {
          match: /^api \/repos\/octo\/app\/environments\/dev$/,
          result: { code: 1, stderr: "HTTP 403: Forbidden" }
        },
        {
          match: /^api --method DELETE \/repos\/octo\/app\/environments\/dev$/,
          result: { code: "0" }
        }
      ]
    });

    await post({
      repo: "octo/app",
      environment: "dev",
      operationEnvironment: "dev",
      operationId: "op-http"
    });

    // The refusal is propagated as a refusal. Collapsing it into an empty
    // result would read as "the environment is gone" to the caller.
    expect(harness.cleanupReads).toEqual([
      { code: 1, stdout: "", stderr: "HTTP 403: Forbidden" }
    ]);
  });
});

describe("create-environment real-loopback HIT: the seven-step workflow", () => {
  it("answers a single synchronous 200 describing the whole run", async () => {
    start();

    const response = await post({ repo: "octo/app", environment: "dev" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      success: true,
      operationId: "op-http",
      environment: "dev",
      provider: "azure",
      repo: "octo/app",
      stateBackend: "oci",
      stateRegistry: "ghcr.io/octo/app/radius-state-dev",
      stateArchive: "radius-state",
      verifyRunUrl: "https://github.com/octo/app/actions/runs/4242",
      actionRequired: false,
      pullRequestUrl: "",
      pullRequestBranch: null,
      pullRequestBaseBranch: null
    });
    expect(Array.isArray(payload.steps)).toBe(true);
  });

  it("reports verification dispatch without implying the environment is ready", async () => {
    const harness = start();

    const response = await post({ repo: "octo/app", environment: "dev" });
    const payload = (await response.json()) as { steps: string[] };

    expect(payload.steps).toContain("✅ Credentials verification dispatched.");
    const dispatchStep = payload.steps.find((step) =>
      step.includes('workflow "radius-verify-credentials.yml"')
    );
    expect(dispatchStep).toEqual(
      expect.stringContaining("@octocat using the stored GitHub CLI credential")
    );
    expect(dispatchStep).toEqual(
      expect.stringContaining(
        'environment "dev", repository "octo/app", ref "main"'
      )
    );
    expect(
      payload.steps.filter(
        (step) => step === "✅ Credentials verification dispatched."
      )
    ).toHaveLength(1);
    expect(payload.steps).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "Environment created. Deploy your application from the Environments list when ready."
        )
      ])
    );
    expect(harness.steps).toContain("✅ Credentials verification dispatched.");
    expect(
      harness.ghCalls.find((call) => call.startsWith("workflow run "))
    ).toContain("--ref main");
  });

  it("dispatches against the confirmed non-main default branch", async () => {
    const harness = start({ defaultBranch: "trunk" });

    const response = await post({ repo: "octo/app", environment: "dev" });

    expect(response.status).toBe(200);
    expect(
      harness.ghCalls.find((call) => call.startsWith("workflow run "))
    ).toContain("--ref trunk");
    expect(harness.operation.verification).toMatchObject({ ref: "trunk" });
    const payload = (await response.json()) as { steps: string[] };
    expect(payload.steps).toEqual(
      expect.arrayContaining([
        expect.stringContaining('repository "octo/app", ref "trunk"')
      ])
    );
  });

  it("skips verification and finishes action_required when cloud credentials are incomplete", async () => {
    // Issue #219: the shared Azure credential is missing a subscription ID, so
    // dispatching verify would only produce a run that fails at the cloud-login
    // step. The handler must skip the dispatch and finish the operation as
    // action_required with guidance, rather than leaving it polling a verify run
    // that will never exist.
    const harness = start({
      azureCredential: () => ({ clientId: "c", tenantId: "t" })
    });

    const response = await post({ repo: "octo/app", environment: "dev" });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      success: true,
      verifySkipped: true,
      verifyRunUrl: ""
    });
    expect(payload.verifySkipReason).toEqual(expect.any(String));
    expect(payload.verifySkipReason).not.toBe("");
    // No verify run was dispatched.
    expect(harness.journal).not.toContain("dispatchVerifyWorkflow");
    expect(
      harness.ghCalls.some((call) => call.startsWith("workflow run "))
    ).toBe(false);
    // The operation reaches a terminal action_required state carrying the note.
    expect(harness.journal).toContain(`setStageState:${STAGE_VERIFY}:skipped`);
    expect(harness.finished).toEqual([
      {
        state: "action_required",
        options: {
          terminal: {
            reason: "credentials-incomplete",
            pullRequestUrl: null,
            userMessage: payload.verifySkipReason
          }
        }
      }
    ]);
  });

  it("reconciles a restored variable mutation before any later provider write", async () => {
    const harness = start({
      preparedEnvironment: {
        requestedName: "dev",
        canonicalName: "dev",
        state: "reused"
      },
      gh: [
        {
          match:
            /^api \/repos\/octo\/app\/environments\/dev\/variables\/RADIUS_MANAGED$/,
          result: {
            code: 0,
            stdout: JSON.stringify({ name: "RADIUS_MANAGED", value: "true" })
          }
        }
      ]
    });
    harness.operation.recoveryState = "provider_reconciliation_pending";
    prepareProviderMutation(harness.operation, {
      kind: "github_environment_variable.put",
      target: "octo/app:dev:RADIUS_MANAGED",
      intent: {
        name: "RADIUS_MANAGED",
        value: "true",
        valueSha256: digestOf("true"),
        previousKnown: true,
        previousValue: null
      }
    });

    const response = await post({
      repo: "octo/app",
      environment: "dev",
      operationEnvironment: "dev",
      operationId: "op-http"
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      cancelled: true,
      code: "operation-stopped"
    });
    const providerRecovery = harness.operation.providerRecovery;
    if (!providerRecovery?.mutations) {
      throw new Error("expected the restored mutation journal");
    }
    expect(providerRecovery.mutations[0]).toMatchObject({
      status: "confirmed"
    });
    expect(harness.operation.setupArtifacts.githubEnvironmentVariables).toEqual(
      [
        expect.objectContaining({
          name: "RADIUS_MANAGED",
          previousValue: null,
          previousKnown: true
        })
      ]
    );
    expect(
      harness.ghCalls.some((call) => call.startsWith("variable set "))
    ).toBe(false);
    expect(
      harness.ghCalls.some((call) => call.startsWith("api --method PUT "))
    ).toBe(false);
  });

  it("recomputes incomplete credentials while reconciling a workflow", async () => {
    const harness = start({
      preparedEnvironment: {
        requestedName: "dev",
        canonicalName: "dev",
        state: "reused"
      },
      azureCredential: () => ({ clientId: "c", tenantId: "t" }),
      gh: recoveredVerifyWorkflowRules()
    });
    prepareVerifyWorkflowRecovery(harness.operation);

    const response = await post({
      repo: "octo/app",
      environment: "dev",
      operationEnvironment: "dev",
      operationId: "op-http"
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      success: true,
      verifySkipped: true,
      verifyRunUrl: ""
    });
    expect(harness.journal).not.toContain("dispatchVerifyWorkflow");
    expect(harness.finished).toEqual([
      {
        state: "action_required",
        options: {
          terminal: {
            reason: "credentials-incomplete",
            pullRequestUrl: null,
            userMessage: payload.verifySkipReason
          }
        }
      }
    ]);
  });

  it("deletes the legacy workflow after successful workflow reconciliation", async () => {
    const harness = start({
      preparedEnvironment: {
        requestedName: "dev",
        canonicalName: "dev",
        state: "reused"
      },
      gh: recoveredVerifyWorkflowRules()
    });
    prepareVerifyWorkflowRecovery(harness.operation);

    const response = await post({
      repo: "octo/app",
      environment: "dev",
      operationEnvironment: "dev",
      operationId: "op-http"
    });

    expect(response.status).toBe(200);
    expect(harness.journal).toContain("deleteLegacyDeployWorkflow");
  });

  it("preflights GHCR package scopes before bootstrapping the state package", async () => {
    // Migrated from the textual `createRoute` ordering assertion in
    // `operations.test.ts`: the same property, observed as call order.
    const harness = start();

    await post({ repo: "octo/app" });

    expect(
      harness.journal.indexOf("preflightGhcrPackageWriteAccess")
    ).toBeLessThan(harness.journal.indexOf("bootstrapGHCRStatePackage"));
    expect(
      harness.journal.indexOf("bootstrapGHCRStatePackage")
    ).toBeGreaterThan(-1);
  });

  it("succeeds with no application model and no deploy parameters present", async () => {
    // Migrated from the four negative source assertions (`appParams(`,
    // `resolveDeployParams(`, `RADIUS_DEPLOY_PARAMS`, `RADIUS_RAD_COMMANDS`).
    // The behavioral form is strictly stronger: the dependency object exposes no
    // way to resolve a deploy model, so a run that completes proves environment
    // creation never needed one.
    const harness = start();

    const response = await post({ repo: "octo/app" });

    expect(response.status).toBe(200);
    const variableSets = harness.ghCalls.filter((call) =>
      call.startsWith("variable set ")
    );
    expect(variableSets.length).toBeGreaterThan(0);
    for (const call of variableSets) {
      expect(call).not.toContain("RADIUS_DEPLOY_PARAMS");
      expect(call).not.toContain("RADIUS_RAD_COMMANDS");
    }
  });

  it("checks whether the GitHub environment exists before creating it", async () => {
    const harness = start();

    await post({ repo: "octo/app" });

    const lookup = harness.ghCalls.indexOf(
      "api /repos/octo/app/environments/dev"
    );
    const put = harness.ghCalls.indexOf(
      "api --method PUT /repos/octo/app/environments/dev"
    );
    expect(lookup).toBeGreaterThan(-1);
    expect(put).toBeGreaterThan(lookup);
    expect(harness.journal).toContain(
      "recordGitHubEnvironment:created_candidate"
    );
  });

  it("fails before workflow mutation when the default branch cannot be resolved", async () => {
    const harness = start({ defaultBranch: null });

    const response = await post({ repo: "octo/app" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        "Could not determine the default branch for octo/app, so Radius did not commit workflow files with guessed rollback provenance.",
      code: "default-branch-unavailable"
    });
    expect(harness.journal).toContain(
      "finalizeSetupFailure:default-branch-unavailable"
    );
    expect(harness.ghCalls.some((call) => call.includes("/contents/"))).toBe(
      false
    );
    expect(harness.committedFiles).toEqual([]);
  });

  it("records a pre-existing environment as reused rather than created", async () => {
    const harness = start({
      gh: [
        {
          match: /^api \/repos\/octo\/app\/environments\/dev$/,
          result: { code: 0, stdout: '{"name":"dev"}' }
        }
      ]
    });

    await post({ repo: "octo/app" });

    expect(harness.journal).toContain("recordGitHubEnvironment:reused");
    expect(harness.operation.setupArtifacts.githubEnvironment).toMatchObject({
      state: "reused",
      origin: "pre_existing"
    });
    expect(harness.journal).not.toContain(
      "promoteCreatedGitHubEnvironment:true"
    );
  });

  it("checkpoints proven ownership before honoring a stop boundary", async () => {
    const harness = start({
      gh: [
        {
          match: /^api --method PUT \/repos\/octo\/app\/environments\/dev$/,
          result: {
            code: 0,
            stdout: JSON.stringify({
              id: 1234567,
              node_id: "MDExOkVudmlyb25tZW50MTIzNDU2Nw==",
              name: "dev",
              created_at: "2023-11-14T22:13:20.000Z"
            })
          }
        }
      ]
    });

    await post({ repo: "octo/app" });

    // The proof is settled in memory first, then the mutation checkpoint saves
    // that ownership before the stop boundary can return.
    const recorded = harness.journal.indexOf(
      "recordGitHubEnvironment:created_candidate"
    );
    const checkpoint = harness.journal.indexOf("checkpoint", recorded);
    const promoted = harness.journal.indexOf(
      "promoteCreatedGitHubEnvironment:true"
    );
    expect(recorded).toBeGreaterThan(-1);
    expect(promoted).toBeGreaterThan(recorded);
    expect(checkpoint).toBeGreaterThan(promoted);
    expect(harness.operation.setupArtifacts.githubEnvironment).toEqual({
      state: "created",
      origin: "this_operation",
      repo: "octo/app",
      name: "dev",
      // GitHub's own id, kept so a later rollback can tell this environment
      // from a replacement created under the same name.
      providerId: "1234567"
    });
    expect(harness.steps).toContain(
      '✅ GitHub environment "dev" created by this setup — Radius owns it and can remove it.'
    );
  });

  it("keeps the environment unowned when GitHub says it predates this request", async () => {
    const harness = start({
      gh: [
        {
          match: /^api --method PUT \/repos\/octo\/app\/environments\/dev$/,
          result: {
            code: 0,
            stdout: JSON.stringify({
              id: 1234567,
              name: "dev",
              created_at: "2020-01-01T00:00:00.000Z",
              updated_at: "2026-02-01T12:00:00.000Z"
            })
          }
        }
      ]
    });

    await post({ repo: "octo/app" });

    expect(harness.operation.setupArtifacts.githubEnvironment).toMatchObject({
      state: "created_candidate",
      origin: "unknown"
    });
    expect(harness.journal).not.toContain(
      "promoteCreatedGitHubEnvironment:true"
    );
    expect(
      harness.steps.some(
        (step) =>
          step.startsWith(
            'ℹ️ Radius left GitHub environment "dev" outside its cleanup scope.'
          ) && step.includes("2020-01-01T00:00:00.000Z")
      )
    ).toBe(true);
  });

  it("fails closed when promoted ownership cannot be checkpointed", async () => {
    const harness = start({ persistRejectsAfter: 3 });

    await post({ repo: "octo/app" });

    const promoted = harness.journal.indexOf(
      "promoteCreatedGitHubEnvironment:true"
    );
    expect(promoted).toBeGreaterThan(-1);
    expect(harness.journal).toContain(
      "diagnostic:operation-store-write-failed"
    );
    expect(harness.operation.setupArtifacts.githubEnvironment.state).toBe(
      "created"
    );
    expect(
      harness.journal.indexOf(
        "finalizeSetupFailure:operation-persistence-failed"
      )
    ).toBeGreaterThan(promoted);
  });

  it("uses GitHub's canonical name for state, variables, workflows, and verification", async () => {
    const harness = start({
      gh: [
        {
          match: /^api \/repos\/octo\/app\/environments\/production$/,
          result: {
            code: 0,
            stdout: '{"name":"Production","id":1234567}'
          }
        }
      ]
    });

    const response = await post({
      repo: "octo/app",
      environment: "production"
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      environment: "Production",
      stateRegistry: "ghcr.io/octo/app/radius-state-Production"
    });
    expect(harness.operation.environment).toBe("production");
    expect(harness.operation.context).toMatchObject({
      requestedEnvironment: "production",
      canonicalEnvironment: "Production"
    });
    expect(harness.journal).toEqual(
      expect.arrayContaining([
        "stateRegistry:Production",
        "generateVerifyWorkflow:Production",
        "generateDeployWorkflow:Production",
        "generateDeleteWorkflow:Production"
      ])
    );
    expect(
      harness.ghCalls
        .filter((call) => call.startsWith("variable set "))
        .every((call) => call.includes("--env Production"))
    ).toBe(true);
    expect(
      harness.ghCalls.some(
        (call) =>
          call.startsWith("workflow run ") &&
          call.includes("environment=Production")
      )
    ).toBe(true);
    expect(
      harness.ghCalls.some(
        (call) =>
          call === "api --method PUT /repos/octo/app/environments/production"
      )
    ).toBe(false);
  });

  it("reuses the operation's persisted canonical resolution without another environment lookup", async () => {
    const harness = start({
      preparedEnvironment: {
        requestedName: "production",
        canonicalName: "Production",
        state: "created_candidate"
      }
    });

    const response = await post({
      repo: "octo/app",
      environment: "Production",
      operationEnvironment: "production",
      operationId: "op-http"
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      environment: "Production"
    });
    expect(
      harness.ghCalls.some((call) =>
        /^api \/repos\/octo\/app\/environments\/(?!Production(?:\/|$))/.test(
          call
        )
      )
    ).toBe(false);
    expect(harness.journal).toContain(
      "recordGitHubEnvironment:created_candidate"
    );
  });

  it("aborts without creating anything when the environment lookup is ambiguous", async () => {
    // A lookup that neither succeeded nor proved absence must fail closed: a PUT
    // here could silently adopt someone else's environment.
    const harness = start({
      gh: [
        {
          match: /^api \/repos\/octo\/app\/environments\/dev$/,
          result: { code: 1, stderr: "HTTP 500: upstream unavailable" }
        }
      ]
    });

    const response = await post({ repo: "octo/app" });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error:
        'Could not resolve GitHub environment "dev". HTTP 500: upstream unavailable',
      code: "create-environment-unhandled"
    });
    expect(
      harness.ghCalls.some((call) => call.startsWith("api --method PUT"))
    ).toBe(false);
  });

  it.each([
    {
      status: 404,
      stderr: "HTTP 404: Not Found",
      detail: "HTTP 404: Not Found"
    },
    {
      status: 403,
      stderr: "HTTP 403: Resource not accessible",
      detail: "HTTP 403: Resource not accessible"
    },
    {
      status: null,
      stderr: "connection closed",
      detail: "connection closed"
    }
  ])(
    "does not create the environment when repository confirmation fails with status $status",
    async ({ stderr, detail }) => {
      const harness = start({
        gh: [
          {
            match: /^api \/repos\/octo\/app$/,
            result: { code: 1, stderr }
          }
        ]
      });

      const response = await post({ repo: "octo/app" });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: `Could not confirm repository "octo/app" before creating GitHub environment "dev". ${detail}`,
        code: "create-environment-unhandled"
      });
      expect(
        harness.ghCalls.some((call) => call.startsWith("api --method PUT"))
      ).toBe(false);
      expect(harness.ghCalls).toEqual([
        "api /repos/octo/app/environments/dev",
        "api /repos/octo/app"
      ]);
    }
  );

  it("records candidate provenance when create omits the canonical name", async () => {
    const harness = start({
      gh: [
        {
          match: /^api --method PUT \/repos\/octo\/app\/environments\/dev$/,
          result: { code: 0, stdout: "{}" }
        }
      ]
    });

    const response = await post({ repo: "octo/app" });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error:
        'GitHub created environment "dev" but did not report its canonical name. The environment was left in place because Radius cannot prove this request created it.',
      code: "create-environment-unhandled"
    });
    expect(harness.operation.setupArtifacts?.githubEnvironment).toEqual({
      state: "created_candidate",
      origin: "unknown",
      repo: "octo/app",
      name: "dev",
      // The create answered without an id, so there is nothing to record and
      // a rollback will refuse to delete by name alone.
      providerId: null
    });
    expect(harness.ghCalls).toEqual([
      "api /repos/octo/app/environments/dev",
      "api /repos/octo/app",
      "api --method PUT /repos/octo/app/environments/dev"
    ]);
  });

  it.each([
    { code: 0, expectedErrors: [] },
    { code: "0", expectedErrors: [] },
    { code: 1, expectedErrors: ["cleanup failed"] }
  ])(
    "handles cleanup command result code $code",
    async ({ code, expectedErrors }) => {
      const harness = start({
        gh: [
          {
            match: /^api \/repos\/octo\/app\/environments\/dev$/,
            result: { code: 0, stdout: '{"name":"dev"}' }
          },
          {
            match:
              /^api --method DELETE \/repos\/octo\/app\/environments\/dev$/,
            result: { code, stderr: "cleanup failed" }
          }
        ],
        statePackageError: "state setup failed",
        exerciseCleanupDelete: true
      });

      const response = await post({ repo: "octo/app" });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "state setup failed",
        code: "create-environment-unhandled"
      });
      expect(harness.cleanupErrors).toEqual(expectedErrors);
    }
  );

  it("tags the environment as Radius-managed and drops the cached listing", async () => {
    const harness = start();

    await post({ repo: "octo/app" });

    expect(harness.ghCalls).toContain(
      "variable set RADIUS_MANAGED --body true --env dev --repo octo/app"
    );
    expect(harness.journal).toContain("envListCacheDelete:octo/app");
  });

  it("finalizes a variable preflight failure instead of reporting nonexistent reconciliation", async () => {
    const harness = start({
      gh: [
        {
          match:
            /^api \/repos\/octo\/app\/environments\/dev\/variables\/RADIUS_MANAGED$/,
          result: { code: 1, stderr: "HTTP 503: unavailable" }
        }
      ]
    });

    const response = await post({ repo: "octo/app" });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "create-environment-unhandled"
    });
    expect(harness.failures).toContainEqual(
      expect.objectContaining({ code: "create-environment-unhandled" })
    );
    expect(
      harness.ghCalls.some((call) =>
        call.startsWith("variable set RADIUS_MANAGED ")
      )
    ).toBe(false);
  });

  it("records the credential profile the request names", async () => {
    const harness = start();

    await post({ repo: "octo/app", profileName: "work" });

    expect(harness.ghCalls).toContain(
      "variable set RADIUS_CREDENTIAL_PROFILE --body work --env dev --repo octo/app"
    );
  });

  it("falls back to the shared Azure credential for values the request omits", async () => {
    // The shared credential is missing a subscription ID, so the fallback fills
    // client/tenant but verification is skipped with a warning (issue #219).
    const harness = start({
      azureCredential: () => ({ clientId: "c", tenantId: "t" })
    });

    await post({ repo: "octo/app" });

    expect(harness.ghCalls).toContain(
      "variable set AZURE_CLIENT_ID --body c --env dev --repo octo/app"
    );
    expect(
      harness.steps.some((step) =>
        step.startsWith("⚠️ Missing OIDC credentials")
      )
    ).toBe(true);
  });

  it("sets the AWS values, with a default region, for an AWS environment", async () => {
    const harness = start();

    await post({
      repo: "octo/app",
      provider: "aws",
      roleArn: "arn:aws:iam::1"
    });

    expect(harness.ghCalls).toContain(
      "variable set AWS_REGION --body us-east-1 --env dev --repo octo/app"
    );
    expect(harness.ghCalls).toContain(
      "variable set AWS_ROLE_ARN --body arn:aws:iam::1 --env dev --repo octo/app"
    );
  });

  it("defaults an empty environment name to dev rather than keeping the empty string", async () => {
    // `||`, not `??`: "" is not a usable GitHub environment name.
    const harness = start();

    const response = await post({ repo: "octo/app", environment: "" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ environment: "dev" });
    expect(harness.ghCalls).toContain("api /repos/octo/app/environments/dev");
  });

  it("records every committed workflow file against the default branch", async () => {
    const harness = start();

    await post({ repo: "octo/app" });

    // Every file carries the provenance a later rollback verifies against:
    // the commit it created, the blob GitHub stored, the digest of the bytes
    // Radius sent, and (here) no previous blob, because Radius created them.
    expect(harness.committedFiles).toEqual([
      {
        path: ".github/workflows/radius-verify-credentials.yml",
        branch: "main",
        mode: "default_branch",
        commitSha: "commit-sha",
        blobSha: "blob-sha",
        contentSha256: VERIFY_CONTENT_DIGEST,
        previousBlobSha: null,
        previousBlobKnown: true
      },
      {
        path: ".github/workflows/run-rad-commands.yml",
        branch: "main",
        mode: "default_branch",
        commitSha: "commit-sha",
        blobSha: "blob-sha",
        contentSha256: WORKFLOW_CONTENT_DIGEST,
        previousBlobSha: null,
        previousBlobKnown: true
      },
      {
        path: ".github/workflows/radius-delete.yml",
        branch: "main",
        mode: "default_branch",
        commitSha: "commit-sha",
        blobSha: "blob-sha",
        contentSha256: WORKFLOW_CONTENT_DIGEST,
        previousBlobSha: null,
        previousBlobKnown: true
      }
    ]);
    expect(harness.journal).toContain("deleteLegacyDeployWorkflow");
  });

  it("records the commit point only after the verify dispatch succeeded", async () => {
    const harness = start();

    await post({ repo: "octo/app" });

    const dispatch = harness.journal.indexOf("dispatchVerifyWorkflow");
    expect(dispatch).toBeGreaterThan(-1);
    expect(harness.journal.indexOf("recordCommitState")).toBeGreaterThan(
      dispatch
    );
    expect(harness.commitStates).toEqual([
      {
        mode: "default_branch",
        branch: "main",
        baseBranch: "main",
        pullRequestUrl: null
      }
    ]);
    // Dispatched, so the operation is not finished here — verification is still
    // running and the monitor owns the terminal state.
    expect(harness.finished).toEqual([]);
  });

  it("persists the run URL returned by the dispatch without discovery polling", async () => {
    const harness = start();

    await post({ repo: "octo/app" });

    expect(harness.state).toMatchObject({
      deployDispatchedAt: 1700000000000,
      verifyRunId: "4242",
      verifyRunUrl: "https://github.com/octo/app/actions/runs/4242"
    });
    expect(
      harness.ghCalls.filter(
        (call) =>
          call.startsWith("run list ") &&
          call.includes("databaseId,createdAt,displayTitle,event,headBranch")
      )
    ).toEqual([]);
    expect(harness.journal).toContain(`enterStage:${STAGE_VERIFY}`);
  });

  it("fails closed when the pre-dispatch run baseline is unreadable", async () => {
    const harness = start({
      gh: [{ match: /^run list /, result: { code: 0, stdout: "<html>" } }]
    });

    const response = await post({ repo: "octo/app" });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      code: "verify-baseline-read-failed"
    });
    expect(harness.state.verifyRunId).toBeUndefined();
    expect(harness.journal).not.toContain("dispatchVerifyWorkflow");
  });

  it("does not dispatch when the verification baseline read fails", async () => {
    const harness = start({
      gh: [
        {
          match: /^run list /,
          result: { code: 1, stderr: "GitHub Actions unavailable" }
        }
      ]
    });

    const response = await post({ repo: "octo/app" });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      code: "verify-baseline-read-failed"
    });
    expect(harness.journal).not.toContain("dispatchVerifyWorkflow");
  });

  it("surfaces a conclusive SAML dispatch refusal without reconciliation", async () => {
    const harness = start({
      dispatchResults: [
        {
          code: 1,
          stderr:
            "Resource protected by organization SAML enforcement. You must grant your OAuth token access."
        }
      ]
    });

    const response = await post({ repo: "octo/app" });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "verify-dispatch-failed",
      error: expect.stringContaining("SAML enforcement")
    });
    expect(
      harness.ghCalls.filter((call) => call.startsWith("run list "))
    ).toHaveLength(1);
    const operation = harness.operation as CreateEnvironmentOperation & {
      providerRecovery?: {
        mutations?: Array<{
          status: string;
          initialDiagnostic?: string | null;
        }>;
      };
    };
    expect(operation.providerRecovery?.mutations?.at(-1)).toMatchObject({
      status: "not_applied",
      initialDiagnostic: expect.stringContaining("SAML enforcement")
    });
  });

  it("does not adopt concurrent environment runs after an uncertain verification dispatch", async () => {
    const harness = start({
      gh: [
        {
          match: /^workflow run /,
          result: { code: 1, stderr: "terminated", timedOut: true }
        }
      ],
      runListResults: [
        { code: 0, stdout: "[]" },
        {
          code: 0,
          stdout: JSON.stringify([
            {
              databaseId: 4242,
              createdAt: "2023-11-14T22:13:20.000Z",
              event: "workflow_dispatch",
              headBranch: "main",
              displayTitle: "Verify Radius credentials (dev)"
            },
            {
              databaseId: 4243,
              createdAt: "2023-11-14T22:13:21.000Z",
              event: "workflow_dispatch",
              headBranch: "main",
              displayTitle: "Verify Radius credentials (prod)"
            }
          ])
        }
      ]
    });

    const response = await post({ repo: "octo/app", environment: "dev" });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(harness.state.verifyRunId).toBeUndefined();
    expect(
      harness.ghCalls.filter((call) => call.startsWith("workflow run "))
    ).toHaveLength(1);
    expect(
      (
        harness.operation as CreateEnvironmentOperation & {
          providerRecovery?: { state?: string };
        }
      ).providerRecovery
    ).toMatchObject({ state: "manual_required" });
  });

  it("adopts one exact run after an ambiguous timeout without redispatch", async () => {
    const harness = start({
      dispatchResults: [
        { code: 1, stderr: "request timed out", timedOut: true }
      ],
      runListResults: [
        { code: 0, stdout: "[]" },
        {
          code: 0,
          stdout: JSON.stringify([
            {
              databaseId: 4244,
              createdAt: "2023-11-14T22:13:20.000Z",
              displayTitle: "Radius verify dev [op-http]",
              event: "workflow_dispatch",
              headBranch: "main"
            }
          ])
        }
      ]
    });

    const response = await post({ repo: "octo/app", environment: "dev" });

    expect(response.status).toBe(200);
    expect(harness.operation.verification).toMatchObject({
      runId: "4244",
      runUrl: "https://github.com/octo/app/actions/runs/4244"
    });
    expect(
      harness.ghCalls.filter((call) => call.startsWith("workflow run "))
    ).toHaveLength(1);
  });

  it("terminalizes an ambiguous timeout when no exact run appears", async () => {
    const harness = start({
      dispatchResults: [
        { code: 1, stderr: "request timed out", timedOut: true }
      ],
      runListResults: [
        { code: 0, stdout: "[]" },
        { code: 0, stdout: "[]" },
        { code: 0, stdout: "[]" },
        { code: 0, stdout: "[]" }
      ]
    });

    const response = await post({ repo: "octo/app", environment: "dev" });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(harness.operation).toMatchObject({
      state: "failed_partial",
      endedAt: expect.any(String),
      recoveryState: "manual_required",
      failure: { code: "provider-reconciliation-manual-required" }
    });
    expect(
      harness.ghCalls.filter((call) => call.startsWith("workflow run "))
    ).toHaveLength(1);
  });

  it("treats a successful dispatch without a run URL as ambiguous", async () => {
    const harness = start({
      dispatchResults: [{ code: 0, stdout: "" }],
      runListResults: [
        { code: 0, stdout: "[]" },
        { code: 0, stdout: "[]" },
        { code: 0, stdout: "[]" },
        { code: 0, stdout: "[]" }
      ]
    });

    const response = await post({ repo: "octo/app" });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(harness.operation).toMatchObject({
      state: "failed_partial",
      recoveryState: "manual_required"
    });
    expect(
      harness.ghCalls.filter((call) => call.startsWith("workflow run "))
    ).toHaveLength(1);
  });

  it("fails closed instead of resuming an interrupted dispatch", async () => {
    const markedVerifyWorkflow = [
      "on:",
      "  workflow_dispatch:",
      "    inputs:",
      "      environment:",
      "        required: true",
      "      radius_operation:",
      "        required: false",
      "run-name: Radius verify ${{ inputs.environment }} [${{ inputs.radius_operation }}]",
      "jobs:"
    ].join("\n");
    const interruptedRun = {
      databaseId: 4242,
      createdAt: new Date(1700000000000 + 1000).toISOString(),
      event: "workflow_dispatch",
      headBranch: "main",
      displayTitle: "Radius verify dev [op-http]"
    };
    const visible = { code: 0, stdout: JSON.stringify([interruptedRun]) };
    const harness = start({
      files: {
        ".github/workflows/radius-verify-credentials.yml": markedVerifyWorkflow
      },
      gh: [
        {
          match: /^workflow run /,
          result: { code: 1, stderr: "a redispatch must not happen" }
        }
      ],
      runListResults: [visible, visible, visible, visible]
    });
    const operation = harness.operation as CreateEnvironmentOperation & {
      providerRecovery?: {
        mutations?: Array<{ kind: string; status: string }>;
      };
    };
    const pending = prepareProviderMutation(operation, {
      kind: "github_workflow.dispatch",
      target: "octo/app:radius-verify-credentials.yml:main:dev",
      providerIdempotencyKey: "op-http",
      intent: {
        dispatchedAt: 1700000000000,
        baselineRunId: null,
        ref: "main",
        environment: "dev",
        operationMarker: "op-http"
      }
    });
    settleProviderMutation(
      operation,
      pending.mutationId,
      "outcome_unknown",
      "The provider request ended without a response."
    );

    await post({ repo: "octo/app", environment: "dev" });

    expect(
      operation.providerRecovery?.mutations?.find(
        (entry) => entry.kind === "github_workflow.dispatch"
      )
    ).toMatchObject({ status: "manual_required" });
    expect(
      harness.ghCalls.filter((call) => call.startsWith("workflow run "))
    ).toEqual([]);
    expect(harness.operation.verification).toBeUndefined();
  });

  it("fails 400 with the workflow-scope hint when the verify workflow cannot be committed", async () => {
    const harness = start({
      ghCommandPresentation: {
        kind: "absolute",
        shell: "posix",
        executablePath: "/opt/Copilot Tools/gh",
        installationNote: "Install GitHub CLI system-wide."
      },
      gh: [
        {
          match: /^api --method PUT \/repos\/octo\/app\/contents\//,
          result: {
            code: 1,
            stderr:
              "HTTP 403: refusing to allow an OAuth App to create or update workflow `x.yml` without `workflow` scope"
          }
        }
      ]
    });

    const response = await post({ repo: "octo/app" });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string; code: string };
    expect(payload.code).toBe("verify-workflow-commit-failed");
    expect(payload.error).toContain(
      "'/opt/Copilot Tools/gh' auth refresh -h github.com -s workflow"
    );
    expect(payload.error).toContain("Install GitHub CLI system-wide.");
    expect(harness.committedFiles).toEqual([]);
  });

  it("fails 400 with the write-access hint for any other commit refusal", async () => {
    start({
      gh: [
        {
          match: /^api --method PUT \/repos\/octo\/app\/contents\//,
          result: { code: 1, stderr: "HTTP 404: Not Found" }
        }
      ]
    });

    const response = await post({ repo: "octo/app" });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain(
      "Check that you have write access to the repository"
    );
  });

  it("does not report a server-side commit failure as a refusal it can retry", async () => {
    const harness = start({
      gh: [
        {
          match: /^api --method PUT \/repos\/octo\/app\/contents\//,
          result: { code: 1, stderr: "HTTP 500: server error" }
        }
      ]
    });

    const response = await post({ repo: "octo/app" });

    // A 500 can be reported after GitHub already accepted the write, so the
    // write is reconciled against the repository rather than replayed, and the
    // single PUT is never repeated behind the customer's back.
    expect(
      harness.ghCalls.filter((call) =>
        call.startsWith("api --method PUT /repos/octo/app/contents/")
      )
    ).toHaveLength(1);
    expect(response.status).not.toBe(400);
    const recovery = (
      harness.operation as CreateEnvironmentOperation & {
        providerRecovery?: {
          mutations?: Array<{ kind?: string; status?: string }>;
        };
      }
    ).providerRecovery;
    const put = recovery?.mutations?.find(
      (entry) => entry.kind === "github_workflow.put"
    );
    // Never `not_applied`: that is the one status that would authorize a
    // later attempt to reissue a write GitHub may already hold.
    expect(put?.status).not.toBe("not_applied");
  });

  it("retries qualified workflow registration rejections and persists the returned run", async () => {
    const harness = start({
      dispatchResults: [
        {
          code: 1,
          stderr:
            "HTTP 404: workflow radius-verify-credentials.yml not found on branch main"
        },
        {
          code: 1,
          stderr: 'HTTP 422: Unexpected inputs provided: ["radius_operation"]'
        },
        {
          code: 0,
          stdout: "https://github.com/octo/app/actions/runs/4250\n"
        }
      ]
    });

    const response = await post({ repo: "octo/app" });
    const payload = await response.json();

    expect(payload).toMatchObject({ success: true });
    expect(response.status).toBe(200);
    expect(harness.operation.verification).toMatchObject({
      runId: "4250",
      runUrl: "https://github.com/octo/app/actions/runs/4250"
    });
    expect(
      harness.ghCalls.filter((call) => call.startsWith("workflow run "))
    ).toHaveLength(3);
    expect(
      harness.ghCalls.filter(
        (call) => call.startsWith("run list ") && call.includes("--limit 1")
      )
    ).toHaveLength(1);
  });

  it("does not retry a generic workflow dispatch rejection", async () => {
    const harness = start({
      gh: [
        {
          match: /^workflow run /,
          result: { code: 1, stderr: "HTTP 404: workflow not found" }
        }
      ]
    });

    const response = await post({ repo: "octo/app" });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "verify-dispatch-failed"
    });
    expect(
      harness.ghCalls.filter((call) => call.startsWith("workflow run "))
    ).toHaveLength(1);
  });
});

describe("create-environment real-loopback HIT: the protected-branch path", () => {
  // Only the commit that targets the default branch is rejected; the retry the
  // committer makes against the pull-request branch is allowed through, which
  // is what a real protected branch does.
  const protectedScript: Script = {
    gh: [
      {
        match:
          /^api --method PUT \/repos\/octo\/app\/contents\/\S+ --input @default$/,
        result: { code: 1, stderr: "protected branch" }
      }
    ],
    headSha: "sha-base",
    createBranch: { ok: true, stderr: "" },
    pullRequest: {
      ok: true,
      url: "https://github.com/octo/app/pull/7",
      number: 7
    }
  };

  it("opens a pull request and finishes action_required without dispatching", async () => {
    const harness = start(protectedScript);

    const response = await post({ repo: "octo/app" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      actionRequired: true,
      pullRequestUrl: "https://github.com/octo/app/pull/7",
      pullRequestBranch: "radius/setup-dev-workflows-op-http",
      pullRequestBaseBranch: "main",
      verifyRunUrl: ""
    });
    expect(
      harness.ghCalls.some((call) => call.startsWith("workflow run "))
    ).toBe(false);
    expect(harness.commitStates).toEqual([
      {
        mode: "pull_request",
        branch: "radius/setup-dev-workflows-op-http",
        baseBranch: "main",
        pullRequestUrl: "https://github.com/octo/app/pull/7"
      }
    ]);
    expect(harness.journal).toContain(`setStageState:${STAGE_VERIFY}:skipped`);
    expect(harness.finished).toEqual([
      {
        state: "action_required",
        options: {
          terminal: {
            reason: "pr-merge-required",
            pullRequestUrl: "https://github.com/octo/app/pull/7",
            branch: "radius/setup-dev-workflows-op-http",
            baseBranch: "main",
            userMessage:
              "Merge the pull request to finish setup; credential verification and deploys run once it lands."
          }
        }
      }
    ]);
    expect(harness.journal).toContain("persistBestEffort");
  });

  it("persists pull-request provenance before honoring Stop", async () => {
    const harness = start(protectedScript);
    harness.setJournalHook((entry) => {
      if (entry === "stopBoundary:after-workflow-pull-request") {
        harness.operation.stopRequested = true;
      }
    });

    const response = await post({ repo: "octo/app" });
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      code: "operation-stopped",
      boundary: "after-workflow-pull-request"
    });
    expect(harness.commitStates).toEqual([
      {
        mode: "pull_request",
        branch: "radius/setup-dev-workflows-op-http",
        baseBranch: "main",
        pullRequestUrl: "https://github.com/octo/app/pull/7"
      }
    ]);
    expect(harness.journal).toContain("createPullRequestApi");
    expect(harness.journal).not.toContain("dispatchVerifyWorkflow");
  });

  // Reconciliation still owns the operation and it is not terminal, so it must
  // outrank a Stop recorded while the pull request was in flight. Ending the
  // operation here would leave the journal entry open with nothing to settle it.
  it("answers a reconciling pull request rather than honoring a pending Stop", async () => {
    const harness = start({
      ...protectedScript,
      gh: [
        ...(protectedScript.gh ?? []),
        {
          // The reconciling read cannot answer either, so the outcome stays
          // unknown and the operation stays reconciling.
          match: /^api \/repos\/octo\/app\/pulls\?/,
          result: { code: 1, stderr: "HTTP 500" }
        }
      ],
      pullRequest: { ok: false, stderr: "ECONNRESET" }
    });
    harness.setJournalHook((entry) => {
      if (entry === "createPullRequestApi")
        harness.operation.stopRequested = true;
    });

    const response = await post({ repo: "octo/app" });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      code: "provider-mutation-outcome-unknown",
      reconciling: true,
      operationId: "op-http"
    });
    expect(String(body.message)).toContain("github_pull_request.create");
    expect(harness.journal).toContain("createPullRequestApi");
    expect((harness.operation as { endedAt?: unknown }).endedAt).toBeFalsy();
    expect(harness.failures).toEqual([]);

    harness.journal.length = 0;
    harness.ghCalls.length = 0;
    const recoveryResponse = await post({ repo: "octo/app" });

    expect(recoveryResponse.status).toBe(202);
    expect(harness.journal).not.toContain("preflightRepoAdmin");
    expect(harness.journal).not.toContain("preflightGhcrPackageWriteAccess");
    expect(harness.journal).not.toContain("bootstrapGHCRStatePackage");
    expect(harness.journal).not.toContain("deleteLegacyDeployWorkflow");
    expect(
      harness.ghCalls.some((call) => call.startsWith("variable set "))
    ).toBe(false);
  });

  it("skips deleting the legacy deploy workflow while commits go through a pull request", async () => {
    const harness = start(protectedScript);

    await post({ repo: "octo/app" });

    expect(harness.journal).not.toContain("deleteLegacyDeployWorkflow");
    expect(
      harness.committedFiles.every((file) => file.mode === "pull_request")
    ).toBe(true);
  });

  it("accepts a returned run URL for a legacy workflow without a marker", async () => {
    const harness = start({
      ...protectedScript,
      files: {
        ".github/workflows/radius-verify-credentials.yml":
          "on: workflow_dispatch\njobs:\n"
      }
    });

    const response = await post({ repo: "octo/app" });

    expect(await response.json()).toMatchObject({
      actionRequired: false,
      pullRequestUrl: "",
      pullRequestBranch: null
    });
    expect(harness.operation.verification).toMatchObject({
      event: "workflow_dispatch",
      operationMarker: "op-http",
      runId: "4242",
      runUrl: "https://github.com/octo/app/actions/runs/4242"
    });
    expect(
      harness.ghCalls.some((call) =>
        call.startsWith(
          "workflow run radius-verify-credentials.yml -f environment=dev --repo octo/app --ref radius/setup-dev-workflows-"
        )
      )
    ).toBe(true);
    expect(harness.commitStates.at(-1)).toMatchObject({
      mode: "pull_request",
      pullRequestUrl: null
    });
  });

  it("waits for the merge when the dispatcher still chains off verification", async () => {
    const harness = start({
      ...protectedScript,
      files: {
        ".github/workflows/radius-verify-credentials.yml":
          "on: workflow_dispatch\njobs:\n",
        ".github/workflows/run-rad-commands.yml":
          "on:\n  workflow_run:\njobs:\n"
      }
    });

    const response = await post({ repo: "octo/app" });

    expect(await response.json()).toMatchObject({ actionRequired: true });
    expect(
      harness.steps.some((step) =>
        step.includes("still auto-runs after verification")
      )
    ).toBe(true);
  });

  // The guidance and the steps around it answer the same question, so the
  // regression worth guarding is not the wording but the pair: the customer
  // must never be told verification waits for the merge in the same run that
  // dispatches it. The marker is part of that answer, because this run reports
  // `actionRequired: false` and so owes the customer no action.
  it("reports an informational next step when it dispatches from the branch", async () => {
    const harness = start({
      ...protectedScript,
      files: {
        ".github/workflows/radius-verify-credentials.yml":
          "on: workflow_dispatch\njobs:\n"
      }
    });

    const response = await post({ repo: "octo/app" });

    expect(await response.json()).toMatchObject({ actionRequired: false });
    expect(harness.steps).toContain(
      '\u2139\ufe0f Credential verification is running against branch "radius/setup-dev-workflows-op-http", ' +
        'so it is not waiting for the merge. Merging the pull request above puts the workflows on "main".'
    );
    expect(
      harness.steps.filter((step) => step.startsWith("\u{1F449}"))
    ).toEqual([]);
    expect(
      harness.steps.some((step) => step.includes("run once it lands"))
    ).toBe(false);
    // The claim is only honest once the dispatch was accepted, so it must
    // follow it rather than predict it.
    expect(
      harness.steps.indexOf("\u2705 Credentials verification dispatched.")
    ).toBeLessThan(
      harness.steps.findIndex((step) => step.includes("is running against"))
    );
  });

  it("prompts for the merge when it does not dispatch", async () => {
    const harness = start(protectedScript);

    const response = await post({ repo: "octo/app" });

    expect(await response.json()).toMatchObject({ actionRequired: true });
    expect(
      harness.steps.filter((step) => step.startsWith("\u{1F449}"))
    ).toEqual([
      "\u{1F449} Merge the pull request above to finish setup; credential verification " +
        'and deploys run once it lands on "main".'
    ]);
    expect(
      harness.steps.some((step) => step.includes("is running against"))
    ).toBe(false);
    expect(
      harness.ghCalls.some((call) => call.startsWith("workflow run "))
    ).toBe(false);
  });

  // Merging is not what unblocks this run: verification was skipped because the
  // cloud credentials are incomplete, and the operation finishes asking for
  // those. Promising that verification follows the merge would repeat the
  // contradiction one step above the skip that refutes it.
  it("names the credentials as the blocker when they are incomplete", async () => {
    const harness = start({
      ...protectedScript,
      files: {
        ".github/workflows/radius-verify-credentials.yml":
          "on: workflow_dispatch\njobs:\n"
      },
      azureCredential: () => ({ clientId: "c", tenantId: "t" })
    });

    await post({ repo: "octo/app" });

    expect(
      harness.steps.filter((step) => step.startsWith("\u{1F449}"))
    ).toEqual([
      '\u{1F449} Merging the pull request above puts the workflows on "main", but credential ' +
        "verification is waiting on the cloud credentials above, not on the merge."
    ]);
    expect(
      harness.steps.some((step) => step.includes("run once it lands"))
    ).toBe(false);
    expect(harness.finished).toMatchObject([
      {
        state: "action_required",
        options: { terminal: { reason: "credentials-incomplete" } }
      }
    ]);
  });

  // A rejected dispatch fails the request before the guidance, so no run can
  // claim verification is going when it never started.
  it("claims nothing about verification when the dispatch is rejected", async () => {
    const harness = start({
      ...protectedScript,
      gh: [
        ...(protectedScript.gh ?? []),
        {
          match: /^workflow run /,
          result: { code: 1, stderr: "HTTP 422: workflow does not exist" }
        }
      ],
      files: {
        ".github/workflows/radius-verify-credentials.yml":
          "on: workflow_dispatch\njobs:\n"
      }
    });

    const response = await post({ repo: "octo/app" });

    expect(response.status).toBe(400);
    expect(
      harness.steps.some((step) => step.includes("is running against"))
    ).toBe(false);
    expect(
      harness.steps.filter((step) => step.startsWith("\u{1F449}"))
    ).toEqual([]);
    expect(
      harness.steps.some((step) =>
        step.startsWith("\u274C Could not dispatch verify workflow")
      )
    ).toBe(true);
  });

  // A first-time setup on a protected branch: the verify workflow is not on
  // the default branch yet AND the cloud credentials are incomplete. Merging
  // is necessary but not sufficient, so promising verification runs once it
  // lands would be the same false promise in a case where two things block it.
  it("names both blockers when the merge and the credentials are outstanding", async () => {
    const harness = start({
      ...protectedScript,
      azureCredential: () => ({ clientId: "c", tenantId: "t" })
    });

    const response = await post({ repo: "octo/app" });

    expect(await response.json()).toMatchObject({ actionRequired: true });
    expect(harness.steps.filter((step) => step.startsWith("👉"))).toEqual([
      '👉 Merge the pull request above to put the workflows on "main", and finish the ' +
        "cloud credentials above. Credential verification is waiting on both, so merging " +
        "alone will not start it."
    ]);
    expect(
      harness.steps.some((step) => step.includes("run once it lands"))
    ).toBe(false);
    // The headline is what the panel and the chip show, so it must withdraw
    // the same promise the step does rather than contradicting it.
    expect(harness.finished).toMatchObject([
      {
        options: {
          terminal: {
            userMessage:
              "Merge the pull request and finish the cloud credentials to complete setup. " +
              "Credential verification is waiting on both, so merging alone will not start it."
          }
        }
      }
    ]);
    expect(
      harness.ghCalls.some((call) => call.startsWith("workflow run "))
    ).toBe(false);
  });

  // A stop leaves the operation cancelled, so the guidance is deliberately not
  // emitted: "merge to finish setup" would promise an outcome for an operation
  // the customer just abandoned, which is the same false promise this guidance
  // exists to remove. The committed pull request is still named by its own
  // step and by the recorded commit state, so nothing about what exists is
  // lost.
  it("claims nothing about the merge when the operation is stopped", async () => {
    const harness = start({
      ...protectedScript,
      files: {
        ".github/workflows/radius-verify-credentials.yml":
          "on: workflow_dispatch\njobs:\n"
      }
    });
    harness.setJournalHook((entry) => {
      if (entry === "stopBoundary:before-verification-dispatch")
        harness.operation.stopRequested = true;
    });

    const response = await post({ repo: "octo/app" });

    expect(await response.json()).toMatchObject({
      cancelled: true,
      boundary: "before-verification-dispatch"
    });
    expect(harness.steps.filter((step) => step.startsWith("👉"))).toEqual([]);
    expect(
      harness.steps.some((step) => step.includes("run once it lands"))
    ).toBe(false);
    expect(
      harness.steps.some((step) => step.includes("is running against"))
    ).toBe(false);
    // What exists is still on the record, so the stop stays honest about it.
    expect(harness.steps).toContain(
      "✅ Opened pull request #7: https://github.com/octo/app/pull/7"
    );
    expect(harness.commitStates[0]).toMatchObject({
      mode: "pull_request",
      pullRequestUrl: "https://github.com/octo/app/pull/7"
    });
  });

  it("gives no merge guidance when the pull request was never opened", async () => {
    const harness = start({
      ...protectedScript,
      pullRequest: { ok: false, stderr: "HTTP 422: already exists" }
    });

    await post({ repo: "octo/app" });

    expect(
      harness.steps.filter((step) => step.startsWith("\u{1F449}"))
    ).toEqual([]);
    expect(
      harness.steps.some((step) =>
        step.includes("Merge the pull request above")
      )
    ).toBe(false);
  });

  it("keeps the branch and asks the user to open the pull request manually when the API refuses", async () => {
    const harness = start({
      ...protectedScript,
      pullRequest: { ok: false, stderr: "HTTP 422: already exists" }
    });

    const response = await post({ repo: "octo/app" });

    expect(await response.json()).toMatchObject({
      actionRequired: true,
      pullRequestUrl: "",
      pullRequestBranch: "radius/setup-dev-workflows-op-http"
    });
    expect(harness.commitStates).toEqual([
      {
        mode: "pull_request",
        branch: "radius/setup-dev-workflows-op-http",
        baseBranch: "main",
        pullRequestUrl: null
      }
    ]);
    expect(
      harness.steps.some((step) =>
        step.includes("could not open a pull request automatically")
      )
    ).toBe(true);
  });
});

describe("create-environment real-loopback HIT: the cancellation gates", () => {
  it("answers 500 and stops touching GitHub when a checkpoint cannot be saved", async () => {
    // Admission persists once and succeeds; the next write is the first
    // checkpoint, which runs immediately after the environment is created.
    // Everything after it must not run. The wording is the shared
    // `persistMutationCheckpoint` helper's ("no further" cloud resources),
    // which is distinct from the admission-time refusal that reports no cloud
    // resources at all.
    const harness = start({ persistRejectsAfter: 3 });

    const response = await post({ repo: "octo/app" });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error:
        "Radius changed no further cloud resources because it could not save the setup recovery record.",
      code: "operation-persistence-failed"
    });
    expect(harness.journal).toContain(
      "diagnostic:operation-store-write-failed"
    );
    expect(harness.ghCalls).toEqual([
      "api /repos/octo/app/environments/dev",
      "api /repos/octo/app",
      "api --method PUT /repos/octo/app/environments/dev"
    ]);
  });

  it("persists every completed mutation group on the successful path", async () => {
    const harness = start();

    await post({ repo: "octo/app" });

    expect(
      harness.journal.filter((entry) => entry === "checkpoint")
    ).toHaveLength(10);
  });

  it("passes every safe boundary in order when no stop is recorded", async () => {
    const harness = start();

    await post({ repo: "octo/app" });

    expect(
      harness.journal.filter((entry) => entry.startsWith("stopBoundary:"))
    ).toEqual([
      "stopBoundary:before-github-environment",
      "stopBoundary:before-ghcr-bootstrap",
      "stopBoundary:before-github-environment-create",
      "stopBoundary:after-github-environment",
      "stopBoundary:before-ghcr-state-package",
      "stopBoundary:after-ghcr-state-package",
      "stopBoundary:before-radius-managed-variable",
      "stopBoundary:after-radius-managed-variable",
      "stopBoundary:before-state-package-configuration",
      "stopBoundary:after-state-package-configuration",
      "stopBoundary:before-provider-configuration",
      "stopBoundary:after-provider-configuration",
      "stopBoundary:before-workflow-commit",
      "stopBoundary:before-workflow-provider-mutation",
      "stopBoundary:after-workflow-commit",
      "stopBoundary:before-workflow-provider-mutation",
      "stopBoundary:after-workflow-commit",
      "stopBoundary:after-workflow-commit",
      "stopBoundary:before-workflow-provider-mutation",
      "stopBoundary:after-workflow-commit",
      "stopBoundary:before-verification-dispatch",
      "stopBoundary:before-verification-dispatch-attempt:1",
      "stopBoundary:after-verification-dispatch"
    ]);
  });

  it("honors a recorded stop at the first boundary and touches GitHub no further", async () => {
    const harness = start();
    // Recorded while the request was in flight, exactly as the stop route
    // records it: the executor observes it at its next safe boundary.
    harness.operation.stopRequested = true;

    const response = await post({ repo: "octo/app" });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      cancelled: true,
      code: "operation-stopped",
      boundary: "before-github-environment",
      operationId: "op-http"
    });
    expect(body.operation).toMatchObject({ terminalState: "cancelled" });
    // Nothing after the boundary ran: no GHCR bootstrap, no environment PUT,
    // no workflow commit, no verify dispatch.
    expect(harness.ghCalls).toEqual([]);
    expect(harness.journal).not.toContain("preflightGhcrPackageWriteAccess");
    expect(harness.journal).not.toContain("dispatchVerifyWorkflow");
  });

  // The remaining boundaries, each driven by recording the stop just as the run
  // reaches it. The property under test is the same every time: the write that
  // was already running completes, and nothing after the boundary starts.
  it.each([
    { boundary: "before-workflow-commit", committed: false, dispatched: false },
    {
      boundary: "before-verification-dispatch",
      committed: true,
      dispatched: false
    },
    {
      boundary: "after-verification-dispatch",
      committed: true,
      dispatched: true
    }
  ])(
    "honors a stop that arrives as the run reaches the $boundary boundary",
    async ({ boundary, committed, dispatched }) => {
      const harness = start();
      harness.setJournalHook((entry) => {
        if (entry === `stopBoundary:${boundary}`)
          harness.operation.stopRequested = true;
      });

      const response = await post({ repo: "octo/app" });
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        cancelled: true,
        code: "operation-stopped",
        boundary
      });
      expect(harness.committedFiles.length > 0).toBe(committed);
      expect(harness.journal.includes("dispatchVerifyWorkflow")).toBe(
        dispatched
      );
      // A stopped run never reports success.
      expect(body.success).toBeUndefined();
    }
  );

  // The remaining ordinary boundaries. Each one is reached on the successful
  // script, so recording the stop as the run arrives proves nothing after it
  // starts and that no automatic cleanup was attempted.
  it.each([
    "before-github-environment-create",
    "before-ghcr-state-package",
    "before-radius-managed-variable",
    "after-radius-managed-variable",
    "before-state-package-configuration",
    "before-provider-configuration",
    "after-provider-configuration"
  ])("honors a stop recorded at the %s boundary", async (boundary) => {
    const harness = start();
    harness.setJournalHook((entry) => {
      if (entry === `stopBoundary:${boundary}`)
        harness.operation.stopRequested = true;
    });

    const response = await post({ repo: "octo/app" });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      cancelled: true,
      code: "operation-stopped",
      boundary
    });
    expect(body.success).toBeUndefined();
    expect(harness.failures).toEqual([]);
    expect(harness.journal).not.toContain("dispatchVerifyWorkflow");
  });

  // The credential-profile variable is written only when a profile name is sent,
  // so its own boundaries need a request that carries one.
  it.each([
    "before-credential-profile-variable",
    "after-credential-profile-variable"
  ])("honors a stop recorded at the %s boundary", async (boundary) => {
    const harness = start();
    harness.setJournalHook((entry) => {
      if (entry === `stopBoundary:${boundary}`)
        harness.operation.stopRequested = true;
    });

    const response = await post({ repo: "octo/app", profileName: "default" });
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      cancelled: true,
      code: "operation-stopped",
      boundary
    });
    expect(harness.failures).toEqual([]);
  });

  // A stop honored inside the workflow publisher ends the publish rather than
  // reporting a refusal for work the customer already asked to stop.
  it("honors a stop recorded at the after-workflow-commit boundary", async () => {
    const harness = start();
    harness.setJournalHook((entry) => {
      if (entry === "stopBoundary:after-workflow-commit")
        harness.operation.stopRequested = true;
    });

    const response = await post({ repo: "octo/app" });
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      cancelled: true,
      code: "operation-stopped",
      boundary: "after-workflow-commit"
    });
    expect(harness.committedFiles.length).toBeGreaterThan(0);
    expect(harness.journal).not.toContain("dispatchVerifyWorkflow");
    expect(harness.failures).toEqual([]);
  });

  // The variable write that was already running finishes; the stop is honored
  // before the next one, and no automatic rollback is attempted.
  it.each([
    {
      variable: "RADIUS_MANAGED",
      boundary: "after-radius-managed-variable-attempt"
    },
    {
      variable: "RADIUS_STATE_BACKEND",
      boundary: "after-state-package-configuration-attempt"
    },
    {
      variable: "RADIUS_CREDENTIAL_PROFILE",
      boundary: "after-credential-profile-variable-attempt"
    },
    {
      variable: "AZURE_CLIENT_ID",
      boundary: "after-provider-configuration-attempt"
    }
  ])(
    "honors a stop after the failed $variable write",
    async ({ variable, boundary }) => {
      const harness = start({
        gh: [
          {
            match: new RegExp(`^variable set ${variable} `),
            result: { code: 1, stderr: "HTTP 403: Forbidden" }
          }
        ]
      });
      harness.setJournalHook((entry) => {
        if (entry === `stopBoundary:${boundary}`)
          harness.operation.stopRequested = true;
      });

      const response = await post({ repo: "octo/app", profileName: "default" });
      const body = (await response.json()) as Record<string, unknown>;

      expect(body).toMatchObject({
        cancelled: true,
        code: "operation-stopped",
        boundary
      });
      expect(harness.failures).toEqual([]);
    }
  );

  // A refusal Radius would normally report still runs the automatic cleanup, so
  // the stop is honored before that cleanup rather than after it.
  it("honors a stop recorded before the failure cleanup of a later refusal", async () => {
    const harness = start({
      runListResults: [{ code: 1, stderr: "HTTP 500" }]
    });
    harness.setJournalHook((entry) => {
      if (entry === "stopBoundary:before-setup-failure-cleanup")
        harness.operation.stopRequested = true;
    });

    const response = await post({ repo: "octo/app" });
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      cancelled: true,
      code: "operation-stopped",
      boundary: "before-setup-failure-cleanup"
    });
    expect(harness.failures).toEqual([]);
  });

  // The pull-request journal cannot say which of two matching pull requests the
  // interrupted attempt opened, so it refuses. The stop is honored before the
  // refusal's cleanup.
  it("honors a stop after an unresolvable pull-request attempt", async () => {
    const harness = start({
      headSha: "sha-base",
      createBranch: { ok: true, stderr: "" },
      gh: [
        {
          match:
            /^api --method PUT \/repos\/octo\/app\/contents\/\S+ --input @default$/,
          result: { code: 1, stderr: "protected branch" }
        },
        {
          match: /^api \/repos\/octo\/app\/pulls\?/,
          result: {
            code: 0,
            stdout: JSON.stringify([
              {
                html_url: "https://github.com/octo/app/pull/7",
                number: 7,
                head: { ref: "radius/setup-dev-workflows-op-http" },
                base: { ref: "main" }
              },
              {
                html_url: "https://github.com/octo/app/pull/8",
                number: 8,
                head: { ref: "radius/setup-dev-workflows-op-http" },
                base: { ref: "main" }
              }
            ])
          }
        }
      ],
      pullRequest: { ok: false, stderr: "ECONNRESET" }
    });
    harness.setJournalHook((entry) => {
      if (entry === "stopBoundary:after-workflow-pull-request-attempt")
        harness.operation.stopRequested = true;
    });

    const response = await post({ repo: "octo/app" });
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      cancelled: true,
      code: "operation-stopped",
      boundary: "after-workflow-pull-request-attempt"
    });
    expect(harness.failures).toEqual([]);
  });

  // A refused preflight would normally roll back. The stop is honored first, so
  // nothing is deleted on a run the customer already asked to end.
  it.each([
    {
      name: "repository admin",
      script: { repoAdminRefusal: "Admin access is required." } as Script
    },
    {
      name: "GHCR package write",
      script: {
        ghcrPreflight: {
          ok: false,
          status: 403,
          error: "GHCR package write access is missing.",
          code: "ghcr-package-write-required"
        }
      } as Script
    }
  ])(
    "lets a stop win over the automatic cleanup for a refused $name preflight",
    async ({ script }) => {
      const harness = start(script);
      harness.setJournalHook((entry) => {
        if (entry === "stopBoundary:before-setup-failure-cleanup")
          harness.operation.stopRequested = true;
      });

      const response = await post({ repo: "octo/app" });
      const body = (await response.json()) as Record<string, unknown>;

      expect(body).toMatchObject({
        cancelled: true,
        code: "operation-stopped",
        boundary: "before-setup-failure-cleanup"
      });
      expect(harness.failures).toEqual([]);
    }
  );

  // The PUT was answered with a rejection GitHub composed, so its provenance is
  // settled. The stop is honored before the automatic cleanup that would follow.
  it("honors a stop recorded while a refused environment create was in flight", async () => {
    const harness = start({
      gh: [
        {
          match: /^api --method PUT \/repos\/octo\/app\/environments\/dev$/,
          result: { code: 1, stderr: "HTTP 422: Validation Failed" }
        }
      ]
    });
    harness.setJournalHook((entry) => {
      if (entry === "stopBoundary:after-github-environment-attempt")
        harness.operation.stopRequested = true;
    });

    const response = await post({ repo: "octo/app" });
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      cancelled: true,
      code: "operation-stopped",
      boundary: "after-github-environment-attempt"
    });
    expect(harness.failures).toEqual([]);
  });

  it("stops after the environment exists rather than abandoning it mid-write", async () => {
    const harness = start();
    // The stop lands while the GitHub environment is being created, so the
    // first boundary after that write is where it must be honored.
    harness.setJournalHook((entry) => {
      if (entry === "recordGitHubEnvironment:created_candidate") {
        harness.operation.stopRequested = true;
      }
    });

    const response = await post({ repo: "octo/app" });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      code: "operation-stopped",
      boundary: "after-github-environment"
    });
    // The environment write finished and was recorded before the stop.
    expect(harness.ghCalls).toContain(
      "api --method PUT /repos/octo/app/environments/dev"
    );
    expect(harness.journal).not.toContain("dispatchVerifyWorkflow");
    expect(harness.committedFiles).toEqual([]);
    expect(harness.operation.setupArtifacts.githubEnvironment).toMatchObject({
      state: "created",
      origin: "this_operation"
    });
  });

  it("lets GHCR bootstrap finish and stops before GitHub environment configuration", async () => {
    const harness = start();
    harness.setJournalHook((entry) => {
      if (entry === "stopBoundary:after-ghcr-state-package") {
        harness.operation.stopRequested = true;
      }
    });

    const response = await post({ repo: "octo/app" });
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      code: "operation-stopped",
      boundary: "after-ghcr-state-package"
    });
    expect(harness.journal).toContain("bootstrapGHCRStatePackage");
    expect(
      harness.ghCalls.some((call) => call.startsWith("variable set "))
    ).toBe(false);
  });

  it("honors Stop after a failed GHCR attempt before automatic rollback", async () => {
    const harness = start({ statePackageError: "registry unavailable" });
    harness.setJournalHook((entry) => {
      if (entry === "stopBoundary:after-ghcr-state-package-attempt") {
        harness.operation.stopRequested = true;
      }
    });

    const response = await post({ repo: "octo/app" });
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      code: "operation-stopped",
      boundary: "after-ghcr-state-package-attempt"
    });
    expect(harness.failures).toEqual([]);
  });

  it("finishes the coherent state-package variables before stopping provider configuration", async () => {
    const harness = start();
    harness.setJournalHook((entry) => {
      if (entry === "stopBoundary:after-state-package-configuration") {
        harness.operation.stopRequested = true;
      }
    });

    const response = await post({ repo: "octo/app" });
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      code: "operation-stopped",
      boundary: "after-state-package-configuration"
    });
    expect(
      harness.ghCalls.some((call) =>
        call.startsWith("variable set RADIUS_STATE_ARCHIVE ")
      )
    ).toBe(true);
    expect(
      harness.ghCalls.some((call) =>
        call.startsWith("variable set AZURE_CLIENT_ID ")
      )
    ).toBe(false);
  });

  it("stops before opening a workflow pull request after preserving committed files", async () => {
    const harness = start({
      gh: [
        {
          match:
            /^api --method PUT \/repos\/octo\/app\/contents\/\S+ --input @default$/,
          result: { code: 1, stderr: "protected branch" }
        }
      ],
      headSha: "sha-base",
      createBranch: { ok: true, stderr: "" },
      pullRequest: {
        ok: true,
        url: "https://github.com/octo/app/pull/7",
        number: 7
      }
    });
    harness.setJournalHook((entry) => {
      if (entry === "stopBoundary:before-workflow-pull-request") {
        harness.operation.stopRequested = true;
      }
    });

    const response = await post({ repo: "octo/app" });
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      code: "operation-stopped",
      boundary: "before-workflow-pull-request"
    });
    expect(harness.committedFiles.length).toBeGreaterThan(0);
    expect(harness.journal).not.toContain("createPullRequestApi");
  });

  it("honors Stop immediately after a failed verification dispatch attempt", async () => {
    const harness = start({
      gh: [
        {
          match: /^workflow run /,
          // A rejection GitHub composed, so the dispatch journal settles the
          // attempt before the boundary rather than reconciling it.
          result: { code: 1, stderr: "HTTP 422: Validation Failed" }
        }
      ]
    });
    harness.setJournalHook((entry) => {
      if (entry === "stopBoundary:after-verification-dispatch-attempt") {
        harness.operation.stopRequested = true;
      }
    });

    const response = await post({ repo: "octo/app" });
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      code: "operation-stopped",
      boundary: "after-verification-dispatch-attempt"
    });
    expect(harness.failures).toEqual([]);
    expect(
      harness.ghCalls.filter((call) => call.startsWith("workflow run "))
    ).toHaveLength(1);
  });
});
