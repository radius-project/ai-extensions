// Every decision the create-environment journey makes that is not a click.
//
// The journey itself needs a real Azure subscription, a real GitHub token, and
// a provisioned fixture repository, so none of it can run on a developer
// machine or in a pull request. That makes the spec body the worst possible
// place to keep a rule: a mistake there is only ever discovered by a nightly
// run, hours later, as an unexplained failure against real infrastructure.
//
// So the rules live here as pure functions with their own tests, and the spec
// keeps only the browser actions and the fixture calls. Two of them exist
// specifically to stop a run passing while proving nothing:
//
// - `classifyWorkflowPublication` separates the committed-workflow path from
//   the pull-request fallback the product takes when its token lacks `workflow`
//   scope. Accepting either would let a scope regression pass silently.
// - `findEnvironmentIdentityProblems` refuses a GitHub Environment wired to the
//   bootstrap identity rather than to the application the product created.
//   Those two share a variable name, and confusing them would make every later
//   stage authenticate as the privileged runner identity and pass.
import type { CanvasState } from "../../../src/shared.js";
import { TERMINAL_STATES } from "../../../src/operations.js";
import { describeError } from "./cloud-command-port.js";

/** The verify workflow the product publishes, named as a stable anchor. */
export const VERIFY_WORKFLOW_PATH =
  ".github/workflows/radius-verify-credentials.yml";

/**
 * What must exist on the default branch once stage one completes.
 *
 * Only the verify workflow is required. The deploy and delete workflows are
 * provider-shaped and named by the product's own dispatcher resolution, so
 * pinning them here would couple the journey to a naming decision stage one
 * does not test.
 */
export const REQUIRED_DEFAULT_BRANCH_WORKFLOWS: readonly string[] = [
  VERIFY_WORKFLOW_PATH
];

export type JourneyGate =
  | { readonly enabled: true }
  | {
      readonly enabled: false;
      readonly disposition: "skip" | "fail";
      readonly reason: string;
    };

export interface JourneyGateInput {
  /** `RADIUS_CLOUD_E2E`, as read from the environment. */
  readonly cloudE2eFlag?: string;
  readonly fixtureProvisioned: boolean;
  /** What `describeUnprovisionedFixtureRepository()` reported. */
  readonly unprovisionedReason: string;
  /** `AZURE_SUBSCRIPTION_ID`. */
  readonly subscriptionId?: string;
  /** `GH_TOKEN`. */
  readonly githubToken?: string;
}

function isSet(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Whether the journey may run, and why not when it may not.
 *
 * An ordinary `pnpm test` skips when cloud execution was not requested. Once a
 * run opts in, every missing prerequisite is a preflight failure so a broken
 * cloud job cannot be green without executing any cloud assertion.
 */
export function evaluateCreateEnvironmentGate(
  input: JourneyGateInput
): JourneyGate {
  if (!isSet(input.cloudE2eFlag))
    return {
      enabled: false,
      disposition: "skip",
      reason:
        "RADIUS_CLOUD_E2E is not set, so the cloud create-environment journey is opt-out by default."
    };
  if (!input.fixtureProvisioned)
    return {
      enabled: false,
      disposition: "fail",
      reason: input.unprovisionedReason
    };
  if (!isSet(input.subscriptionId))
    return {
      enabled: false,
      disposition: "fail",
      reason:
        "AZURE_SUBSCRIPTION_ID is not set; the fixture needs a subscription to provision the per-run resource group and cluster in."
    };
  if (!isSet(input.githubToken))
    return {
      enabled: false,
      disposition: "fail",
      reason:
        "GH_TOKEN is not set; the cloud harness needs a token for the fixture repository."
    };
  return { enabled: true };
}

export type AzurePrincipalType = "user" | "servicePrincipal";

export interface AzureAccount {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly subscriptionName: string;
  readonly principalName: string;
  readonly principalType: AzurePrincipalType;
}

function requireNonEmptyString(
  value: unknown,
  field: string,
  context: string
): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(
      `${context} did not report a usable "${field}"; the cloud journey cannot build a credential profile from it.`
    );
  return value.trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : null;
}

/**
 * Narrows `az account show -o json` into the identity the run signs in as.
 *
 * The journey types this tenant and subscription into the real credential form,
 * so a malformed or partial payload has to fail here rather than reach the
 * browser as an empty field and be reported as a validation error the product
 * was right to raise.
 */
export function readAzureAccount(payload: unknown): AzureAccount {
  const context = "az account show";
  const record = asRecord(payload);
  if (!record)
    throw new Error(
      `${context} returned no account object; sign in with \`az login\` before running the cloud journey.`
    );
  const user = asRecord(record.user);
  if (!user)
    throw new Error(
      `${context} returned no "user" object, so the caller's principal type is unknown.`
    );
  const rawType = requireNonEmptyString(user.type, "user.type", context);
  // The caller's principal type decides whether the product's owner lookup can
  // succeed at all: `az ad signed-in-user show` is Graph `/me`-backed and does
  // not exist for a service principal. Recording it keeps a failure legible
  // instead of surfacing as an opaque `app-owner-lookup-failed`.
  if (rawType !== "user" && rawType !== "servicePrincipal")
    throw new Error(
      `${context} reported an unrecognized principal type "${rawType}"; expected "user" or "servicePrincipal".`
    );
  return {
    tenantId: requireNonEmptyString(record.tenantId, "tenantId", context),
    subscriptionId: requireNonEmptyString(record.id, "id", context),
    subscriptionName: requireNonEmptyString(record.name, "name", context),
    principalName: requireNonEmptyString(user.name, "user.name", context),
    principalType: rawType
  };
}

export interface OidcSubjectCustomization {
  readonly useDefault: boolean;
  readonly useImmutableSubject?: boolean;
  readonly subClaimPrefix?: string;
}

/**
 * Narrows `gh api repos/<repo>/actions/oidc/customization/sub`.
 *
 * `use_default` must be an explicit boolean. Defaulting it would let the
 * journey assert the default subject format against a repository that
 * customizes its subject, which is the one case where a wrong expectation
 * looks exactly like a product defect.
 */
export function readOidcSubjectCustomization(
  payload: unknown
): OidcSubjectCustomization {
  const context = "the repository's OIDC subject customization";
  const record = asRecord(payload);
  if (!record) throw new Error(`${context} could not be read as an object.`);
  if (typeof record.use_default !== "boolean")
    throw new Error(
      `${context} did not report a boolean "use_default"; refusing to guess the subject format.`
    );
  const customization: {
    useDefault: boolean;
    useImmutableSubject?: boolean;
    subClaimPrefix?: string;
  } = { useDefault: record.use_default };
  if (typeof record.use_immutable_subject === "boolean")
    customization.useImmutableSubject = record.use_immutable_subject;
  if (
    typeof record.sub_claim_prefix === "string" &&
    record.sub_claim_prefix.trim() !== ""
  )
    customization.subClaimPrefix = record.sub_claim_prefix.trim();
  return customization;
}

/**
 * The trailing claim of a GitHub Actions environment subject.
 *
 * GitHub percent-escapes `:` in the environment segment, and only `:`, because
 * the separator between claims is itself a colon. An unescaped name would
 * produce a credential Entra accepts and GitHub never matches.
 */
export function environmentSubjectSuffix(environmentName: string): string {
  return `environment:${environmentName.replace(/:/g, "%3A")}`;
}

export type ExpectedSubjects =
  | { readonly supported: true; readonly required: readonly string[] }
  | { readonly supported: false; readonly reason: string };

export interface ExpectedSubjectsInput {
  /** `owner/repo`. */
  readonly fullName: string;
  readonly ownerId: unknown;
  readonly repoId: unknown;
  readonly environmentName: string;
  readonly customization: OidcSubjectCustomization;
}

function positiveId(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0)
    return String(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value.trim()))
    return value.trim();
  return null;
}

/**
 * The federated-credential subjects the run must find on the created
 * application.
 *
 * Derived from GitHub's published subject format and the repository's own
 * customization response, never from the product's derivation, so a product
 * change that starts emitting the wrong subject fails here instead of agreeing
 * with itself. Two forms exist because GitHub is migrating to immutable
 * subjects: unless GitHub explicitly reports immutable subjects, both the
 * mutable and immutable forms must be present, since either could be the one a
 * token later presents.
 */
export function expectedFederatedCredentialSubjects(
  input: ExpectedSubjectsInput
): ExpectedSubjects {
  const parts = input.fullName.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1])
    return {
      supported: false,
      reason: `"${input.fullName}" is not an owner/repo full name, so no subject can be derived.`
    };
  const [owner, repo] = parts;
  const suffix = environmentSubjectSuffix(input.environmentName);

  if (!input.customization.useDefault)
    return {
      supported: false,
      reason:
        `${input.fullName} customizes its OIDC subject claims. The cloud journey only asserts GitHub's ` +
        "default subject format, so reset the fixture repository's customization before running it."
    };

  const ownerId = positiveId(input.ownerId);
  const repoId = positiveId(input.repoId);
  if (!ownerId || !repoId)
    return {
      supported: false,
      reason: `${input.fullName} did not report positive numeric owner and repository ids, which the immutable subject form requires.`
    };

  const prefix = input.customization.subClaimPrefix?.replace(
    /^(?:repo|repository):/,
    ""
  );
  const immutableSlug =
    prefix && prefix.includes("@") ?
      prefix
    : `${owner}@${ownerId}/${repo}@${repoId}`;
  const immutable = `repo:${immutableSlug}:${suffix}`;
  if (input.customization.useImmutableSubject === true)
    return { supported: true, required: [immutable] };
  return {
    supported: true,
    required: [`repo:${owner}/${repo}:${suffix}`, immutable]
  };
}

export type WorkflowPublication =
  | { readonly outcome: "committed"; readonly paths: readonly string[] }
  | {
      readonly outcome: "pull-request";
      readonly branches: readonly string[];
      readonly pullRequests: readonly number[];
    }
  | { readonly outcome: "missing"; readonly missingPaths: readonly string[] };

export interface WorkflowPublicationInput {
  /** Paths present on the repository's default branch after the journey. */
  readonly defaultBranchPaths: Iterable<string>;
  /** `radius/setup-*` branches the product opened a pull request from. */
  readonly fallbackBranches: Iterable<string>;
  readonly openPullRequests: Iterable<number>;
  readonly requiredPaths?: readonly string[];
}

/**
 * Which publication path the product actually took.
 *
 * A token without `workflow` scope makes the product open a pull request from a
 * `radius/setup-*` branch instead of committing to the default branch. That run
 * completes, and every other assertion in the journey still passes, so without
 * this distinction the suite would report success while never testing the
 * committed-workflow path it exists to cover. The fallback is therefore checked
 * first: a fallback branch present alongside the files is still evidence the
 * committed path was not what happened.
 */
export function classifyWorkflowPublication(
  input: WorkflowPublicationInput
): WorkflowPublication {
  const branches = [...input.fallbackBranches];
  const pullRequests = [...input.openPullRequests];
  if (branches.length > 0 || pullRequests.length > 0)
    return { outcome: "pull-request", branches, pullRequests };

  const required = input.requiredPaths ?? REQUIRED_DEFAULT_BRANCH_WORKFLOWS;
  const present = new Set(input.defaultBranchPaths);
  const missingPaths = required.filter((path) => !present.has(path));
  if (missingPaths.length > 0) return { outcome: "missing", missingPaths };
  return { outcome: "committed", paths: [...required] };
}

export interface WorkflowPublicationContext {
  readonly repository: string;
  readonly defaultBranch: string;
}

/** The failure message for a publication outcome that is not `committed`. */
export function describeWorkflowPublication(
  publication: WorkflowPublication,
  context: WorkflowPublicationContext
): string {
  if (publication.outcome === "committed")
    return `${context.repository}@${context.defaultBranch} carries ${publication.paths.join(", ")}.`;
  if (publication.outcome === "pull-request")
    return (
      `The product took its pull-request fallback for ${context.repository} instead of committing to ` +
      `${context.defaultBranch}: branches ${describeList(publication.branches)}, open pull requests ` +
      `${describeList(publication.pullRequests.map((number) => `#${number}`))}. That path is taken when the ` +
      "token lacks `workflow` scope, and a run that takes it never exercises the committed-workflow path. " +
      "Grant the cloud end-to-end GitHub App `workflows: write` and re-run."
    );
  return (
    `${context.repository}@${context.defaultBranch} is missing ${describeList(publication.missingPaths)} after ` +
    "the create-environment journey completed, and no pull-request fallback explains it."
  );
}

function describeList(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

export interface EnvironmentVariableExpectation {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  readonly cluster: string;
  readonly location: string;
  readonly namespace: string;
}

export interface EnvironmentIdentityInput {
  /** The environment's variables, as GitHub reports them. */
  readonly variables: ReadonlyMap<string, string>;
  /** The `appId` of the application the product created this run. */
  readonly createdAppId: string;
  /** The identity the runner itself signs in as, when it is known. */
  readonly bootstrapClientId?: string;
  readonly expected: EnvironmentVariableExpectation;
}

function sameId(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * Everything wrong with the GitHub Environment the product created.
 *
 * `AZURE_CLIENT_ID` carries the whole security argument for this tier. In CI it
 * names the bootstrap identity, and inside the fixture repository it must name
 * the application the product just created. If the bootstrap value ever reached
 * the Environment, every later stage would authenticate as the privileged
 * runner identity and pass while proving nothing — so that specific confusion
 * is reported as its own finding rather than folded into a mismatch.
 */
export function findEnvironmentIdentityProblems(
  input: EnvironmentIdentityInput
): string[] {
  const problems: string[] = [];
  const clientId = input.variables.get("AZURE_CLIENT_ID");
  if (!clientId || clientId.trim() === "")
    problems.push(
      "AZURE_CLIENT_ID is absent or empty, so no workflow in this environment can authenticate to Azure."
    );
  else if (input.bootstrapClientId && sameId(clientId, input.bootstrapClientId))
    problems.push(
      `AZURE_CLIENT_ID is the bootstrap identity (${input.bootstrapClientId}) rather than an application the product created. ` +
        "Every later stage would authenticate as the privileged runner identity and pass while proving nothing."
    );
  else if (!sameId(clientId, input.createdAppId))
    problems.push(
      `AZURE_CLIENT_ID is "${clientId}" but the product created application "${input.createdAppId}".`
    );

  for (const [name, expected, exact] of [
    ["AZURE_TENANT_ID", input.expected.tenantId, false],
    ["AZURE_SUBSCRIPTION_ID", input.expected.subscriptionId, false],
    ["AZURE_RESOURCE_GROUP", input.expected.resourceGroup, false],
    ["AZURE_AKS_CLUSTER_NAME", input.expected.cluster, true],
    ["AZURE_LOCATION", input.expected.location, false],
    ["KUBERNETES_NAMESPACE", input.expected.namespace, true]
  ] as const) {
    const actual = input.variables.get(name);
    if (actual === undefined)
      problems.push(`${name} is absent; expected "${expected}".`);
    else if (exact ? actual !== expected : !sameId(actual, expected))
      problems.push(`${name} is "${actual}"; expected "${expected}".`);
  }
  return problems;
}

/** Parses `gh api .../environments/<name>/variables` into a lookup. */
export function readEnvironmentVariables(
  payload: unknown
): ReadonlyMap<string, string> {
  const context = "the GitHub environment's variables";
  const record = asRecord(payload);
  const list = record?.variables;
  if (!Array.isArray(list))
    throw new Error(`${context} response carried no "variables" array.`);
  const variables = new Map<string, string>();
  for (const entry of list) {
    const item = asRecord(entry);
    if (!item || typeof item.name !== "string") continue;
    variables.set(item.name, typeof item.value === "string" ? item.value : "");
  }
  return variables;
}

/** Narrows `az ad sp show --id <appId> -o json`. */
export function readServicePrincipalObjectId(payload: unknown): string {
  const record = asRecord(payload);
  const id = record?.id;
  if (typeof id !== "string" || id.trim() === "")
    throw new Error(
      'The service principal lookup returned no usable "id". Role assignments are made against the ' +
        "service principal's object id, not the application's, so the journey cannot verify them without it."
    );
  return id.trim();
}

/** The numeric ids an immutable OIDC subject is built from. */
export interface RepositoryIdentity {
  readonly ownerId: number;
  readonly repoId: number;
}

/** Narrows `gh api repos/{owner}/{repo}`. */
export function readRepositoryIdentity(payload: unknown): RepositoryIdentity {
  const record = asRecord(payload);
  const owner = asRecord(record?.owner);
  const ownerId = owner?.id;
  const repoId = record?.id;
  if (typeof ownerId !== "number" || typeof repoId !== "number")
    throw new Error(
      'The repository lookup returned no numeric "owner.id" and "id", so the immutable OIDC subject ' +
        "the product registers cannot be predicted."
    );
  return { ownerId, repoId };
}

/**
 * The workflow paths present on a branch, from `gh api .../contents/<dir>`.
 *
 * GitHub answers a missing directory with 404 rather than an empty array, and
 * the caller turns that into `[]`. Anything else that is not an array is a
 * response this cannot read, and reporting "no workflows" for it would convert
 * an unreadable answer into a confident false negative.
 */
export function readDirectoryPaths(payload: unknown): string[] {
  if (!Array.isArray(payload))
    throw new Error(
      "The repository contents listing did not return an array of entries."
    );
  const paths: string[] = [];
  for (const entry of payload) {
    const item = asRecord(entry);
    if (item && typeof item.path === "string") paths.push(item.path);
  }
  return paths;
}

/** The branch the product cuts when its token lacks `workflow` scope. */
export function workflowFallbackBranchPrefix(environmentName: string): string {
  return `radius/setup-${environmentName}-workflows-`;
}

/** Selects this run's branches from `gh api .../git/matching-refs/heads/...`. */
export function selectFallbackBranches(
  payload: unknown,
  environmentName: string
): string[] {
  if (!Array.isArray(payload))
    throw new Error("The branch listing did not return an array of branches.");
  const prefix = workflowFallbackBranchPrefix(environmentName);
  const names: string[] = [];
  for (const entry of payload) {
    const item = asRecord(entry);
    const rawName =
      typeof item?.name === "string" ? item.name
      : typeof item?.ref === "string" ? item.ref.replace(/^refs\/heads\//, "")
      : "";
    if (rawName.startsWith(prefix)) names.push(rawName);
  }
  return names;
}

/**
 * Selects this run's fallback pull requests from `gh api repos/{repo}/pulls`.
 *
 * Matched on the head ref rather than the title, because the title is prose the
 * product is free to reword while the branch name is derived.
 */
export function selectFallbackPullRequests(
  payload: unknown,
  environmentName: string
): number[] {
  if (!Array.isArray(payload))
    throw new Error(
      "The pull request listing did not return an array of pull requests."
    );
  const prefix = workflowFallbackBranchPrefix(environmentName);
  const numbers: number[] = [];
  const entries = payload.flatMap((page) =>
    Array.isArray(page) ? page : [page]
  );
  for (const entry of entries) {
    const item = asRecord(entry);
    const head = asRecord(item?.head);
    if (
      typeof item?.number === "number" &&
      typeof head?.ref === "string" &&
      head.ref.startsWith(prefix)
    )
      numbers.push(item.number);
  }
  return numbers;
}

export interface OperationSnapshot {
  readonly state: string;
  readonly terminal: boolean;
  readonly error: string;
}

export interface OperationHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly body: string;
}

/** Validates and parses one `/api/operations/{id}` HTTP response. */
export function readOperationHttpResponse(
  response: OperationHttpResponse
): unknown {
  if (!response.ok) {
    const status = `${response.status} ${response.statusText}`.trim();
    const body = response.body.trim() || "<empty body>";
    throw new Error(
      `The operation status request failed with HTTP ${status}: ${body}`
    );
  }
  return parseJsonPayload(response.body, "the operation status request");
}

/** Reads the operation id returned by `POST /api/operations`. */
export function readOperationId(payload: unknown): string {
  const operationId = asRecord(payload)?.operationId;
  if (typeof operationId !== "string" || operationId.trim() === "")
    throw new Error(
      'The create operation response carried no usable "operationId".'
    );
  return operationId.trim();
}

/**
 * Narrows one `/api/operations/{id}` poll.
 *
 * An unreadable payload fails immediately. Treating it as a non-terminal state
 * would turn a stable route or schema failure into an ambiguous 20-minute
 * timeout.
 */
export function readOperationSnapshot(payload: unknown): OperationSnapshot {
  const operation = asRecord(asRecord(payload)?.operation);
  if (!operation)
    throw new Error(
      'The operation status response carried no readable "operation" object.'
    );
  if (typeof operation.state !== "string" || operation.state.trim() === "")
    throw new Error(
      'The operation status response carried no usable "operation.state".'
    );
  if (
    operation.error !== undefined &&
    operation.error !== null &&
    typeof operation.error !== "string"
  )
    throw new Error(
      'The operation status response carried a non-string "operation.error".'
    );
  const state = operation.state.trim();
  const failure = asRecord(operation.failure);
  const rawOperationError =
    typeof operation.error === "string" ? operation.error.trim() : "";
  const error =
    typeof failure?.message === "string" && failure.message.trim() !== "" ?
      failure.message.trim()
    : rawOperationError;
  const terminalState =
    typeof operation.terminalState === "string" ?
      operation.terminalState.trim()
    : "";
  if (
    operation.terminalState !== undefined &&
    operation.terminalState !== null &&
    !TERMINAL_STATES.includes(terminalState)
  )
    throw new Error(
      'The operation status response carried an unknown "operation.terminalState".'
    );
  const terminal = terminalState !== "" || TERMINAL_STATES.includes(state);
  return {
    state,
    terminal,
    error
  };
}

/** The shape of a finished external command, narrowed to what this needs. */
export interface CommandOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Parses one command's stdout as JSON.
 *
 * Separate from `parseJsonArray` in the command port because several of the
 * probes below read objects, and treating an unparseable body as an empty
 * object would turn an unreadable answer into a confident wrong one.
 */
export function parseJsonPayload(text: string, context: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "")
    throw new Error(`${context} returned no output to parse as JSON.`);
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `${context} returned output that is not valid JSON: ${describeError(error)}`,
      { cause: error }
    );
  }
}

/**
 * The workflow files on the default branch, tolerating an absent directory.
 *
 * GitHub answers a repository with no `.github/workflows` directory with 404,
 * which is a legitimate "no workflows" rather than a probe failure — and it is
 * exactly the state a run must be able to report when the product published
 * nothing. Any other non-zero exit is a probe that could not answer, and is
 * raised rather than being read as an empty directory.
 */
export function readWorkflowDirectory(
  result: CommandOutcome,
  context: string
): string[] {
  if (result.code !== 0) {
    if (/HTTP 404/i.test(`${result.stderr}\n${result.stdout}`)) return [];
    const diagnostic =
      result.stderr.trim() || result.stdout.trim() || "<no output>";
    throw new Error(
      `${context} failed with exit code ${result.code}: ${diagnostic}`
    );
  }
  return readDirectoryPaths(parseJsonPayload(result.stdout, context));
}

export interface CloudCanvasStateInput {
  readonly repository: string;
  readonly branch: string;
  readonly workspacePath: string;
}

/**
 * The canvas state a cloud run starts from.
 *
 * Deliberately not `baseCanvasState`: that one names the hermetic fixture
 * repository and worktree branch, and seeding those here would point every real
 * `gh` call at a repository that does not exist.
 */
export function cloudCanvasState(input: CloudCanvasStateInput): CanvasState {
  return {
    contextRepo: input.repository,
    contextBranch: input.branch,
    workspacePath: input.workspacePath,
    workspaceRepo: input.repository,
    workspaceBranch: input.branch,
    graphTargetRepo: input.repository,
    graphBranch: input.branch,
    plannedRepo: input.repository,
    plannedBranch: input.branch,
    deployingRepo: input.repository,
    deployingBranch: input.branch
  };
}

export interface CleanupStep {
  readonly label: string;
  readonly run: () => Promise<void>;
}

export async function runCleanupSteps(
  steps: readonly CleanupStep[],
  primaryError?: unknown
): Promise<void> {
  const cleanupErrors: Error[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      cleanupErrors.push(
        new Error(`${step.label}: ${describeError(error)}`, { cause: error })
      );
    }
  }
  if (cleanupErrors.length === 0) return;

  if (primaryError !== undefined)
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      "The create-environment journey failed and cleanup also failed."
    );
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  throw new AggregateError(
    cleanupErrors,
    "The create-environment journey cleanup failed."
  );
}
