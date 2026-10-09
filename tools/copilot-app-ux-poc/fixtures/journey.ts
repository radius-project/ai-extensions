// Pure helpers for the opt-in modeling journey. They mirror the contracts in
// packages/adapter-canvas/test/e2e-cloud/support, but stay self-contained so
// this tool does not import production Canvas source.

export const JOURNEY_GATE_VARIABLE = "COPILOT_APP_E2E_JOURNEY";

export interface JourneyConfig {
  /** GitHub repository of the unmodeled fixture, as `owner/name`. */
  repository: string;
  /** Project name in the Copilot app project picker. */
  projectName: string;
  /** Commit that the fixture default branch must point to before the run. */
  baselineSha: string;
  defaultBranch: string;
  tenantId: string;
  subscriptionId: string;
  resourceGroup: string;
  clusterName: string;
  namespace: string;
  credentialProfile: string;
  environmentName: string;
}

export type JourneyConfigResult =
  { enabled: false; reason: string } | { enabled: true; config: JourneyConfig };

const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*)\/[A-Za-z0-9._-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const ENVIRONMENT_NAME_PATTERN = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const SIMPLE_NAME_PATTERN = /^[A-Za-z0-9._()-]+$/;

/** Builds a short, unique environment name such as `uxe2e-lx3k9a2b`. */
export function generateEnvironmentName(now: number, random: number): string {
  const time = Math.max(0, Math.floor(now)).toString(36).slice(-6);
  const salt = Math.floor(Math.abs(random) * 36 ** 2)
    .toString(36)
    .padStart(2, "0")
    .slice(-2);
  return `uxe2e-${time}${salt}`;
}

/**
 * Reads the journey configuration. The journey is off unless the gate
 * variable is exactly "1". When it is on, every required value must be
 * present and valid, so a typo fails at once instead of after cloud work.
 */
export function readJourneyConfig(
  env: Readonly<Record<string, string | undefined>>,
  makeEnvironmentName: () => string
): JourneyConfigResult {
  if (env[JOURNEY_GATE_VARIABLE]?.trim() !== "1") {
    return {
      enabled: false,
      reason:
        `The modeling journey is off. Set ${JOURNEY_GATE_VARIABLE}=1 to run it. ` +
        "It sends prompts, pushes to the fixture repository, and creates cloud resources."
    };
  }
  const problems: string[] = [];
  const read = (
    name: string,
    pattern: RegExp,
    description: string,
    fallback?: string
  ): string => {
    const value = env[name]?.trim() || fallback || "";
    if (!value) {
      problems.push(`${name} is required (${description}).`);
    } else if (!pattern.test(value)) {
      problems.push(`${name} is not a valid ${description}: "${value}".`);
    }
    return value;
  };

  const repository = read(
    "COPILOT_APP_E2E_REPO",
    REPOSITORY_PATTERN,
    "GitHub repository as owner/name"
  );
  const repositoryName = repository.split("/")[1] ?? "";
  const config: JourneyConfig = {
    repository,
    projectName: read(
      "COPILOT_APP_E2E_PROJECT",
      SIMPLE_NAME_PATTERN,
      "Copilot app project name",
      repositoryName
    ),
    baselineSha: read(
      "COPILOT_APP_E2E_BASELINE_SHA",
      SHA_PATTERN,
      "full 40-character lowercase commit SHA"
    ),
    defaultBranch: read(
      "COPILOT_APP_E2E_DEFAULT_BRANCH",
      BRANCH_PATTERN,
      "branch name",
      "main"
    ),
    tenantId: read(
      "COPILOT_APP_E2E_AZURE_TENANT_ID",
      GUID_PATTERN,
      "Azure tenant GUID"
    ),
    subscriptionId: read(
      "COPILOT_APP_E2E_AZURE_SUBSCRIPTION_ID",
      GUID_PATTERN,
      "Azure subscription GUID"
    ),
    resourceGroup: read(
      "COPILOT_APP_E2E_AZURE_RESOURCE_GROUP",
      SIMPLE_NAME_PATTERN,
      "Azure resource group name"
    ),
    clusterName: read(
      "COPILOT_APP_E2E_AKS_CLUSTER",
      SIMPLE_NAME_PATTERN,
      "AKS cluster name"
    ),
    namespace: read(
      "COPILOT_APP_E2E_NAMESPACE",
      /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
      "Kubernetes namespace",
      "default"
    ),
    credentialProfile: read(
      "COPILOT_APP_E2E_CREDENTIAL_PROFILE",
      SIMPLE_NAME_PATTERN,
      "credential profile name",
      "copilot-app-ux-e2e"
    ),
    environmentName: read(
      "COPILOT_APP_E2E_ENV_NAME",
      ENVIRONMENT_NAME_PATTERN,
      "environment name (lowercase letters, digits, and dashes; 3-32 characters)",
      makeEnvironmentName()
    )
  };
  if (problems.length > 0) {
    throw new Error(
      `The modeling journey configuration is not valid:\n- ${problems.join("\n- ")}`
    );
  }
  return { enabled: true, config };
}

/** The prompt that starts the radius-app-bicep skill in the new session. */
export function modelingPrompt(): string {
  return (
    "Use the radius-app-bicep skill to generate the Radius application model " +
    "(.radius/app.bicep) for this repository. Do not commit or push. " +
    "Do not deploy. Stop when the model is staged."
  );
}

export interface SessionInfo {
  branch: string;
  baseBranch: string;
  path: string;
  sessionId: string;
}

/**
 * Reads the session information dialog. Each copy button has the accessible
 * name "Copy <field>, <value>".
 */
export function parseSessionInfo(labels: readonly string[]): SessionInfo {
  const fields = new Map<string, string>();
  for (const label of labels) {
    const match = /^Copy (branch|base branch|path|session ID), (.+)$/.exec(
      label.trim()
    );
    if (match?.[1] && match[2]) {
      fields.set(match[1], match[2].trim());
    }
  }
  const missing = ["branch", "base branch", "path", "session ID"].filter(
    (field) => !fields.has(field)
  );
  if (missing.length > 0) {
    throw new Error(
      `The session information dialog did not show: ${missing.join(", ")}. Labels seen: ${labels.join(" | ") || "<none>"}`
    );
  }
  return {
    branch: fields.get("branch") ?? "",
    baseBranch: fields.get("base branch") ?? "",
    path: fields.get("path") ?? "",
    sessionId: fields.get("session ID") ?? ""
  };
}

/** Reads the session ID from an app URL such as `/workspaces/<id>`. */
export function sessionIdFromAppUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const match = /^\/workspaces\/([^/]+)\/?$/.exec(url.pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

export const MODEL_FILES = [
  ".radius/app.bicep",
  ".radius/bicepconfig.json",
  ".radius/app.origin.json"
] as const;

export interface ModelProgress {
  ready: boolean;
  missingFiles: string[];
  unstagedFiles: string[];
}

/**
 * The skill is done when it published every model file and staged them with
 * `git add`. Staging is the skill's last step, so this is the ready signal.
 */
export function classifyModelProgress(
  existingFiles: ReadonlySet<string>,
  stagedOutput: string
): ModelProgress {
  const staged = new Set(
    stagedOutput
      .split(/\r?\n/)
      .map((line) => line.trim().replaceAll("\\", "/"))
      .filter(Boolean)
  );
  const missingFiles = MODEL_FILES.filter((file) => !existingFiles.has(file));
  const unstagedFiles = MODEL_FILES.filter((file) => !staged.has(file));
  return {
    ready: missingFiles.length === 0 && unstagedFiles.length === 0,
    missingFiles,
    unstagedFiles
  };
}

/** Builds the canvas URL for one page and keeps the other query values. */
export function canvasPageUrl(current: string, page: string): string {
  const url = new URL(current);
  url.searchParams.set("page", page);
  url.hash = "";
  return url.toString();
}

/** Builds a repository-scoped Canvas listing route. */
export function repositoryListingPath(
  route: "/api/list-applications" | "/api/list-deployments",
  repository: string,
  fresh = false
): string {
  return `${route}?repo=${encodeURIComponent(repository)}${fresh ? "&fresh=1" : ""}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined;
}

function rejectEndpointError(
  record: Record<string, unknown> | undefined,
  endpoint: string
): void {
  const error = record?.error;
  if (error === undefined || error === null || error === "") return;
  throw new Error(
    `The ${endpoint} reported an error: ${typeof error === "string" ? error : JSON.stringify(error)}`
  );
}

/** Reads the operation ID that `POST /api/operations` returns. */
export function readOperationId(payload: unknown): string {
  const operationId = asRecord(payload)?.operationId;
  if (typeof operationId !== "string" || operationId.trim() === "") {
    throw new Error('The operation response had no usable "operationId".');
  }
  return operationId.trim();
}

export const TERMINAL_OPERATION_STATES: readonly string[] = [
  "succeeded",
  "succeeded_with_warnings",
  "action_required",
  "failed",
  "failed_partial",
  "cancelled"
];

export interface OperationSnapshot {
  state: string;
  terminal: boolean;
  error: string;
}

/**
 * Reads one `/api/operations/{id}` poll. An unreadable payload fails at once,
 * so a schema change does not turn into a long timeout.
 */
export function readOperationSnapshot(payload: unknown): OperationSnapshot {
  const operation = asRecord(asRecord(payload)?.operation);
  if (!operation) {
    throw new Error('The operation response had no "operation" object.');
  }
  if (typeof operation.state !== "string" || operation.state.trim() === "") {
    throw new Error('The operation response had no usable "operation.state".');
  }
  const state = operation.state.trim();
  const failureMessage = asRecord(operation.failure)?.message;
  const error =
    typeof failureMessage === "string" && failureMessage.trim() !== "" ?
      failureMessage.trim()
    : typeof operation.error === "string" ? operation.error.trim()
    : "";
  const terminalState =
    typeof operation.terminalState === "string" ?
      operation.terminalState.trim()
    : "";
  if (terminalState && !TERMINAL_OPERATION_STATES.includes(terminalState)) {
    throw new Error(
      `The operation response had an unknown terminal state: "${terminalState}".`
    );
  }
  return {
    state,
    terminal: terminalState !== "" || TERMINAL_OPERATION_STATES.includes(state),
    error
  };
}

export interface DeployStatusSnapshot {
  status: string;
  terminal: boolean;
  succeeded: boolean;
  error: string;
  runUrl: string;
}

/** Reads one `/api/deploy-status` poll. "complete" is the success state. */
export function readDeployStatus(payload: unknown): DeployStatusSnapshot {
  const record = asRecord(payload);
  if (!record) {
    throw new Error("The deploy status response was not a JSON object.");
  }
  if (typeof record.status !== "string" || record.status.trim() === "") {
    throw new Error('The deploy status response had no usable "status".');
  }
  const status = record.status.trim();
  return {
    status,
    terminal: status === "complete" || status === "failed",
    succeeded: status === "complete",
    error: typeof record.error === "string" ? record.error.trim() : "",
    runUrl:
      typeof record.deployRunUrl === "string" ? record.deployRunUrl.trim() : ""
  };
}

/** Reads `/api/list-applications` and requires exactly one application. */
export function readSingleApplicationName(payload: unknown): string {
  const record = asRecord(payload);
  rejectEndpointError(record, "application listing");
  const list = record?.applications;
  if (!Array.isArray(list)) {
    throw new Error('The application listing had no "applications" array.');
  }
  const names = list.map((entry, index) => {
    const name = asRecord(entry)?.name;
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error(
        `The application listing had a malformed entry at index ${index}.`
      );
    }
    return name.trim();
  });
  if (names.length !== 1) {
    throw new Error(
      names.length === 0 ?
        "The fixture repository has no application to deploy. Did the model reach the default branch?"
      : `The fixture repository has ${names.length} applications (${names.join(", ")}). The journey expects one.`
    );
  }
  return names[0] as string;
}

export interface DeploymentRow {
  app: string;
  environment: string;
  status: string;
}

/**
 * Reads `/api/list-deployments`. An unreadable listing fails, because an empty
 * listing is the proof that a deployment is gone.
 */
export function readDeploymentRows(payload: unknown): DeploymentRow[] {
  const record = asRecord(payload);
  rejectEndpointError(record, "deployment listing");
  const list = record?.deployments;
  if (!Array.isArray(list)) {
    throw new Error('The deployment listing had no "deployments" array.');
  }
  return list.map((entry, index) => {
    const item = asRecord(entry);
    if (
      !item ||
      typeof item.app !== "string" ||
      item.app.trim() === "" ||
      typeof item.environment !== "string" ||
      item.environment.trim() === ""
    ) {
      throw new Error(
        `The deployment listing had a malformed entry at index ${index}.`
      );
    }
    return {
      app: item.app.trim(),
      environment: item.environment.trim(),
      status: typeof item.status === "string" ? item.status : ""
    };
  });
}

/** True when the listing has a row for the application and environment. */
export function hasDeployment(
  rows: readonly DeploymentRow[],
  application: string,
  environment: string
): boolean {
  return rows.some(
    (row) =>
      row.app === application &&
      row.environment.toLowerCase() === environment.toLowerCase()
  );
}

export const APP_DEPLOYED_REFUSAL_CODE = "app-deployed";

/** Lists every problem with the refusal to delete a live environment. */
export function findDeleteRefusalProblems(input: {
  status: number;
  payload: unknown;
  application: string;
}): string[] {
  const problems: string[] = [];
  if (input.status !== 409) {
    problems.push(
      `The delete of an environment with a live deployment returned HTTP ${input.status}, not 409.`
    );
  }
  const record = asRecord(input.payload);
  if (!record) {
    problems.push("The refusal had no JSON object.");
    return problems;
  }
  if (record.code !== APP_DEPLOYED_REFUSAL_CODE) {
    problems.push(
      `The refusal code was ${JSON.stringify(record.code)}, not "${APP_DEPLOYED_REFUSAL_CODE}".`
    );
  }
  const message = typeof record.error === "string" ? record.error : "";
  if (!message.includes(input.application)) {
    problems.push(
      `The refusal message does not name application "${input.application}": ${message || "<empty>"}`
    );
  }
  if (record.app !== input.application) {
    problems.push(
      `The refusal named application ${JSON.stringify(record.app)}, not "${input.application}".`
    );
  }
  return problems;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Classifies `gh api repos/<repo>/contents/.radius/app.bicep?ref=<sha>`. A
 * clean fixture must answer 404. Any other failure is not proof of absence.
 */
export function classifyBaselineModel(
  result: CommandResult
): "absent" | "present" {
  if (result.code === 0) return "present";
  if (/HTTP 404|Not Found/i.test(`${result.stderr}\n${result.stdout}`)) {
    return "absent";
  }
  throw new Error(
    `Could not check the fixture baseline for .radius/app.bicep: ${result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`}`
  );
}
