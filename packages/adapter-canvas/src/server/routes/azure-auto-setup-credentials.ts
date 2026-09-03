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
import {
  providerMutationRecord,
  unresolvedProviderMutations
} from "../../operations.js";
import type {
  AzureAutoSetupCommandResult,
  AzureAutoSetupCredentialInput
} from "./azure-auto-setup-types.js";
import {
  deterministicProviderUuid,
  executeRecoverableMutation,
  providerMutationWillWrite
} from "../services/provider-mutation-recovery.js";

interface RoleAssignmentInput {
  assignmentId?: string;
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

const AZURE_PROPAGATION_ATTEMPTS = 6;
const MAX_RETRY_DELAY_MS = 10_000;

export function isRetryableAzureReadFailure(stderr?: string): boolean {
  const detail = stderr || "";
  if (
    /(?:HTTP\s*(?:401|403)|AuthorizationFailed|InvalidAuthenticationToken|Authentication_Unauthorized|Authorization_RequestDenied|Insufficient privileges)/i.test(
      detail
    )
  ) {
    return false;
  }
  return /(?:HTTP\s*(?:429|5\d\d)|TooManyRequests|ECONNRESET|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|temporarily unavailable|service unavailable|gateway time-?out)/i.test(
    detail
  );
}

export function azureRetryDelayMs(
  stderr: string | undefined,
  fallbackMs: number,
  nowMs = Date.now()
): number | null {
  const value = /Retry-After\s*:\s*([^\r\n]+)/i.exec(stderr || "")?.[1]?.trim();
  if (!value) return Math.min(fallbackMs, MAX_RETRY_DELAY_MS);
  const seconds = Number(value);
  const requested =
    Number.isFinite(seconds) && seconds >= 0 ?
      seconds * 1000
    : Date.parse(value) - nowMs;
  const delay = Math.max(
    0,
    Number.isFinite(requested) ? requested : fallbackMs
  );
  return delay > MAX_RETRY_DELAY_MS ? null : delay;
}

function parseFederatedCredentialInventory(stdout: string): {
  subjects: string[];
  nameToSubject: Map<string, string>;
} | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return null;
    const credentials: FederatedCredential[] = [];
    for (const value of parsed) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null;
      }
      const entry = value as { name?: unknown; subject?: unknown };
      const claimsMatchingExpression = (
        value as { claimsMatchingExpression?: unknown }
      ).claimsMatchingExpression;
      const subject =
        typeof entry.subject === "string" ? entry.subject.trim() : "";
      const hasClaimsMatchingExpression =
        (typeof claimsMatchingExpression === "string" &&
          claimsMatchingExpression.trim() !== "") ||
        (typeof claimsMatchingExpression === "object" &&
          claimsMatchingExpression !== null &&
          !Array.isArray(claimsMatchingExpression));
      if (
        typeof entry.name !== "string" ||
        !entry.name.trim() ||
        (!subject && !hasClaimsMatchingExpression)
      ) {
        return null;
      }
      credentials.push({
        name: entry.name.trim(),
        subject
      });
    }
    return {
      subjects: credentials.map((credential) => credential.subject),
      nameToSubject: new Map(
        credentials.map((credential) => [credential.name, credential.subject])
      )
    };
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

function isRollbackPending(operation: { providerRecovery?: unknown }): boolean {
  const recovery = operation.providerRecovery;
  return (
    recovery !== null &&
    typeof recovery === "object" &&
    "state" in recovery &&
    recovery.state === "rollback_pending"
  );
}

export function isReplicationLagError(stderr?: string): boolean {
  if (!stderr) return false;
  return /does not exist in the directory|PrincipalNotFound|Cannot find (?:principal|user or service principal)|No matching principal|not found in the directory/i.test(
    stderr
  );
}

export function buildRoleAssignmentArgs({
  assignmentId,
  objectId,
  role,
  scope,
  subscriptionId
}: RoleAssignmentInput): string[] {
  return [
    "role",
    "assignment",
    "create",
    ...(assignmentId ? ["--name", assignmentId] : []),
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

/**
 * The federated credential's own object id, from the create response.
 *
 * `az ad app federated-credential create` answers with the object it made, so
 * the id is settled with the mutation rather than read back afterwards. A
 * follow-up read can fail for a moment of Graph replication lag, and a null id
 * is terminal: a credential Radius cannot identify by id is one it will never
 * delete automatically.
 */
export function federatedCredentialIdFrom(
  stdout: string | undefined
): string | null {
  try {
    const parsed: unknown = JSON.parse((stdout || "").trim() || "null");
    if (!parsed || typeof parsed !== "object") return null;
    const id = (parsed as { id?: unknown }).id;
    return typeof id === "string" && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The federated credential's own object id, or nothing.
 *
 * Nothing is a refusal rather than a gap: a credential Radius cannot identify
 * by id is one it will not delete automatically, because the name it would
 * otherwise delete by belongs to whoever holds it next.
 */
export async function readFederatedCredentialId(
  runAz: (args: string[]) => Promise<AzureAutoSetupCommandResult>,
  clientId: string,
  name: string
): Promise<string | null> {
  try {
    const shown = await runAz([
      "ad",
      "app",
      "federated-credential",
      "show",
      "--id",
      clientId,
      "--federated-credential-id",
      name,
      "--query",
      "id",
      "-o",
      "tsv"
    ]);
    if (shown.code !== 0 && shown.code !== "0") return null;
    const id = String(shown.stdout || "").trim();
    return id || null;
  } catch {
    return null;
  }
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
  const { steps, runAz, fail, stopBoundary, checkpoint } = workflow;
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
  const listArgs = [
    "ad",
    "app",
    "federated-credential",
    "list",
    "--id",
    clientId,
    "--query",
    "[].{id:id,name:name,subject:subject,issuer:issuer,audiences:audiences,claimsMatchingExpression:claimsMatchingExpression}",
    "-o",
    "json"
  ];
  let listResult: AzureAutoSetupCommandResult | null = null;
  for (let attempt = 0; attempt < AZURE_PROPAGATION_ATTEMPTS; attempt++) {
    listResult = await runAz(listArgs);
    if (listResult.code === 0 || listResult.code === "0") break;
    const detail = listResult.stderr || listResult.stdout;
    if (
      !isRetryableAzureReadFailure(detail) ||
      attempt + 1 >= AZURE_PROPAGATION_ATTEMPTS
    ) {
      break;
    }
    const delay = azureRetryDelayMs(detail, 2000 * (attempt + 1));
    if (delay === null) break;
    await dependencies.sleep(delay);
  }
  if (!listResult || (listResult.code !== 0 && listResult.code !== "0")) {
    await fail(
      400,
      "Could not read the App Registration federated credentials: " +
        (listResult?.stderr ||
          listResult?.stdout ||
          "Azure CLI request failed."),
      "federated-credential-list-failed",
      { steps, clientId, appName, azError: listResult?.stderr || "" }
    );
    return false;
  }
  const inventory = parseFederatedCredentialInventory(listResult.stdout);
  if (!inventory) {
    await fail(
      400,
      "Microsoft Entra returned an invalid federated credential list.",
      "federated-credential-list-malformed",
      { steps, clientId, appName }
    );
    return false;
  }
  const existingSubjects = inventory.subjects;
  const existingNameToSubject = inventory.nameToSubject;
  let existingCredentials: AzureFederatedCredential[] = [];
  try {
    const parsed = JSON.parse(listResult.stdout || "[]");
    if (Array.isArray(parsed)) {
      existingCredentials = parseFederatedCredentials(parsed);
    }
  } catch {
    // The inventory parse above already validated the payload shape; leave the
    // full-identity list empty and fall back to per-credential verification.
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
  const ordinarilyMissing = selectMissingFederatedCredentials(
    oidc.federatedCredentials,
    existingSubjects
  );
  const credentials = oidc.federatedCredentials.filter((credential) => {
    const pending = providerMutationRecord(
      workflow.operation,
      "azure_federated_credential.create",
      `${clientId}:${credential.name}`
    );
    return (
      pending?.status === "prepared" ||
      pending?.status === "outcome_unknown" ||
      pending?.status === "confirmed" ||
      ordinarilyMissing.some(
        (missing) =>
          missing.name === credential.name &&
          missing.subject === credential.subject
      )
    );
  });
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
    return checkpoint(
      `after-record-credential-provenance:${origin}:${credential.name}`
    );
  };

  for (const desired of oidc.federatedCredentials) {
    const existing = existingCredentials.find(
      (credential) => credential.subject === desired.subject
    );
    if (existing && !(await recordProvenance(existing, "reused"))) return false;
  }

  for (const credential of credentials) {
    steps.push(`Creating federated credential "${credential.name}"...`);
    const credentialTarget = `${clientId}:${credential.name}`;
    // Only a forward create is stoppable. A credential listed here because its
    // journal entry is still open needs the reconciling read to settle it.
    if (
      providerMutationWillWrite(
        workflow.operation,
        "azure_federated_credential.create",
        credentialTarget
      ) &&
      !(await stopBoundary(
        `before-federated-credential-create:${credential.name}`
      ))
    )
      return false;
    const contents = JSON.stringify({
      name: credential.name,
      issuer: GITHUB_ACTIONS_OIDC_ISSUER,
      subject: credential.subject,
      audiences: [AZURE_AD_TOKEN_EXCHANGE_AUDIENCE],
      description: `Created by Radius operation ${workflow.operation.operationId}`
    });
    const path = dependencies.tempFile.createPath();
    let result: AzureAutoSetupCommandResult;
    try {
      dependencies.tempFile.write(path, contents);
      const mutation =
        await executeRecoverableMutation<AzureAutoSetupCommandResult>({
          operation: workflow.operation,
          kind: "azure_federated_credential.create",
          target: credentialTarget,
          persist: dependencies.operations.persist,
          beforeMutation: () =>
            stopBoundary(
              `before-federated-credential-create:${credential.name}`
            ),
          mutate: () =>
            runAz([
              "ad",
              "app",
              "federated-credential",
              "create",
              "--id",
              clientId,
              "--parameters",
              "@" + path,
              "--query",
              "{id:id,name:name,subject:subject,issuer:issuer,audiences:audiences,description:description}",
              "-o",
              "json"
            ]),
          accept: (value) => value,
          providerIdOf: (result) => federatedCredentialIdFrom(result.stdout),
          reconcile: async () => {
            const shown = await runAz([
              "ad",
              "app",
              "federated-credential",
              "show",
              "--id",
              clientId,
              "--federated-credential-id",
              credential.name,
              "--query",
              "{id:id,subject:subject,description:description}",
              "-o",
              "json"
            ]);
            if (shown.code !== 0 && shown.code !== "0") {
              if (
                /not found|does not exist/i.test(shown.stderr || shown.stdout)
              ) {
                return {
                  state: "not_applied" as const,
                  evidence:
                    "Microsoft Entra confirmed the federated credential is absent."
                };
              }
              throw new Error(
                shown.stderr ||
                  shown.stdout ||
                  "The federated credential could not be read."
              );
            }
            let actual: {
              id?: unknown;
              subject?: unknown;
              description?: unknown;
            };
            try {
              actual = JSON.parse(shown.stdout) as {
                id?: unknown;
                subject?: unknown;
                description?: unknown;
              };
            } catch {
              throw new Error(
                "Microsoft Entra returned unreadable federated credential state."
              );
            }
            if (
              actual.subject !== credential.subject ||
              actual.description !==
                `Created by Radius operation ${workflow.operation.operationId}`
            ) {
              return {
                state: "manual_required" as const,
                guidance:
                  `Federated credential "${credential.name}" exists, but its subject or Radius operation provenance does not match. ` +
                  "Radius will not overwrite or delete it."
              };
            }
            return {
              state: "applied" as const,
              value: { code: 0, stdout: shown.stdout, stderr: "" },
              evidence:
                "The credential name, subject, and Radius operation provenance matched."
            };
          }
        });
      if (mutation.state === "cancelled") return false;
      result =
        mutation.state === "applied" ?
          mutation.value
        : mutation.result || {
            code: 1,
            stdout: "",
            stderr:
              "Microsoft Entra confirmed the federated credential was not created."
          };
    } finally {
      dependencies.tempFile.remove(path);
    }
    const created = result.code === 0;
    if (created) {
      // Record rollback authority before live verification. If verification
      // fails, the operation must still remember the object it just created.
      dependencies.operations.recordCreatedFederatedCredential(
        workflow.operation,
        {
          name: credential.name,
          subject: credential.subject,
          providerId:
            providerMutationRecord(
              workflow.operation,
              "azure_federated_credential.create",
              `${clientId}:${credential.name}`
            )?.providerId ||
            (await readFederatedCredentialId(runAz, clientId, credential.name))
        }
      );
      if (
        !(await checkpoint(
          `after-federated-credential-create:${credential.name}`
        ))
      )
        return false;
    }
    if (result.code !== 0) {
      if (
        !(await checkpoint(
          `after-federated-credential-create-attempt:${credential.name}`
        ))
      )
        return false;
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
  const unresolvedCredentials = unresolvedProviderMutations(
    workflow.operation
  ).filter((mutation) => mutation.kind === "azure_federated_credential.create");
  if (unresolvedCredentials.length > 0) {
    await fail(
      409,
      "Provider reconciliation is still pending. Radius will not complete setup or start another provider mutation.",
      "provider-reconciliation-pending",
      { steps, clientId, appName }
    );
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
  for (let attempt = 0; attempt < AZURE_PROPAGATION_ATTEMPTS; attempt++) {
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
    if (
      !isReplicationLagError(lastError) &&
      !isRetryableAzureReadFailure(lastError)
    ) {
      break;
    }
    if (attempt + 1 < AZURE_PROPAGATION_ATTEMPTS) {
      const delay = azureRetryDelayMs(lastError, 2000 * (attempt + 1));
      if (delay === null) break;
      await sleep(delay);
    }
  }
  return { objectId: "", error: lastError };
}

async function assignRole(
  input: RoleAssignmentInput,
  operation: AzureAutoSetupCredentialInput["workflow"]["operation"],
  persist: () => Promise<void>,
  runAz: AzureAutoSetupCredentialInput["workflow"]["runAz"],
  sleep: AzureAutoSetupCredentialInput["dependencies"]["sleep"],
  stopBoundary: AzureAutoSetupCredentialInput["workflow"]["stopBoundary"]
): Promise<
  | { ok: true; created: boolean; stderr: "" }
  | { ok: false; stopped: true; created: false; stderr: "" }
  | { ok: false; stopped?: false; created: false; stderr: string }
> {
  let last: AzureAutoSetupCommandResult = {
    code: 1,
    stdout: "",
    stderr: ""
  };
  const mutationKind = "azure_role_assignment.create";
  const mutationTarget =
    input.assignmentId || `${input.objectId}:${input.role}:${input.scope}`;
  for (let attempt = 0; attempt < AZURE_PROPAGATION_ATTEMPTS; attempt++) {
    const attemptNumber = attempt + 1;
    // Only a forward attempt is stoppable. A journaled attempt that reaches here
    // to be reconciled is a read, and stopping before it would strand the
    // provenance of a request nobody saw answered.
    if (
      providerMutationWillWrite(operation, mutationKind, mutationTarget) &&
      !(await stopBoundary(
        `before-role-assignment:${input.role}:attempt-${attemptNumber}`
      ))
    ) {
      return { ok: false, stopped: true, created: false, stderr: "" };
    }
    const mutation =
      await executeRecoverableMutation<AzureAutoSetupCommandResult>({
        operation,
        kind: mutationKind,
        target: mutationTarget,
        providerIdempotencyKey: input.assignmentId || null,
        persist,
        beforeMutation: () =>
          stopBoundary(
            `before-role-assignment:${input.role}:attempt-${attemptNumber}`
          ),
        mutate: () => runAz(buildRoleAssignmentArgs(input)),
        accept: (value) => value,
        createdByOperation: (value) => !value.stderr.includes("already exists"),
        reconcile: async () => {
          if (!input.assignmentId) {
            return {
              state: "manual_required" as const,
              guidance:
                "Radius cannot reconcile this role assignment without its deterministic provider ID."
            };
          }
          const listed = await runAz([
            "role",
            "assignment",
            "list",
            "--scope",
            input.scope,
            "--query",
            `[?name=='${input.assignmentId}'].{id:id,principalId:principalId,roleDefinitionName:roleDefinitionName,scope:scope}`,
            "-o",
            "json"
          ]);
          if (listed.code !== 0 && listed.code !== "0") {
            if (
              /not found|does not exist/i.test(listed.stderr || listed.stdout)
            ) {
              return {
                state: "not_applied" as const,
                evidence:
                  "Azure confirmed the deterministic assignment ID is absent."
              };
            }
            throw new Error(
              listed.stderr ||
                listed.stdout ||
                "The Azure role assignment could not be read."
            );
          }
          let matches: Array<{
            id?: unknown;
            principalId?: unknown;
            roleDefinitionName?: unknown;
            scope?: unknown;
          }>;
          try {
            matches = JSON.parse(listed.stdout) as typeof matches;
          } catch {
            throw new Error("Azure returned unreadable role assignment state.");
          }
          if (!Array.isArray(matches)) {
            throw new Error("Azure returned unreadable role assignment state.");
          }
          if (matches.length === 0) {
            return {
              state: "not_applied" as const,
              evidence:
                "Azure confirmed the deterministic assignment ID is absent."
            };
          }
          const actual = matches.length === 1 ? matches[0] : undefined;
          if (
            !actual ||
            typeof actual.id !== "string" ||
            !actual.id
              .toLowerCase()
              .endsWith(`/${input.assignmentId.toLowerCase()}`) ||
            actual.principalId !== input.objectId ||
            actual.roleDefinitionName !== input.role ||
            typeof actual.scope !== "string" ||
            actual.scope.toLowerCase() !== input.scope.toLowerCase()
          ) {
            return {
              state: "manual_required" as const,
              guidance:
                `Azure role assignment "${input.assignmentId}" exists, but its principal, role, or scope does not match this operation. ` +
                "Radius will not modify or delete it."
            };
          }
          return {
            state: "applied" as const,
            value: {
              code: 0,
              stdout: listed.stdout,
              stderr:
                (
                  providerMutationRecord(
                    operation,
                    mutationKind,
                    mutationTarget
                  )?.createdByOperation === false
                ) ?
                  "already exists"
                : ""
            },
            evidence:
              "The deterministic assignment ID, principal, role, and scope matched."
          };
        }
      });
    if (mutation.state === "cancelled") {
      return { ok: false, stopped: true, created: false, stderr: "" };
    }
    last =
      mutation.state === "applied" ?
        mutation.value
      : mutation.result || {
          code: 1,
          stdout: "",
          stderr: "Azure confirmed the role assignment was not created."
        };
    if (last.code === 0) {
      return {
        ok: true,
        created: !last.stderr.includes("already exists"),
        stderr: ""
      };
    }
    if (
      !(await stopBoundary(
        `after-role-assignment-attempt:${input.role}:attempt-${attemptNumber}`
      ))
    ) {
      return { ok: false, stopped: true, created: false, stderr: "" };
    }
    if (last.stderr.includes("already exists")) {
      return { ok: true, created: false, stderr: "" };
    }
    const failureDetail = last.stderr || last.stdout;
    if (
      !isReplicationLagError(failureDetail) &&
      !isRetryableAzureReadFailure(failureDetail)
    ) {
      break;
    }
    if (attempt + 1 < AZURE_PROPAGATION_ATTEMPTS) {
      if (
        !(await stopBoundary(
          `before-role-assignment-backoff:${input.role}:attempt-${attemptNumber}`
        ))
      ) {
        return { ok: false, stopped: true, created: false, stderr: "" };
      }
      const delay = azureRetryDelayMs(failureDetail, 2000 * attemptNumber);
      if (delay === null) break;
      await sleep(delay);
    }
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
  const { operation, steps, runAz, fail, stopBoundary, checkpoint } = workflow;

  // Reconciliation may have decided this attempt must be undone while the
  // request that reached here was still in flight. Every mutation below adds a
  // resource to a set the rollback has already been selected for, so the halt
  // comes before the first one rather than after it.
  if (isRollbackPending(operation)) {
    await fail(
      409,
      "Radius reconciled an interrupted provider request and must delete the setup resources before creating a Service Principal.",
      "provider-rollback-pending",
      { steps, clientId, appName }
    );
    return false;
  }
  steps.push("Creating Service Principal...");
  const servicePrincipal = await dependencies.ensureServicePrincipal(
    clientId,
    runAz,
    {
      operation,
      persist: dependencies.operations.persist
    },
    () => stopBoundary("before-service-principal-create")
  );
  if (!servicePrincipal.ok) {
    if (servicePrincipal.stopped) return false;
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
  if (servicePrincipal.state === "created_candidate") {
    steps.push(
      "ℹ️ The Service Principal was absent before this step and present after it, but the create command did not report success, so Radius cannot prove it created it and will not remove it during setup deletion."
    );
  }
  dependencies.operations.recordServicePrincipal(operation, {
    state: servicePrincipal.state,
    origin: servicePrincipal.origin,
    appId: clientId,
    ...(servicePrincipal.objectId ?
      { objectId: servicePrincipal.objectId }
    : {})
  });
  if (!(await checkpoint("after-service-principal"))) return false;

  if (isRollbackPending(operation)) {
    await fail(
      409,
      "Radius reconciled the interrupted Service Principal request and must delete the setup resources before adding federated credentials.",
      "provider-rollback-pending",
      { steps, clientId, appName }
    );
    return false;
  }
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
  if (isRollbackPending(operation)) {
    await fail(
      409,
      "Radius reconciled an interrupted federated credential request and must delete the setup resources before assigning Azure roles.",
      "provider-rollback-pending",
      { steps, clientId, appName }
    );
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
  if (!(await checkpoint("after-service-principal-object-id"))) return false;

  const contributorScope = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;
  const contributorAssignmentId = deterministicProviderUuid(
    `${operation.operationId}\0${servicePrincipalObjectId}\0Contributor\0${contributorScope}`
  );
  steps.push(`Assigning Contributor role on ${resourceGroup}...`);
  const contributor = await assignRole(
    {
      objectId: servicePrincipalObjectId,
      assignmentId: contributorAssignmentId,
      role: "Contributor",
      scope: contributorScope,
      subscriptionId
    },
    operation,
    dependencies.operations.persist,
    runAz,
    dependencies.sleep,
    stopBoundary
  );
  if (!contributor.ok) {
    if (contributor.stopped) return false;
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
      assignmentId: contributorAssignmentId,
      role: "Contributor",
      scope: contributorScope,
      principalObjectId: servicePrincipalObjectId
    });
    if (!(await checkpoint("after-role-assignment:Contributor"))) return false;
  }
  if (isRollbackPending(operation)) {
    await fail(
      409,
      "Radius reconciled the interrupted Contributor assignment and must delete the setup resources before any further provider changes.",
      "provider-rollback-pending",
      { steps, clientId, appName }
    );
    return false;
  }

  const aksResourceGroup = pickAksResourceGroup(
    clusterResourceGroup,
    resourceGroup
  );
  const clusterScope = `/subscriptions/${subscriptionId}/resourceGroups/${aksResourceGroup}/providers/Microsoft.ContainerService/managedClusters/${clusterName}`;
  const clusterAssignmentId = deterministicProviderUuid(
    `${operation.operationId}\0${servicePrincipalObjectId}\0Azure Kubernetes Service RBAC Cluster Admin\0${clusterScope}`
  );
  steps.push(
    `Assigning Azure Kubernetes Service RBAC Cluster Admin on ${clusterName}...`
  );
  const clusterRole = await assignRole(
    {
      objectId: servicePrincipalObjectId,
      assignmentId: clusterAssignmentId,
      role: "Azure Kubernetes Service RBAC Cluster Admin",
      scope: clusterScope,
      subscriptionId
    },
    operation,
    dependencies.operations.persist,
    runAz,
    dependencies.sleep,
    stopBoundary
  );
  if (clusterRole.ok) {
    steps.push("✅ AKS RBAC Cluster Admin role assigned");
    if (clusterRole.created) {
      dependencies.operations.recordCreatedRoleAssignment(operation, {
        assignmentId: clusterAssignmentId,
        role: "Azure Kubernetes Service RBAC Cluster Admin",
        scope: clusterScope,
        principalObjectId: servicePrincipalObjectId
      });
      if (
        !(await checkpoint(
          "after-role-assignment:Azure Kubernetes Service RBAC Cluster Admin"
        ))
      )
        return false;
    }
  } else if (clusterRole.stopped) {
    return false;
  } else {
    steps.push(
      "⚠️ Could not assign the AKS RBAC Cluster Admin role automatically. " +
        'If your cluster uses Azure RBAC for Kubernetes (the default for AKS Automatic) the deploy will fail at "Verify AKS Access". ' +
        `Grant it manually: az role assignment create --assignee-object-id ${servicePrincipalObjectId} --assignee-principal-type ServicePrincipal --role "Azure Kubernetes Service RBAC Cluster Admin" --scope ${clusterScope}. ` +
        "Details: " +
        clusterRole.stderr
    );
  }
  if (isRollbackPending(operation)) {
    await fail(
      409,
      "Radius reconciled the interrupted AKS role assignment and must delete the setup resources before setup can complete.",
      "provider-rollback-pending",
      { steps, clientId, appName }
    );
    return false;
  }

  // Contributor cannot manage Microsoft.Authorization/locks. Locks Contributor
  // (28bf596f-4eb7-45ce-b5bc-6cf482fec137) grants only the lock read, write, and
  // delete actions needed by recipes that create CanNotDelete locks.
  //
  // Best-effort and non-fatal, like the AKS cluster role: the operator may not
  // be allowed to create role assignments, and applications that never request
  // a lock work without this role.
  const locksContributorAssignmentId = deterministicProviderUuid(
    `${operation.operationId}\0${servicePrincipalObjectId}\0Locks Contributor\0${contributorScope}`
  );
  steps.push(
    `Assigning Locks Contributor on ${resourceGroup} (required to manage resource locks)...`
  );
  const locksContributor = await assignRole(
    {
      objectId: servicePrincipalObjectId,
      assignmentId: locksContributorAssignmentId,
      role: "Locks Contributor",
      scope: contributorScope,
      subscriptionId
    },
    operation,
    dependencies.operations.persist,
    runAz,
    dependencies.sleep,
    stopBoundary
  );
  if (locksContributor.ok) {
    steps.push("✅ Locks Contributor role assigned");
    if (locksContributor.created) {
      dependencies.operations.recordCreatedRoleAssignment(operation, {
        assignmentId: locksContributorAssignmentId,
        role: "Locks Contributor",
        scope: contributorScope,
        principalObjectId: servicePrincipalObjectId
      });
      if (!(await checkpoint("after-role-assignment:Locks Contributor")))
        return false;
    }
  } else if (locksContributor.stopped) {
    return false;
  } else {
    steps.push(
      "⚠️ Could not assign the Locks Contributor role automatically. " +
        "Applications whose recipes set a resource lock will fail to deploy, and " +
        'existing locked resources will fail to delete with "AuthorizationFailed". ' +
        `Grant the least-privilege role manually: az role assignment create --assignee-object-id ${servicePrincipalObjectId} --assignee-principal-type ServicePrincipal --role "Locks Contributor" --scope ${contributorScope}. ` +
        "Details: " +
        locksContributor.stderr
    );
  }
  if (isRollbackPending(operation)) {
    await fail(
      409,
      "Radius reconciled the interrupted Locks Contributor role assignment and must delete the setup resources before setup can complete.",
      "provider-rollback-pending",
      { steps, clientId, appName }
    );
    return false;
  }
  return true;
}
