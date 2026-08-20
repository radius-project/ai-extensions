import {
  findLegacyMutableCredentialName,
  parseFederatedCredentials,
  selectMissingFederatedCredentials
} from "../../azure-oidc.js";
import type { AzureFederatedCredential } from "../../azure-oidc.js";
import {
  AZURE_AD_TOKEN_EXCHANGE_AUDIENCE,
  GITHUB_ACTIONS_OIDC_ISSUER
} from "../../credential-provenance.js";
import type {
  AzureAutoSetupCommandResult,
  AzureAutoSetupCredentialInput
} from "./azure-auto-setup-types.js";

interface RoleAssignmentInput {
  objectId: string;
  role: string;
  scope: string;
  subscriptionId: string;
}

interface FederatedCredential {
  name: string;
  subject: string;
}

function parseFederatedCredentialObject(
  stdout: string
): AzureFederatedCredential | null {
  try {
    const parsed = JSON.parse(stdout);
    return parseFederatedCredentials([parsed])[0] ?? null;
  } catch {
    return null;
  }
}

function hasCompleteFederatedCredentialIdentity(
  credential: AzureFederatedCredential | null
): boolean {
  return Boolean(
    credential?.id &&
    credential.name &&
    credential.subject &&
    credential.issuer &&
    credential.audiences.length > 0
  );
}

export function isReplicationLagError(stderr?: string): boolean {
  if (!stderr) return false;
  return /does not exist in the directory|PrincipalNotFound|Cannot find (?:principal|user or service principal)|No matching principal|not found in the directory/i.test(
    stderr
  );
}

export function buildRoleAssignmentArgs({
  objectId,
  role,
  scope,
  subscriptionId
}: RoleAssignmentInput): string[] {
  return [
    "role",
    "assignment",
    "create",
    "--assignee-object-id",
    objectId,
    "--assignee-principal-type",
    "ServicePrincipal",
    "--role",
    role,
    "--scope",
    scope,
    "--subscription",
    subscriptionId,
    "--output",
    "none"
  ];
}

export function findFederatedCredentialNameCollision(
  desired: Array<Partial<FederatedCredential>> | null,
  existingNameToSubject: Map<string, string> | Record<string, string> | null
): {
  name: string;
  existingSubject: string | undefined;
  desiredSubject: string;
} | null {
  if (!desired || !existingNameToSubject) return null;
  const lookup =
    existingNameToSubject instanceof Map ?
      existingNameToSubject
    : new Map(Object.entries(existingNameToSubject));
  for (const credential of desired) {
    if (!credential?.name || !credential.subject) continue;
    if (
      lookup.has(credential.name) &&
      lookup.get(credential.name) !== credential.subject
    ) {
      return {
        name: credential.name,
        existingSubject: lookup.get(credential.name),
        desiredSubject: credential.subject
      };
    }
  }
  return null;
}

export function pickAksResourceGroup(
  clusterResourceGroup: unknown,
  resourceGroup: string
): string {
  const own =
    typeof clusterResourceGroup === "string" ? clusterResourceGroup.trim() : "";
  return own || resourceGroup;
}

async function createFederatedCredentials({
  workflow,
  dependencies,
  oidc,
  oidcSuffix,
  clientId,
  tenantId,
  appName
}: Pick<
  AzureAutoSetupCredentialInput,
  | "workflow"
  | "dependencies"
  | "oidc"
  | "oidcSuffix"
  | "clientId"
  | "tenantId"
  | "appName"
>): Promise<boolean> {
  const { steps, runAz, fail, checkpoint } = workflow;
  const appResult = await runAz([
    "ad",
    "app",
    "show",
    "--id",
    clientId,
    "--query",
    "id",
    "-o",
    "tsv"
  ]);
  const applicationObjectId = appResult.stdout.trim();
  if (appResult.code !== 0 || !applicationObjectId) {
    await fail(
      400,
      `Could not resolve the Entra object id for App Registration ${clientId}.`,
      "app-object-id-failed",
      { steps, clientId, appName, azError: appResult.stderr }
    );
    return false;
  }
  const listResult = await runAz([
    "ad",
    "app",
    "federated-credential",
    "list",
    "--id",
    clientId,
    "--query",
    "[].{id:id,name:name,subject:subject,issuer:issuer,audiences:audiences}",
    "-o",
    "json"
  ]);
  let existingSubjects: string[] = [];
  let existingNameToSubject = new Map<string, string>();
  let existingCredentials: AzureFederatedCredential[] = [];
  if (listResult.code === 0) {
    try {
      const parsed = JSON.parse(listResult.stdout || "[]");
      if (Array.isArray(parsed)) {
        existingCredentials = parseFederatedCredentials(parsed);
        existingSubjects = existingCredentials
          .map((credential) => credential.subject)
          .filter(Boolean);
        existingNameToSubject = new Map(
          existingCredentials.map((credential) => [
            credential.name,
            credential.subject
          ])
        );
      }
    } catch {
      // Legacy behavior attempts every credential when the advisory list fails.
    }
  }

  const mutableCredentialName = findLegacyMutableCredentialName(
    oidc,
    oidcSuffix,
    existingNameToSubject
  );
  if (mutableCredentialName) {
    steps.push(
      `⚠️ Legacy mutable federated credential "${mutableCredentialName}" is still present. ` +
        `After immutable OIDC verification succeeds, remove it with: ` +
        `az ad app federated-credential delete --id ${clientId} ` +
        `--federated-credential-id ${mutableCredentialName}`
    );
  }
  const credentials = selectMissingFederatedCredentials(
    oidc.federatedCredentials,
    existingSubjects
  );
  const skippedCount = oidc.federatedCredentials.length - credentials.length;
  if (skippedCount > 0) {
    steps.push(
      `✅ ${skippedCount} federated credential(s) already present — skipping`
    );
  }
  const collision = findFederatedCredentialNameCollision(
    credentials,
    existingNameToSubject
  );
  if (collision) {
    await fail(
      400,
      `Federated credential name "${collision.name}" already exists with a different subject ` +
        `("${collision.existingSubject}" vs required "${collision.desiredSubject}"). Two environment ` +
        `names normalize to the same credential name — rename this environment to avoid characters ` +
        `that collapse together (for example ":" and "-").`,
      "federated-credential-name-collision",
      { steps, clientId, appName }
    );
    return false;
  }

  const recordProvenance = async (
    credential: AzureFederatedCredential,
    origin: "created" | "reused"
  ): Promise<boolean> => {
    if (!hasCompleteFederatedCredentialIdentity(credential)) {
      await fail(
        400,
        `Could not verify the complete Entra identity for federated credential "${credential.name}".`,
        "federated-credential-identity-incomplete",
        { steps, clientId, appName }
      );
      return false;
    }
    try {
      await dependencies.operations.recordFederatedCredentialProvenance(
        workflow.operation,
        {
          repo: oidc.fullName,
          repoId: oidc.repoId,
          environment: String(workflow.operation.environment || ""),
          tenantId,
          clientId,
          applicationObjectId,
          credentialId: credential.id,
          name: credential.name,
          subject: credential.subject,
          issuer: credential.issuer,
          audiences: credential.audiences,
          subjectConfig: oidc.subjectConfig,
          origin
        }
      );
    } catch (error) {
      await fail(
        500,
        `Federated credential "${credential.name}" was ${origin === "created" ? "created" : "found"}, but Radius could not save the ownership record needed for safe cleanup.`,
        "credential-provenance-write-failed",
        { steps, clientId, appName, error: String(error) }
      );
      return false;
    }
    return checkpoint();
  };

  for (const desired of oidc.federatedCredentials) {
    const existing = existingCredentials.find(
      (credential) => credential.subject === desired.subject
    );
    if (existing && !(await recordProvenance(existing, "reused"))) return false;
  }

  for (const credential of credentials) {
    steps.push(`Creating federated credential "${credential.name}"...`);
    const contents = JSON.stringify({
      name: credential.name,
      issuer: GITHUB_ACTIONS_OIDC_ISSUER,
      subject: credential.subject,
      audiences: [AZURE_AD_TOKEN_EXCHANGE_AUDIENCE]
    });
    const path = dependencies.tempFile.createPath();
    let result: AzureAutoSetupCommandResult;
    try {
      dependencies.tempFile.write(path, contents);
      result = await runAz([
        "ad",
        "app",
        "federated-credential",
        "create",
        "--id",
        clientId,
        "--parameters",
        "@" + path,
        "--query",
        "{id:id,name:name,subject:subject,issuer:issuer,audiences:audiences}",
        "-o",
        "json"
      ]);
    } finally {
      dependencies.tempFile.remove(path);
    }
    const created = result.code === 0;
    if (created) {
      dependencies.operations.recordCreatedFederatedCredential(
        workflow.operation,
        { name: credential.name, subject: credential.subject }
      );
    }
    if (result.code !== 0) {
      if (!result.stderr.includes("already exists")) {
        await fail(
          400,
          `Failed to create federated credential "${credential.name}": ` +
            result.stderr,
          "federated-credential-failed",
          { steps, clientId, appName, azError: result.stderr }
        );
        return false;
      }
    }
    const showResult = await runAz([
      "ad",
      "app",
      "federated-credential",
      "show",
      "--id",
      clientId,
      "--federated-credential-id",
      credential.name,
      "--query",
      "{id:id,name:name,subject:subject,issuer:issuer,audiences:audiences}",
      "-o",
      "json"
    ]);
    const liveCredential = parseFederatedCredentialObject(showResult.stdout);
    if (
      showResult.code !== 0 ||
      liveCredential?.subject !== credential.subject
    ) {
      await fail(
        400,
        `Federated credential "${credential.name}" ${created ? "could not be verified" : "already exists but its subject"} ` +
          `("${liveCredential?.subject || ""}") does not match the required subject ("${credential.subject}").`,
        "federated-credential-subject-mismatch",
        { steps, clientId, appName }
      );
      return false;
    }
    if (
      !liveCredential ||
      !hasCompleteFederatedCredentialIdentity(liveCredential)
    ) {
      await fail(
        400,
        `Could not verify the complete Entra identity for federated credential "${credential.name}".`,
        "federated-credential-identity-incomplete",
        { steps, clientId, appName }
      );
      return false;
    }
    steps.push(
      `✅ Federated credential "${credential.name}" ${created ? "created" : "reused"}`
    );
    if (
      !(await recordProvenance(liveCredential, created ? "created" : "reused"))
    )
      return false;
  }
  return true;
}

async function resolveServicePrincipalObjectId(
  clientId: string,
  runAz: AzureAutoSetupCredentialInput["workflow"]["runAz"],
  sleep: AzureAutoSetupCredentialInput["dependencies"]["sleep"]
): Promise<{ objectId: string; error: string }> {
  let lastError = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    const result = await runAz([
      "ad",
      "sp",
      "show",
      "--id",
      clientId,
      "--query",
      "id",
      "-o",
      "tsv"
    ]);
    const objectId = (result.stdout || "").trim();
    if (result.code === 0 && objectId) return { objectId, error: "" };
    lastError = result.stderr || result.stdout || "";
    if (attempt < 5) await sleep(2000 * (attempt + 1));
  }
  return { objectId: "", error: lastError };
}

async function assignRole(
  input: RoleAssignmentInput,
  runAz: AzureAutoSetupCredentialInput["workflow"]["runAz"],
  sleep: AzureAutoSetupCredentialInput["dependencies"]["sleep"]
): Promise<{ ok: boolean; created: boolean; stderr: string }> {
  let last: AzureAutoSetupCommandResult = {
    code: 1,
    stdout: "",
    stderr: ""
  };
  for (let attempt = 0; attempt < 6; attempt++) {
    last = await runAz(buildRoleAssignmentArgs(input));
    if (last.code === 0 || last.stderr.includes("already exists")) {
      return {
        ok: true,
        created: last.code === 0 && !last.stderr.includes("already exists"),
        stderr: ""
      };
    }
    if (!isReplicationLagError(last.stderr)) break;
    if (attempt < 5) await sleep(2000 * (attempt + 1));
  }
  return { ok: false, created: false, stderr: last.stderr };
}

export async function configureAzureAutoSetupCredentials({
  workflow,
  dependencies,
  oidc,
  oidcSuffix,
  clientId,
  tenantId,
  appName,
  subscriptionId,
  resourceGroup,
  clusterResourceGroup,
  clusterName
}: AzureAutoSetupCredentialInput): Promise<boolean> {
  const { operation, steps, runAz, fail, checkpoint } = workflow;

  steps.push("Creating Service Principal...");
  const servicePrincipal = await dependencies.ensureServicePrincipal(
    clientId,
    runAz
  );
  if (!servicePrincipal.ok) {
    await fail(
      400,
      "Could not create or find the Service Principal: " +
        servicePrincipal.stderr,
      "sp-failed",
      { steps, clientId, appName, azError: servicePrincipal.stderr }
    );
    return false;
  }
  steps.push("✅ Service Principal ready");
  dependencies.operations.recordServicePrincipal(operation, {
    state: servicePrincipal.state,
    appId: clientId,
    ...(servicePrincipal.objectId ?
      { objectId: servicePrincipal.objectId }
    : {})
  });
  if (!(await checkpoint())) return false;

  const credentialsReady =
    await dependencies.operations.withCredentialProvenanceLock(() =>
      createFederatedCredentials({
        workflow,
        dependencies,
        oidc,
        oidcSuffix,
        clientId,
        tenantId,
        appName
      })
    );
  if (!credentialsReady) {
    return false;
  }

  let servicePrincipalObjectId = servicePrincipal.objectId;
  if (!servicePrincipalObjectId) {
    steps.push("Resolving Service Principal object id...");
    const lookup = await resolveServicePrincipalObjectId(
      clientId,
      runAz,
      dependencies.sleep
    );
    if (!lookup.objectId) {
      await fail(
        400,
        "Could not resolve the Service Principal object id needed to assign Azure roles: " +
          lookup.error,
        "sp-objectid-failed",
        { steps, clientId, appName, azError: lookup.error }
      );
      return false;
    }
    servicePrincipalObjectId = lookup.objectId;
  }
  dependencies.operations.recordServicePrincipal(operation, {
    objectId: servicePrincipalObjectId
  });
  if (!(await checkpoint())) return false;

  const contributorScope = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;
  steps.push(`Assigning Contributor role on ${resourceGroup}...`);
  const contributor = await assignRole(
    {
      objectId: servicePrincipalObjectId,
      role: "Contributor",
      scope: contributorScope,
      subscriptionId
    },
    runAz,
    dependencies.sleep
  );
  if (!contributor.ok) {
    await fail(
      400,
      "Failed to assign Contributor role: " + contributor.stderr,
      "role-assignment-failed",
      { steps, clientId, appName, azError: contributor.stderr }
    );
    return false;
  }
  steps.push("✅ Contributor role assigned");
  if (contributor.created) {
    dependencies.operations.recordCreatedRoleAssignment(operation, {
      role: "Contributor",
      scope: contributorScope,
      principalObjectId: servicePrincipalObjectId
    });
    if (!(await checkpoint())) return false;
  }

  const aksResourceGroup = pickAksResourceGroup(
    clusterResourceGroup,
    resourceGroup
  );
  const clusterScope = `/subscriptions/${subscriptionId}/resourceGroups/${aksResourceGroup}/providers/Microsoft.ContainerService/managedClusters/${clusterName}`;
  steps.push(
    `Assigning Azure Kubernetes Service RBAC Cluster Admin on ${clusterName}...`
  );
  const clusterRole = await assignRole(
    {
      objectId: servicePrincipalObjectId,
      role: "Azure Kubernetes Service RBAC Cluster Admin",
      scope: clusterScope,
      subscriptionId
    },
    runAz,
    dependencies.sleep
  );
  if (clusterRole.ok) {
    steps.push("✅ AKS RBAC Cluster Admin role assigned");
    if (clusterRole.created) {
      dependencies.operations.recordCreatedRoleAssignment(operation, {
        role: "Azure Kubernetes Service RBAC Cluster Admin",
        scope: clusterScope,
        principalObjectId: servicePrincipalObjectId
      });
      if (!(await checkpoint())) return false;
    }
  } else {
    steps.push(
      "⚠️ Could not assign the AKS RBAC Cluster Admin role automatically. " +
        'If your cluster uses Azure RBAC for Kubernetes (the default for AKS Automatic) the deploy will fail at "Verify AKS Access". ' +
        `Grant it manually: az role assignment create --assignee-object-id ${servicePrincipalObjectId} --assignee-principal-type ServicePrincipal --role "Azure Kubernetes Service RBAC Cluster Admin" --scope ${clusterScope}. ` +
        "Details: " +
        clusterRole.stderr
    );
  }
  return true;
}
