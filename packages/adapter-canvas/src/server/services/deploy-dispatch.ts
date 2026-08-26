import type { BicepParam } from "../../bicep.js";
import {
  resolveOidcSubject,
  type GitHubJsonRunner,
  type ResolveOidcSubjectResult
} from "../../azure-oidc.js";
import type { CanvasState, DeployErrorKind } from "../../shared.js";
import { buildEnvironmentSuffix } from "@radius-project/core/platforms";
import { remediationView } from "@radius-project/core/remediations";
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
    log: (message: string) => void
  ): Promise<void>;
  ensureWorkflowsCurrent(
    repo: string,
    environment: string,
    provider: string,
    only: string[],
    workingBranch: string
  ): Promise<unknown>;
  // Reads the newest existing run id for the deploy workflow so a baseline can
  // be captured immediately before dispatch. Resolves to null on any read
  // failure, in which case run discovery falls back to its time window.
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
  // Only an improvement is kept.
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
    const retryAllowed = shouldRetryWithKeyringCredential({
      stderr: first.stderr,
      timedOut: first.timedOut,
      hasInjectedToken
    });
    if (!retryAllowed)
      return { result: first, credentialSource: firstCredentialSource };
    const fallbackEnv = { ...env };
    delete fallbackEnv.GH_TOKEN;
    delete fallbackEnv.GITHUB_TOKEN;
    const second = await retry(fallbackEnv);
    return second.code === 0 ?
        { result: second, credentialSource: "keyring" }
      : { result: first, credentialSource: firstCredentialSource };
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
    // No credential fallback here. Writing a repository secret as whichever
    // account happens to be active machine-wide is a silent identity change for
    // a credential-bearing write, and the failures a secret write actually
    // produces ("Resource not accessible…", 403, 404) never identify a missing
    // `workflow` scope, so a retry could not be justified by the diagnostic
    // either. The real error is surfaced with the account guidance instead.
    const setRes = await dependencies.runGhWithStdin(setArgs, payload);
    if (setRes.code !== 0) {
      const env = dependencies.readProcessEnv();
      const accountHint =
        env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() ?
          " The Copilot session token may not be allowed to write this repository's environment secrets; pick the GitHub account to act as in the Create Environment dialog, then retry."
        : "";
      const failure =
        'Could not provision RADIUS_DEPLOY_PARAMS on environment "' +
        environment +
        '": ' +
        ((setRes.stderr || "").trim() || "unknown error") +
        ". The deploy would fail for a missing required parameter (" +
        names +
        "), so it was not started." +
        accountHint;
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

  // The preflight answers one of five things, and the difference matters more
  // than the check itself:
  //
  // - "covered": every subject GitHub could mint has a federated credential.
  // - "skipped": the environment deliberately has no Azure login to check.
  // - "missing": we got a definitive answer from GitHub and Azure and NOT ONE of
  //   the possible subjects is present. The workflow could only fail its login,
  //   so refusing here is strictly better than a late AADSTS700213 (also written
  //   AADSTS7002138 in some Entra responses).
  // - "case-mismatch": no exact subject exists, but credentials differ only by
  //   casing. Re-running environment creation preserves that mismatch, so this
  //   needs distinct manual remediation, and it reports every mis-cased subject
  //   so fixing them all takes one pass.
  // - "unverified": we could not complete the check, or coverage is partial.
  //   This dispatches with a warning rather than blocking. Blocking here would
  //   regress every user whose deploy works today but whose machine cannot run
  //   the check — `az` is not otherwise required to deploy, since the workflow
  //   authenticates in Actions, not locally. Partial coverage is in the same
  //   bucket: when GitHub's effective default subject format is indeterminate
  //   the resolver returns both the mutable and immutable forms, and only one of
  //   them will ever be presented, so holding just one is not proof of failure.
  type AzureFederatedCredentialValidation =
    | { status: "covered" }
    | { status: "skipped"; message: string }
    | { status: "missing"; message: string }
    | { status: "case-mismatch"; message: string }
    | { status: "unverified"; message: string };

  const validationUnverified = (
    environment: string,
    reason: string
  ): AzureFederatedCredentialValidation => ({
    status: "unverified",
    message:
      `Could not verify Azure federated credential coverage for environment "${environment}": ${reason}. ` +
      "Deploying anyway — if the workflow fails to log in to Azure with AADSTS700213, re-run Create Environment with Azure auto-setup."
  });

  type GitHubVariableLookup =
    | { kind: "value"; value: string }
    | { kind: "blank" }
    | { kind: "absent" }
    | { kind: "error"; reason: string };

  // GitHub Actions resolves a variable from the environment first and falls back
  // to the repository only when the environment does not define it, so the
  // preflight has to read them in that order to see what the workflow will see.
  // A variable that exists with an empty value still shadows the repository one,
  // so only "absent" falls through.
  const readGitHubActionsVariable = async (
    repo: string,
    environment: string,
    name: string
  ): Promise<GitHubVariableLookup> => {
    const envPath = `/repos/${repo}/environments/${encodeURIComponent(
      environment
    )}/variables/${name}`;
    const repoPath = `/repos/${repo}/actions/variables/${name}`;
    const read = async (
      path: string,
      scope: string
    ): Promise<GitHubVariableLookup> => {
      const response = await dependencies.runGitHubJson(path);
      if (!response.ok) {
        if (response.status === 404) return { kind: "absent" };
        return {
          kind: "error",
          reason: `GitHub ${scope} ${name} lookup failed (${response.stderr || `HTTP ${response.status ?? "unknown"}`})`
        };
      }
      const value = response.json?.value;
      if (typeof value !== "string") {
        return {
          kind: "error",
          reason: `GitHub ${scope} has an invalid ${name}`
        };
      }
      if (!value.trim()) return { kind: "blank" };
      return { kind: "value", value: value.trim() };
    };
    const environmentValue = await read(
      envPath,
      `environment "${environment}"`
    );
    if (environmentValue.kind !== "absent") return environmentValue;
    return read(repoPath, `repository "${repo}"`);
  };

  // Entra compares the OIDC subject case-sensitively, but GitHub resolves an
  // environment by name case-insensitively — so deploying "dev" against an
  // environment stored as "Dev" reads its variables fine while the token carries
  // "environment:Dev". Building the subject from the requested spelling would
  // hard-block that working deploy, so the name GitHub reports wins.
  const readCanonicalEnvironmentName = async (
    repo: string,
    environment: string
  ): Promise<
    { kind: "name"; name: string } | { kind: "error"; reason: string }
  > => {
    const response = await dependencies.runGitHubJson(
      `/repos/${repo}/environments/${encodeURIComponent(environment)}`
    );
    if (!response.ok) {
      return {
        kind: "error",
        reason: `GitHub environment "${environment}" lookup failed (${response.stderr || `HTTP ${response.status ?? "unknown"}`})`
      };
    }
    const name = response.json?.name;
    if (typeof name !== "string" || !name.trim()) {
      return {
        kind: "error",
        reason: `GitHub did not report a name for environment "${environment}"`
      };
    }
    return { kind: "name", name: name.trim() };
  };

  const validateAzureFederatedCredential = async (
    repo: string,
    environment: string
  ): Promise<AzureFederatedCredentialValidation> => {
    let clientId: string;
    try {
      const clientIdLookup = await readGitHubActionsVariable(
        repo,
        environment,
        "AZURE_CLIENT_ID"
      );
      if (clientIdLookup.kind === "error") {
        return validationUnverified(environment, clientIdLookup.reason);
      }
      if (clientIdLookup.kind === "blank") {
        // The upstream provider workflow gates azure/login on
        // `vars.AZURE_CLIENT_ID != ''`, so an empty value is the documented way
        // to run a non-OIDC cluster. There is no login to fail and nothing to
        // check — warning here would send someone off to "fix" a variable that
        // is deliberately blank.
        return {
          status: "skipped",
          message: `Azure login is disabled for environment "${environment}" (AZURE_CLIENT_ID is empty) — skipping the federated credential check.`
        };
      }
      if (clientIdLookup.kind === "absent") {
        return validationUnverified(
          environment,
          `neither GitHub environment "${environment}" nor repository "${repo}" defines AZURE_CLIENT_ID`
        );
      }
      clientId = clientIdLookup.value;
    } catch (error) {
      return validationUnverified(
        environment,
        `GitHub variable lookup failed (${dependencies.errorMessage(error)})`
      );
    }

    let envName: string;
    let resolved: ResolveOidcSubjectResult;
    try {
      const canonical = await readCanonicalEnvironmentName(repo, environment);
      if (canonical.kind === "error") {
        return validationUnverified(environment, canonical.reason);
      }
      envName = canonical.name;
      resolved = await resolveOidcSubject(
        {
          targetRepo: repo,
          envName,
          suffix: buildEnvironmentSuffix(envName)
        },
        dependencies.runGitHubJson
      );
    } catch (error) {
      return validationUnverified(
        environment,
        `GitHub OIDC subject resolution failed (${dependencies.errorMessage(error)})`
      );
    }
    const expectedSubjects = resolved.federatedCredentials.map(
      (credential) => credential.subject
    );

    let listResult: DeployCommandResult;
    try {
      // No `--tenant`: `az ad app federated-credential list` does not accept it
      // and exits with "unrecognized arguments", which would make this check a
      // permanent no-op. A signed-in context in the wrong tenant simply fails
      // the read and lands in the same warn bucket.
      listResult = await dependencies.runAz(
        buildFederatedCredentialListArgs(clientId)
      );
    } catch (error) {
      return validationUnverified(
        environment,
        `Azure federated credential lookup failed (${dependencies.errorMessage(error)})`
      );
    }
    if (listResult.code !== 0) {
      return validationUnverified(
        environment,
        `Azure federated credential lookup failed (${(listResult.stderr || "").trim() || "unknown error"})`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(listResult.stdout || "");
    } catch (error) {
      return validationUnverified(
        environment,
        `Azure federated credential lookup returned malformed JSON (${dependencies.errorMessage(error)})`
      );
    }
    if (!Array.isArray(parsed)) {
      return validationUnverified(
        environment,
        "Azure federated credential lookup returned an invalid subject list"
      );
    }
    // Flexible federated credentials match on `claimsMatchingExpression` and
    // report a null subject, so entries without one are skipped rather than
    // disabling the check for every ordinary credential beside them.
    const subjects = parsed
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const missingSubjects = expectedSubjects.filter(
      (subject) => !subjects.includes(subject)
    );
    if (missingSubjects.length === 0) return { status: "covered" };

    if (missingSubjects.length < expectedSubjects.length) {
      // Partial coverage of the indeterminate mutable/immutable pair. Only one
      // form is ever presented and we cannot tell which, so this is a warning.
      const missingSubjectText = missingSubjects
        .map((subject) => `"${subject}"`)
        .join(" and ");
      return validationUnverified(
        environment,
        `App Registration ${clientId} covers only part of the subject pair GitHub may mint (no credential for ${missingSubjectText})`
      );
    }

    // Report every mis-cased subject, not just the first. `expectedSubjects`
    // holds the mutable and immutable pair, and a credential typed by hand
    // that got one spelling wrong usually got both wrong. Naming one would
    // send the user back for a second round, and correcting only that one
    // lands in the partial-coverage branch above, which warns and dispatches
    // into the very login failure this check exists to prevent.
    const caseMismatches: { expected: string; existing: string }[] = [];
    for (const expected of expectedSubjects) {
      for (const existing of subjects) {
        if (existing.toLowerCase() !== expected.toLowerCase()) continue;
        caseMismatches.push({ expected, existing });
        break;
      }
    }
    if (caseMismatches.length > 0) {
      const mismatchText = caseMismatches
        .map(
          ({ expected, existing }) =>
            `expected "${expected}" but the app has "${existing}"`
        )
        .join("; ");
      return {
        status: "case-mismatch",
        message:
          `Azure deploy to environment "${envName}" is blocked because App Registration ${clientId} has federated credential subjects that differ from the ones GitHub mints only by letter casing: ${mismatchText}. ` +
          // Predicted, not quoted: nothing here calls Entra, so saying so keeps
          // a user from hunting for a run that never happened. The codes are
          // still spelled out because that is what they would search for, and
          // both spellings appear because Entra is not consistent about them.
          'Entra compares subjects case-sensitively, so this deploy\'s Azure login would be rejected with "No matching federated identity record found for presented assertion subject" (AADSTS700213, also written AADSTS7002138 in some Entra responses). No workflow run was started, so that rejection will not appear in the Actions logs. ' +
          `Correct the existing credentials rather than re-running Create Environment, which rebuilds the subject from the same spelling. List their ids with: az ad app federated-credential list --id ${clientId} --query "[].{id:id,subject:subject}" -o table. Then fix each one with: az ad app federated-credential update --id ${clientId} --federated-credential-id <id> --parameters "{\\"subject\\":\\"<expected subject>\\"}".`
      };
    }

    // Every subject on the app is a near match worth showing: on a repository
    // covered by GitHub's immutable-default rollout the existing subjects carry
    // `owner@id/name@id`, and a prefix filter built from the mutable spelling
    // would hide them exactly when the user most needs to see how close the
    // credential was.
    const nearMatchNote =
      subjects.length > 0 ?
        ` Existing credential subjects on the app: ${subjects
          .slice(0, 3)
          .join(", ")}${subjects.length > 3 ? ", ..." : ""}.`
      : "";
    const expectedSubjectText = expectedSubjects
      .map((subject) => `"${subject}"`)
      .join(" or ");
    return {
      status: "missing",
      message:
        `Azure deploy to environment "${envName}" is blocked because App Registration ${clientId} ` +
        `has no federated credential matching any subject GitHub could present for it (expected one of ${expectedSubjectText}).` +
        nearMatchNote +
        " Re-run Create Environment with Azure auto-setup (or create the credential manually) before deploying."
    };
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
        await reportBranchNotPushed(
          entry,
          repo,
          deployRef,
          dependencies.branchNotPushedKind,
          log
        );
        return { dispatched: false };
      }

      // After the branch check on purpose: an unpushed branch is the cheaper,
      // more local failure, and reporting federated credentials first would name
      // the wrong blocker.
      if (provider === "azure") {
        const validation = await validateAzureFederatedCredential(
          repo,
          envForDeploy
        );
        if (validation.status === "missing") {
          log("❌ " + validation.message);
          entry.state.deployError = validation.message;
          entry.state.deployErrorKind = dependencies.oidcSubjectMissingKind;
          entry.state.deployStatus = "failed";
          return { dispatched: false };
        }
        if (validation.status === "case-mismatch") {
          log("❌ " + validation.message);
          entry.state.deployError = validation.message;
          entry.state.deployErrorKind =
            dependencies.oidcSubjectCaseMismatchKind;
          entry.state.deployStatus = "failed";
          return { dispatched: false };
        }
        if (validation.status === "unverified") log("⚠ " + validation.message);
        if (validation.status === "skipped") log("• " + validation.message);
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
      // Capture the newest existing run id right before dispatching, so the
      // monitor can pick out the run this dispatch creates (the first with a
      // greater id) instead of matching a prior run by its creation time.
      let baselineRunId: number | string | null = null;
      try {
        baselineRunId = await dependencies.latestWorkflowRunId(
          repo,
          deployWorkflowFile
        );
      } catch (e) {
        log(
          "⚠ Could not read the latest run id before dispatch (" +
            dependencies.errorMessage(e) +
            "); run discovery will fall back to a time window."
        );
      }
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
      let dispatchCredentialSource = dependencies.ghCredentialSource();
      if (dispatchDeployRes.code !== 0) {
        const attempt = await withStrippedToken(dispatchDeployRes, (env) =>
          dependencies.runGh(dispatchArgs, { env })
        );
        dispatchDeployRes = attempt.result;
        dispatchCredentialSource = attempt.credentialSource;
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
          await reportBranchNotPushed(
            entry,
            repo,
            deployRef,
            dispatchKind,
            log
          );
          return { dispatched: false };
        }
        const scopeHint =
          needsWorkflowScope(de) && dispatchCredentialSource === "injected" ?
            ' The Copilot session token is missing the "workflow" scope and `gh auth refresh` cannot change it. Authenticate a stored GitHub CLI account with the workflow scope, or restart with a session token that includes it, then retry.'
          : needsWorkflowScope(de) ?
            ' Your stored GitHub CLI credential is missing the "workflow" scope. Run `gh auth refresh -h github.com -s workflow` in a terminal, then retry.'
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
        environment: envForDeploy,
        baselineRunId
      };
    }
  };
}
