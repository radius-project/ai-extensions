import {
  parseFederatedCredentials,
  type AzureFederatedCredential
} from "./platforms/setup-azure-identity.js";
import type { ProviderMutationCommandResult } from "./setup-azure-recovery.js";
export interface RoleAssignmentInput {
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

export function parseFederatedCredentialObject(
  stdout: string
): AzureFederatedCredential | null {
  try {
    const parsed = JSON.parse(stdout);
    return parseFederatedCredentials([parsed])[0] ?? null;
  } catch {
    return null;
  }
}

export const AZURE_PROPAGATION_ATTEMPTS = 6;
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

export async function readAzureWithPropagationRetry(
  read: () => Promise<ProviderMutationCommandResult>,
  sleep: (milliseconds: number) => Promise<void>,
  accept: (result: ProviderMutationCommandResult) => boolean,
  retrySuccessfulResult: (
    result: ProviderMutationCommandResult
  ) => boolean = () => false
): Promise<ProviderMutationCommandResult> {
  let last: ProviderMutationCommandResult = {
    code: 1,
    stdout: "",
    stderr: "Azure read was not attempted."
  };
  for (let attempt = 0; attempt < AZURE_PROPAGATION_ATTEMPTS; attempt++) {
    last = await read();
    if (accept(last)) return last;
    const succeeded = last.code === 0 || last.code === "0";
    const detail = last.stderr || last.stdout;
    if (
      !(
        (succeeded && retrySuccessfulResult(last)) ||
        isReplicationLagError(detail) ||
        isRetryableAzureReadFailure(detail)
      ) ||
      attempt + 1 >= AZURE_PROPAGATION_ATTEMPTS
    ) {
      break;
    }
    const delay = azureRetryDelayMs(detail, 2000 * (attempt + 1));
    if (delay === null) break;
    await sleep(delay);
  }
  return last;
}

export function parseFederatedCredentialInventory(stdout: string): {
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

export function hasCompleteFederatedCredentialIdentity(
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
  return /Request_ResourceNotFound|Directory_ObjectNotFound|does not exist(?: in the directory)?|PrincipalNotFound|Cannot find (?:principal|user or service principal)|No matching principal|not found in the directory/i.test(
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
  runAz: (args: string[]) => Promise<ProviderMutationCommandResult>,
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
