// Policy for the cloud journey's environment-creation edge cases.
//
// The cloud spec drives the real canvas against real Azure and GitHub. These
// helpers decide what that evidence means: which refusal codes count as the
// product stopping safely, whether an Entra application that the run does not
// own stayed unchanged, and whether a second create reused the first app. The
// rules are here, behind unit tests, so a mistake in them is found locally and
// not first by a nightly run.
import {
  isGitHubApiNotFound,
  type CloudCommandResult
} from "./cloud-command-port.js";

/** The CI variable that names the seeded application no Radius setup made. */
export const FOREIGN_APP_NAME_VARIABLE = "AIEXT_CLOUD_E2E_FOREIGN_APP_NAME";
/** The CI variable that names the seeded, unowned, Radius-tagged application. */
export const ORPHAN_APP_NAME_VARIABLE = "AIEXT_CLOUD_E2E_ORPHAN_APP_NAME";

/**
 * Codes that prove the product stopped because the Azure CLI is signed out.
 *
 * The product runs `az account set` and then `az account show` before it
 * touches anything. An empty CLI configuration fails the first; a CLI that
 * still has the subscription cached fails the second. Both stop the setup
 * before any mutation.
 */
export const SIGNED_OUT_FAILURE_CODES: readonly string[] = Object.freeze([
  "az-subscription-set-failed",
  "az-not-logged-in"
]);
export const FOREIGN_APP_FAILURE_CODES: readonly string[] = Object.freeze([
  "app-registration-not-owned"
]);
export const ORPHAN_APP_FAILURE_CODES: readonly string[] = Object.freeze([
  "app-registration-radius-orphaned"
]);

const RADIUS_MANAGED_TAG = "radius-managed";
const RADIUS_REPO_TAG_PREFIX = "radius-repo:";
const RADIUS_ENVIRONMENT_TAG_PREFIX = "radius-environment:";
const PROBE_ENVIRONMENT_NAME_LIMIT = 255;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined;
}

function requireString(value: unknown, field: string, context: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${context} returned no "${field}".`);
  return text;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * The failure code a terminal operation recorded, or "" when it recorded none.
 *
 * Read from `operation.failure.code` in the `/api/operations/:id` payload.
 */
export function readOperationFailureCode(payload: unknown): string {
  const operation = asRecord(asRecord(payload)?.operation);
  const failure = asRecord(operation?.failure);
  return typeof failure?.code === "string" ? failure.code.trim() : "";
}

/**
 * Why a refusal probe did not end the way a safe refusal must.
 *
 * A refusal is safe only when the operation failed and named one of the
 * expected codes. A success means the product acted on state it must refuse,
 * and an unexpected code means it stopped for some other reason, which proves
 * nothing about the guard under test.
 */
export function findRefusalProblems(input: {
  state: string;
  failureCode: string;
  expectedCodes: readonly string[];
}): string[] {
  const problems: string[] = [];
  if (input.state !== "failed")
    problems.push(
      `The operation ended "${input.state}", but it must end "failed".`
    );
  if (!input.expectedCodes.includes(input.failureCode))
    problems.push(
      `The operation failed with code "${input.failureCode || "<none>"}", but it must be one of: ${input.expectedCodes.join(", ")}.`
    );
  return problems;
}

export type SeededAppGate =
  { enabled: true; appName: string } | { enabled: false; reason: string };

/**
 * Whether a seeded-application probe can run.
 *
 * The seeded applications are made once by an administrator, outside CI. A run
 * without them skips that probe and says why, so the rest of the journey still
 * runs.
 */
export function evaluateSeededAppGate(
  variable: string,
  value: string | undefined
): SeededAppGate {
  const appName = value?.trim() ?? "";
  if (appName) return { enabled: true, appName };
  return {
    enabled: false,
    reason: `${variable} is not set, so this probe has no seeded Entra application to use. See docs/eng/CLOUD_E2E_RUNBOOK.md.`
  };
}

/** One Entra application, as `az ad app list -o json` reports it. */
export interface SeededAppRegistration {
  readonly appId: string;
  readonly objectId: string;
  readonly tags: readonly string[];
}

/**
 * The one application with this display name.
 *
 * Zero matches means the seed is missing. More than one means the product
 * cannot choose either, so the probe would test a different path.
 */
export function readSingleAppRegistration(
  payload: unknown,
  appName: string
): SeededAppRegistration {
  const context = `az ad app list --display-name ${appName}`;
  if (!Array.isArray(payload))
    throw new Error(`${context} did not return a list.`);
  const matches = payload
    .map((entry) => asRecord(entry))
    .filter(
      (entry): entry is Record<string, unknown> =>
        !!entry && entry.displayName === appName
    );
  if (matches.length !== 1)
    throw new Error(
      `${context} found ${matches.length} applications named "${appName}"; the probe needs exactly one.`
    );
  const [app] = matches;
  const tags = Array.isArray(app.tags) ? app.tags : [];
  return {
    appId: requireString(app.appId, "appId", context),
    objectId: requireString(app.id, "id", context),
    tags: sortedUnique(
      tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  };
}

/** The object ids in a Graph directory-object list, such as an owner list. */
export function readDirectoryObjectIds(
  payload: unknown,
  context: string
): string[] {
  if (!Array.isArray(payload))
    throw new Error(`${context} did not return a list.`);
  return sortedUnique(
    payload.map((entry) => requireString(asRecord(entry)?.id, "id", context))
  );
}

/** The subjects of an application's federated identity credentials. */
export function readFederatedCredentialSubjects(
  payload: unknown,
  context: string
): string[] {
  if (!Array.isArray(payload))
    throw new Error(`${context} did not return a list.`);
  return sortedUnique(
    payload.map((entry) =>
      requireString(asRecord(entry)?.subject, "subject", context)
    )
  );
}

/** Everything a refusal must leave unchanged on a seeded application. */
export interface SeededAppSnapshot extends SeededAppRegistration {
  readonly ownerIds: readonly string[];
  readonly federatedSubjects: readonly string[];
}

function describeListChange(
  label: string,
  before: readonly string[],
  after: readonly string[]
): string | undefined {
  if (before.join("\n") === after.join("\n")) return undefined;
  return `The ${label} changed from [${before.join(", ")}] to [${after.join(", ")}].`;
}

/**
 * How a seeded application changed while the product refused to use it.
 *
 * The refusal is the product's claim that it did nothing. Comparing the
 * identity, tags, owners, and federated credentials before and after is the
 * proof.
 */
export function findSeededAppMutationProblems(
  before: SeededAppSnapshot,
  after: SeededAppSnapshot
): string[] {
  const problems: string[] = [];
  if (before.appId !== after.appId || before.objectId !== after.objectId)
    problems.push(
      `The application identity changed from ${before.appId}/${before.objectId} to ${after.appId}/${after.objectId}.`
    );
  for (const change of [
    describeListChange("tags", before.tags, after.tags),
    describeListChange("owners", before.ownerIds, after.ownerIds),
    describeListChange(
      "federated credential subjects",
      before.federatedSubjects,
      after.federatedSubjects
    )
  ])
    if (change) problems.push(change);
  return problems;
}

function tagValue(tags: readonly string[], prefix: string): string {
  const tag = tags.find((entry) => entry.toLowerCase().startsWith(prefix));
  return tag ? tag.slice(prefix.length).trim() : "";
}

/**
 * Why a seeded application cannot prove the guard it is meant for.
 *
 * Both seeds must be unowned by the caller; otherwise the product reuses them.
 * The foreign seed must not carry the Radius tag, or the product reports an
 * orphan instead. The orphan seed must carry the Radius tags for this
 * repository and an environment, or the product reports a plain ownership
 * refusal instead.
 */
export function findSeededAppPreconditionProblems(input: {
  kind: "foreign" | "orphan";
  snapshot: SeededAppSnapshot;
  callerObjectId: string;
  repository: string;
}): string[] {
  const { kind, snapshot } = input;
  const problems: string[] = [];
  if (snapshot.ownerIds.includes(input.callerObjectId))
    problems.push(
      `The CI identity ${input.callerObjectId} owns the seeded ${kind} application, so the product would reuse it.`
    );
  const managed = snapshot.tags.includes(RADIUS_MANAGED_TAG);
  if (kind === "foreign") {
    if (managed)
      problems.push(
        `The seeded foreign application has the "${RADIUS_MANAGED_TAG}" tag; remove it, or the product reports an orphan.`
      );
    return problems;
  }
  if (!managed)
    problems.push(
      `The seeded orphan application needs the "${RADIUS_MANAGED_TAG}" tag.`
    );
  const repo = tagValue(snapshot.tags, RADIUS_REPO_TAG_PREFIX);
  if (repo.toLowerCase() !== input.repository.toLowerCase())
    problems.push(
      `The seeded orphan application needs the tag "${RADIUS_REPO_TAG_PREFIX}${input.repository}", but it has "${repo || "<none>"}".`
    );
  if (!tagValue(snapshot.tags, RADIUS_ENVIRONMENT_TAG_PREFIX))
    problems.push(
      `The seeded orphan application needs a "${RADIUS_ENVIRONMENT_TAG_PREFIX}<environment>" tag.`
    );
  return problems;
}

/**
 * The environment name the orphan probe must request.
 *
 * The product reports an orphan only for the environment named in the tag, so
 * the probe takes its name from the seed rather than inventing one.
 */
export function readOrphanEnvironmentName(tags: readonly string[]): string {
  const name = tagValue(tags, RADIUS_ENVIRONMENT_TAG_PREFIX);
  if (!name)
    throw new Error(
      `The seeded orphan application has no "${RADIUS_ENVIRONMENT_TAG_PREFIX}" tag.`
    );
  return name;
}

/**
 * The `az` arguments that print the caller's directory object id.
 *
 * A service principal has no Graph `/me`, so it is looked up by its client id.
 */
export function callerObjectIdArgs(account: {
  principalType: "user" | "servicePrincipal";
  principalName: string;
}): string[] {
  return account.principalType === "servicePrincipal" ?
      [
        "ad",
        "sp",
        "show",
        "--id",
        account.principalName,
        "--query",
        "id",
        "-o",
        "tsv"
      ]
    : ["ad", "signed-in-user", "show", "--query", "id", "-o", "tsv"];
}

export function readCallerObjectId(stdout: string): string {
  const id = stdout.trim();
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))
    throw new Error(
      `The caller's object id lookup returned "${id}", which is not a GUID.`
    );
  return id.toLowerCase();
}

/**
 * A GitHub Environment name for a refusal probe.
 *
 * It keeps the run's `radtest-` prefix, so scheduled cleanup still finds it if
 * a regression ever lets the product create it.
 */
export function probeEnvironmentName(base: string, suffix: string): string {
  const name = `${base}-${suffix}`;
  if (name.length > PROBE_ENVIRONMENT_NAME_LIMIT)
    throw new Error(
      `The probe environment name "${name}" is longer than ${PROBE_ENVIRONMENT_NAME_LIMIT} characters.`
    );
  return name;
}

/**
 * Whether `gh api repos/<repo>/environments/<name>` found the environment.
 *
 * Any failure other than 404 is a probe that could not answer, so it throws
 * rather than being read as absent.
 */
export function classifyGitHubEnvironmentProbe(
  result: CloudCommandResult,
  environmentName: string
): "present" | "absent" {
  if (result.code === 0) return "present";
  if (isGitHubApiNotFound(result)) return "absent";
  throw new Error(
    `Could not determine whether GitHub Environment "${environmentName}" exists: gh exited ${result.code}: ${(result.stderr || result.stdout).trim()}`
  );
}

/**
 * Why a second create did not reuse the application the first create made.
 */
export function findAppReuseProblems(
  created: { appId: string; objectId: string },
  reused: { appId: string; objectId: string }
): string[] {
  if (created.appId === reused.appId && created.objectId === reused.objectId)
    return [];
  return [
    `The second create used application ${reused.appId}/${reused.objectId}, but the first create made ${created.appId}/${created.objectId}.`
  ];
}

/**
 * Runs `run` with one environment variable replaced, then restores it.
 *
 * The harness host runs the product's server in this process, and the server
 * copies `process.env` each time it starts `az`. So an override here reaches
 * the product's CLI calls. The original value comes back even when `run`
 * throws, so a failed probe cannot sign out the stages after it.
 */
export async function withEnvironmentOverride<T>(
  key: string,
  value: string,
  run: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env
): Promise<T> {
  const had = Object.prototype.hasOwnProperty.call(env, key);
  const previous = env[key];
  env[key] = value;
  try {
    return await run();
  } finally {
    if (had) env[key] = previous;
    else delete env[key];
  }
}
