// The fixture repository's pinned baseline, and every name a cloud run derives.
//
// Two rules hold this file together:
//
// 1. The baseline commit is pinned in exactly one place. Updating the fixture
//    application is then a deliberate, reviewable SHA bump rather than an
//    invisible upstream change that rots the suite into an unexplained
//    overnight failure. The pinned SHA doubles as the cleanup reset target.
//
// 2. Names the *product* chooses are derived from the product's own rules, not
//    restated from memory. `appRegistrationName` mirrors
//    `src/server/routes/azure-auto-setup-application.ts`, so the clean-slate
//    probe looks for precisely what the product would create. Names the
//    *fixture* chooses are run-scoped so two runs never collide.

/**
 * The fixture repository does not exist yet.
 *
 * These are placeholders. Layer 4 cannot run until the repository is created
 * with a committed `.radius/` baseline and this file is updated in the same
 * change that switches the suite on. `isFixtureRepositoryProvisioned()` is what
 * stops a placeholder from masquerading as a passing cloud check.
 */
// TODO(#639): replace with the real fixture repository owner once provisioned.
export const FIXTURE_REPO_OWNER = "TODO-owner";
// TODO(#639): replace with the real fixture repository name once provisioned.
export const FIXTURE_REPO_NAME = "TODO-repo";
// TODO(#639): confirm the default branch of the provisioned repository.
export const FIXTURE_REPO_DEFAULT_BRANCH = "main";
/**
 * The commit the fixture repository is reset to before and after every run.
 *
 * TODO(#639): replace with the real baseline commit once the repository carries
 * `.radius/app.bicep`, `.radius/bicepconfig.json`, and `.radius/app.origin.json`.
 */
export const FIXTURE_BASELINE_SHA = "0".repeat(40);

/** `owner/name`, the form both `gh` and the product's OIDC lookup use. */
export const FIXTURE_REPOSITORY = `${FIXTURE_REPO_OWNER}/${FIXTURE_REPO_NAME}`;

/** Where the baseline's staged model lives inside the repository. */
export const FIXTURE_RADIUS_DIRECTORY = ".radius";

/**
 * The scheduled Cloud E2E cleanup workflow deletes tagged groups with this
 * prefix first. The shared Radius purge job also deletes `^radtest-` groups
 * older than six hours, so this prefix keeps that job as the fallback safety net
 * when our own cleanup cannot run.
 */
export const RESOURCE_GROUP_PREFIX = "radtest-canvas";

/** Branch prefix the product uses when it lacks `workflow` token scope. */
export const WORKFLOW_FALLBACK_BRANCH_PREFIX = "radius/setup-";

/** Repository-scoped mutex shared by cloud runs and scheduled cleanup. */
export const CLOUD_E2E_LEASE_REF = "refs/heads/radius/cloud-e2e-lease";

/** Commit-message field that binds a held lease to its GitHub Actions run. */
export const CLOUD_E2E_LEASE_OWNER_PREFIX = "cloud-e2e-owner-run-id:";

/**
 * Prefix every per-run GitHub Environment name carries.
 *
 * Exported rather than inlined into `environmentName` because the cleanup
 * workflow matches stale environments on it. A second copy of the prefix in
 * YAML would be a destructive operation keyed off a value nothing keeps in
 * step with this one.
 */
export const ENVIRONMENT_NAME_PREFIX = "radtest-";

const PLACEHOLDER_PATTERN = /^TODO-/;
const UNSET_SHA_PATTERN = /^0+$/;

/** The three constants that must all be real before a cloud run may proceed. */
export interface FixtureRepositoryPin {
  readonly owner: string;
  readonly name: string;
  readonly baselineSha: string;
}

export const FIXTURE_REPOSITORY_PIN: FixtureRepositoryPin = {
  owner: FIXTURE_REPO_OWNER,
  name: FIXTURE_REPO_NAME,
  baselineSha: FIXTURE_BASELINE_SHA
};

export function cloudE2ELeaseCommitMessage(githubRunId: string): string {
  const normalized = githubRunId.trim();
  if (!/^[1-9]\d*$/.test(normalized))
    throw new Error(
      `A GitHub Actions run id must be a positive integer; received "${githubRunId}".`
    );
  return `Radius Cloud E2E lease\n\n${CLOUD_E2E_LEASE_OWNER_PREFIX}${normalized}`;
}

export function parseCloudE2ELeaseOwnerRunId(
  commitMessage: unknown
): string | null {
  if (typeof commitMessage !== "string") return null;
  const ownerLine = commitMessage
    .split(/\r?\n/)
    .find((line) => line.startsWith(CLOUD_E2E_LEASE_OWNER_PREFIX));
  if (!ownerLine) return null;
  const runId = ownerLine.slice(CLOUD_E2E_LEASE_OWNER_PREFIX.length).trim();
  return /^[1-9]\d*$/.test(runId) ? runId : null;
}

/**
 * Which of the pinned constants still hold placeholder values.
 *
 * Takes the pin as a parameter rather than reading the constants directly, so
 * the rule is provable in both directions today. The day someone provisions the
 * repository the guard must already be known to answer yes — discovering that
 * for the first time during a cloud run is the silent failure this layer exists
 * to prevent.
 */
export function findUnprovisionedFixtureFields(
  pin: FixtureRepositoryPin = FIXTURE_REPOSITORY_PIN
): string[] {
  const missing: string[] = [];
  if (PLACEHOLDER_PATTERN.test(pin.owner)) missing.push("FIXTURE_REPO_OWNER");
  if (PLACEHOLDER_PATTERN.test(pin.name)) missing.push("FIXTURE_REPO_NAME");
  if (UNSET_SHA_PATTERN.test(pin.baselineSha))
    missing.push("FIXTURE_BASELINE_SHA");
  return missing;
}

/**
 * Whether the constants above name a real repository.
 *
 * The live conformance check and, from layer 4, the journey skip on this. A
 * placeholder must never be able to produce a green cloud result.
 */
export function isFixtureRepositoryProvisioned(
  pin: FixtureRepositoryPin = FIXTURE_REPOSITORY_PIN
): boolean {
  return findUnprovisionedFixtureFields(pin).length === 0;
}

/** Explains, in a skip message, exactly what is still missing. */
export function describeUnprovisionedFixtureRepository(
  pin: FixtureRepositoryPin = FIXTURE_REPOSITORY_PIN
): string {
  const missing = findUnprovisionedFixtureFields(pin);
  return missing.length === 0 ?
      "The fixture repository is provisioned."
    : `The fixture repository is not provisioned yet: ${missing.join(", ")} still hold placeholder values in test/e2e-cloud/support/fixture-repository.ts.`;
}

/**
 * The per-run resource group. Everything the fixture creates lives here, so
 * teardown targets one name and never a wildcard.
 */
export function resourceGroupName(uniqueId: string): string {
  return `${RESOURCE_GROUP_PREFIX}-${requireUniqueId(uniqueId)}`;
}

/** The per-run AKS cluster, which exists only so `az aks list` finds it. */
export function clusterName(uniqueId: string): string {
  return `aks-${requireUniqueId(uniqueId)}`;
}

/**
 * The per-run GitHub Environment name.
 *
 * Environment naming is what carries per-run isolation on a long-lived fixture
 * repository, so it must be unique even though the app registration name (see
 * below) cannot be.
 */
export function environmentName(uniqueId: string): string {
  return `${ENVIRONMENT_NAME_PREFIX}${requireUniqueId(uniqueId)}`;
}

/**
 * The app registration the product creates, derived from
 * `azure-auto-setup-application.ts`:
 *
 *     let appName = `radius-deploy-${oidc.fullName.replace("/", "-")}`;
 *
 * Note this is scoped to the repository only — not to the environment and not
 * to the run. Two concurrent runs against one fixture repository therefore
 * share a single app registration name. That is the product's rule and the
 * fixture must not "fix" it by inventing a run-scoped name, or the clean-slate
 * probe would stop looking for the thing the product actually creates. Runs are
 * serialized by CI concurrency instead.
 */
export function appRegistrationName(repository = FIXTURE_REPOSITORY): string {
  return `radius-deploy-${repository.replace("/", "-")}`;
}

/** The resource-group scope the product assigns `Contributor` at. */
export function resourceGroupScope(
  subscriptionId: string,
  resourceGroup: string
): string {
  return `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;
}

/**
 * A run id short enough for Azure's name limits and containing nothing that
 * would need escaping in a resource name.
 */
export function shortenUniqueId(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!normalized)
    throw new Error(
      `A run unique id must contain at least one alphanumeric character; received "${value}".`
    );
  return normalized.slice(0, 12);
}

function requireUniqueId(value: string): string {
  if (!value || !value.trim())
    throw new Error("A run unique id is required to name cloud resources.");
  return value;
}

/**
 * An Azure region token: lowercase letters and digits, beginning with a letter,
 * as in `westus3` or `eastus2euap`. Deliberately narrow. The value reaches
 * `az group create --location`, so anything unexpected should be rejected here
 * with a readable message rather than surfacing forty minutes later as an
 * opaque `az` failure that triages as an infrastructure fault.
 */
const AZURE_REGION_PATTERN = /^[a-z]+[a-z0-9]*$/;

/**
 * The region CI asks for, or `undefined` to leave the fixture's own default.
 *
 * `AIEXT_CLOUD_E2E_AZURE_LOCATION` is published by the upstream Terraform so the
 * region can move without a code change. It is absent locally and absent until
 * that Terraform is applied, and an absent value must mean "use the default"
 * rather than "use the empty string" — `az group create --location ""` fails in
 * a way that looks nothing like a missing variable.
 */
export function resolveFixtureLocation(
  value: string | undefined
): string | undefined {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return undefined;
  if (!AZURE_REGION_PATTERN.test(normalized))
    throw new Error(
      `AIEXT_CLOUD_E2E_AZURE_LOCATION must be an Azure region such as "westus3"; received "${value}".`
    );
  return normalized;
}
