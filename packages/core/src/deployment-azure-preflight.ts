import {
  resolveOidcSubject,
  type GitHubJsonRunner,
  type ResolveOidcSubjectResult
} from "./platforms/setup-azure-identity.js";
import { buildEnvironmentSuffix } from "./platforms/oidc-subject.js";

export type DeploymentAzureValidation =
  | { status: "covered" }
  | {
      status: "skipped" | "missing" | "case-mismatch" | "unverified";
      message: string;
    };

export interface DeploymentAzurePorts {
  readGitHub: GitHubJsonRunner;
  readSubjects(clientId: string): Promise<{
    code: string | number;
    stdout: string;
    stderr: string;
  }>;
  errorMessage(error: unknown): string;
}

type VariableLookup =
  | { kind: "value"; value: string }
  | { kind: "blank" }
  | { kind: "absent" }
  | { kind: "error"; reason: string };

function unverified(
  environment: string,
  reason: string
): DeploymentAzureValidation {
  return {
    status: "unverified",
    message:
      `Could not verify Azure federated credential coverage for environment "${environment}": ${reason}. ` +
      "Deploying anyway — if the workflow fails to log in to Azure with AADSTS700213, re-run Create Environment with Azure auto-setup."
  };
}

async function readClientId(
  repo: string,
  environment: string,
  readGitHub: GitHubJsonRunner
): Promise<VariableLookup> {
  const read = async (path: string, scope: string): Promise<VariableLookup> => {
    const response = await readGitHub(path);
    if (!response.ok) {
      if (response.status === 404) return { kind: "absent" };
      return {
        kind: "error",
        reason: `GitHub ${scope} AZURE_CLIENT_ID lookup failed (${response.stderr || `HTTP ${response.status ?? "unknown"}`})`
      };
    }
    const value = response.json?.value;
    if (typeof value !== "string") {
      return {
        kind: "error",
        reason: `GitHub ${scope} has an invalid AZURE_CLIENT_ID`
      };
    }
    return value.trim() ?
        { kind: "value", value: value.trim() }
      : { kind: "blank" };
  };
  // An explicitly blank environment variable still shadows the repository.
  const value = await read(
    `/repos/${repo}/environments/${encodeURIComponent(environment)}/variables/AZURE_CLIENT_ID`,
    `environment "${environment}"`
  );
  return value.kind !== "absent" ?
      value
    : read(
        `/repos/${repo}/actions/variables/AZURE_CLIENT_ID`,
        `repository "${repo}"`
      );
}

export async function validateDeploymentAzureIdentity(
  repo: string,
  environment: string,
  ports: DeploymentAzurePorts
): Promise<DeploymentAzureValidation> {
  let clientId: string;
  try {
    const lookup = await readClientId(repo, environment, ports.readGitHub);
    if (lookup.kind === "error") return unverified(environment, lookup.reason);
    if (lookup.kind === "blank") {
      return {
        status: "skipped",
        message: `Azure login is disabled for environment "${environment}" (AZURE_CLIENT_ID is empty) — skipping the federated credential check.`
      };
    }
    if (lookup.kind === "absent") {
      return unverified(
        environment,
        `neither GitHub environment "${environment}" nor repository "${repo}" defines AZURE_CLIENT_ID`
      );
    }
    clientId = lookup.value;
  } catch (error) {
    return unverified(
      environment,
      `GitHub variable lookup failed (${ports.errorMessage(error)})`
    );
  }

  let envName: string;
  let resolved: ResolveOidcSubjectResult;
  try {
    const response = await ports.readGitHub(
      `/repos/${repo}/environments/${encodeURIComponent(environment)}`
    );
    if (!response.ok) {
      return unverified(
        environment,
        `GitHub environment "${environment}" lookup failed (${response.stderr || `HTTP ${response.status ?? "unknown"}`})`
      );
    }
    const name = response.json?.name;
    if (typeof name !== "string" || !name.trim()) {
      return unverified(
        environment,
        `GitHub did not report a name for environment "${environment}"`
      );
    }
    // Use GitHub's stored casing, which is what its case-sensitive OIDC claim carries.
    envName = name.trim();
    resolved = await resolveOidcSubject(
      {
        targetRepo: repo,
        envName,
        suffix: buildEnvironmentSuffix(envName)
      },
      ports.readGitHub
    );
  } catch (error) {
    return unverified(
      environment,
      `GitHub OIDC subject resolution failed (${ports.errorMessage(error)})`
    );
  }
  const expected = resolved.federatedCredentials.map(
    (credential) => credential.subject
  );
  let listed: Awaited<ReturnType<DeploymentAzurePorts["readSubjects"]>>;
  try {
    listed = await ports.readSubjects(clientId);
  } catch (error) {
    return unverified(
      environment,
      `Azure federated credential lookup failed (${ports.errorMessage(error)})`
    );
  }
  if (listed.code !== 0) {
    return unverified(
      environment,
      `Azure federated credential lookup failed (${listed.stderr.trim() || "unknown error"})`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(listed.stdout);
  } catch (error) {
    return unverified(
      environment,
      `Azure federated credential lookup returned malformed JSON (${ports.errorMessage(error)})`
    );
  }
  if (!Array.isArray(parsed)) {
    return unverified(
      environment,
      "Azure federated credential lookup returned an invalid subject list"
    );
  }
  // Flexible federated credentials have null subjects; they do not invalidate ordinary ones.
  const subjects = parsed
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const missing = expected.filter((subject) => !subjects.includes(subject));
  if (missing.length === 0) return { status: "covered" };
  // Only one of an indeterminate mutable/immutable pair will actually be minted.
  if (missing.length < expected.length) {
    return unverified(
      environment,
      `App Registration ${clientId} covers only part of the subject pair GitHub may mint (no credential for ${missing.map((subject) => `"${subject}"`).join(" and ")})`
    );
  }
  const mismatches: { expected: string; existing: string }[] = [];
  for (const subject of expected) {
    for (const existing of subjects) {
      if (existing.toLowerCase() !== subject.toLowerCase()) continue;
      mismatches.push({ expected: subject, existing });
      break;
    }
  }
  if (mismatches.length > 0) {
    const text = mismatches
      .map(
        ({ expected, existing }) =>
          `expected "${expected}" but the app has "${existing}"`
      )
      .join("; ");
    return {
      status: "case-mismatch",
      message:
        `Azure deploy to environment "${envName}" is blocked because App Registration ${clientId} has federated credential subjects that differ from the ones GitHub mints only by letter casing: ${text}. ` +
        'Entra compares subjects case-sensitively, so this deploy\'s Azure login would be rejected with "No matching federated identity record found for presented assertion subject" (AADSTS700213, also written AADSTS7002138 in some Entra responses). No workflow run was started, so that rejection will not appear in the Actions logs. ' +
        `Correct the existing credentials rather than re-running Create Environment, which rebuilds the subject from the same spelling. List their ids with: az ad app federated-credential list --id ${clientId} --query "[].{id:id,subject:subject}" -o table. Then fix each one with: az ad app federated-credential update --id ${clientId} --federated-credential-id <id> --parameters "{\\"subject\\":\\"<expected subject>\\"}".`
    };
  }
  const near =
    subjects.length > 0 ?
      ` Existing credential subjects on the app: ${subjects.slice(0, 3).join(", ")}${subjects.length > 3 ? ", ..." : ""}.`
    : "";
  return {
    status: "missing",
    message:
      `Azure deploy to environment "${envName}" is blocked because App Registration ${clientId} ` +
      `has no federated credential matching any subject GitHub could present for it (expected one of ${expected.map((subject) => `"${subject}"`).join(" or ")}).` +
      near +
      " Re-run Create Environment with Azure auto-setup (or create the credential manually) before deploying."
  };
}
