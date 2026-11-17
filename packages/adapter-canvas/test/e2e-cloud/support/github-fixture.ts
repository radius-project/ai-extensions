// The GitHub side of a cloud run's fixture: the repository lease, the clone at
// the pinned baseline, the GitHub part of the clean-slate check, and the GitHub
// part of teardown.
//
// Every cloud's fixture shares one fixture repository, so this lives apart
// from any one cloud's fixture. Each function takes the repository it acts on
// and the commands port, and writes only through that port, so each branch is
// provable without a GitHub credential.
import {
  asRecord,
  describeError,
  expectSuccess,
  isGitHubApiNotFound,
  parseJsonArray,
  requireString,
  type CloudCommandPort,
  type CloudFixturePorts
} from "./cloud-command-port.js";
import { selectPrefixedEnvironments } from "./cloud-cleanup.js";
import {
  AWS_ENVIRONMENT_NAME_PREFIX,
  CLOUD_E2E_LEASE_REF,
  cloudE2ELeaseCommitMessage,
  ENVIRONMENT_NAME_PREFIX,
  WORKFLOW_FALLBACK_BRANCH_PREFIX
} from "./fixture-repository.js";

/** The fixture repository a run acts on, and the baseline it starts from. */
export interface GitHubFixtureRepository {
  readonly commands: CloudCommandPort;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly baselineSha: string;
}

/** The GitHub state one run's environment owns. */
export interface GitHubRunState {
  readonly environmentName: string;
  readonly statePackage: string;
}

/** One step of construction that teardown must undo. */
export interface UnwindStep {
  readonly describe: string;
  readonly run: () => Promise<void>;
}

/** The GitHub Actions run that owns the lease, and its marker commit message. */
export interface FixtureLeaseOwner {
  readonly runId: string;
  readonly message: string;
}

/**
 * What a reclaim removed and what it could not.
 *
 * Shared across every cloud's part of one reclaim, because the last GitHub
 * step resets the default branch only when nothing before it failed.
 */
export interface ReclaimLedger {
  readonly reclaimed: string[];
  readonly failures: string[];
}

/**
 * Validates the run id before anything is written, so an unverifiable owner
 * never reaches the lease.
 */
export function fixtureLeaseOwner(
  githubRunId: string | undefined
): FixtureLeaseOwner | undefined {
  const runId = githubRunId?.trim() || undefined;
  return runId === undefined ? undefined : (
      { runId, message: cloudE2ELeaseCommitMessage(runId) }
    );
}

function requireGitObjectId(value: string, context: string): string {
  const normalized = value.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(normalized))
    throw new Error(`${context} returned an invalid Git object id.`);
  return normalized;
}

/**
 * Takes the repository-scoped lease and records its release in `unwind`.
 *
 * A CI run also marks the lease with its run id, so scheduled cleanup can tell
 * an abandoned lease from a live one.
 */
export async function acquireFixtureLease(
  fixture: GitHubFixtureRepository,
  owner: FixtureLeaseOwner | undefined,
  unwind: UnwindStep[]
): Promise<void> {
  const { commands, repository, baselineSha } = fixture;
  expectSuccess(
    await commands.runGh([
      "api",
      "--method",
      "POST",
      `repos/${repository}/git/refs`,
      "-f",
      `ref=${CLOUD_E2E_LEASE_REF}`,
      "-f",
      `sha=${baselineSha}`
    ]),
    `gh api create ${CLOUD_E2E_LEASE_REF}`
  );
  unwind.push({
    describe: `release repository lease ${CLOUD_E2E_LEASE_REF}`,
    run: async () => {
      expectSuccess(
        await commands.runGh([
          "api",
          "--method",
          "DELETE",
          `repos/${repository}/git/${CLOUD_E2E_LEASE_REF}`
        ]),
        `gh api delete ${CLOUD_E2E_LEASE_REF}`
      );
    }
  });

  if (!owner) return;
  const treeSha = requireGitObjectId(
    expectSuccess(
      await commands.runGh([
        "api",
        `repos/${repository}/git/commits/${baselineSha}`,
        "--jq",
        ".tree.sha"
      ]),
      `gh api read baseline tree ${baselineSha}`
    ).stdout,
    "The fixture baseline tree lookup"
  );
  const leaseCommitSha = requireGitObjectId(
    expectSuccess(
      await commands.runGh([
        "api",
        "--method",
        "POST",
        `repos/${repository}/git/commits`,
        "-f",
        `message=${owner.message}`,
        "-f",
        `tree=${treeSha}`,
        "-F",
        `parents[]=${baselineSha}`,
        "--jq",
        ".sha"
      ]),
      `gh api create lease marker for workflow run ${owner.runId}`
    ).stdout,
    "The fixture lease marker creation"
  );
  expectSuccess(
    await commands.runGh([
      "api",
      "--method",
      "PATCH",
      `repos/${repository}/git/${CLOUD_E2E_LEASE_REF}`,
      "-f",
      `sha=${leaseCommitSha}`
    ]),
    `gh api mark ${CLOUD_E2E_LEASE_REF} for workflow run ${owner.runId}`
  );
}

/**
 * Clones the repository into a fresh workspace pinned to the baseline, and
 * records the workspace's removal in `unwind`.
 */
export async function cloneFixtureAtBaseline(
  ports: Pick<CloudFixturePorts, "makeWorkspaceDir" | "removeDir">,
  fixture: GitHubFixtureRepository,
  workspacePrefix: string,
  unwind: UnwindStep[]
): Promise<string> {
  const { commands, repository, baselineSha } = fixture;
  const workspacePath = await ports.makeWorkspaceDir(workspacePrefix);
  unwind.push({
    describe: `remove workspace ${workspacePath}`,
    run: () => ports.removeDir(workspacePath)
  });

  expectSuccess(
    await commands.runGh(["repo", "clone", repository, workspacePath]),
    `gh repo clone ${repository}`
  );
  // Pin the clone to the reviewed baseline rather than trusting the branch
  // head, so a run that starts against a repository someone left dirty fails
  // at the clean-slate check instead of quietly testing a different app.
  expectSuccess(
    await commands.runGit(["reset", "--hard", baselineSha], workspacePath),
    `git reset --hard ${baselineSha}`
  );
  return workspacePath;
}

/** Runs every step in reverse order, even after one fails. */
export async function unwindAll(steps: UnwindStep[]): Promise<string[]> {
  const failures: string[] = [];
  // Reverse order, and every step is attempted even after one fails: stopping
  // at the first failure is how a subscription accumulates orphaned clusters.
  for (let step = steps.pop(); step !== undefined; step = steps.pop()) {
    try {
      await step.run();
    } catch (error) {
      failures.push(`${step.describe}: ${describeError(error)}`);
    }
  }
  return failures;
}

/** The GitHub part of the clean-slate check. */
export async function collectGitHubLeakedState(
  fixture: GitHubFixtureRepository,
  run: GitHubRunState
): Promise<string[]> {
  const { commands, repository } = fixture;
  const findings: string[] = [];

  const environment = await commands.runGh([
    "api",
    `repos/${repository}/environments/${run.environmentName}`
  ]);
  if (environment.code === 0)
    findings.push(
      `GitHub environment "${run.environmentName}" in ${repository}`
    );
  else if (!isGitHubApiNotFound(environment))
    throw new Error(
      `Could not probe GitHub environment "${run.environmentName}" in ${repository}: ` +
        `gh exited ${environment.code}: ${(environment.stderr || environment.stdout).trim()}`
    );

  // The run's own name is unique, so the probe above never sees an environment
  // an earlier run leaked. The wizard does: it refuses to create an environment
  // in a namespace that any listed environment owns. One leaked `radtest-*`
  // environment therefore blocks the create step, so it is leaked state here.
  const listingContext = `Listing GitHub environments in ${repository}`;
  const listing = await commands.runGh([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repository}/environments?per_page=100`
  ]);
  expectSuccess(listing, listingContext);
  if (!listing.stdout.trim())
    throw new Error(
      `${listingContext} returned an empty response instead of JSON.`
    );
  // Every cloud's runs share the fixture's default branch and delete
  // workflows, so a leftover from either cloud blocks this run.
  const environments = parseJsonArray(listing, listingContext);
  for (const name of [
    ENVIRONMENT_NAME_PREFIX,
    AWS_ENVIRONMENT_NAME_PREFIX
  ].flatMap((prefix) => selectPrefixedEnvironments(environments, prefix)))
    if (name !== run.environmentName)
      findings.push(
        `GitHub environment "${name}" in ${repository} from an earlier run ` +
          "(the product refuses to create an environment in a namespace another environment owns)"
      );

  const statePackage = await readStatePackage(
    commands,
    repository,
    run.statePackage
  );
  if (statePackage)
    findings.push(
      `GHCR state package "${run.statePackage}" (${statePackage.visibility || "unknown"} visibility, linked to ` +
        `"${statePackage.linkedRepository || "(no repository)"}")`
    );

  const head = await readDefaultBranchSha(
    commands,
    repository,
    fixture.defaultBranch
  );
  if (!sameSha(head, fixture.baselineSha))
    findings.push(
      `${repository}@${fixture.defaultBranch} is at ${head}, not the pinned baseline ${fixture.baselineSha} ` +
        "(a previous run committed workflow files to the default branch)"
    );

  // The product only commits to the default branch when its token carries
  // `workflow` scope. Without it, it opens a pull request from a
  // `radius/setup-*` branch instead, which leaves the default branch pristine —
  // so the branch and pull request probes below are the only thing standing
  // between that path and a silently green clean slate.
  for (const branch of await listWorkflowFallbackBranches(commands, repository))
    findings.push(`workflow fallback branch "${branch}" in ${repository}`);

  for (const pull of await listOpenPullRequests(commands, repository))
    findings.push(
      `open pull request #${pull.number} ("${pull.title}", head "${pull.headRef}") in ${repository}`
    );

  return findings;
}

/**
 * Refuses a probe environment that already exists, so teardown never deletes
 * an environment this run did not create.
 */
export async function requireProbeEnvironmentAbsent(
  fixture: GitHubFixtureRepository,
  run: Pick<GitHubRunState, "environmentName">,
  name: string
): Promise<void> {
  if (!name.trim() || name === run.environmentName)
    throw new Error(
      "Probe cleanup needs a non-empty environment name distinct from the main environment."
    );
  const apiPath = `repos/${fixture.repository}/environments/${encodeURIComponent(name)}`;
  const result = await fixture.commands.runGh(["api", apiPath]);
  if (result.code === 0)
    throw new Error(
      `Refusing to register pre-existing probe environment "${name}" for cleanup.`
    );
  if (!isGitHubApiNotFound(result))
    throw new Error(
      `Could not verify probe environment "${name}" is absent: ${result.stderr || result.stdout}`
    );
}

/** Runs one reclaim step and records whether it succeeded. */
export async function attemptReclaim(
  ledger: ReclaimLedger,
  label: string,
  run: () => Promise<void>
): Promise<void> {
  try {
    await run();
    ledger.reclaimed.push(label);
  } catch (error) {
    ledger.failures.push(`${label}: ${describeError(error)}`);
  }
}

/**
 * Removes a GitHub environment and its deployment records, keeping the
 * environment when any record could not be removed.
 */
export async function reclaimGitHubEnvironment(
  ledger: ReclaimLedger,
  fixture: GitHubFixtureRepository,
  name: string,
  label: string
): Promise<void> {
  const { commands, repository } = fixture;
  const { failures } = ledger;
  // Deployment records outlive their environment. Clear them even when
  // the environment is absent, and preserve it if any record step fails.
  const failuresBeforeRecords = failures.length;
  const records = await listDeploymentRecordIds(
    commands,
    repository,
    name
  ).catch((error: unknown) => {
    failures.push(
      `probe GitHub deployment records for ${name}: ${describeError(error)}`
    );
    return null;
  });
  if (records && records.length > 0)
    await attemptReclaim(
      ledger,
      `${records.length} GitHub deployment record(s) for ${name}`,
      async () => {
        for (const id of records) {
          expectSuccess(
            await commands.runGh([
              "api",
              "--method",
              "POST",
              `repos/${repository}/deployments/${id}/statuses`,
              "-f",
              "state=inactive"
            ]),
            `gh api POST deployments/${id}/statuses`
          );
          expectSuccess(
            await commands.runGh([
              "api",
              "--method",
              "DELETE",
              `repos/${repository}/deployments/${id}`
            ]),
            `gh api DELETE deployments/${id}`
          );
        }
      }
    );
  if (failures.length !== failuresBeforeRecords) {
    failures.push(
      `preserve GitHub environment ${name}: its deployment records could not be ` +
        "reclaimed, and deleting the environment now would strand them behind a name nothing " +
        "will match again"
    );
    return;
  }
  const apiPath = `repos/${repository}/environments/${encodeURIComponent(name)}`;
  try {
    const probe = await commands.runGh(["api", apiPath]);
    if (isGitHubApiNotFound(probe)) return;
    if (probe.code !== 0)
      throw new Error(
        `gh exited ${probe.code}: ${(probe.stderr || probe.stdout).trim()}`
      );
    await attemptReclaim(ledger, label, async () => {
      const result = await commands.runGh([
        "api",
        "--method",
        "DELETE",
        apiPath
      ]);
      if (result.code !== 0 && !isGitHubApiNotFound(result))
        expectSuccess(result, `gh api DELETE ${apiPath}`);
    });
  } catch (error) {
    failures.push(`probe GitHub environment ${name}: ${describeError(error)}`);
  }
}

/**
 * The GitHub part of teardown, after every cloud's part: the run's environment,
 * its state package, fallback pull requests and branches, and the default
 * branch.
 *
 * The default branch is reset only when the ledger records no failure from any
 * earlier step, because the generated workflows are what a retry needs.
 */
export async function reclaimGitHubRunState(
  ledger: ReclaimLedger,
  fixture: GitHubFixtureRepository,
  run: GitHubRunState
): Promise<void> {
  const { commands, repository, defaultBranch, baselineSha } = fixture;
  const { failures } = ledger;
  const attempt = (label: string, step: () => Promise<void>) =>
    attemptReclaim(ledger, label, step);

  await reclaimGitHubEnvironment(
    ledger,
    fixture,
    run.environmentName,
    `GitHub environment ${run.environmentName}`
  );

  const packageRecord = await readStatePackage(
    commands,
    repository,
    run.statePackage
  ).catch((error: unknown) => {
    failures.push(
      `probe GHCR state package ${run.statePackage}: ${describeError(error)}`
    );
    return null;
  });
  if (packageRecord) {
    const packageSafetyError = validateStatePackageForDeletion(
      packageRecord,
      repository
    );
    if (packageSafetyError) {
      failures.push(
        `refuse GHCR state package ${run.statePackage}: ${packageSafetyError}`
      );
    } else {
      await attempt(`GHCR state package ${run.statePackage}`, async () => {
        const deletion = await commands.runGhPackage([
          "api",
          "--method",
          "DELETE",
          packageRecord.apiPath
        ]);
        if (isGitHubApiNotFound(deletion)) {
          const remaining = await readStatePackage(
            commands,
            repository,
            run.statePackage
          );
          if (remaining)
            throw new Error(
              `gh api DELETE ${packageRecord.apiPath} returned HTTP 404, but the package is still readable. ` +
                "The package credential does not have effective delete access."
            );
          return;
        }
        expectSuccess(deletion, `gh api DELETE ${packageRecord.apiPath}`);
      });
    }
  }

  // Close pull requests before removing their head branches so cleanup does
  // not rely on GitHub implicitly changing pull-request state.
  const pulls = await listOpenPullRequests(commands, repository).catch(
    (error: unknown) => {
      failures.push(`list open pull requests: ${describeError(error)}`);
      return [] as OpenPullRequest[];
    }
  );
  for (const pull of pulls.filter((candidate) =>
    candidate.headRef.startsWith(WORKFLOW_FALLBACK_BRANCH_PREFIX)
  ))
    await attempt(`pull request #${pull.number}`, async () => {
      expectSuccess(
        await commands.runGh([
          "api",
          "--method",
          "PATCH",
          `repos/${repository}/pulls/${pull.number}`,
          "-f",
          "state=closed"
        ]),
        `gh api PATCH pulls/${pull.number}`
      );
    });

  // A leaked `radius/setup-*` branch poisons the next run's clean slate the
  // same way a leaked Entra application does.
  const branches = await listWorkflowFallbackBranches(
    commands,
    repository
  ).catch((error: unknown) => {
    failures.push(`list workflow fallback branches: ${describeError(error)}`);
    return [] as string[];
  });
  for (const branch of branches)
    await attempt(`branch ${branch}`, async () => {
      expectSuccess(
        await commands.runGh([
          "api",
          "--method",
          "DELETE",
          `repos/${repository}/git/refs/heads/${branch}`
        ]),
        `gh api DELETE refs/heads/${branch}`
      );
    });

  // The generated workflows are recovery inputs for every retained
  // environment. Resetting the branch after an earlier cleanup failure
  // removes the only workflow scheduled cleanup can dispatch, permanently
  // deadlocking the fixture behind its own fail-closed preservation.
  if (failures.length === 0) {
    const head = await readDefaultBranchSha(
      commands,
      repository,
      defaultBranch
    ).catch((error: unknown) => {
      failures.push(`read ${defaultBranch} head: ${describeError(error)}`);
      return null;
    });
    if (head !== null && !sameSha(head, baselineSha))
      await attempt(`${defaultBranch} reset to ${baselineSha}`, async () => {
        expectSuccess(
          await commands.runGh([
            "api",
            "--method",
            "PATCH",
            `repos/${repository}/git/refs/heads/${defaultBranch}`,
            "-f",
            `sha=${baselineSha}`,
            "-F",
            "force=true"
          ]),
          `gh api PATCH refs/heads/${defaultBranch}`
        );
      });
  }
}

interface StatePackageRecord {
  readonly apiPath: string;
  readonly visibility: string;
  readonly linkedRepository: string;
}

async function readStatePackage(
  commands: CloudCommandPort,
  repository: string,
  registry: string
): Promise<StatePackageRecord | null> {
  const owner = repository.slice(0, repository.indexOf("/"));
  const packageName = registry.slice(registry.lastIndexOf("/") + 1);

  const ownerType = expectSuccess(
    await commands.runGhPackage(["api", `users/${owner}`, "--jq", ".type"]),
    `gh api read account type for ${owner}`
  ).stdout.trim();
  const scope =
    ownerType === "Organization" ? "orgs"
    : ownerType === "User" ? "users"
    : null;
  if (!scope)
    throw new Error(
      `GitHub account "${owner}" returned unsupported type "${ownerType || "(empty)"}".`
    );

  const apiPath = `${scope}/${owner}/packages/container/${encodeURIComponent(packageName)}`;
  const result = await commands.runGhPackage(["api", apiPath]);
  if (isGitHubApiNotFound(result)) return null;
  expectSuccess(result, `gh api read GHCR package ${registry}`);

  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `gh api read GHCR package ${registry} returned invalid JSON: ${describeError(error)}`,
      { cause: error }
    );
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error(
      `gh api read GHCR package ${registry} returned a non-object response.`
    );
  const record = payload as Record<string, unknown>;
  const linkedRepository =
    (
      record.repository &&
      typeof record.repository === "object" &&
      !Array.isArray(record.repository) &&
      typeof (record.repository as Record<string, unknown>).full_name ===
        "string"
    ) ?
      String((record.repository as Record<string, unknown>).full_name).trim()
    : "";
  return {
    apiPath,
    visibility:
      typeof record.visibility === "string" ? record.visibility.trim() : "",
    linkedRepository
  };
}

function validateStatePackageForDeletion(
  statePackage: StatePackageRecord,
  repository: string
): string | null {
  if (
    statePackage.visibility !== "private" &&
    statePackage.visibility !== "internal"
  )
    return `visibility is "${statePackage.visibility || "unknown"}", not private or internal`;
  if (!statePackage.linkedRepository)
    return (
      "it is not linked to a repository, so its provenance cannot be proven " +
      `(expected "${repository}")`
    );
  if (statePackage.linkedRepository.toLowerCase() !== repository.toLowerCase())
    return `it is linked to "${statePackage.linkedRepository}", not "${repository}"`;
  return null;
}

// Deleting a GitHub Environment leaves its deployment records behind: the two
// are linked by environment *name*, so the records outlive it. The extension
// never deletes one, because to the product a deployment record is history
// rather than a resource it owns, so the suite that caused them has to.
async function listDeploymentRecordIds(
  commands: CloudCommandPort,
  repository: string,
  environmentName: string
): Promise<number[]> {
  const context = `gh api repos/${repository}/deployments?environment=${environmentName}`;
  // Paginated: a run creates a deployment record per deploy, and an
  // environment can accumulate more than one page of them. Stopping at the
  // first page would report success while stranding the rest.
  const result = await commands.runGh([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repository}/deployments?environment=${encodeURIComponent(environmentName)}&per_page=100`
  ]);
  expectSuccess(result, context);
  if (!result.stdout.trim())
    throw new Error(`${context} returned an empty response instead of JSON.`);
  const pages = parseJsonArray(result, context);
  const entries = pages.flatMap((page, index) => {
    if (!Array.isArray(page))
      throw new Error(
        `${context} returned page ${index} with JSON type "${typeof page}" where an array was expected.`
      );
    return page;
  });
  return entries.map((entry, index) => {
    const record = asRecord(entry, context, index);
    const id = record.id;
    if (typeof id !== "number" || !Number.isInteger(id))
      throw new Error(
        `${context} returned an entry at index ${index} with no usable numeric "id".`
      );
    return id;
  });
}

async function listWorkflowFallbackBranches(
  commands: CloudCommandPort,
  repository: string
): Promise<string[]> {
  const context = `gh api matching-refs ${WORKFLOW_FALLBACK_BRANCH_PREFIX} in ${repository}`;
  // `matching-refs` answers 200 with an empty array when nothing matches, so
  // there is no not-found case to disambiguate here.
  const entries = parseJsonArray(
    await commands.runGh([
      "api",
      `repos/${repository}/git/matching-refs/heads/${WORKFLOW_FALLBACK_BRANCH_PREFIX}`
    ]),
    context
  );
  return entries.map((entry, index) =>
    requireString(
      asRecord(entry, context, index).ref,
      "ref",
      context,
      index
    ).replace(/^refs\/heads\//, "")
  );
}

interface OpenPullRequest {
  readonly number: number;
  readonly title: string;
  readonly headRef: string;
}

async function listOpenPullRequests(
  commands: CloudCommandPort,
  repository: string
): Promise<OpenPullRequest[]> {
  const context = `gh api open pull requests in ${repository}`;
  const result = await commands.runGh([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repository}/pulls?state=open&per_page=100`
  ]);
  expectSuccess(result, context);
  if (!result.stdout.trim())
    throw new Error(`${context} returned an empty response instead of JSON.`);
  const pages = parseJsonArray(result, context);
  const entries = pages.flatMap((page, index) => {
    if (!Array.isArray(page))
      throw new Error(
        `${context} returned page ${index} with JSON type "${typeof page}" where an array was expected.`
      );
    return page;
  });
  return entries.map((entry, index) => {
    const record = asRecord(entry, context, index);
    const head = asRecord(record.head ?? {}, context, index);
    return {
      number: requirePositiveInteger(record.number, "number", context, index),
      title: typeof record.title === "string" ? record.title : "(untitled)",
      headRef: typeof head.ref === "string" ? head.ref : "(unknown)"
    };
  });
}

async function readDefaultBranchSha(
  commands: CloudCommandPort,
  repository: string,
  branch: string
): Promise<string> {
  const result = expectSuccess(
    await commands.runGh([
      "api",
      `repos/${repository}/commits/${branch}`,
      "--jq",
      ".sha"
    ]),
    `gh api commits/${branch} in ${repository}`
  );
  const sha = result.stdout.trim();
  if (!sha)
    throw new Error(
      `gh api commits/${branch} in ${repository} returned no commit SHA.`
    );
  return sha;
}

function sameSha(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function requirePositiveInteger(
  value: unknown,
  field: string,
  context: string,
  index: number
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
    throw new Error(
      `${context} returned an entry at index ${index} with no usable "${field}".`
    );
  return value;
}
