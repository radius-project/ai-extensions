import type { BicepParam } from "../../bicep.js";
import type { GitHubJsonRunner } from "../../azure-oidc.js";
import type { CanvasState, DeployErrorKind } from "../../shared.js";
import { ensureDeploymentSecret, startDeployment } from "@radius-project/core";
import { remediationView } from "@radius-project/core/remediations";
import {
  BARE_GH_COMMAND_PRESENTATION,
  displayGhCommand,
  type GhCommandPresentation
} from "../../gh-command-display.js";
import { assertDeployDependencies } from "./deploy-service-dependencies.js";
import {
  needsWorkflowScope,
  shouldRetryWithKeyringCredential
} from "./workflow-credential-fallback.js";

// Second runtime stage of a background deploy: everything between "we have a
// graph" and "a workflow run exists". Branch reachability, the rad commands and
// secret parameters the run needs, publishing and synchronising the workflow
// files, the dispatch itself, and the listing-cache invalidation that follows a
// successful one.
//
// Separated from the run monitor because the failure model is different: every
// path here settles the deploy itself and reports "not dispatched", while the
// monitor's job only begins once a run exists.

export interface DeployDispatchInstanceEntry {
  state: CanvasState;
}

// `code` is `string | number` because that is what the legacy runner produced: a
// spawn failure surfaces a string errno like "ENOENT", and every comparison
// against it is a `=== 0` / `!== 0` check that treats a string as failure.
// `timedOut` is set when the runner's timeout killed the child, so the
// command's outcome is unknown and no credential fallback may re-run it.
export interface DeployCommandResult {
  code: string | number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface DeployCommandOptions {
  env?: NodeJS.ProcessEnv;
}

export interface DeployDispatchDependencies {
  ghCommandPresentation?: GhCommandPresentation;
  // The workflow that actually runs `rad` commands, injected so the file name
  // stays owned by `server.ts`.
  deployWorkflowFile: string;
  // The dispatcher plus provider workflow files a `--ref` dispatch needs on the
  // branch it runs from.
  deployWorkflowFiles: readonly string[];
  branchNotPushedKind: DeployErrorKind;
  // Marks the Azure OIDC preflight refusal below, so the repair guard can tell
  // it apart from a failure the agent could fix by editing the model.
  oidcSubjectMissingKind: DeployErrorKind;
  // A case-only mismatch needs different remediation from a genuinely absent
  // subject: recreating the environment preserves the wrong spelling.
  oidcSubjectCaseMismatchKind: DeployErrorKind;
  getBranchHeadSha(repo: string, branch: string): Promise<string | null>;
  getDefaultBranch(repo: string): Promise<string | null>;
  // Resolves rather than rejects on a non-zero exit, so the caller can inspect
  // stderr and choose the failure message.
  runGh(
    args: string[],
    options?: DeployCommandOptions
  ): Promise<DeployCommandResult>;
  // Like `runGh` but feeds a value (a secret JSON) over stdin so it never lands
  // on the argv/process list.
  runGhWithStdin(
    args: string[],
    stdin: string,
    options?: DeployCommandOptions
  ): Promise<DeployCommandResult>;
  runAz(args: string[]): Promise<DeployCommandResult>;
  runGitHubJson: GitHubJsonRunner;
  readProcessEnv(): NodeJS.ProcessEnv;
  ghCredentialSource(): "injected" | "keyring";
  fetchFileForSelection(
    entry: DeployDispatchInstanceEntry,
    repo: string,
    branch: string,
    repoPath: string
  ): Promise<string | null>;
  appParams(source: string): BicepParam[];
  resolveDeployParams(params: readonly BicepParam[]): Record<string, string>;
  partitionParams(
    params: readonly BicepParam[],
    resolved: Readonly<Record<string, string>>
  ): { secret: Record<string, string>; public: Record<string, string> };
  extractAppName(source: string): string;
  buildDeployRadCommand(
    appFile: string,
    environment: string,
    publicParams: Readonly<Record<string, string>>
  ): string;
  buildAppGraphRadCommand(appName: string): string;
  ensureDeployWorkflowsOnBranch(
    repo: string,
    branch: string,
    environment: string,
    log: (message: string) => void,
    onWorkflowWritten: (file: string) => void
  ): Promise<void>;
  ensureWorkflowsCurrent(
    repo: string,
    environment: string,
    provider: string,
    only: string[],
    workingBranch: string
  ): Promise<{ created: readonly string[]; updated: readonly string[] }>;
  // Suspends for `ms` so a dispatch can wait out GitHub's workflow
  // registration delay (#767: a just-authored/updated workflow file 404s on
  // `gh workflow run` for a short window after it is committed, because
  // GitHub has not finished indexing it).
  sleep(ms: number): Promise<void>;
  isCurrent(): boolean;
  // Reads the newest existing run id for the deploy workflow so a baseline can
  // be captured immediately before dispatch. Null means an empty successful list;
  // failed or malformed reads must reject rather than erase this evidence.
  latestWorkflowRunId(
    repo: string,
    workflowFile: string
  ): Promise<number | string | null>;
  classifyDeployDispatchFailure(stderr: string): DeployErrorKind;
  // Generator-owned paths with uncommitted changes in the session worktree, as
  // allowlisted tokens. Injected because a branch-not-pushed failure has to tell
  // the user to commit the generated model before pushing it; a bare push would
  // publish the branch without the files the run needs. Resolves to an empty
  // list when nothing is pending or the worktree cannot be read.
  uncommittedGeneratedPaths(
    entry: DeployDispatchInstanceEntry
  ): Promise<readonly string[]>;
  invalidateDeployListCache(repo: string): void;
  errorMessage(error: unknown): string;
  now(): number;
}

export interface DeployDispatchRequest {
  entry: DeployDispatchInstanceEntry;
  repo: string;
  branch: string;
  provider: string;
  // The environment exactly as the request carried it. The resolved environment
  // already sits on the instance state and wins; this is only the fallback.
  requestedEnvironment: unknown;
  log(message: string): void;
}

export type DeployDispatchOutcome =
  | { dispatched: false }
  | {
      dispatched: true;
      workflowFile: string;
      dispatchedAt: number;
      environment: string;
      // Newest run id that existed just before this dispatch, so the run
      // monitor can identify the run this dispatch created as the first one
      // whose id exceeds it, rather than matching a prior run by time window.
      // Null when the baseline could not be read.
      baselineRunId: number | string | null;
    };

export interface DeployDispatchService {
  prepareAndDispatch(
    request: DeployDispatchRequest
  ): Promise<DeployDispatchOutcome>;
}

const REQUIRED_DEPENDENCIES: readonly (keyof DeployDispatchDependencies)[] = [
  "getBranchHeadSha",
  "getDefaultBranch",
  "runGh",
  "runGhWithStdin",
  "runAz",
  "runGitHubJson",
  "readProcessEnv",
  "ghCredentialSource",
  "fetchFileForSelection",
  "appParams",
  "resolveDeployParams",
  "partitionParams",
  "extractAppName",
  "buildDeployRadCommand",
  "buildAppGraphRadCommand",
  "ensureDeployWorkflowsOnBranch",
  "ensureWorkflowsCurrent",
  "sleep",
  "isCurrent",
  "latestWorkflowRunId",
  "classifyDeployDispatchFailure",
  "uncommittedGeneratedPaths",
  "invalidateDeployListCache",
  "errorMessage",
  "now"
];

// Exported so the opt-in `az` contract test can drive the real argument list.
// `az ad app federated-credential list` accepts only `--id` plus global args —
// adding a scoping flag such as `--tenant` makes it exit with "unrecognized
// arguments", which would silently turn the preflight into a permanent no-op.
export function buildFederatedCredentialListArgs(clientId: string): string[] {
  return [
    "ad",
    "app",
    "federated-credential",
    "list",
    "--id",
    clientId,
    "--query",
    "[].subject",
    "-o",
    "json"
  ];
}

export function createDeployDispatchService(
  dependencies: DeployDispatchDependencies
): DeployDispatchService {
  assertDeployDependencies(
    "createDeployDispatchService",
    dependencies,
    REQUIRED_DEPENDENCIES
  );
  if (!dependencies.deployWorkflowFile) {
    throw new Error(
      "createDeployDispatchService is missing required dependencies: deployWorkflowFile"
    );
  }
  if (!dependencies.branchNotPushedKind) {
    throw new Error(
      "createDeployDispatchService is missing required dependencies: branchNotPushedKind"
    );
  }
  // Not covered by REQUIRED_DEPENDENCIES because it is a string rather than a
  // function. Omitting it would leave deployErrorKind undefined on a preflight
  // refusal, and the repair guard would open a repair loop on a failure no model
  // edit can fix — the exact outcome this kind exists to prevent.
  if (!dependencies.oidcSubjectMissingKind) {
    throw new Error(
      "createDeployDispatchService is missing required dependencies: oidcSubjectMissingKind"
    );
  }
  if (!dependencies.oidcSubjectCaseMismatchKind) {
    throw new Error(
      "createDeployDispatchService is missing required dependencies: oidcSubjectCaseMismatchKind"
    );
  }
  if (
    !Array.isArray(dependencies.deployWorkflowFiles) ||
    dependencies.deployWorkflowFiles.length === 0
  ) {
    throw new Error(
      "createDeployDispatchService is missing required dependencies: deployWorkflowFiles"
    );
  }

  // The injected OAuth token often lacks the `workflow` scope, so a failure that
  // names that missing scope is retried once with the token stripped and gh
  // falls back to the keyring credential. Every other failure keeps its own
  // error: retrying it would run the command as whichever account is active
  // machine-wide, which is not the account the rest of the deploy acts as. A
  // timed-out command is never retried — GitHub may already have accepted it.
  // Once retried, the second command owns the outcome; retaining the first
  // rejection would hide a later timeout or transport failure.
  const withStrippedToken = async (
    first: DeployCommandResult,
    retry: (env: NodeJS.ProcessEnv) => Promise<DeployCommandResult>
  ): Promise<{
    result: DeployCommandResult;
    credentialSource: "injected" | "keyring";
  }> => {
    const env = dependencies.readProcessEnv();
    const firstCredentialSource = dependencies.ghCredentialSource();
    const hasInjectedToken = Boolean(
      env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim()
    );
    const retryAllowed =
      firstCredentialSource === "injected" &&
      shouldRetryWithKeyringCredential({
        stderr: first.stderr,
        timedOut: first.timedOut,
        hasInjectedToken
      });
    if (!retryAllowed || !dependencies.isCurrent())
      return { result: first, credentialSource: firstCredentialSource };
    const fallbackEnv = { ...env };
    delete fallbackEnv.GH_TOKEN;
    delete fallbackEnv.GITHUB_TOKEN;
    const second = await retry(fallbackEnv);
    return { result: second, credentialSource: "keyring" };
  };

  // Ensure the environment carries the secret params the deployed app.bicep
  // needs (an @secure() password, say). The workflow can ONLY read these from
  // the RADIUS_DEPLOY_PARAMS secret — unlike the public rad commands they
  // cannot be passed inline as a dispatch input — so if the secret is absent
  // the deploy fails for a missing required parameter. Env creation seeds it,
  // but that step is skipped when app.bicep is not present yet, so reconcile
  // here. An existing secret is left untouched so an auto-generated value stays
  // stable across redeploys (it cannot be read back to compare).
  const provisionSecretParams = async (
    repo: string,
    environment: string,
    secretParams: Readonly<Record<string, string>>,
    log: (message: string) => void
  ): Promise<string | null> => {
    const outcome = await ensureDeploymentSecret(
      { repo, environment },
      secretParams,
      {
        isCurrent: dependencies.isCurrent,
        errorMessage: dependencies.errorMessage,
        log,
        readNames: async (target) => {
          const r = await dependencies.runGh([
            "api",
            `/repos/${target.repo}/environments/${encodeURIComponent(
              target.environment
            )}/secrets`,
            "--paginate",
            "--slurp"
          ]);
          if (r.code !== 0 || r.timedOut) {
            throw new Error(
              r.stderr.trim() || "Environment secret listing failed."
            );
          }
          const response: unknown = JSON.parse(r.stdout);
          if (!Array.isArray(response) || response.length === 0) {
            throw new Error("Environment secret listing is malformed.");
          }
          const names: string[] = [];
          const pages: unknown[] = response;
          for (const page of pages) {
            if (
              !page ||
              typeof page !== "object" ||
              !("secrets" in page) ||
              !Array.isArray(page.secrets)
            ) {
              throw new Error("Environment secret listing is malformed.");
            }
            const secrets: unknown[] = page.secrets;
            for (const secret of secrets) {
              if (
                !secret ||
                typeof secret !== "object" ||
                !("name" in secret) ||
                typeof secret.name !== "string" ||
                !/^[A-Za-z_][A-Za-z0-9_]*$/.test(secret.name)
              ) {
                throw new Error("Environment secret listing is malformed.");
              }
              names.push(secret.name);
            }
          }
          return names;
        },
        write: async (target, parameters) => {
          const setArgs = [
            "secret",
            "set",
            "RADIUS_DEPLOY_PARAMS",
            "--env",
            target.environment,
            "--repo",
            target.repo
          ];
          const payload = JSON.stringify(parameters);
          // No credential fallback here. Writing a repository secret as whichever
          // account happens to be active machine-wide is a silent identity change for
          // a credential-bearing write, and the failures a secret write actually
          // produces ("Resource not accessible…", 403, 404) never identify a missing
          // `workflow` scope, so a retry could not be justified by the diagnostic
          // either. The real error is surfaced with the account guidance instead.
          const setRes = await dependencies.runGhWithStdin(setArgs, payload);
          if (setRes.code !== 0 || setRes.timedOut) {
            const env = dependencies.readProcessEnv();
            const accountHint =
              env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() ?
                " The Copilot session token may not be allowed to write this repository's environment secrets; pick the GitHub account to act as in the Create Environment dialog, then retry."
              : "";
            throw new Error(
              ((setRes.stderr || "").trim() || "unknown error") + accountHint
            );
          }
        }
      }
    );
    if (outcome.kind !== "ready") {
      log("❌ " + outcome.message);
      return outcome.message;
    }
    return null;
  };

  // Both branch-not-pushed paths (the pre-dispatch remote check and the "No ref
  // found" dispatch failure) report the same blocker, so they share one message
  // builder. It is the single place that decides whether the guidance is a bare
  // push or a commit-then-push, which is what keeps the two paths from drifting
  // into telling the user different things about the same worktree.
  const reportBranchNotPushed = async (
    entry: DeployDispatchInstanceEntry,
    repo: string,
    deployRef: string,
    kind: DeployErrorKind,
    log: (message: string) => void
  ): Promise<void> => {
    const paths = await dependencies.uncommittedGeneratedPaths(entry);
    if (!dependencies.isCurrent()) return;
    const dirty = paths.length > 0;
    const remediation = remediationView("git-push-branch", {
      branch: deployRef,
      currentBranch: entry.state.workspaceBranch ?? "",
      paths: paths.join(",")
    });
    const steps = remediation.runnable ? remediation.command : "";
    log('❌ Branch "' + deployRef + '" has not been pushed to ' + repo + ".");
    if (dirty) {
      log(
        "   Generated files are not committed yet: " +
          paths.join(", ") +
          " — pushing alone would not publish them."
      );
    }
    log(
      remediation.runnable ?
        (dirty ?
          "   Commit and push, then redeploy:  "
        : "   Push it and redeploy:  ") + steps
      : `   ${remediation.unsupportedReason}`
    );
    entry.state.deployError =
      'The branch "' +
      deployRef +
      "\" hasn't been pushed to " +
      repo +
      " yet, so there's nothing on GitHub to deploy." +
      (!remediation.runnable ? ` ${remediation.unsupportedReason}`
      : dirty ?
        " The generated Radius files (" +
        paths.join(", ") +
        ") are not committed either, so pushing on its own would not publish " +
        "them. Commit them and push, then try again:\n\n    "
      : " Push it and try again:\n\n    ") +
      steps;
    entry.state.deployErrorKind = kind;
    entry.state.deployErrorBranch = deployRef;
    entry.state.deployErrorPaths = paths.join(",");
    entry.state.deployStatus = "failed";
  };

  return {
    async prepareAndDispatch(request) {
      const { entry, repo, branch, provider, requestedEnvironment, log } =
        request;
      if (!dependencies.isCurrent()) return { dispatched: false };
      delete entry.state.deployDispatchReference;
      delete entry.state.deployDispatchEvidence;
      log("━━ Deploying Radius application ━━");
      const envForDeploy =
        entry.state.envName ||
        (typeof requestedEnvironment === "string" ? requestedEnvironment : (
          ""
        )) ||
        "dev";
      // Persist the resolved environment so the deployed-graph reader (GHCR
      // artifact tag) can be rebuilt from state later.
      entry.state.deployEnvName = envForDeploy;
      const deployWorkflowFile = dependencies.deployWorkflowFile;
      // Deploy the SELECTED branch's code (worktree-consistent): run the
      // workflow on `branch` so it checks out and `rad deploy`s that branch's
      // app.bicep — the same file the params below are computed from — instead
      // of always deploying the default branch. `branch` is already resolved to
      // the selected branch or the repo's real default, so it is never empty.
      const deployRef = branch;

      const requestedFile = entry.state.deployParams?.appFile;
      const started = await startDeployment(
        {
          repo,
          branch: deployRef,
          environment: envForDeploy,
          workflowFile: deployWorkflowFile,
          provider,
          // Both legacy clients synthesize this default even for root-only apps.
          appFile:
            requestedFile === ".radius/app.bicep" ? undefined : requestedFile
        },
        {
          isCurrent: dependencies.isCurrent,
          errorMessage: dependencies.errorMessage,
          branch: {
            head: dependencies.getBranchHeadSha,
            defaultBranch: dependencies.getDefaultBranch
          },
          azure: {
            readGitHub: dependencies.runGitHubJson,
            readSubjects: (clientId) =>
              dependencies.runAz(buildFederatedCredentialListArgs(clientId))
          },
          commands: {
            readFile: (target, path) =>
              dependencies.fetchFileForSelection(
                entry,
                target.repo,
                target.branch,
                path
              ),
            parameters: (source) => {
              const parsed = dependencies.appParams(source);
              return dependencies.partitionParams(
                parsed,
                dependencies.resolveDeployParams(parsed)
              );
            },
            applicationName: dependencies.extractAppName,
            deployCommand: dependencies.buildDeployRadCommand,
            graphCommand: dependencies.buildAppGraphRadCommand,
            ensureSecret: (parameters) =>
              provisionSecretParams(repo, envForDeploy, parameters, log)
          },
          publication: {
            publish: (target, written) =>
              dependencies.ensureDeployWorkflowsOnBranch(
                target.repo,
                target.branch,
                target.environment,
                log,
                written
              ),
            synchronize: (target) =>
              dependencies.ensureWorkflowsCurrent(
                target.repo,
                target.environment,
                provider,
                [...dependencies.deployWorkflowFiles],
                target.branch
              )
          },
          dispatch: {
            latestRunId: () =>
              dependencies.latestWorkflowRunId(repo, deployWorkflowFile),
            sleep: dependencies.sleep,
            now: dependencies.now,
            dispatch: async (target, commands) => {
              const args = [
                "workflow",
                "run",
                target.workflowFile,
                "--ref",
                target.branch,
                "-f",
                "environment=" + target.environment,
                "--repo",
                target.repo,
                "-f",
                "rad_commands=" + JSON.stringify(commands)
              ];
              const result = await dependencies.runGh(args);
              return result.code === 0 ?
                  {
                    result,
                    credentialSource: dependencies.ghCredentialSource()
                  }
                : withStrippedToken(result, (env) =>
                    dependencies.runGh(args, { env })
                  );
            }
          },
          onCommands: (application, commands) => {
            entry.state.deployAppName =
              application || entry.state.deployAppName || "";
            log("Deploying with rad commands: " + commands.join("  |  "));
          },
          onAzureNote: (status, message) =>
            log((status === "unverified" ? "⚠ " : "• ") + message),
          onDispatchReady: (target) =>
            log(
              "🚀 Dispatching run rad commands workflow (" +
                target.workflowFile +
                ') on branch "' +
                target.branch +
                '" for environment "' +
                target.environment +
                '"...'
            )
        }
      );
      if (!dependencies.isCurrent() || started.kind === "cancelled")
        return { dispatched: false };
      if (started.kind === "refused") {
        if (started.reason === "branch-not-pushed") {
          await reportBranchNotPushed(
            entry,
            repo,
            deployRef,
            dependencies.branchNotPushedKind,
            log
          );
          return { dispatched: false };
        }
        entry.state.deployError = started.message;
        entry.state.deployErrorKind =
          started.reason === "oidc-subject-missing" ?
            dependencies.oidcSubjectMissingKind
          : started.reason === "oidc-subject-case-mismatch" ?
            dependencies.oidcSubjectCaseMismatchKind
          : "dispatch-refused";
        if (started.reason === "preparation")
          entry.state.deployDispatchEvidence = "refused";
        entry.state.deployStatus = "failed";
        log("❌ " + started.message);
        return { dispatched: false };
      }
      const { evidence, recentlyPublished: justCreatedDispatcher } = started;
      entry.state.deployDispatchEvidence = evidence.kind;
      if (!("reference" in evidence)) {
        entry.state.deployError =
          "Deployment was not dispatched: " + evidence.message;
        entry.state.deployErrorKind = "dispatch-refused";
        entry.state.deployStatus = "failed";
        log("❌ " + entry.state.deployError);
        return { dispatched: false };
      }
      entry.state.deployDispatchReference = evidence.reference;
      if (evidence.kind !== "accepted") {
        const dispatchDeployRes: DeployCommandResult = evidence.command
          ?.result ?? {
          code: "unknown",
          stdout: "",
          stderr: evidence.message
        };
        const dispatchCredentialSource =
          evidence.command?.credentialSource ??
          dependencies.ghCredentialSource();
        const de = (dispatchDeployRes.stderr || "").trim();
        log("❌ Failed to dispatch the run rad commands workflow: " + de);
        // A "No ref found" (or unresolved ref) dispatch error means the branch
        // is not on the remote — surface the same clean, actionable "push the
        // branch" guidance. Every other dispatch failure is a run of unknown
        // outcome, so the split is made once, where it can be tested.
        const dispatchKind =
          evidence.kind === "uncertain" ?
            "run-unconfirmed"
          : dependencies.classifyDeployDispatchFailure(de);
        if (dispatchKind === dependencies.branchNotPushedKind) {
          await reportBranchNotPushed(
            entry,
            repo,
            deployRef,
            dispatchKind,
            log
          );
          return { dispatched: false };
        }
        const ghCommandPresentation =
          dependencies.ghCommandPresentation || BARE_GH_COMMAND_PRESENTATION;
        const refreshCommand = displayGhCommand(ghCommandPresentation, [
          "auth",
          "refresh",
          "-h",
          "github.com",
          "-s",
          "workflow"
        ]);
        const installation =
          ghCommandPresentation.installationNote ?
            ` ${ghCommandPresentation.installationNote}`
          : "";
        const scopeHint =
          needsWorkflowScope(de) && dispatchCredentialSource === "injected" ?
            ' The Copilot session token is missing the "workflow" scope and `gh auth refresh` cannot change it. Authenticate a stored GitHub CLI account with the workflow scope, or restart with a session token that includes it, then retry.'
          : needsWorkflowScope(de) ?
            refreshCommand ?
              ` Your stored GitHub CLI credential is missing the "workflow" scope. Run \`${refreshCommand}\` in a terminal, then retry.${installation}`
            : ` Your stored GitHub CLI credential is missing the "workflow" scope. ${ghCommandPresentation.installationNote}`
          : (
            justCreatedDispatcher &&
            !dispatchDeployRes.timedOut &&
            /not found|HTTP 404/i.test(de)
          ) ?
            " " +
            deployWorkflowFile +
            " was committed to " +
            repo +
            " and GitHub may still be registering it. Radius already waited and retried; wait a little longer and redeploy. If the error persists, confirm " +
            deployWorkflowFile +
            ' exists on branch "' +
            deployRef +
            '" and that GitHub Actions are enabled for ' +
            repo +
            "."
          : " Ensure " +
            deployWorkflowFile +
            ' exists on branch "' +
            deployRef +
            '" (push the branch so it carries the app.bicep and workflow files) and that GitHub Actions are enabled for ' +
            repo +
            ".";
        entry.state.deployError =
          "Failed to start the run rad commands workflow (" +
          deployWorkflowFile +
          ") on " +
          repo +
          ". " +
          (de || "The dispatch request failed.") +
          scopeHint;
        entry.state.deployErrorKind =
          evidence.kind === "refused" ? "dispatch-refused" : dispatchKind;
        entry.state.deployStatus = "failed";
        return { dispatched: false };
      }
      log("✅ Run rad commands workflow dispatched.");
      // A new deploy is in flight, so any cached deployments listing is stale —
      // drop it so the deploy page reflects the new run on the next poll.
      dependencies.invalidateDeployListCache(repo);
      return {
        dispatched: true,
        workflowFile: deployWorkflowFile,
        dispatchedAt: evidence.reference.dispatchedAt,
        environment: envForDeploy,
        baselineRunId: evidence.reference.baselineRunId
      };
    }
  };
}
