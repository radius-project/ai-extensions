import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEnvironmentExecutionOwner } from "../../runtime/environment-execution-owner.js";
import {
  runEnvironmentOperationWorkflow,
  type EnvironmentOperationWorkflowDependencies
} from "./environment-operation.js";
import type { SetupOutcome } from "./setup-outcome.js";
import { configureCredentialProvenanceStore } from "../../credential-provenance.js";
import { createAzureSetupService } from "./azure-setup.js";
import type { AzureAutoSetupOperation } from "../routes/azure-auto-setup-types.js";
import {
  createParityAzureFixture,
  parityAzureRequest,
  parityClientId,
  runDirectParityConfiguration,
  unexpectedParityCall
} from "../../../test/support/server/setup-parity.js";
import {
  createConfigureEnvironmentService,
  type ConfigureEnvironmentDependencies
} from "./configure-environment.js";
import type { SetupInput } from "./setup-outcome.js";
import type { CreateEnvironmentRequestData } from "../routes/create-environment-refusals.js";
import { isValidRepoSlug } from "../../azure-oidc.js";
import { createSelectedNamespaceClaimsPorts } from "../routes/create-environment-namespace-claims.js";
import {
  buildVerifyWorkflowDispatchArgs,
  planCredentialVerification
} from "../../verification-plan.js";
import {
  finalizeSetupFailure,
  guardStopBoundary,
  persistBestEffort,
  persistMutationCheckpoint
} from "../../server.js";
import {
  createSetupArtifactLedger,
  addLegacyStep,
  enterStage,
  prepareProviderMutation,
  providerMutationsByKind,
  promoteCreatedGitHubEnvironment,
  recordCommittedWorkflowFile,
  recordGitHubEnvironment,
  recordGitHubEnvironmentVariable,
  setCanonicalEnvironment,
  setStageState,
  settleProviderMutation
} from "../../operations.js";
import type { SetupArtifactLedger } from "../../operations.js";
import { successfulSelectedGhExecutor } from "../../../test/support/server/selected-gh.js";
import type { CanvasState } from "../../shared.js";
import type { GhCommandPresentation } from "../../gh-command-display.js";
import type { CreateEnvironmentInstanceEntry } from "./configure-environment.js";
import type {
  CreateEnvironmentCommandResult,
  CreateEnvironmentOperation,
  GhcrPreflightResult
} from "../routes/create-environment-types.js";
import type { WorkflowFileReadResult } from "../../verification-plan.js";

let activeHarness: Harness | undefined;

afterEach(async () => {
  activeHarness = undefined;
  await configureCredentialProvenanceStore(null);
  vi.useRealTimers();
});

const STAGE_IDENTITY = "authorize-identity";
const STAGE_CONFIGURE = "configure-environment";
const STAGE_VERIFY = "verify";

interface GhRule {
  match: RegExp;
  result: Partial<CreateEnvironmentCommandResult>;
}

interface Script {
  pairedProvider?: "azure" | "aws";
  direct?: boolean;
  trace?(entry: unknown): void;
  ghCommandPresentation?: GhCommandPresentation;
  onGhCommand?(command: string): void;
  gh?: GhRule[];
  runListResults?: Array<Partial<CreateEnvironmentCommandResult>>;
  dispatchResults?: Array<Partial<CreateEnvironmentCommandResult>>;
  repoAdminRefusal?: string;
  ghcrPreflight?: GhcrPreflightResult;
  defaultBranch?: string | null;
  headSha?: string | null;
  createBranch?: { ok: boolean; stderr: string };
  files?: Record<string, string>;
  fileReadResults?: Record<string, WorkflowFileReadResult>;
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
  // The repository's existing namespace claims as the admission rung reads
  // them, and the failure that must make it fail closed.
  namespaceClaimants?: Record<string, Record<string, string>>;
  namespaceClaimsFailure?: string;
  noPinnedNamespaceAccount?: boolean;
  legacyDeleteResult?: boolean | "cancelled";
}

interface Harness {
  dependencies: ConfigureEnvironmentDependencies;
  azure: ReturnType<typeof createParityAzureFixture> | undefined;
  persisted: unknown[];
  /** Claim reads that travelled the account pinned to the operation. */
  selectedClaimCalls: string[];
  /** Every ambient `cliExec` invocation, so a regression to it is observable. */
  ambientCliCalls: string[];
  journal: string[];
  setJournalHook(hook: ((entry: string) => void) | null): void;
  ghCalls: string[];
  steps: string[];
  operation: CreateEnvironmentOperation &
    AzureAutoSetupOperation & {
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
  cleanupReads: Array<{
    code: number | string;
    stdout: string;
    stderr: string;
  }>;
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
const gitBlobShaOf = (content: string): string => {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
};
const DEPLOY_WORKFLOW_BODY = "on: workflow_dispatch\njobs:\n";
const WORKFLOW_CONTENT_DIGEST = digestOf(DEPLOY_WORKFLOW_BODY);
const VERIFY_CONTENT_DIGEST = digestOf(MARKED_VERIFY_WORKFLOW);
const VERIFY_OPERATION_MARKER = `radius-operation:op-http:workflow:.github/workflows/radius-verify-credentials.yml:${VERIFY_CONTENT_DIGEST.slice(0, 16)}`;

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
      match: /^api \/repos\/octo\/app\/commits\?.*per_page=100&page=1$/,
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
  const persisted: unknown[] = [];
  const journal: string[] = [];
  // Lets a test act at an exact point in the run — recording a stop while the
  // request is mid-flight, which is the only way that race happens for real.
  let journalHook: ((entry: string) => void) | null = null;
  const appendJournal = journal.push.bind(journal);
  // Defined non-enumerably so the journal still compares as a plain array.
  Object.defineProperty(journal, "push", {
    value: (...entries: string[]) => {
      const length = appendJournal(...entries);
      for (const entry of entries) script.trace?.(["journal", entry]);
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
  const cleanupReads: Array<{
    code: number | string;
    stdout: string;
    stderr: string;
  }> = [];
  let persistCalls = 0;

  // `stages` and `steps` are present because the real stop guard closes the
  // record through the production `finish`, which walks both.
  const operation: Harness["operation"] = {
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
  if (script.pairedProvider) {
    operation.provider = script.pairedProvider;
    operation.currentStage = STAGE_IDENTITY;
    operation.state = "running";
    operation.stages = [
      { id: STAGE_IDENTITY, label: "Identity", state: "running" },
      { id: STAGE_CONFIGURE, label: "Configure", state: "pending" },
      { id: STAGE_VERIFY, label: "Verify", state: "pending" }
    ];
    operation.request = {
      needsAzureCredentials: script.pairedProvider === "azure",
      azure: { ...parityAzureRequest },
      environment:
        script.pairedProvider === "azure" ?
          {
            ...parityAzureRequest,
            // These deliberately disagree with the eventual live identity.
            clientId: "stale-request-client",
            namespace: "application"
          }
        : {
            roleArn: "arn:aws:iam::123456789012:role/radius-deploy",
            region: "us-west-2",
            accountId: "123456789012",
            cluster: "cluster",
            namespace: "application"
          }
    };
  }
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
  // The claim reads the namespace rung performs, answered as `gh` would. They
  // are served through the same rule table as every other gh call so the read
  // travels a real channel rather than a bespoke port fake.
  const claimsGhRules = (): GhRule[] => {
    if (script.namespaceClaimsFailure) {
      return [
        {
          match: /^api --paginate \/repos\/[^ ]*\/environments/,
          result: { code: 1, stderr: script.namespaceClaimsFailure }
        }
      ];
    }
    // A repository with no scripted claimants still has to answer the read: an
    // unanswered call is a failure, and the rung fails closed on failures.
    const claimants = script.namespaceClaimants ?? {};
    const rules: GhRule[] = [
      {
        match:
          /^api --paginate \/repos\/[^ ]*\/environments\?per_page=100 --jq/,
        result: { code: 0, stdout: Object.keys(claimants).join("\n") }
      }
    ];
    for (const [name, variables] of Object.entries(claimants)) {
      rules.push({
        // Production URL-encodes the environment name, so the rule has to match
        // the encoded path. Matching the raw name would leave a call with an
        // encodable character unscripted, making the harness less faithful than
        // the code it is exercising.
        match: new RegExp(
          `^api --paginate /repos/[^ ]*/environments/${escapeRegExp(
            encodeURIComponent(name)
          )}/variables`
        ),
        result: {
          code: 0,
          stdout: Object.entries(variables)
            .map(([key, value]) => `${key}\t${value}`)
            .join("\n")
        }
      });
    }
    return rules;
  };

  const selectedClaimCalls: string[] = [];
  const ambientCliCalls: string[] = [];
  const runGhArgs = (args: string[]): CreateEnvironmentCommandResult => {
    const key = args
      .map((arg) => (arg === TEMP_BODY_PATH ? `@${lastBodyBranch}` : arg))
      .join(" ");
    ghCalls.push(key);
    script.trace?.(["gh", key]);
    script.onGhCommand?.(key);
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
                event:
                  (
                    operation.verification &&
                    typeof operation.verification === "object" &&
                    "event" in operation.verification
                  ) ?
                    operation.verification.event
                  : "workflow_dispatch",
                headBranch:
                  (
                    operation.verification &&
                    typeof operation.verification === "object" &&
                    "ref" in operation.verification
                  ) ?
                    operation.verification.ref
                  : "main",
                status: "queued",
                url: "ignored"
              }
            ])
          ),
        stderr: ""
      };
    }
    for (const rule of [...claimsGhRules(), ...(script.gh ?? [])]) {
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

  const dependencies: ConfigureEnvironmentDependencies = {
    ghCommandPresentation: script.ghCommandPresentation,
    // --- request scope: read per request, exactly as server.ts does ---
    readInstanceEntry: () => (script.direct ? undefined : entry),
    getSelectedGitHubExecutor: () => ({
      ...successfulSelectedGhExecutor({ run: async (args) => runGhArgs(args) }),
      verifyIdentity: async () => {
        if (script.pairedProvider)
          script.trace?.(["verify-selected-identity", "octocat"]);
      }
    }),

    // --- admission ---
    // Wired the way `server.ts` wires it: the real ports over the GitHub account
    // pinned to this operation, so the read under test is the production read
    // rather than a restatement of it. Null when no account is pinned, which is
    // what the rung must fail closed on.
    namespaceClaimsFor: () =>
      script.noPinnedNamespaceAccount ? null : (
        createSelectedNamespaceClaimsPorts({
          run: async (args: string[]) => {
            selectedClaimCalls.push(args.join(" "));
            return runGhArgs(args);
          }
        })
      ),
    isValidRepoSlug,
    getOperation: (operationId) =>
      (
        (script.preparedEnvironment || script.pairedProvider) &&
        operationId === operation.operationId
      ) ?
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
      if (script.pairedProvider)
        persisted.push(JSON.parse(JSON.stringify(operation)));
      script.trace?.(["durable"]);
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
      if (script.pairedProvider) enterStage(operation, stage);
    },
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    stageAuthorizeIdentity: STAGE_IDENTITY,
    stageConfigureEnvironment: STAGE_CONFIGURE,

    // --- gh runner ---
    cliExec: (_command, args, _options, callback) => {
      ambientCliCalls.push(args.join(" "));
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
      if (script.pairedProvider) addLegacyStep(operation, text);
      script.trace?.(["step", text]);
    },
    finalizeSetupFailure: async (_operation, input) => {
      failures.push({ ...input });
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
    isShuttingDown: () => false,
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
    bootstrapGHCRStatePackage: async (input) => {
      journal.push("bootstrapGHCRStatePackage");
      if (script.pairedProvider) script.trace?.(["package-bootstrap", input]);
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
    getDefaultBranch: async (repo) => {
      const branch = "defaultBranch" in script ? script.defaultBranch : "main";
      if (script.pairedProvider)
        script.trace?.(["default-branch", repo, branch]);
      return branch;
    },
    getBranchHeadSha: async (repo, branch) => {
      script.trace?.(["branch-head"]);
      if (script.pairedProvider)
        script.trace?.(["branch-head-read", repo, branch, script.headSha]);
      if (!("headSha" in script))
        throw new Error("unscripted getBranchHeadSha");
      return script.headSha;
    },
    createBranchRef: async (repo, branch, sha) => {
      script.trace?.(["branch-create"]);
      if (script.pairedProvider)
        script.trace?.(["branch-create-request", repo, branch, sha]);
      if (!script.createBranch) throw new Error("unscripted createBranchRef");
      return script.createBranch;
    },
    tempFile: {
      write: (contents) => {
        script.trace?.(["contents-body", JSON.parse(contents)]);
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
      remove: () => {
        script.trace?.(["contents-cleanup"]);
      }
    },

    // --- GitHub environment ---
    setCanonicalEnvironment: (target, environment) => {
      setCanonicalEnvironment(target, environment);
      if (script.pairedProvider)
        script.trace?.(["canonical-environment", environment]);
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
    azureCredential: () => {
      const credential =
        script.azureCredential ? script.azureCredential()
        : script.pairedProvider ?
          {
            ...operation.context,
            tenantId: parityAzureRequest.tenantId,
            subscriptionId: parityAzureRequest.subscriptionId
          }
        : { clientId: "c", tenantId: "t", subscriptionId: "s" };
      if (script.pairedProvider)
        script.trace?.(["azure-credential-read", credential]);
      return credential;
    },
    awsCredential: () => {
      if (script.pairedProvider) script.trace?.(["aws-credential-read", {}]);
      return {};
    },
    optionalString: (value) => (typeof value === "string" ? value : ""),

    // --- workflow generation and commit ---
    generateVerifyWorkflow: async (
      environment,
      _provider,
      setupPushOperationMarker
    ) => {
      journal.push(`generateVerifyWorkflow:${environment}`);
      if (setupPushOperationMarker) {
        journal.push(`setupPushOperationMarker:${setupPushOperationMarker}`);
      }
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
      if (script.pairedProvider)
        script.trace?.(["committed-workflow", committed]);
    },
    deleteLegacyDeployWorkflow: async (
      _repo,
      _executor,
      beforeDelete,
      branch
    ) => {
      journal.push("deleteLegacyDeployWorkflow");
      journal.push(`legacyDeployDeleteBranch:${branch || "default"}`);
      if (script.legacyDeleteResult === "cancelled") {
        operation.stopRequested = true;
        if (beforeDelete && !(await beforeDelete())) return "cancelled";
      }
      return script.legacyDeleteResult ?? true;
    },
    createPullRequestApi: async (...args) => {
      if (!script.pullRequest)
        throw new Error("unscripted createPullRequestApi");
      journal.push("createPullRequestApi");
      script.trace?.(["pull-request", args.slice(0, 5)]);
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
    fetchFileFromRepo: async (repo, path, branch) => {
      const content =
        script.files?.[path] ??
        ((
          committedFiles.some(
            (file) =>
              `.github/workflows/${path.split("/").pop()}` === file.path &&
              (!branch || file.branch === branch)
          )
        ) ?
          MARKED_VERIFY_WORKFLOW
        : null);
      if (script.pairedProvider)
        script.trace?.(["workflow-file-read", repo, path, branch, content]);
      return content;
    },
    fetchFileFromRepoResult: async (_repo, path) => {
      journal.push(`fetchFileFromRepoResult:${path}`);
      return (
        script.fileReadResults?.[path] ??
        (script.files && path in script.files ?
          { content: script.files[path], error: null, status: 200 }
        : { content: null, error: "HTTP 404: Not Found", status: 404 })
      );
    },
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
      if (script.pairedProvider) setStageState(operation, stage, stageState);
    },
    finish: (_operation, finishState, options) => {
      journal.push(`finish:${finishState}`);
      finished.push({ state: finishState, options });
    },

    // --- clocks: injected so the dispatch backoff costs no wall time ---
    sleep: async () => undefined,
    now: () => 1700000000000
  };

  const azure =
    script.pairedProvider === "azure" ?
      createParityAzureFixture(operation, dependencies, (effect) =>
        script.trace?.(effect)
      )
    : undefined;

  const harness: Harness = {
    dependencies,
    azure,
    persisted,
    selectedClaimCalls,
    ambientCliCalls,
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
  activeHarness = harness;
  return harness;
}

async function configure(body: unknown): Promise<SetupOutcome> {
  if (!activeHarness) throw new Error("Configuration fixture was not started.");
  let input: SetupInput<CreateEnvironmentRequestData>;
  try {
    input = {
      data: JSON.parse(typeof body === "string" ? body : JSON.stringify(body))
    };
  } catch (error) {
    input = { error };
  }
  return createConfigureEnvironmentService(activeHarness.dependencies)(
    input,
    "panel-a"
  );
}

/** Escapes a value used inside a `RegExp`, so a name is matched literally. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every gh call except the namespace rung's read-only claim lookup. The rung
 * reads GitHub before admitting, so an assertion that setup touched nothing has
 * to exclude that read while still showing every other call, mutating or not.
 */
function ghCallsExcludingNamespaceClaimLookup(
  calls: readonly string[]
): string[] {
  return calls.filter(
    (call) => !/^api --paginate \/repos\/[^ ]*\/environments/.test(call)
  );
}

describe("matched headless and panel-bound setup service parity", () => {
  const snapshot = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value));
  const asRecord = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Expected an object response.");
    return Object.fromEntries(Object.entries(value));
  };

  async function runFixture(
    provider: "azure" | "aws",
    mode: "direct" | "protected",
    binding: "headless" | "panel"
  ) {
    const trace: unknown[] = [];
    const results: unknown[] = [];
    const harness = start({
      pairedProvider: provider,
      direct: binding === "headless",
      ...(mode === "protected" ?
        {
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
        }
      : {}),
      trace(effect) {
        trace.push(snapshot(effect));
        if (Array.isArray(effect) && effect[0] === "durable")
          trace.push(["operation-at-save", snapshot(harness.operation)]);
      }
    });
    const { operation, dependencies: d, azure } = harness;
    await azure?.bindProvenance();
    const executor = d.getSelectedGitHubExecutor(operation.operationId);
    if (!executor) throw new Error("Missing selected fixture executor.");
    const stopBoundary = (boundary: string) =>
      d.guardStopBoundary({
        operation,
        boundary,
        persist: d.persistOperations,
        report: d.reportOperationDiagnostic,
        respond: unexpectedParityCall
      });
    const dependencies: EnvironmentOperationWorkflowDependencies = {
      preflightRepoAdmin: d.preflightRepoAdmin,
      preflightGhcrPackageWriteAccess: d.preflightGhcrPackageWriteAccess,
      readGitHubJson: d.readGitHubJson,
      guardStopBoundary: (_op, boundary) => stopBoundary(boundary),
      setCanonicalEnvironment: (_op, name) =>
        d.setCanonicalEnvironment(operation, name),
      recordGitHubEnvironment: (_op, patch) =>
        d.recordGitHubEnvironment(operation, patch),
      promoteCreatedGitHubEnvironment: (_op, identity) =>
        d.promoteCreatedGitHubEnvironment(operation, identity),
      addLegacyStep: (_op, text) => d.addLegacyStep(operation, text),
      persistEnvironmentResolution: () =>
        d.persistMutationCheckpoint({
          operation,
          persist: d.persistOperations,
          report: d.reportOperationDiagnostic,
          fail: unexpectedParityCall
        }),
      persistProviderMutation: d.persistOperations,
      finalizeEnvironmentResolutionFailure: unexpectedParityCall,
      getOperation: (id) =>
        id === operation.operationId ? operation : undefined,
      now: d.now,
      instanceId: "panel-a",
      setupServices: {
        authorizeAzure: (request) => invoke("azure", request),
        configureEnvironment: (request) => invoke("environment", request)
      }
    };
    async function invoke(
      stage: "azure" | "environment",
      request: Record<string, unknown>
    ): Promise<SetupOutcome> {
      trace.push(["stage-request", stage, snapshot(request)]);
      let outcome: SetupOutcome;
      if (binding === "headless") {
        if (stage === "azure") {
          if (!azure) throw new Error("AWS must not authorize Azure.");
          outcome = await azure.runDirect(request);
        } else {
          outcome = await runDirectParityConfiguration(request, d);
        }
      } else {
        if (stage === "azure") {
          if (!azure) throw new Error("AWS must not authorize Azure.");
          outcome = await createAzureSetupService(azure.dependencies)({
            data: request
          });
        } else {
          outcome = await createConfigureEnvironmentService(d)(
            { data: request },
            "panel-a"
          );
        }
      }
      expect(outcome.status, JSON.stringify(outcome.body)).toBe(200);
      const body = outcome.body;
      expect(body.success).toBe(true);
      const { success: _success, steps, ...domain } = body;
      if (stage === "azure") {
        results.push([
          stage,
          {
            ...domain,
            applicationState: operation.setupArtifacts.azureApp.state
          },
          steps
        ]);
      } else {
        // Only the absence of a skip reason has different representations.
        expect(domain.verifySkipReason).toBe("");
        results.push([stage, { ...domain, verifySkipReason: null }, steps]);
      }
      return outcome;
    }
    const coordinator = await runEnvironmentOperationWorkflow(
      operation,
      executor,
      dependencies
    );
    expect(coordinator).toEqual({ shouldMonitor: true });
    expect(harness.failures).toEqual([]);
    expect(harness.ambientCliCalls).toEqual([]);
    const mutations = operation.providerRecovery?.mutations ?? [];
    expect(mutations.length).toBeGreaterThan(0);
    expect(
      mutations.filter((mutation) => mutation.status !== "confirmed")
    ).toEqual(
      mode === "direct" ?
        []
      : [
          expect.objectContaining({
            kind: "github_workflow.put",
            target:
              "octo/app:<default>:.github/workflows/radius-verify-credentials.yml",
            status: "not_applied"
          })
        ]
    );
    expect(
      providerMutationsByKind(operation, "github_workflow.put")
    ).toHaveLength(mode === "direct" ? 3 : 4);
    expect(harness.committedFiles).toHaveLength(3);
    if (provider === "azure") {
      for (const kind of [
        "azure_application.create",
        "azure_service_principal.create",
        "azure_federated_credential.create",
        "azure_role_assignment.create"
      ])
        expect(providerMutationsByKind(operation, kind), kind).not.toHaveLength(
          0
        );
      expect(operation.context?.clientId).toBe(parityClientId);
      expect(
        harness.ghCalls.some(
          (call) =>
            call.includes(`AZURE_CLIENT_ID`) && call.includes(parityClientId)
        )
      ).toBe(true);
      expect(azure?.provenance.size).toBe(1);
    } else {
      expect(
        providerMutationsByKind(operation, "github_branch.create")
      ).toHaveLength(1);
      expect(
        providerMutationsByKind(operation, "github_pull_request.create")
      ).toHaveLength(1);
      // The existing AWS path intentionally does not journal variable writes.
      expect(
        providerMutationsByKind(operation, "github_environment_variable.put")
      ).toHaveLength(0);
      expect(
        harness.ghCalls.some(
          (call) =>
            call.includes("AWS_ROLE_ARN") &&
            call.includes("arn:aws:iam::123456789012:role/radius-deploy")
        )
      ).toBe(true);
    }
    return {
      results: snapshot({ coordinator, stages: results }),
      trace,
      durable: snapshot({
        saves: harness.persisted,
        operation,
        provenance: [...(azure?.provenance ?? [])],
        committedFiles: harness.committedFiles,
        commitStates: harness.commitStates,
        finished: harness.finished
      })
    };
  }

  it.each([
    { provider: "azure", mode: "direct" },
    { provider: "aws", mode: "protected" }
  ] as const)(
    "matches $provider identity/configuration and $mode publication with and without panel projection",
    async ({ provider, mode }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(1700000000000);
      const direct = await runFixture(provider, mode, "headless");

      const canvas = await runFixture(provider, mode, "panel");
      expect(canvas.results).toEqual(direct.results);
      expect(canvas.trace).toEqual(direct.trace);
      expect(canvas.durable).toEqual(direct.durable);
    }
  );

  it.each([
    "warning",
    "input-resume",
    "unknown-resume",
    "manual-required",
    "stop",
    "checkpoint",
    "selected-refusal"
  ] as const)(
    "matches Azure %s outcomes, exact effects and durable records through direct and panel-bound services",
    async (scenario) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(1700000000000);
      const run = async (direct: boolean) => {
        const trace: unknown[] = [];
        const harness = start({
          pairedProvider: "azure",
          direct,
          trace: (effect) => trace.push(snapshot(effect))
        });
        const { azure, operation } = harness;
        if (!azure) throw new Error("Missing Azure fixture.");
        await azure.bindProvenance();
        const original = azure.dependencies.external.runAz;
        if (scenario === "checkpoint") {
          const checkpoint = azure.dependencies.persistMutationCheckpoint;
          azure.dependencies.persistMutationCheckpoint = (input) =>
            checkpoint({
              ...input,
              persist: async () => {
                throw new Error("Checkpoint store unavailable");
              }
            });
        }
        let attempted = false;
        azure.dependencies.external.runAz = async (args) => {
          const result = await original(args);
          const verb = args.slice(0, 3).join(" ");
          if (verb === "ad app create") {
            attempted = true;
            if (
              scenario === "input-resume" &&
              !args.includes("--service-management-reference")
            )
              return {
                code: 1,
                stdout: "",
                stderr:
                  "ServiceManagementReference is required by directory policy"
              };
            if (scenario === "unknown-resume" || scenario === "manual-required")
              return {
                code: 1,
                stdout: "",
                stderr: "ETIMEDOUT",
                timedOut: true
              };
          }
          if (
            verb === "ad app list" &&
            args.includes(
              "[].{appId:appId,displayName:displayName,tags:tags}"
            ) &&
            attempted &&
            (scenario === "unknown-resume" || scenario === "manual-required")
          ) {
            return scenario === "unknown-resume" ?
                { code: 1, stdout: "", stderr: "Recovery read unavailable" }
              : {
                  code: 0,
                  stdout:
                    '[{"appId":"unowned-app","displayName":"radius-deploy-octo-app","tags":[]}]',
                  stderr: ""
                };
          }
          if (
            scenario === "warning" &&
            verb === "role assignment create" &&
            args.includes("Locks Contributor")
          )
            return {
              code: 1,
              stdout: "",
              stderr: "AuthorizationFailed: role assignment denied"
            };
          if (
            scenario === "stop" &&
            verb === "ad app federated-credential" &&
            args[3] === "create"
          )
            operation.stopRequested = true;
          return result;
        };
        if (scenario === "selected-refusal") {
          const error = new Error("The selected account changed.");
          const selected =
            azure.dependencies.external.getSelectedGitHubExecutor(
              operation.operationId
            );
          if (!selected) throw new Error("Missing selected executor");
          azure.dependencies.external.getSelectedGitHubExecutor = () => ({
            ...selected,
            verifyIdentity: async () => {
              throw error;
            }
          });
        }
        const invokeAzure = async (extra: Record<string, unknown> = {}) => {
          const request = {
            ...parityAzureRequest,
            repo: operation.repo,
            environment: operation.environment,
            operationId: operation.operationId,
            ...extra
          };
          if (direct) {
            const outcome = await azure.runDirect(request);
            return { status: outcome.status, body: outcome.body };
          }
          const response = await createAzureSetupService(azure.dependencies)({
            data: request
          });
          return {
            status: response.status,
            body: asRecord(response.body)
          };
        };
        const first = await invokeAzure();
        const results = [first];
        if (scenario === "input-resume") {
          expect(first).toMatchObject({
            status: 400,
            body: {
              inputRequired: true,
              code: "service-management-reference-required"
            }
          });
          expect(operation.azureAppCreateContinuation).toBeDefined();
          expect(JSON.stringify(first.body)).not.toContain(
            "appCreateContinuation"
          );
          expect(harness.persisted.length).toBeGreaterThan(0);
          // Resume from JSON-equivalent saved state, not a fixture-only live object.
          Object.assign(operation, snapshot(operation));
          results.push(
            await invokeAzure({
              serviceManagementReference: "99999999-9999-9999-9999-999999999999"
            })
          );
          expect(results[1]).toMatchObject({
            status: 200,
            body: { success: true, clientId: parityClientId }
          });
          expect(operation.azureAppCreateContinuation).toBeUndefined();
          expect(
            harness.journal.filter((event) => event === "preflightRepoAdmin")
          ).toHaveLength(1);
        } else if (scenario === "unknown-resume") {
          expect(first).toMatchObject({
            status: 202,
            body: {
              reconciling: true,
              code: "provider-mutation-outcome-unknown"
            }
          });
          Object.assign(operation, snapshot(operation));
          results.push(await invokeAzure());
          expect(results[1]).toMatchObject({
            status: 202,
            body: { reconciling: true }
          });
          expect(
            trace.filter(
              (effect) =>
                Array.isArray(effect) &&
                effect[0] === "az" &&
                effect[1].slice(0, 3).join(" ") === "ad app create"
            )
          ).toHaveLength(1);
          expect(
            providerMutationsByKind(operation, "azure_application.create")[0]
              ?.reconcileAttempts
          ).toBe(2);
          expect(harness.failures).toEqual([]);
        } else if (scenario === "warning") {
          expect(first).toMatchObject({ status: 200, body: { success: true } });
          expect(operation.stages).toContainEqual(
            expect.objectContaining({ id: STAGE_IDENTITY, state: "warning" })
          );
          expect(
            harness.steps.some(
              (step) => step.includes("Locks Contributor") && step.includes("⚠")
            )
          ).toBe(true);
        } else if (scenario === "stop") {
          expect(first).toMatchObject({
            status: 200,
            body: { cancelled: true, code: "operation-stopped" }
          });
          expect(harness.failures).toEqual([]);
          expect(
            trace.filter(
              (effect) =>
                Array.isArray(effect) && effect[0] === "credential-file-remove"
            )
          ).toHaveLength(1);
          expect(
            trace.some(
              (effect) =>
                Array.isArray(effect) &&
                effect[0] === "az" &&
                effect[1].slice(0, 3).join(" ") === "role assignment create"
            )
          ).toBe(false);
        } else if (scenario === "checkpoint") {
          expect(first).toMatchObject({
            status: 500,
            body: { code: "operation-persistence-failed" }
          });
          expect(harness.failures).toHaveLength(1);
        } else {
          expect(first.status).toBe(400);
          expect(harness.failures).toHaveLength(1);
          expect(first.body.error).toContain(
            scenario === "selected-refusal" ?
              "selected account changed"
            : "will not adopt"
          );
        }
        return snapshot({
          results,
          trace,
          operation,
          persisted: harness.persisted,
          provenance: [...azure.provenance],
          failures: harness.failures
        });
      };
      // Stack locations differ at the call boundary. Keep diagnostic text and
      // every non-stack value intact, including the exception's first line.
      const normalize = (value: unknown): unknown =>
        JSON.parse(
          JSON.stringify(value, (key, item: unknown) => {
            if (key !== "evidence" || typeof item !== "string") return item;
            return item.replace(
              /(?:\n\s+at [^\n]+)+/g,
              "\n    at <stack-frames>"
            );
          })
        );
      expect(
        normalize({
          evidence:
            "Private diagnostic\n    at direct (source.ts:1:2)\nSemantic evidence",
          error: "at unchanged"
        })
      ).toEqual({
        evidence:
          "Private diagnostic\n    at <stack-frames>\nSemantic evidence",
        error: "at unchanged"
      });
      const direct = await run(true);

      const panelBound = await run(false);
      expect(normalize(panelBound)).toEqual(normalize(direct));
    }
  );

  it.each(["present", "closed", "replaced"] as const)(
    "projects direct configuration only into its current attachment generation (%s)",
    async (state) => {
      const harness = start({ direct: true });
      const owner = createEnvironmentExecutionOwner();
      const attachment = owner.attach("own");
      const original = { state: {} as CanvasState };
      const replacement = { state: {} as CanvasState };
      const other = { state: {} as CanvasState };
      const entries = new Map([
        ["own", original],
        ["other", other]
      ]);
      const reads: string[] = [];
      harness.dependencies.readInstanceEntry = (id) => {
        reads.push(id);
        return entries.get(id);
      };
      harness.setJournalHook((entry) => {
        if (entry === "dispatchVerifyWorkflow") {
          if (state === "closed") entries.delete("own");
          if (state === "replaced") {
            entries.set("own", replacement);
            owner.attach("own");
          }
        }
      });
      const outcome = await createConfigureEnvironmentService(
        harness.dependencies
      )({ data: { repo: "octo/app" } }, "own", attachment.isCurrent);
      expect(outcome).toMatchObject({ kind: "completed", status: 200 });
      expect(reads).toEqual(state === "replaced" ? [] : ["own"]);
      expect(other.state).toEqual({});
      if (state === "present") expect(original.state.verifyRunId).toBe("4242");
      else expect(original.state).toEqual({});
      expect(replacement.state).toEqual({});
      expect(harness.operation).toMatchObject({
        verification: { runId: "4242" }
      });
    }
  );

  it.each([
    "stop",
    "checkpoint",
    "selected-refusal",
    "unknown-resume",
    "manual-required"
  ] as const)(
    "matches configuration %s effects and durable outcomes without mirrored orchestration",
    async (scenario) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(1700000000000);
      const run = async (direct: boolean) => {
        const trace: unknown[] = [];
        const harness = start({
          direct,
          pairedProvider: "aws",
          ...(scenario === "unknown-resume" ?
            {
              gh: [
                {
                  match:
                    /^api --method PUT \/repos\/octo\/app\/contents\/\S+ --input @default$/,
                  result: { code: 1, stderr: "protected branch" }
                },
                {
                  match: /^api \/repos\/octo\/app\/pulls\?/,
                  result: { code: 1, stderr: "HTTP 500" }
                },
                {
                  match: /^api \/repos\/octo\/app\/git\/ref\/heads\//,
                  result: {
                    code: 1,
                    stderr: "HTTP 500: branch state unavailable"
                  }
                }
              ],
              headSha: "sha-base",
              createBranch: { ok: true, stderr: "" },
              pullRequest: { ok: false, stderr: "ECONNRESET" }
            }
          : {}),
          ...(scenario === "manual-required" ?
            {
              dispatchResults: [
                { code: 1, stderr: "request timed out", timedOut: true }
              ],
              runListResults: [
                { code: 0, stdout: "[]" },
                { code: 0, stdout: "[]" },
                { code: 0, stdout: "[]" },
                { code: 0, stdout: "[]" }
              ]
            }
          : {}),
          trace: (effect) => trace.push(snapshot(effect))
        });
        const { dependencies: d, operation } = harness;
        if (scenario === "checkpoint") {
          const checkpoint = d.persistMutationCheckpoint;
          d.persistMutationCheckpoint = (input) =>
            checkpoint({
              ...input,
              persist: async () => {
                throw new Error("Checkpoint store unavailable");
              }
            });
        }
        if (scenario === "selected-refusal")
          d.getSelectedGitHubExecutor = () => null;
        if (scenario === "stop")
          harness.setJournalHook((entry) => {
            if (entry === "bootstrapGHCRStatePackage")
              operation.stopRequested = true;
          });
        const data = {
          repo: "octo/app",
          provider: "aws",
          environment: "dev",
          operationId: operation.operationId,
          roleArn: "arn:aws:iam::123456789012:role/radius-deploy",
          region: "us-west-2",
          accountId: "123456789012",
          cluster: "cluster",
          namespace: "application"
        };
        const invoke = async () => {
          if (direct) {
            const outcome = await runDirectParityConfiguration(data, d);
            return { status: outcome.status, body: outcome.body };
          }
          const response = await configure(data);
          return {
            status: response.status,
            body: asRecord(response.body)
          };
        };
        const results = [await invoke()];
        if (scenario === "unknown-resume") {
          expect(results[0]).toMatchObject({
            status: 202,
            body: { reconciling: true }
          });
          Object.assign(operation, snapshot(operation));
          results.push(await invoke());
          expect(results[1]).toMatchObject({
            status: 202,
            body: { reconciling: true }
          });
          expect(
            harness.journal.filter((entry) => entry === "createPullRequestApi")
          ).toHaveLength(1);
          expect(results[0].body.message).toContain(
            "github_pull_request.create"
          );
          expect(results[1].body.message).toContain("github_branch.create");
          expect(
            providerMutationsByKind(operation, "github_pull_request.create")[0]
              ?.reconcileAttempts
          ).toBe(1);
          expect(
            providerMutationsByKind(operation, "github_branch.create")[0]
              ?.reconcileAttempts
          ).toBe(1);
          expect(harness.failures).toEqual([]);
        } else if (scenario === "stop") {
          expect(results[0]).toMatchObject({
            status: 200,
            body: { cancelled: true }
          });
          expect(harness.failures).toEqual([]);
          expect(harness.committedFiles).toEqual([]);
        } else if (scenario === "checkpoint") {
          expect(results[0]).toMatchObject({
            status: 500,
            body: { code: "operation-persistence-failed" }
          });
          expect(harness.failures).toHaveLength(1);
          expect(harness.committedFiles).toEqual([]);
        } else {
          expect(results[0].status).toBe(400);
          expect(harness.failures).toHaveLength(1);
          expect(results[0].body.error).toContain(
            scenario === "selected-refusal" ?
              "selected GitHub account executor is unavailable"
            : "No exact verification run appeared"
          );
          if (scenario === "manual-required")
            expect(operation.recoveryState).toBe("manual_required");
        }
        return JSON.parse(
          JSON.stringify(
            {
              results,
              trace,
              persisted: harness.persisted,
              operation,
              failures: harness.failures
            },
            (key, item: unknown) =>
              key === "evidence" && typeof item === "string" ?
                item.replace(/(?:\n\s+at [^\n]+)+/g, "\n    at <stack-frames>")
              : item
          )
        );
      };
      const direct = await run(true);

      expect(await run(false)).toEqual(direct);
    }
  );

  it("rejects unscripted provider calls and creation without a live temporary credential body", async () => {
    const { azure } = start({ pairedProvider: "azure", direct: true });
    if (!azure) throw new Error("Missing Azure fixture.");
    await expect(
      azure.dependencies.external.runAz(["unexpected"])
    ).rejects.toThrow("Unexpected parity fixture call");
    await expect(
      azure.dependencies.external.runGitHubJson("/unexpected")
    ).rejects.toThrow("Unexpected parity fixture call");
    const create = ["ad", "app", "federated-credential", "create"];
    await expect(azure.dependencies.external.runAz(create)).rejects.toThrow(
      "requires a written request body"
    );
    const path = azure.dependencies.tempFile.createPath();
    azure.dependencies.tempFile.write(path, '{"name":"temporary-credential"}');
    azure.dependencies.tempFile.remove(path);
    await expect(azure.dependencies.external.runAz(create)).rejects.toThrow(
      "requires a written request body"
    );
    expect(azure.provenance.size).toBe(0);
  });

  it("releases the fixture provenance lock and preserves the original failure", async () => {
    const trace: unknown[] = [];
    const { azure } = start({
      pairedProvider: "azure",
      direct: true,
      trace: (entry) => trace.push(snapshot(entry))
    });
    if (!azure) throw new Error("Missing Azure fixture.");
    await azure.bindProvenance();
    const failure = new Error("provenance write unavailable");
    await expect(
      azure.dependencies.operations.withCredentialProvenanceLock(async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(trace).toEqual([["provenance-load"], ["lock"], ["unlock"]]);
    expect(azure.provenance.size).toBe(0);
  });

  it("refuses a different live record at the shared fixture boundary", () => {
    const test = start({ pairedProvider: "azure", direct: true });
    if (!test.azure) throw new Error("Missing Azure fixture.");
    const foreign = { ...test.operation, operationId: "different-operation" };
    expect(() =>
      createParityAzureFixture(foreign, test.dependencies, () => {})
    ).toThrow("requires the registered live operation");
    expect(() =>
      test.azure?.dependencies.honorStopBoundary({
        operation: foreign,
        boundary: "before-provider-write",
        persist: async () => {},
        report: () => {}
      })
    ).toThrow("Unexpected parity fixture call");
    expect(test.persisted).toEqual([]);
  });
});

it("reports a failing configuration finalizer once without leaving the service pending", async () => {
  const harness = start({ defaultBranch: null });
  let finalizations = 0;
  harness.dependencies.finalizeSetupFailure = async () => {
    finalizations++;
    throw new Error("private cleanup detail");
  };
  const response = await configure({ repo: "octo/app" });
  expect(response.status).toBe(500);
  expect(response.body).toMatchObject({ code: "setup-handler-failed" });
  expect(finalizations).toBe(1);
  expect(harness.journal).toContain("diagnostic:setup-handler-failed");
});

it("keeps the Azure cleanup runner available when direct configuration cannot publish", async () => {
  const harness = start({ direct: true, defaultBranch: null });
  const runAz = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
  harness.dependencies.runAzCommand = runAz;
  const finalize = harness.dependencies.finalizeSetupFailure;
  harness.dependencies.finalizeSetupFailure = async (operation, input) => {
    const cleanup = input.runAz;
    if (typeof cleanup !== "function")
      throw new Error("Missing Azure cleanup runner.");
    await cleanup(["cleanup"]);
    return finalize(operation, input);
  };
  const result = await runDirectParityConfiguration(
    { repo: "octo/app" },
    harness.dependencies
  );
  expect(result).toMatchObject({
    kind: "failed",
    status: 400,
    body: { code: "default-branch-unavailable" }
  });
  expect(runAz).toHaveBeenCalledExactlyOnceWith(["cleanup"]);
  expect(harness.failures).toHaveLength(1);
});

describe("publication baseline parity", () => {
  it.each(["direct", "protected", "merge-required"] as const)(
    "preserves the %s command, journal, narration, and durable transcript",
    async (mode) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(1700000000000);
      const trace: unknown[] = [];
      const saved = new Map<string, string>();
      const kinds = [
        "github_environment.ensure",
        "github_environment_variable.put",
        "github_branch.create",
        "github_workflow.put",
        "github_pull_request.create",
        "github_workflow.dispatch"
      ] as const;
      const harness = start({
        ...(mode !== "direct" ?
          {
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
          }
        : {}),
        ...(mode === "merge-required" ?
          {
            fileReadResults: {
              ".github/workflows/radius-deploy.yml": {
                content: "on: push\njobs:",
                status: 200,
                error: null
              }
            }
          }
        : {}),
        trace(entry) {
          if (Array.isArray(entry) && entry[0] === "durable") {
            const changes = kinds
              .flatMap((kind) =>
                providerMutationsByKind(harness.operation, kind)
              )
              .filter((record) => {
                const encoded = JSON.stringify(record);
                if (saved.get(record.mutationId) === encoded) return false;
                saved.set(record.mutationId, encoded);
                return true;
              });
            trace.push(
              JSON.parse(
                JSON.stringify([
                  "durable",
                  changes,
                  harness.operation.verification
                ])
              )
            );
          } else trace.push(JSON.parse(JSON.stringify(entry)));
        }
      });
      const response = await configure({ repo: "octo/app" });
      // Preserve the serialized-outcome golden from before transport removal.
      const body = JSON.parse(JSON.stringify(response.body));
      expect(response.status).toBe(200);
      expect(body.steps).toEqual(harness.steps);
      expect(harness.ambientCliCalls).toEqual([]);
      expect(
        providerMutationsByKind(harness.operation, "github_workflow.put")
      ).toHaveLength(mode === "direct" ? 3 : 4);
      expect(
        providerMutationsByKind(
          harness.operation,
          "github_environment_variable.put"
        ).length
      ).toBeGreaterThan(0);
      if (mode === "direct") {
        expect(harness.state.verifyRunId).toBe("4242");
        expect(
          providerMutationsByKind(harness.operation, "github_workflow.dispatch")
        ).toHaveLength(1);
      } else {
        expect(
          providerMutationsByKind(harness.operation, "github_branch.create")
        ).toHaveLength(1);
        expect(
          providerMutationsByKind(
            harness.operation,
            "github_pull_request.create"
          )
        ).toHaveLength(1);
      }
      expect({
        trace,
        body,
        ledger: harness.operation.setupArtifacts,
        verification: harness.operation.verification,
        panel: harness.state,
        finished: harness.finished
      }).toMatchSnapshot();
    }
  );
});

describe("environment configuration service: the refusal ladder", () => {
  it("refuses 400 when no repository was supplied", async () => {
    start();

    const response = await configure({});

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "No target repository specified."
    });
  });

  it("refuses 400 for a repository that is not owner/repo", async () => {
    start();

    const response = await configure({ repo: "octo" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Invalid repository "octo". Expected "owner/repo".',
      code: "invalid-repo"
    });
  });

  // The invariant the wizard's own check cannot carry. Both cases must refuse
  // before any GitHub mutation, and the second must refuse precisely because
  // the claims could not be read.
  it("refuses 409 when another environment already holds the namespace", async () => {
    const harness = start({
      namespaceClaimants: {
        dev: {
          RADIUS_MANAGED: "true",
          AZURE_CLIENT_ID: "client-1",
          AZURE_SUBSCRIPTION_ID: "sub-1",
          AZURE_AKS_CLUSTER_NAME: "aks-1",
          KUBERNETES_NAMESPACE: "payments"
        }
      }
    });

    const response = await configure({
      repo: "octo/app",
      environment: "prod",
      provider: "azure",
      subscriptionId: "sub-1",
      cluster: "aks-1",
      namespace: "payments"
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error:
        'Namespace "payments" on cluster "aks-1" already belongs to environment "dev". Radius allows one environment per namespace, so choose a different namespace or deploy to "dev".',
      code: "namespace-already-claimed",
      environment: "dev"
    });
    // The safety property: refused before any GitHub mutation. The journal
    // carries only the recovery record this request registered for itself.
    expect(ghCallsExcludingNamespaceClaimLookup(harness.ghCalls)).toEqual([]);
    expect(harness.journal).toEqual(["persist:1"]);
  });

  it("refuses 409 and changes nothing when the namespace claims cannot be read", async () => {
    const harness = start({ namespaceClaimsFailure: "gh: forbidden" });

    const response = await configure({
      repo: "octo/app",
      environment: "prod",
      provider: "azure",
      subscriptionId: "sub-1",
      cluster: "aks-1",
      namespace: "payments"
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error:
        "Radius created nothing because it could not confirm which namespaces octo/app's environments already use: gh: forbidden",
      code: "namespace-claims-unavailable"
    });
    expect(ghCallsExcludingNamespaceClaimLookup(harness.ghCalls)).toEqual([]);
    expect(harness.journal).toEqual(["persist:1"]);
  });

  // The read runs as the account pinned to the operation. Without one the
  // claims cannot be established, so the request is refused rather than
  // admitted on an ambient account's view of the repository.
  // The scenario the review asked for: the ambient `gh` account cannot see the
  // repository, and the account pinned to the operation can. Creation must
  // proceed, because the claims are established through the pinned account.
  it("establishes the claims through the pinned account, not the ambient one", async () => {
    const harness = start({
      namespaceClaimants: {
        dev: {
          RADIUS_MANAGED: "true",
          AZURE_CLIENT_ID: "client-1",
          AZURE_SUBSCRIPTION_ID: "sub-1",
          AZURE_AKS_CLUSTER_NAME: "aks-1",
          KUBERNETES_NAMESPACE: "orders"
        }
      }
    });

    const response = await configure({
      repo: "octo/app",
      environment: "prod",
      provider: "azure",
      subscriptionId: "sub-1",
      cluster: "aks-1",
      namespace: "payments"
    });

    // Admitted: the namespace is free, which only the pinned account could show.
    expect(response.status).not.toBe(409);
    expect(harness.selectedClaimCalls).toEqual([
      "api --paginate /repos/octo/app/environments?per_page=100 --jq .environments[].name",
      'api --paginate /repos/octo/app/environments/dev/variables?per_page=100 --jq .variables[] | .name + "\\t" + (.value // "")'
    ]);
    // A regression to the ambient runner would show up here.
    expect(
      harness.ambientCliCalls.filter((call) =>
        call.includes("/environments?per_page=100")
      )
    ).toEqual([]);
  });

  // An environment name that has to be URL-encoded still has to be read, and
  // the harness has to script it the way production requests it. Without the
  // encoding this call would go unscripted and the conflict would be missed.
  it("refuses 409 for a holder whose name must be URL-encoded", async () => {
    const harness = start({
      namespaceClaimants: {
        "team a/dev": {
          RADIUS_MANAGED: "true",
          AZURE_CLIENT_ID: "client-1",
          AZURE_SUBSCRIPTION_ID: "sub-1",
          AZURE_AKS_CLUSTER_NAME: "aks-1",
          KUBERNETES_NAMESPACE: "payments"
        }
      }
    });

    const response = await configure({
      repo: "octo/app",
      environment: "prod",
      provider: "azure",
      subscriptionId: "sub-1",
      cluster: "aks-1",
      namespace: "payments"
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: "namespace-already-claimed",
      environment: "team a/dev"
    });
    // The read went out against the encoded path, exactly as production builds it.
    expect(harness.selectedClaimCalls).toContain(
      'api --paginate /repos/octo/app/environments/team%20a%2Fdev/variables?per_page=100 --jq .variables[] | .name + "\\t" + (.value // "")'
    );
  });

  it("refuses 409 when no GitHub account is pinned to the operation", async () => {
    const harness = start({ noPinnedNamespaceAccount: true });

    const response = await configure({
      repo: "octo/app",
      environment: "prod",
      provider: "azure",
      subscriptionId: "sub-1",
      cluster: "aks-1",
      namespace: "payments"
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error:
        "Radius created nothing because it could not confirm which namespaces octo/app's environments already use: the GitHub account pinned to this setup is unavailable.",
      code: "namespace-claims-unavailable"
    });
    expect(ghCallsExcludingNamespaceClaimLookup(harness.ghCalls)).toEqual([]);
  });

  it("answers the unhandled-error envelope when the body is not JSON", async () => {
    const harness = start();

    const response = await configure("not json at all");

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: "create-environment-unhandled"
    });
    expect(ghCallsExcludingNamespaceClaimLookup(harness.ghCalls)).toEqual([]);
  });

  it("refuses with the repo-admin message before touching GitHub", async () => {
    const harness = start({
      repoAdminRefusal: "You need admin on octo/app."
    });

    const response = await configure({ repo: "octo/app" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: "You need admin on octo/app.",
      code: "repo-admin-required"
    });
    expect(ghCallsExcludingNamespaceClaimLookup(harness.ghCalls)).toEqual([]);
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

    const response = await configure({ repo: "octo/app" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
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

      const response = await configure({
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

    await configure({
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

    await configure({
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

describe("environment configuration service: the seven-step workflow", () => {
  it.each(["success", "timeout", "rejected", "persistence-error"] as const)(
    "retains initial dispatch evidence without post-shutdown publication (%s)",
    async (outcome) => {
      const harness = start({
        dispatchResults: [
          {
            code: outcome === "success" ? 0 : 1,
            stdout:
              outcome === "success" ?
                "https://github.com/octo/app/actions/runs/4242"
              : "",
            stderr: outcome === "rejected" ? "HTTP 403" : "timeout",
            timedOut: outcome === "timeout" || outcome === "persistence-error"
          }
        ]
      });
      let stopped = false;
      harness.dependencies.isShuttingDown = () => stopped;
      const guard = harness.dependencies.guardStopBoundary;
      harness.dependencies.guardStopBoundary = async (input) => {
        if (!stopped) return guard(input);
        input.respond(503, { code: "setup-shutting-down" });
        return false;
      };
      harness.setJournalHook((entry) => {
        if (entry === "dispatchVerifyWorkflow") stopped = true;
      });
      const persist = harness.dependencies.persistOperations;
      harness.dependencies.persistOperations = async () => {
        await persist();
        if (stopped && outcome === "persistence-error")
          throw new Error("acknowledgement journal unavailable");
      };
      const result = await configure({ repo: "octo/app" });
      expect(result).toMatchObject(
        outcome === "persistence-error" ?
          { kind: "failed", status: 500 }
        : { kind: "stopped", status: 503 }
      );
      expect(
        harness.ghCalls.filter((call) => call.startsWith("run list "))
      ).toHaveLength(1);
      expect(
        harness.ghCalls.filter((call) => call.startsWith("workflow run "))
      ).toHaveLength(1);
      expect(harness.failures).toEqual([]);
      expect(harness.finished).toEqual([]);
      expect(
        harness.operation.providerRecovery?.mutations?.at(-1)?.status
      ).toBe(
        outcome === "success" ? "confirmed"
        : outcome === "rejected" ? "not_applied"
        : "outcome_unknown"
      );
      expect(harness.state.verifyRunId).toBeUndefined();
    }
  );
  it.each([false, true])(
    "keeps an optional template failure nonfatal only without a pending workflow PUT: pending=%s",
    async (pending) => {
      const harness = start({
        preparedEnvironment: {
          requestedName: "dev",
          canonicalName: "dev",
          state: "reused"
        },
        gh: [
          {
            match:
              /^api \/repos\/octo\/app\/contents\/\.github\/workflows\/radius-verify-credentials\.yml --jq \.sha$/,
            result: { code: 0, stdout: gitBlobShaOf(MARKED_VERIFY_WORKFLOW) }
          },
          {
            match:
              /^api \/repos\/octo\/app\/contents\/\.github\/workflows\/run-rad-commands\.yml --jq \.sha$/,
            result: { code: 0, stdout: gitBlobShaOf(DEPLOY_WORKFLOW_BODY) }
          }
        ]
      });
      harness.operation.state = "running";
      const path = ".github/workflows/radius-delete.yml";
      if (pending) {
        const mutation = prepareProviderMutation(harness.operation, {
          kind: "github_workflow.put",
          target: `octo/app:<default>:${path}`,
          intent: {
            branch: "<default>",
            path,
            previousBlobSha: null,
            previousBlobKnown: true,
            contentSha256: WORKFLOW_CONTENT_DIGEST,
            operationMarker: `radius-operation:op-http:workflow:${path}:${WORKFLOW_CONTENT_DIGEST.slice(0, 16)}`
          }
        });
        settleProviderMutation(
          harness.operation,
          mutation.mutationId,
          "outcome_unknown",
          "Prior optional workflow PUT timed out."
        );
        await harness.dependencies.persistOperations();
      }
      const savedMutations = structuredClone(
        providerMutationsByKind(harness.operation, "github_workflow.put")
      );
      let generatorCalls = 0;
      harness.dependencies.generateDeleteWorkflow = async () => {
        generatorCalls++;
        throw new Error("Delete template fetch unavailable.");
      };
      let pullRequestCalls = 0;
      harness.dependencies.createPullRequestApi = async () => {
        pullRequestCalls++;
        throw new Error("Unchanged workflows must not open a pull request.");
      };
      let cleanupCalls = 0;
      const unexpectedCleanup = async (): Promise<never> => {
        cleanupCalls++;
        throw new Error("Unproven ownership must not reach cleanup.");
      };
      let finalizations = 0;
      harness.dependencies.finalizeSetupFailure = async (operation, input) => {
        finalizations++;
        if (
          typeof input.status !== "number" ||
          typeof input.error !== "string" ||
          typeof input.code !== "string"
        ) {
          throw new Error("Malformed adapter finalization request.");
        }
        return finalizeSetupFailure(operation, {
          status: input.status,
          error: input.error,
          code: input.code,
          runAz: unexpectedCleanup,
          runGitHubVariable: unexpectedCleanup,
          runDeleteEnvironment: unexpectedCleanup,
          readEnvironment: unexpectedCleanup
        });
      };

      const response = await configure({
        operationId: harness.operation.operationId,
        repo: "octo/app",
        environment: "dev",
        provider: "azure"
      });
      const body = response.body;

      expect(generatorCalls).toBe(1);
      expect(cleanupCalls).toBe(0);
      expect(pullRequestCalls).toBe(0);
      expect(harness.selectedClaimCalls.length).toBeGreaterThan(0);
      expect(harness.steps).toContain(
        "⚠️ Could not generate/commit delete workflows: Delete template fetch unavailable."
      );
      expect(
        providerMutationsByKind(harness.operation, "github_workflow.put")
      ).toEqual(savedMutations);
      expect(
        harness.ghCalls.filter((call) =>
          /^api --method (PUT|POST|DELETE) .*\/contents\//.test(call)
        )
      ).toEqual([]);
      if (pending) {
        expect(response.status).toBe(409);
        expect(body).toMatchObject({
          code: "provider-reconciliation-pending",
          providerRecoveryGuidance: expect.stringContaining(
            "github_workflow.put"
          )
        });
        expect(harness.operation.state).toBe("failed_partial");
        expect(finalizations).toBe(1);
        expect(
          harness.ghCalls.filter((call) =>
            /--method (PUT|POST|DELETE)|workflow run|variable set/.test(call)
          )
        ).toEqual([]);
        expect(harness.finished).toEqual([]);
      } else {
        expect(response.status).toBe(200);
        expect(body).toMatchObject({ success: true, actionRequired: false });
        expect(finalizations).toBe(0);
        expect(
          harness.ghCalls.filter((call) => call.startsWith("workflow run "))
        ).toHaveLength(1);
      }
    }
  );

  it("answers a single synchronous 200 describing the whole run", async () => {
    start();

    const response = await configure({ repo: "octo/app", environment: "dev" });

    expect(response.status).toBe(200);
    const payload = response.body as Record<string, unknown>;
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

    const response = await configure({ repo: "octo/app", environment: "dev" });
    const payload = response.body as { steps: string[] };

    expect(payload.steps).toContain("✅ Credential verification dispatched.");
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
        (step) => step === "✅ Credential verification dispatched."
      )
    ).toHaveLength(1);
    expect(payload.steps).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "Environment created. Deploy your application from the Environments list when ready."
        )
      ])
    );
    expect(harness.steps).toContain("✅ Credential verification dispatched.");
    expect(
      harness.ghCalls.find((call) => call.startsWith("workflow run "))
    ).toContain("--ref main");
  });

  it("dispatches against the confirmed non-main default branch", async () => {
    const harness = start({ defaultBranch: "trunk" });

    const response = await configure({ repo: "octo/app", environment: "dev" });

    expect(response.status).toBe(200);
    expect(
      harness.ghCalls.find((call) => call.startsWith("workflow run "))
    ).toContain("--ref trunk");
    expect(harness.operation.verification).toMatchObject({ ref: "trunk" });
    const payload = response.body as { steps: string[] };
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

    const response = await configure({ repo: "octo/app", environment: "dev" });

    expect(response.status).toBe(200);
    const payload = response.body as Record<string, unknown>;
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

    const response = await configure({
      repo: "octo/app",
      environment: "dev",
      operationEnvironment: "dev",
      operationId: "op-http"
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
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

  it.each([
    {
      provider: "azure",
      note: "Azure OIDC credentials (client ID, tenant ID, and subscription ID) are not fully configured for this environment. Use auto-setup or enter them manually, then verify credentials from the Environments list."
    },
    {
      provider: "aws",
      note: "The AWS IAM role ARN is not configured for this environment. Enter it (or use auto-setup), then verify credentials from the Environments list."
    }
  ])(
    "recomputes incomplete $provider credentials without replaying configuration during workflow reconciliation",
    async ({ provider, note }) => {
      const harness = start({
        preparedEnvironment: {
          requestedName: "dev",
          canonicalName: "dev",
          state: "reused"
        },
        azureCredential: () => {
          if (provider === "aws")
            throw new Error("AWS status must not read Azure credentials");
          return { clientId: "c", tenantId: "t" };
        },
        gh: recoveredVerifyWorkflowRules()
      });
      harness.operation.provider = provider;
      prepareVerifyWorkflowRecovery(harness.operation);

      const response = await configure({
        repo: "octo/app",
        environment: "dev",
        operationEnvironment: "dev",
        operationId: "op-http",
        provider
      });

      expect(response.status).toBe(200);
      const payload = response.body as Record<string, unknown>;
      expect(payload).toMatchObject({
        success: true,
        verifySkipped: true,
        verifyRunUrl: "",
        verifySkipReason: note
      });
      expect(
        harness.ghCalls.some((call) => call.startsWith("variable set "))
      ).toBe(false);
      expect(harness.steps).not.toContain(
        "Setting environment variables and secrets..."
      );
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
    }
  );

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

    const response = await configure({
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

    await configure({ repo: "octo/app" });

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

    const response = await configure({ repo: "octo/app" });

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

    await configure({ repo: "octo/app" });

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

    const response = await configure({ repo: "octo/app" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error:
        "Could not determine the default branch for octo/app, so Radius did not commit workflow files with guessed deletion provenance.",
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

    await configure({ repo: "octo/app" });

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

    await configure({ repo: "octo/app" });

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

    await configure({ repo: "octo/app" });

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

    await configure({ repo: "octo/app" });

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

    const response = await configure({
      repo: "octo/app",
      environment: "production"
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
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

    const response = await configure({
      repo: "octo/app",
      environment: "Production",
      operationEnvironment: "production",
      operationId: "op-http"
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
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

    const response = await configure({ repo: "octo/app" });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
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

      const response = await configure({ repo: "octo/app" });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: `Could not confirm repository "octo/app" before creating GitHub environment "dev". ${detail}`,
        code: "create-environment-unhandled"
      });
      expect(
        harness.ghCalls.some((call) => call.startsWith("api --method PUT"))
      ).toBe(false);
      expect(ghCallsExcludingNamespaceClaimLookup(harness.ghCalls)).toEqual([
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

    const response = await configure({ repo: "octo/app" });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
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
    expect(ghCallsExcludingNamespaceClaimLookup(harness.ghCalls)).toEqual([
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

      const response = await configure({ repo: "octo/app" });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: "state setup failed",
        code: "create-environment-unhandled"
      });
      expect(harness.cleanupErrors).toEqual(expectedErrors);
    }
  );

  it("tags the environment as Radius-managed and drops the cached listing", async () => {
    const harness = start();

    await configure({ repo: "octo/app" });

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

    const response = await configure({ repo: "octo/app" });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
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

    await configure({ repo: "octo/app", profileName: "work" });

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

    await configure({ repo: "octo/app" });

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

    await configure({
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

  it.each([
    {
      provider: "azure",
      first: "AZURE_CLIENT_ID",
      last: "AZURE_SUBSCRIPTION_ID"
    },
    { provider: "aws", first: "AWS_ROLE_ARN", last: "AWS_ACCOUNT_ID" }
  ])(
    "finishes the coherent $provider credential group when Stop arrives during its first write",
    async ({ provider, first, last }) => {
      const harness = start({
        onGhCommand: (command) => {
          if (command.startsWith(`variable set ${first} `)) {
            harness.operation.stopRequested = true;
          }
        }
      });
      const response = await configure({
        repo: "octo/app",
        provider,
        roleArn: "arn:aws:iam::1",
        accountId: "1"
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        cancelled: true,
        code: "operation-stopped",
        boundary: "after-provider-configuration"
      });
      expect(
        harness.ghCalls.some((call) => call.startsWith(`variable set ${last} `))
      ).toBe(true);
      expect(harness.committedFiles).toEqual([]);
      expect(harness.journal).not.toContain("dispatchVerifyWorkflow");
    }
  );

  it("defaults an empty environment name to dev rather than keeping the empty string", async () => {
    // `||`, not `??`: "" is not a usable GitHub environment name.
    const harness = start();

    const response = await configure({ repo: "octo/app", environment: "" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ environment: "dev" });
    expect(harness.ghCalls).toContain("api /repos/octo/app/environments/dev");
  });

  it("records every committed workflow file against the default branch", async () => {
    const harness = start();

    await configure({ repo: "octo/app" });

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

  it("does not commit or record cleanup artifacts for up-to-date workflows", async () => {
    const workflowFiles = {
      ".github/workflows/radius-verify-credentials.yml": MARKED_VERIFY_WORKFLOW,
      ".github/workflows/run-rad-commands.yml": DEPLOY_WORKFLOW_BODY,
      ".github/workflows/radius-delete.yml": DEPLOY_WORKFLOW_BODY
    };
    const harness = start({
      files: workflowFiles,
      gh: Object.entries(workflowFiles).map(([path, content]) => ({
        match: new RegExp(
          `^api /repos/octo/app/contents/${path.replaceAll(".", "\\.")}(?:\\?ref=main)? --jq \\.sha$`
        ),
        result: { code: 0, stdout: gitBlobShaOf(content) }
      }))
    });

    const response = await configure({ repo: "octo/app" });

    expect(response.status).toBe(200);
    expect(
      harness.ghCalls.filter((call) =>
        call.startsWith("api --method PUT /repos/octo/app/contents/")
      )
    ).toEqual([]);
    expect(harness.committedFiles).toEqual([]);
    expect(harness.operation.setupArtifacts.commit.workflowFiles).toEqual([]);
  });

  it("records the commit point only after the verify dispatch succeeded", async () => {
    const harness = start();

    await configure({ repo: "octo/app" });

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

    await configure({ repo: "octo/app" });

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

    const response = await configure({ repo: "octo/app" });

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({
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

    const response = await configure({ repo: "octo/app" });

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({
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

    const response = await configure({ repo: "octo/app" });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
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

    const response = await configure({ repo: "octo/app", environment: "dev" });

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

    const response = await configure({ repo: "octo/app", environment: "dev" });

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

    const response = await configure({ repo: "octo/app", environment: "dev" });

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

    const response = await configure({ repo: "octo/app" });

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

    await configure({ repo: "octo/app", environment: "dev" });

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

    const response = await configure({ repo: "octo/app" });

    expect(response.status).toBe(400);
    const payload = response.body as { error: string; code: string };
    expect(payload.code).toBe("verify-workflow-commit-failed");
    expect(payload.error).toContain(
      "'/opt/Copilot Tools/gh' auth refresh -h github.com -s workflow"
    );
    expect(payload.error).toContain("Install GitHub CLI system-wide.");
    expect(harness.committedFiles).toEqual([]);
  });

  it("fails with workflow permission guidance when a GitHub App cannot write workflows", async () => {
    const diagnostic =
      "HTTP 403: refusing to allow a GitHub App to create or update workflow `.github/workflows/radius-verify-credentials.yml` without `workflows` permission";
    const harness = start({
      gh: [
        {
          match: /^api --method PUT \/repos\/octo\/app\/contents\//,
          result: { code: 1, stderr: diagnostic }
        }
      ]
    });

    const response = await configure({ repo: "octo/app" });
    const payload = response.body as { code: string; error: string };

    expect(response.status).toBe(400);
    expect(payload.code).toBe("verify-workflow-commit-failed");
    expect(payload.error).toContain(diagnostic);
    expect(payload.error).toContain(
      "Grant the GitHub App Workflows: write permission"
    );
    expect(payload.error).toContain("retry with a new installation token");
    expect(payload.error).not.toContain("auth refresh -h");
    expect(payload.error).not.toContain("fork the repository");
    expect(payload.error).not.toContain("PR fallback failed");
    expect(harness.committedFiles).toEqual([]);
    expect(harness.operation.verification).toBeUndefined();
    expect(
      harness.ghCalls.filter((call) =>
        call.startsWith("api --method PUT /repos/octo/app/contents/")
      )
    ).toHaveLength(1);
    expect(
      harness.ghCalls.filter((call) => call.startsWith("workflow run "))
    ).toEqual([]);
  });

  it("fails 400 with fork and access recovery for any other commit refusal", async () => {
    const harness = start({
      gh: [
        {
          match: /^api --method PUT \/repos\/octo\/app\/contents\//,
          result: { code: 1, stderr: "HTTP 404: Not Found" }
        }
      ]
    });

    const response = await configure({ repo: "octo/app" });

    expect(response.status).toBe(400);
    const payload = response.body as { error: string };
    expect(payload.error).toContain(
      "fork the repository and start a new Copilot session from the fork's GitHub URL"
    );
    expect(harness.operation.verification).toBeUndefined();
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

    const response = await configure({ repo: "octo/app" });

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

    const response = await configure({ repo: "octo/app" });
    const payload = response.body;

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

    const response = await configure({ repo: "octo/app" });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: "verify-dispatch-failed"
    });
    expect(
      harness.ghCalls.filter((call) => call.startsWith("workflow run "))
    ).toHaveLength(1);
  });
});

describe("environment configuration service: the protected-branch path", () => {
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

  it("discovers first-time setup verification without dispatching or waiting for merge", async () => {
    const harness = start(protectedScript);

    const response = await configure({ repo: "octo/app" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      actionRequired: false,
      pullRequestUrl: "https://github.com/octo/app/pull/7",
      pullRequestBranch: null,
      pullRequestBaseBranch: null,
      verifyRunUrl: "https://github.com/octo/app/actions/runs/4242"
    });
    expect(
      harness.ghCalls.some((call) => call.startsWith("workflow run "))
    ).toBe(false);
    expect(harness.commitStates.at(-1)).toEqual({
      mode: "pull_request",
      branch: "radius/setup-dev-workflows-op-http",
      baseBranch: "main",
      pullRequestUrl: "https://github.com/octo/app/pull/7"
    });
    expect(harness.journal).toContain("setupPushOperationMarker:op-http");
    expect(harness.operation.verification).toMatchObject({
      event: "push",
      ref: "radius/setup-dev-workflows-op-http",
      operationMarker: "op-http",
      runId: "4242"
    });
    expect(harness.finished).toEqual([]);
  });

  it("preserves and reuses a persisted automatic verification identity", async () => {
    const harness = start(protectedScript);
    harness.operation.verification = {
      dispatchedAt: 1699999990000,
      workflow: "radius-verify-credentials.yml",
      ref: "radius/setup-dev-workflows-op-http",
      environment: "dev",
      event: "push",
      operationMarker: "op-http",
      baselineRunId: null,
      runId: null,
      runUrl: null,
      recoveryMarker: "preserved"
    };

    const response = await configure({ repo: "octo/app" });

    expect(response.status).toBe(200);
    expect(harness.operation.verification).toMatchObject({
      dispatchedAt: 1699999990000,
      ref: "radius/setup-dev-workflows-op-http",
      event: "push",
      operationMarker: "op-http",
      runId: "4242",
      recoveryMarker: "preserved"
    });
  });

  it("stops automatic setup-branch discovery without publishing its late result", async () => {
    let stopped = false;
    const harness = start({
      ...protectedScript,
      onGhCommand: (command) => {
        if (command.startsWith("run list ")) stopped = true;
      }
    });
    harness.dependencies.isShuttingDown = () => stopped;
    const guard = harness.dependencies.guardStopBoundary;
    harness.dependencies.guardStopBoundary = async (input) => {
      if (!stopped) return guard(input);
      input.respond(503, { code: "setup-shutting-down" });
      return false;
    };
    const result = await configure({ repo: "octo/app" });
    expect(result).toMatchObject({ kind: "stopped", status: 503 });
    expect(
      harness.ghCalls.filter((call) => call.startsWith("run list "))
    ).toHaveLength(1);
    expect(
      harness.ghCalls.some((call) => call.startsWith("workflow run "))
    ).toBe(false);
    expect(harness.operation.verification).toMatchObject({
      event: "push",
      runId: null
    });
    expect(harness.state.verifyRunId).toBeUndefined();
    expect(harness.failures).toEqual([]);
    expect(harness.finished).toEqual([]);
  });

  it("keeps merge-required guidance when the default dispatcher has a legacy chain", async () => {
    const harness = start({
      ...protectedScript,
      files: {
        ".github/workflows/run-rad-commands.yml":
          "on:\n  workflow_dispatch:\n  workflow_run:\njobs:\n"
      }
    });

    const response = await configure({ repo: "octo/app" });

    expect(response.body).toMatchObject({
      actionRequired: true,
      verifyRunUrl: ""
    });
    expect(harness.journal).not.toContain("setupPushOperationMarker:op-http");
    expect(
      harness.ghCalls.some((call) => call.startsWith("workflow run "))
    ).toBe(false);
    expect(harness.steps).toContain(
      "⚠️ Setup-branch credential verification is disabled: The default branch's deploy dispatcher can still auto-run after credential verification."
    );
  });

  it("does not start setup-branch verification while a legacy deploy workflow exists", async () => {
    const harness = start({
      ...protectedScript,
      files: {
        ".github/workflows/radius-verify-credentials.yml":
          MARKED_VERIFY_WORKFLOW,
        ".github/workflows/radius-deploy.yml":
          "on:\n  workflow_run:\n    workflows: [Radius - Verify Credentials]\njobs:\n"
      }
    });

    const response = await configure({ repo: "octo/app" });

    expect(response.body).toMatchObject({
      actionRequired: true,
      verifyRunUrl: ""
    });
    expect(harness.journal).not.toContain("setupPushOperationMarker:op-http");
    expect(harness.journal).toContain(
      "legacyDeployDeleteBranch:radius/setup-dev-workflows-op-http"
    );
    expect(harness.steps).toContain(
      "⚠️ Setup-branch credential verification is disabled: The default branch still contains the legacy deploy workflow, which can auto-run after credential verification."
    );
  });

  it("fails closed when a legacy deploy workflow cannot be checked or removed", async () => {
    const harness = start({
      ...protectedScript,
      fileReadResults: {
        ".github/workflows/radius-verify-credentials.yml": {
          content: null,
          error: "connection reset",
          status: null
        },
        ".github/workflows/radius-deploy.yml": {
          content: null,
          error: "HTTP 403: Forbidden",
          status: 403
        }
      },
      legacyDeleteResult: false
    });

    const response = await configure({ repo: "octo/app" });
    const body = response.body as Record<string, unknown>;

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(String(body.error)).toContain(
      "could not remove the legacy deploy workflow"
    );
    expect(harness.journal).not.toContain("dispatchVerifyWorkflow");
  });

  it("fails closed when legacy deploy removal fails on the default branch", async () => {
    const harness = start({
      files: {
        ".github/workflows/radius-deploy.yml":
          "on:\n  workflow_run:\n    workflows: [Radius - Verify Credentials]\njobs:\n"
      },
      legacyDeleteResult: false
    });

    const response = await configure({ repo: "octo/app" });
    const body = response.body as Record<string, unknown>;

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(String(body.error)).toContain(
      "could not remove the legacy deploy workflow from the default branch"
    );
    expect(harness.journal).not.toContain("dispatchVerifyWorkflow");
  });

  it("preserves cancellation while removing an unsafe legacy deploy workflow", async () => {
    const harness = start({
      ...protectedScript,
      files: {
        ".github/workflows/radius-deploy.yml":
          "on:\n  workflow_run:\n    workflows: [Radius - Verify Credentials]\njobs:\n"
      },
      legacyDeleteResult: "cancelled"
    });

    const response = await configure({ repo: "octo/app" });
    const body = response.body as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      cancelled: true,
      code: "operation-stopped",
      boundary: "before-legacy-workflow-delete",
      operationId: "op-http"
    });
    expect(body.operation).toMatchObject({ terminalState: "cancelled" });
    expect(harness.failures).toEqual([]);
    expect(harness.journal).not.toContain("dispatchVerifyWorkflow");
  });

  it("persists pull-request provenance before honoring Stop", async () => {
    const harness = start(protectedScript);
    harness.setJournalHook((entry) => {
      if (entry === "stopBoundary:after-workflow-pull-request") {
        harness.operation.stopRequested = true;
      }
    });

    const response = await configure({ repo: "octo/app" });
    const body = response.body as Record<string, unknown>;

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

    const response = await configure({ repo: "octo/app" });
    const body = response.body as Record<string, unknown>;

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
    const recoveryResponse = await configure({ repo: "octo/app" });

    expect(recoveryResponse.status).toBe(202);
    expect(harness.journal).not.toContain("preflightRepoAdmin");
    expect(harness.journal).not.toContain("preflightGhcrPackageWriteAccess");
    expect(harness.journal).not.toContain("bootstrapGHCRStatePackage");
    expect(harness.journal).not.toContain("deleteLegacyDeployWorkflow");
    expect(
      harness.ghCalls.some((call) => call.startsWith("variable set "))
    ).toBe(false);
  });

  it("deletes the legacy deploy workflow on the pull request branch", async () => {
    const harness = start(protectedScript);

    await configure({ repo: "octo/app" });

    expect(harness.journal).toContain("deleteLegacyDeployWorkflow");
    expect(harness.journal).toContain(
      "legacyDeployDeleteBranch:radius/setup-dev-workflows-op-http"
    );
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

    const response = await configure({ repo: "octo/app" });

    expect(response.body).toMatchObject({
      actionRequired: false,
      pullRequestUrl: "https://github.com/octo/app/pull/7",
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
      pullRequestUrl: "https://github.com/octo/app/pull/7"
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

    const response = await configure({ repo: "octo/app" });

    expect(response.body).toMatchObject({ actionRequired: true });
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

    const response = await configure({ repo: "octo/app" });

    expect(response.body).toMatchObject({ actionRequired: false });
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
      harness.steps.indexOf("\u2705 Credential verification dispatched.")
    ).toBeLessThan(
      harness.steps.findIndex((step) => step.includes("is running against"))
    );
  });

  it("prompts for the merge when it does not dispatch", async () => {
    const harness = start({
      ...protectedScript,
      fileReadResults: {
        ".github/workflows/radius-verify-credentials.yml": {
          content: null,
          error: "HTTP 404: Not Found",
          status: 404
        },
        ".github/workflows/run-rad-commands.yml": {
          content: null,
          error: "connection reset",
          status: null
        }
      }
    });

    const response = await configure({ repo: "octo/app" });

    expect(response.body).toMatchObject({ actionRequired: true });
    expect(
      harness.steps.filter((step) => step.startsWith("\u{1F449}"))
    ).toEqual([
      '\u{1F449} Merge the pull request above to put the workflows on "main", then retry credential verification.'
    ]);
    expect(
      harness.steps.some((step) => step.includes("is running against"))
    ).toBe(false);
    expect(
      harness.ghCalls.some((call) => call.startsWith("workflow run "))
    ).toBe(false);
    expect(harness.steps).toContain(
      "⚠️ Setup-branch credential verification is disabled: Radius could not safely inspect the default branch's deploy dispatcher for automatic triggers."
    );
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

    await configure({ repo: "octo/app" });

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

    const response = await configure({ repo: "octo/app" });

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

    const response = await configure({ repo: "octo/app" });

    expect(response.body).toMatchObject({ actionRequired: true });
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
    expect(harness.journal).not.toContain("setupPushOperationMarker:op-http");
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

    const response = await configure({ repo: "octo/app" });

    expect(response.body).toMatchObject({
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

    await configure({ repo: "octo/app" });

    expect(
      harness.steps.filter((step) => step.startsWith("\u{1F449}"))
    ).toEqual([]);
    expect(
      harness.steps.some((step) =>
        step.includes("Merge the pull request above")
      )
    ).toBe(false);
  });

  it("still verifies on the setup branch when opening the pull request fails", async () => {
    const harness = start({
      ...protectedScript,
      pullRequest: { ok: false, stderr: "HTTP 422: already exists" }
    });

    const response = await configure({ repo: "octo/app" });

    expect(response.body).toMatchObject({
      actionRequired: false,
      pullRequestUrl: "",
      pullRequestBranch: null
    });
    expect(harness.commitStates.at(-1)).toEqual({
      mode: "pull_request",
      branch: "radius/setup-dev-workflows-op-http",
      baseBranch: "main",
      pullRequestUrl: null
    });
    expect(
      harness.steps.some((step) =>
        step.includes("could not open a pull request automatically")
      )
    ).toBe(true);
  });
});

describe("environment configuration service: the cancellation gates", () => {
  it("answers 500 and stops touching GitHub when a checkpoint cannot be saved", async () => {
    // Admission persists once and succeeds; the next write is the first
    // checkpoint, which runs immediately after the environment is created.
    // Everything after it must not run. The wording is the shared
    // `persistMutationCheckpoint` helper's ("no further" cloud resources),
    // which is distinct from the admission-time refusal that reports no cloud
    // resources at all.
    const harness = start({ persistRejectsAfter: 3 });

    const response = await configure({ repo: "octo/app" });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error:
        "Radius changed no further cloud resources because it could not save the setup recovery record.",
      code: "operation-persistence-failed"
    });
    expect(harness.journal).toContain(
      "diagnostic:operation-store-write-failed"
    );
    expect(ghCallsExcludingNamespaceClaimLookup(harness.ghCalls)).toEqual([
      "api /repos/octo/app/environments/dev",
      "api /repos/octo/app",
      "api --method PUT /repos/octo/app/environments/dev"
    ]);
  });

  it("persists every completed mutation group on the successful path", async () => {
    const harness = start();

    await configure({ repo: "octo/app" });

    expect(
      harness.journal.filter((entry) => entry === "checkpoint")
    ).toHaveLength(11);
  });

  it("passes every safe boundary in order when no stop is recorded", async () => {
    const harness = start();

    await configure({ repo: "octo/app" });

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
      "stopBoundary:before-workflow-policy-read",
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

    const response = await configure({ repo: "octo/app" });
    const body = response.body as Record<string, unknown>;

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
    expect(ghCallsExcludingNamespaceClaimLookup(harness.ghCalls)).toEqual([]);
    expect(harness.journal).not.toContain("preflightGhcrPackageWriteAccess");
    expect(harness.journal).not.toContain("dispatchVerifyWorkflow");
  });

  // The remaining boundaries, each driven by recording the stop just as the run
  // reaches it. The property under test is the same every time: the write that
  // was already running completes, and nothing after the boundary starts.
  it.each([
    {
      boundary: "before-workflow-policy-read",
      committed: false,
      dispatched: false,
      policyRead: false
    },
    {
      boundary: "before-workflow-commit",
      committed: false,
      dispatched: false,
      policyRead: true
    },
    {
      boundary: "before-verification-dispatch",
      committed: true,
      dispatched: false,
      policyRead: true
    },
    {
      boundary: "after-verification-dispatch",
      committed: true,
      dispatched: true,
      policyRead: true
    }
  ])(
    "honors a stop that arrives as the run reaches the $boundary boundary",
    async ({ boundary, committed, dispatched, policyRead }) => {
      const harness = start();
      harness.setJournalHook((entry) => {
        if (entry === `stopBoundary:${boundary}`)
          harness.operation.stopRequested = true;
      });

      const response = await configure({ repo: "octo/app" });
      const body = response.body as Record<string, unknown>;

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
      expect(
        harness.journal.some((entry) =>
          entry.startsWith("fetchFileFromRepoResult:")
        )
      ).toBe(policyRead);
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

    const response = await configure({ repo: "octo/app" });
    const body = response.body as Record<string, unknown>;

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

    const response = await configure({
      repo: "octo/app",
      profileName: "default"
    });
    const body = response.body as Record<string, unknown>;

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

    const response = await configure({ repo: "octo/app" });
    const body = response.body as Record<string, unknown>;

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

      const response = await configure({
        repo: "octo/app",
        profileName: "default"
      });
      const body = response.body as Record<string, unknown>;

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

    const response = await configure({ repo: "octo/app" });
    const body = response.body as Record<string, unknown>;

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

    const response = await configure({ repo: "octo/app" });
    const body = response.body as Record<string, unknown>;

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

      const response = await configure({ repo: "octo/app" });
      const body = response.body as Record<string, unknown>;

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

    const response = await configure({ repo: "octo/app" });
    const body = response.body as Record<string, unknown>;

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

    const response = await configure({ repo: "octo/app" });
    const body = response.body as Record<string, unknown>;

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

    const response = await configure({ repo: "octo/app" });
    const body = response.body as Record<string, unknown>;

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

    const response = await configure({ repo: "octo/app" });
    const body = response.body as Record<string, unknown>;

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

    const response = await configure({ repo: "octo/app" });
    const body = response.body as Record<string, unknown>;

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

    const response = await configure({ repo: "octo/app" });
    const body = response.body as Record<string, unknown>;

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

    const response = await configure({ repo: "octo/app" });
    const body = response.body as Record<string, unknown>;

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
