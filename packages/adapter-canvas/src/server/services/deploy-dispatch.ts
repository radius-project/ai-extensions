import type { BicepParam } from "../../bicep.js";
import type { CanvasState, DeployErrorKind } from "../../shared.js";
import { assertDeployDependencies } from "./deploy-service-dependencies.js";

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
export interface DeployCommandResult {
  code: string | number;
  stdout: string;
  stderr: string;
}

export interface DeployCommandOptions {
  env?: NodeJS.ProcessEnv;
}

export interface DeployDispatchDependencies {
  // The workflow that actually runs `rad` commands, injected so the file name
  // stays owned by `server.ts`.
  deployWorkflowFile: string;
  // The dispatcher plus provider workflow files a `--ref` dispatch needs on the
  // branch it runs from.
  deployWorkflowFiles: readonly string[];
  branchNotPushedKind: DeployErrorKind;
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
  readProcessEnv(): NodeJS.ProcessEnv;
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
    log: (message: string) => void
  ): Promise<void>;
  ensureWorkflowsCurrent(
    repo: string,
    environment: string,
    provider: string,
    only: string[],
    workingBranch: string
  ): Promise<unknown>;
  classifyDeployDispatchFailure(stderr: string): DeployErrorKind;
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
  "readProcessEnv",
  "fetchFileForSelection",
  "appParams",
  "resolveDeployParams",
  "partitionParams",
  "extractAppName",
  "buildDeployRadCommand",
  "buildAppGraphRadCommand",
  "ensureDeployWorkflowsOnBranch",
  "ensureWorkflowsCurrent",
  "classifyDeployDispatchFailure",
  "invalidateDeployListCache",
  "errorMessage",
  "now"
];

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
  if (
    !Array.isArray(dependencies.deployWorkflowFiles) ||
    dependencies.deployWorkflowFiles.length === 0
  ) {
    throw new Error(
      "createDeployDispatchService is missing required dependencies: deployWorkflowFiles"
    );
  }

  // The injected OAuth token often lacks the `workflow` scope (and the scope to
  // write environment secrets), so a failure is retried once with it stripped
  // and gh falls back to the keyring credential. Only an improvement is kept.
  const withStrippedToken = async (
    first: DeployCommandResult,
    retry: (env: NodeJS.ProcessEnv) => Promise<DeployCommandResult>
  ): Promise<DeployCommandResult> => {
    const env = dependencies.readProcessEnv();
    if (!(env.GH_TOKEN || env.GITHUB_TOKEN)) return first;
    const fallbackEnv = { ...env };
    delete fallbackEnv.GH_TOKEN;
    delete fallbackEnv.GITHUB_TOKEN;
    const second = await retry(fallbackEnv);
    return second.code === 0 ? second : first;
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
    secretParams: Record<string, string>,
    log: (message: string) => void
  ): Promise<string | null> => {
    const deployParamsPresent = async (): Promise<boolean> => {
      const r = await dependencies.runGh([
        "api",
        `/repos/${repo}/environments/${encodeURIComponent(
          environment
        )}/secrets`,
        "--jq",
        ".secrets[].name"
      ]);
      return (r.stdout || "")
        .split("\n")
        .map((s) => s.trim())
        .includes("RADIUS_DEPLOY_PARAMS");
    };
    if (await deployParamsPresent()) return null;
    const names = Object.keys(secretParams).join(", ");
    log(
      'Provisioning RADIUS_DEPLOY_PARAMS for "' +
        environment +
        '" (' +
        names +
        ")..."
    );
    const setArgs = [
      "secret",
      "set",
      "RADIUS_DEPLOY_PARAMS",
      "--env",
      environment,
      "--repo",
      repo
    ];
    const payload = JSON.stringify(secretParams);
    let setRes = await dependencies.runGhWithStdin(setArgs, payload);
    if (setRes.code !== 0) {
      setRes = await withStrippedToken(setRes, (env) =>
        dependencies.runGhWithStdin(setArgs, payload, { env })
      );
    }
    if (setRes.code !== 0) {
      const failure =
        'Could not provision RADIUS_DEPLOY_PARAMS on environment "' +
        environment +
        '": ' +
        ((setRes.stderr || "").trim() || "unknown error") +
        ". The deploy would fail for a missing required parameter (" +
        names +
        "), so it was not started.";
      log("❌ " + failure);
      return failure;
    }
    if (!(await deployParamsPresent())) {
      const failure =
        'RADIUS_DEPLOY_PARAMS was accepted but is not present on environment "' +
        environment +
        '". The deploy would fail for a missing required parameter (' +
        names +
        "), so it was not started.";
      log("❌ " + failure);
      return failure;
    }
    log('✅ RADIUS_DEPLOY_PARAMS is set on "' + environment + '".');
    return null;
  };

  // Recompute the rad commands from the CURRENT app.bicep at dispatch time
  // (rather than relying on the RADIUS_RAD_COMMANDS variable captured when the
  // environment was created) so the deploy always reflects the latest bicep.
  // `rad app graph` is appended so the deployed application graph is rendered
  // as part of the run.
  const appendRadCommands = async (
    request: DeployDispatchRequest,
    environment: string,
    dispatchArgs: string[]
  ): Promise<string | null> => {
    const { entry, repo, branch, log } = request;
    let secretError: string | null = null;
    try {
      let bicepPath = ".radius/app.bicep";
      let bicepSource = await dependencies.fetchFileForSelection(
        entry,
        repo,
        branch,
        ".radius/app.bicep"
      );
      if (!bicepSource) {
        bicepSource = await dependencies.fetchFileForSelection(
          entry,
          repo,
          branch,
          "app.bicep"
        );
        if (bicepSource) bicepPath = "app.bicep";
      }
      if (!bicepSource) {
        log(
          "⚠ Could not read app.bicep at dispatch; falling back to the environment's RADIUS_RAD_COMMANDS / default deploy."
        );
        return null;
      }
      const parsed = dependencies.appParams(bicepSource);
      const resolved = dependencies.resolveDeployParams(parsed);
      const { public: publicParams, secret: secretParams } =
        dependencies.partitionParams(parsed, resolved);
      // Capture the app name so the deploy-status reader can prefer an artifact
      // belonging to this application. It is a tiebreaker between artifacts in
      // the same environment, never a lookup key and never a hard filter, so an
      // unresolved name costs nothing.
      entry.state.deployAppName =
        dependencies.extractAppName(bicepSource) ||
        entry.state.deployAppName ||
        "";
      if (Object.keys(secretParams).length > 0) {
        secretError = await provisionSecretParams(
          repo,
          environment,
          secretParams,
          log
        );
      }
      const deployCmd = dependencies.buildDeployRadCommand(
        bicepPath,
        environment,
        publicParams
      );
      const appName = dependencies.extractAppName(bicepSource);
      const commands = [deployCmd];
      if (appName) commands.push(dependencies.buildAppGraphRadCommand(appName));
      dispatchArgs.push("-f", "rad_commands=" + JSON.stringify(commands));
      log("Deploying with rad commands: " + commands.join("  |  "));
      return secretError;
    } catch (e) {
      log(
        "⚠ Could not compute rad commands from bicep (" +
          dependencies.errorMessage(e) +
          "); falling back to the environment default."
      );
      return secretError;
    }
  };

  // Fail fast (with clear, actionable guidance) when the selected branch has
  // not been pushed to the remote yet. A worktree/feature branch that only
  // exists locally has no ref on GitHub, so both publishing the workflow files
  // and dispatching against `--ref <branch>` are doomed. The repo itself is
  // confirmed reachable (its default branch resolves) before blaming the
  // branch, so a transient/auth error is not misreported as "not pushed".
  const branchIsMissingOnRemote = async (
    repo: string,
    deployRef: string
  ): Promise<boolean> => {
    if (!deployRef) return false;
    const refSha = await dependencies.getBranchHeadSha(repo, deployRef);
    if (refSha) return false;
    const repoDefault = await dependencies.getDefaultBranch(repo);
    return !!repoDefault;
  };

  return {
    async prepareAndDispatch(request) {
      const { entry, repo, branch, provider, requestedEnvironment, log } =
        request;
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

      if (await branchIsMissingOnRemote(repo, deployRef)) {
        const pushCmd = "git push -u origin " + deployRef;
        log(
          '❌ Branch "' + deployRef + '" has not been pushed to ' + repo + "."
        );
        log("   Push it and redeploy:  " + pushCmd);
        entry.state.deployError =
          'The branch "' +
          deployRef +
          "\" hasn't been pushed to " +
          repo +
          " yet, so there's nothing on GitHub to deploy. Push it and try again:\n\n    " +
          pushCmd;
        entry.state.deployErrorKind = dependencies.branchNotPushedKind;
        entry.state.deployErrorBranch = deployRef;
        entry.state.deployStatus = "failed";
        return { dispatched: false };
      }

      const dispatchArgs = [
        "workflow",
        "run",
        deployWorkflowFile,
        "--ref",
        deployRef,
        "-f",
        "environment=" + envForDeploy,
        "--repo",
        repo
      ];
      const deploySecretError = await appendRadCommands(
        request,
        envForDeploy,
        dispatchArgs
      );
      // A required secret param could not be provisioned, so starting the run
      // would only produce a guaranteed `rad deploy` failure. Surface the
      // reason and stop before dispatching.
      if (deploySecretError) {
        entry.state.deployError = deploySecretError;
        entry.state.deployStatus = "failed";
        return { dispatched: false };
      }

      // Make sure the workflow files exist on the branch we are about to
      // dispatch on. The env-creation flow only commits them to the default
      // branch, so a feature/worktree branch usually needs them published.
      try {
        await dependencies.ensureDeployWorkflowsOnBranch(
          repo,
          deployRef,
          envForDeploy,
          log
        );
      } catch (e) {
        log(
          '⚠ Could not publish deploy workflows to branch "' +
            deployRef +
            '": ' +
            dependencies.errorMessage(e) +
            ". The dispatch below will fail if the branch has no run-rad-commands workflow."
        );
      }

      // With the deploy workflows present, ensure they are in sync with the
      // upstream Radius templates before running them, so the deploy never
      // executes a drifted copy. Syncs the deploy files on both the default
      // branch and the branch being deployed, which a --ref dispatch checks out.
      await dependencies.ensureWorkflowsCurrent(
        repo,
        envForDeploy,
        provider,
        [...dependencies.deployWorkflowFiles],
        deployRef
      );

      const deployDispatchedAt = dependencies.now();
      log(
        "🚀 Dispatching run rad commands workflow (" +
          deployWorkflowFile +
          ') on branch "' +
          deployRef +
          '" for environment "' +
          envForDeploy +
          '"...'
      );
      let dispatchDeployRes = await dependencies.runGh(dispatchArgs);
      if (dispatchDeployRes.code !== 0) {
        dispatchDeployRes = await withStrippedToken(dispatchDeployRes, (env) =>
          dependencies.runGh(dispatchArgs, { env })
        );
      }
      if (dispatchDeployRes.code !== 0) {
        const de = (dispatchDeployRes.stderr || "").trim();
        log("❌ Failed to dispatch the run rad commands workflow: " + de);
        // A "No ref found" (or unresolved ref) dispatch error means the branch
        // is not on the remote — surface the same clean, actionable "push the
        // branch" guidance. Every other dispatch failure is a run of unknown
        // outcome, so the split is made once, where it can be tested.
        const dispatchKind = dependencies.classifyDeployDispatchFailure(de);
        if (dispatchKind === dependencies.branchNotPushedKind) {
          const pushCmd = "git push -u origin " + deployRef;
          log("   Push it and redeploy:  " + pushCmd);
          entry.state.deployError =
            'The branch "' +
            deployRef +
            "\" hasn't been pushed to " +
            repo +
            " yet, so there's nothing on GitHub to deploy. Push it and try again:\n\n    " +
            pushCmd;
          entry.state.deployErrorKind = dispatchKind;
          entry.state.deployErrorBranch = deployRef;
          entry.state.deployStatus = "failed";
          return { dispatched: false };
        }
        const scopeHint =
          /workflow.{0,20}scope/i.test(de) ?
            ' Your GitHub token is missing the "workflow" scope. Run `gh auth refresh -h github.com -s workflow` in a terminal, then retry.'
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
        entry.state.deployErrorKind = dispatchKind;
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
        dispatchedAt: deployDispatchedAt,
        environment: envForDeploy
      };
    }
  };
}
