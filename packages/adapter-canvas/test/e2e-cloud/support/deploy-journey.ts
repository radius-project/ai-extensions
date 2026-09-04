// Every decision stages two and three make that is not a click.
//
// Stage two deploys the fixture repository's Radius application; stage three
// deletes that deployment. Both dispatch a workflow and then wait, so the risk
// they carry is not a wrong click — it is believing the wrong evidence.
//
// Two rules here exist for that reason alone:
//
// - `findDeployedApplicationProblems` refuses to accept a green workflow run as
//   proof of a deploy. `deployment-resolver.ts` derives the deployment row's
//   status entirely from the newest GitHub deployment record's run conclusion,
//   so a green run and a green row are one fact told twice. Only workloads
//   Radius rendered onto the target cluster prove the application landed.
// - `findSurvivingArtifactProblems` states stage three's contract as the
//   inverse of stage four's. `deployments.ts` is explicit that deleting a
//   deployment tears down the Radius application *while leaving the GitHub
//   Environment and its credentials intact*. Asserting that cloud state is gone
//   would be stage four written by mistake, and it would pass.
import {
  DELETE_APP_DISPATCHER_FILE,
  DELETE_AZURE_FILE,
  DEPLOY_AZURE_FILE,
  DEPLOY_DISPATCHER_FILE
} from "../../../src/infra.js";
import { REQUIRED_DEFAULT_BRANCH_WORKFLOWS } from "./create-environment-journey.js";

/**
 * Workflow files `/api/deploy` must publish before it can dispatch.
 *
 * Imported from the product rather than restated, so renaming a dispatcher
 * breaks this list at compile time instead of at 2 a.m. against real cloud.
 */
export const REQUIRED_DEPLOY_WORKFLOWS: readonly string[] = [
  DEPLOY_DISPATCHER_FILE,
  DEPLOY_AZURE_FILE
];

/** Workflow files `/api/delete-deployment` must publish before it dispatches. */
export const REQUIRED_DELETE_WORKFLOWS: readonly string[] = [
  DELETE_APP_DISPATCHER_FILE,
  DELETE_AZURE_FILE
];

/** Every workflow the complete lifecycle requires before its first dispatch. */
export const REQUIRED_LIFECYCLE_WORKFLOWS: readonly string[] = [
  ...REQUIRED_DEFAULT_BRANCH_WORKFLOWS,
  ...REQUIRED_DEPLOY_WORKFLOWS,
  ...REQUIRED_DELETE_WORKFLOWS
];

/**
 * Environment variables the Azure deploy and delete workflows read.
 *
 * The `RADIUS_STATE_*` three are not decoration. Both workflows restore and
 * persist the Radius control plane's state from an OCI archive, and without
 * them `rad startup` fails with "OCI archive repository is not configured"
 * before either workflow reaches `rad deploy` or `rad app delete`. A stage
 * three that checked only the seven Azure variables would report a healthy
 * Environment that cannot deploy again.
 */
export const REQUIRED_STATE_VARIABLES: readonly string[] = [
  "RADIUS_STATE_BACKEND",
  "RADIUS_STATE_REGISTRY",
  "RADIUS_STATE_ARCHIVE"
];

/** Every variable that must still be present after a deployment is deleted. */
export const REQUIRED_ENVIRONMENT_VARIABLES: readonly string[] = [
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_SUBSCRIPTION_ID",
  "AZURE_RESOURCE_GROUP",
  "AZURE_AKS_CLUSTER_NAME",
  "AZURE_LOCATION",
  "KUBERNETES_NAMESPACE",
  ...REQUIRED_STATE_VARIABLES
];

/**
 * The label Radius stamps on every workload it renders for an application.
 *
 * `radius-project/radius` `pkg/kubernetes/labels.go`. Matching on it is what
 * separates "Radius deployed this application" from "something exists in that
 * namespace" — the composite action pre-creates the namespace before `rad`
 * runs, so namespace occupancy alone proves nothing.
 */
export const RADIUS_APPLICATION_LABEL = "radapp.io/application";

/**
 * States `/api/deploy-status` reports once it will not change again.
 *
 * `"complete"`, not `"success"`: the overall deploy state and the per-resource
 * states use different vocabularies, and polling for `"success"` would wait out
 * the full timeout on a deploy that had already finished.
 */
export const TERMINAL_DEPLOY_STATES: readonly string[] = ["complete", "failed"];

/** The one terminal state that means the application was deployed. */
export const SUCCESSFUL_DEPLOY_STATE = "complete";

/** Builds a repository-scoped Canvas listing route without losing query flags. */
export function repositoryListingPath(
  route: "/api/list-applications" | "/api/list-deployments",
  repository: string,
  fresh = false
): string {
  return `${route}?repo=${encodeURIComponent(repository)}${fresh ? "&fresh=1" : ""}`;
}

export interface DeployStatusSnapshot {
  readonly status: string;
  readonly terminal: boolean;
  readonly succeeded: boolean;
  readonly active: boolean;
  readonly logs: readonly string[];
  readonly error: string;
  readonly errorKind: string;
  readonly runUrl: string;
}

/**
 * Narrows one `/api/deploy-status` poll.
 *
 * An unreadable payload fails immediately rather than counting as a
 * non-terminal state, so a route or schema regression reports itself instead of
 * becoming an unexplained timeout three quarters of an hour later.
 */
export function readDeployStatusSnapshot(
  payload: unknown
): DeployStatusSnapshot {
  const record = asRecord(payload);
  if (!record)
    throw new Error("The deploy status response was not a JSON object.");
  const status = record.status;
  if (typeof status !== "string" || status.trim() === "")
    throw new Error('The deploy status response carried no usable "status".');
  const trimmed = status.trim();
  return {
    status: trimmed,
    terminal: TERMINAL_DEPLOY_STATES.includes(trimmed),
    succeeded: trimmed === SUCCESSFUL_DEPLOY_STATE,
    active: record.active === true,
    logs: optionalStringArray(record.logs, "logs"),
    error: optionalText(record.error, "error"),
    errorKind: optionalText(record.errorKind, "errorKind"),
    runUrl: optionalText(record.deployRunUrl, "deployRunUrl")
  };
}

/**
 * Narrows `/api/list-applications`.
 *
 * The application's name comes from the product's own read of `app.bicep`,
 * which is the same file `rad deploy` reads — so this establishes *what to look
 * for* on the cluster, never *whether it is there*. The cluster answers that.
 */
export function readApplicationNames(payload: unknown): string[] {
  const record = asRecord(payload);
  rejectEndpointError(record, "application listing");
  const list = record?.applications;
  if (!Array.isArray(list))
    throw new Error(
      'The application listing carried no "applications" array, so the deploy target cannot be named.'
    );
  const names: string[] = [];
  for (const [index, entry] of list.entries()) {
    const item = asRecord(entry);
    const name = item?.name;
    if (typeof name !== "string" || name.trim() === "")
      throw new Error(
        `The application listing carried a malformed entry at index ${index}; every entry must have a usable "name".`
      );
    names.push(name.trim());
  }
  return names;
}

/**
 * The single application stage two deploys.
 *
 * The fixture repository holds exactly one `app.bicep`. Anything else means the
 * pin moved to a repository this journey was not written for, and deploying an
 * arbitrary one of several would make the run's meaning depend on listing order.
 */
export function requireSingleApplication(names: readonly string[]): string {
  if (names.length === 1) return names[0] as string;
  throw new Error(
    names.length === 0 ?
      "The fixture repository exposes no application to deploy. Stage two needs an app.bicep at the pinned commit."
    : `The fixture repository exposes ${names.length} applications (${names.join(", ")}); ` +
        "stage two is written for the single-application fixture and would otherwise depend on listing order."
  );
}

export interface DeploymentRow {
  readonly app: string;
  readonly environment: string;
  readonly status: string;
  readonly runUrl: string;
}

/** Narrows `/api/list-deployments`. */
export function readDeploymentRows(payload: unknown): DeploymentRow[] {
  const record = asRecord(payload);
  rejectEndpointError(record, "deployment listing");
  const list = record?.deployments;
  if (!Array.isArray(list))
    throw new Error(
      'The deployment listing carried no "deployments" array. An unreadable listing must not be ' +
        "mistaken for an empty one, because an empty one is how stage three proves the deployment is gone."
    );
  const rows: DeploymentRow[] = [];
  for (const [index, entry] of list.entries()) {
    const item = asRecord(entry);
    if (!item)
      throw new Error(
        `The deployment listing carried a malformed entry at index ${index}; every entry must be an object.`
      );
    if (typeof item.app !== "string" || typeof item.environment !== "string")
      throw new Error(
        `The deployment listing carried a malformed entry at index ${index}; "app" and "environment" must be strings.`
      );
    if (
      item.status !== undefined &&
      item.status !== null &&
      typeof item.status !== "string"
    )
      throw new Error(
        `The deployment listing carried a malformed "status" at index ${index}.`
      );
    if (
      item.runUrl !== undefined &&
      item.runUrl !== null &&
      typeof item.runUrl !== "string"
    )
      throw new Error(
        `The deployment listing carried a malformed "runUrl" at index ${index}.`
      );
    rows.push({
      app: item.app,
      environment: item.environment,
      status: typeof item.status === "string" ? item.status : "",
      runUrl: typeof item.runUrl === "string" ? item.runUrl : ""
    });
  }
  return rows;
}

export type DeploymentPresence =
  | { readonly present: false }
  | {
      readonly present: true;
      readonly status: string;
      readonly runUrl: string;
    };

/**
 * Whether the listing still carries a row for one application and environment.
 *
 * Absence is the product's own completion signal for a delete: the resolver
 * drops the row once the newest deployment record is a successful delete run.
 * That makes it the right thing to *wait* on and the wrong thing to *believe*,
 * which is why stage three waits on this and then asserts the cluster.
 */
export function classifyDeploymentPresence(
  rows: readonly DeploymentRow[],
  application: string,
  environment: string
): DeploymentPresence {
  const match = rows.find(
    (row) =>
      row.app === application &&
      row.environment.toLowerCase() === environment.toLowerCase()
  );
  if (!match) return { present: false };
  return { present: true, status: match.status, runUrl: match.runUrl };
}

/**
 * The Kubernetes namespace Radius renders an application into.
 *
 * `<environment namespace>-<application name>`, normalized, from
 * `pkg/corerp/frontend/controller/applications/updatefilter.go`. Computing it
 * here rather than reading it back from the product keeps the assertion
 * independent: a product that reported the wrong namespace would otherwise be
 * checked against its own mistake.
 */
export function applicationNamespace(
  environmentNamespace: string,
  application: string
): string {
  const environmentPart = requireName(
    environmentNamespace,
    "environment namespace"
  );
  const applicationPart = requireName(application, "application name");
  const namespace = `${environmentPart}-${applicationPart}`.toLowerCase();
  // Kubernetes rejects a namespace longer than 63 characters outright, so a
  // long application name is a deploy that never happens rather than one this
  // journey should sit and poll for.
  if (namespace.length > 63)
    throw new Error(
      `The application namespace "${namespace}" is ${namespace.length} characters; Kubernetes rejects ` +
        "anything longer than 63, so Radius could never have created it."
    );
  return namespace;
}

/** The label selector matching every workload Radius rendered for an app. */
export function radiusApplicationSelector(application: string): string {
  return `${RADIUS_APPLICATION_LABEL}=${requireName(
    application,
    "application name"
  ).toLowerCase()}`;
}

export interface KubernetesWorkload {
  readonly name: string;
  readonly application: string;
  readonly desiredReplicas: number;
  readonly availableReplicas: number;
}

/**
 * Narrows `kubectl get deployments -o json`.
 *
 * A malformed body throws. Reading it as "no workloads" would make stage two
 * report a failed deploy and stage three report a successful delete, from the
 * very same unreadable answer.
 */
export function readKubernetesWorkloads(
  payload: unknown
): KubernetesWorkload[] {
  const record = asRecord(payload);
  if (!record) throw new Error("The kubectl listing was not a JSON object.");
  const items = record.items;
  if (!Array.isArray(items))
    throw new Error('The kubectl listing carried no "items" array.');
  return items.map((entry, index) => {
    const item = asRecord(entry);
    if (!item)
      throw new Error(
        `The kubectl listing carried a non-object entry at index ${index}.`
      );
    const metadata = asRecord(item.metadata);
    const name = metadata?.name;
    if (typeof name !== "string" || name.trim() === "")
      throw new Error(
        `The kubectl listing carried an entry at index ${index} with no usable "metadata.name".`
      );
    const labels = asRecord(metadata?.labels);
    const application = labels?.[RADIUS_APPLICATION_LABEL];
    const spec = asRecord(item.spec);
    const status = asRecord(item.status);
    return {
      name: name.trim(),
      application: typeof application === "string" ? application : "",
      desiredReplicas: countOf(spec?.replicas),
      availableReplicas: countOf(status?.availableReplicas)
    };
  });
}

/** Narrows a generic `kubectl get ... -o json` listing to resource names. */
export function readKubernetesResourceNames(payload: unknown): string[] {
  const record = asRecord(payload);
  if (!record) throw new Error("The kubectl listing was not a JSON object.");
  const items = record.items;
  if (!Array.isArray(items))
    throw new Error('The kubectl listing carried no "items" array.');
  return items.map((entry, index) => {
    const item = asRecord(entry);
    if (!item)
      throw new Error(
        `The kubectl listing carried a non-object entry at index ${index}.`
      );
    const metadata = asRecord(item.metadata);
    const name = metadata?.name;
    if (typeof name !== "string" || name.trim() === "")
      throw new Error(
        `The kubectl listing carried an entry at index ${index} with no usable "metadata.name".`
      );
    const kind = item.kind;
    return typeof kind === "string" && kind.trim() !== "" ?
        `${kind.trim()}/${name.trim()}`
      : name.trim();
  });
}

export interface DeleteEnvironmentResponse {
  readonly status: number;
  readonly payload: unknown;
}

export interface RefusalInput extends DeleteEnvironmentResponse {
  readonly application: string;
  readonly environmentName: string;
  /** Whether the GitHub Environment still exists after the refused request. */
  readonly environmentExists: boolean;
}

/**
 * The refusal code `/api/delete-environment` returns while an app is deployed.
 */
export const APP_DEPLOYED_REFUSAL_CODE = "app-deployed";

/**
 * Everything wrong with how the product refused to delete a live environment.
 *
 * `environments.test.ts` already proves this guard with a faked
 * `resolveEnvDeployment`. What no hermetic test can prove is that a *real*
 * GitHub deployment record, written by a real deploy workflow, resolves to a
 * non-null active deployment — and that is the guard's actual input. A guard
 * that silently stopped recognising real deployments would keep passing every
 * unit test while deleting environments out from under running applications,
 * orphaning their cloud resources.
 */
export function findDeleteEnvironmentRefusalProblems(
  input: RefusalInput
): string[] {
  const problems: string[] = [];
  if (input.status !== 409)
    problems.push(
      `Deleting an environment with application "${input.application}" still deployed answered ${input.status}, ` +
        "not 409. The guard exists so a live deployment's cloud resources are never orphaned by an " +
        "environment delete; a non-409 means it did not recognise the deployment the previous stage created."
    );

  const record = asRecord(input.payload);
  if (!record) {
    problems.push("The refusal carried no JSON object to inspect.");
    return problems;
  }

  const code = record.code;
  if (code !== APP_DEPLOYED_REFUSAL_CODE)
    problems.push(
      `The refusal reported code ${JSON.stringify(code)} rather than "${APP_DEPLOYED_REFUSAL_CODE}", so the ` +
        "browser cannot tell this apart from an unrelated conflict and would not redirect to the deployment."
    );

  const message = typeof record.error === "string" ? record.error : "";
  if (message.trim() === "")
    problems.push("The refusal carried no error message to show the user.");
  else if (!message.includes(input.application))
    problems.push(
      `The refusal message does not name application "${input.application}", so it cannot tell the user what ` +
        `to delete first. It said: ${message}`
    );

  if (record.app !== input.application)
    problems.push(
      `The refusal named application ${JSON.stringify(record.app)} rather than "${input.application}", which is ` +
        "the name the redirect and the delete-deployment flow are both built from."
    );

  if (!input.environmentExists)
    problems.push(
      `GitHub Environment "${input.environmentName}" no longer exists after a refused delete. A guard that ` +
        "refuses and deletes anyway is worse than no guard."
    );

  return problems;
}

export interface DeployedApplicationInput {
  readonly application: string;
  readonly namespace: string;
  /** Whether the namespace itself exists on the target cluster. */
  readonly namespaceExists: boolean;
  readonly workloads: readonly KubernetesWorkload[];
}

/**
 * Everything wrong with what stage two left on the target cluster.
 *
 * Returned as a list rather than thrown one finding at a time, so a failure
 * report distinguishes "the workflow never reached the user's cluster" from
 * "it reached it and deployed nothing" from "it deployed something that cannot
 * run" — three different bugs that a single assertion would flatten into one.
 */
export function findDeployedApplicationProblems(
  input: DeployedApplicationInput
): string[] {
  const problems: string[] = [];
  if (!input.namespaceExists) {
    problems.push(
      `Namespace "${input.namespace}" does not exist on the target cluster, so the deploy never reached it. ` +
        "The workflow builds an ephemeral control plane inside the runner, so a green run that never connected " +
        "to the AKS cluster looks identical to a successful one from GitHub."
    );
    return problems;
  }

  const owned = input.workloads.filter(
    (workload) =>
      workload.application.toLowerCase() === input.application.toLowerCase()
  );
  if (owned.length === 0) {
    problems.push(
      `Namespace "${input.namespace}" carries no workload labelled ${RADIUS_APPLICATION_LABEL}=${input.application}. ` +
        (input.workloads.length === 0 ?
          "The namespace is empty, which is the state the composite action leaves it in when it pre-creates " +
          "the namespace and `rad deploy` then deploys nothing."
        : `It carries ${input.workloads.length} unrelated workload(s): ${input.workloads
            .map((workload) => `"${workload.name}"`)
            .join(", ")}.`)
    );
    return problems;
  }

  const unavailable = owned.filter(
    (workload) => workload.availableReplicas < 1
  );
  for (const workload of unavailable)
    problems.push(
      `Workload "${workload.name}" applied but has ${workload.availableReplicas} available replica(s) of ` +
        `${workload.desiredReplicas} desired, so the application was rendered but never ran.`
    );
  return problems;
}

export interface SurvivingArtifactsInput {
  /** The GitHub Environment stage one created. */
  readonly environmentName: string;
  readonly environmentExists: boolean;
  /** The exact variables stage one observed after environment creation. */
  readonly expectedVariables: ReadonlyMap<string, string>;
  /** Its variables, as GitHub reports them after the delete. */
  readonly variables: ReadonlyMap<string, string>;
  /** The `appId` observed before the delete, and the one observed after. */
  readonly appIdBefore: string;
  readonly appIdAfter: string;
  /** Federated credential subjects still present on the application. */
  readonly federatedSubjects: readonly string[];
  readonly expectedFederatedSubjects: readonly string[];
  /** Workloads still labelled for the application on the target cluster. */
  readonly remainingWorkloads: readonly KubernetesWorkload[];
}

/**
 * Everything stage three broke that it was required to leave alone.
 *
 * This is the inverse of stage four, deliberately. `deployments.ts` states that
 * deleting a deployment leaves the GitHub Environment and its credentials
 * intact; if the product ever started tearing them down here, every subsequent
 * deploy into that environment would fail for a reason nobody would trace back
 * to a delete. The one thing that must be gone is the Radius application's
 * workloads.
 */
export function findSurvivingArtifactProblems(
  input: SurvivingArtifactsInput
): string[] {
  const problems: string[] = [];

  if (!input.environmentExists)
    problems.push(
      `GitHub Environment "${input.environmentName}" no longer exists. Deleting a deployment must tear down ` +
        "the Radius application only; removing the environment is the delete-environment journey's job."
    );
  else
    for (const name of REQUIRED_ENVIRONMENT_VARIABLES) {
      const expected = input.expectedVariables.get(name);
      if (expected === undefined)
        problems.push(
          `Stage one did not record environment variable ${name}, so its survival cannot be proved.`
        );
    }
  if (input.environmentExists)
    for (const [name, expected] of input.expectedVariables) {
      const value = input.variables.get(name);
      if (value === undefined)
        problems.push(
          `Environment variable ${name} was removed by the delete; the environment can no longer deploy.`
        );
      else if (value !== expected)
        problems.push(
          `Environment variable ${name} changed across the delete; the surviving environment no longer matches ` +
            "the configuration stage one proved."
        );
    }

  if (input.appIdAfter.trim() === "")
    problems.push(
      `The Entra application (appId ${input.appIdBefore}) no longer exists. Deleting a deployment must not ` +
        "touch the identity the environment authenticates with."
    );
  else if (
    input.appIdAfter.trim().toLowerCase() !==
    input.appIdBefore.trim().toLowerCase()
  )
    problems.push(
      `The Entra application changed from ${input.appIdBefore} to ${input.appIdAfter} across the delete, ` +
        "so the environment's AZURE_CLIENT_ID now names an application that did not exist when it was written."
    );

  const present = new Set(input.federatedSubjects);
  for (const subject of input.expectedFederatedSubjects)
    if (!present.has(subject))
      problems.push(
        `Federated credential subject "${subject}" was removed by the delete; workflows in this environment ` +
          "can no longer exchange a GitHub token for an Azure one."
      );

  for (const workload of input.remainingWorkloads)
    problems.push(
      `Workload "${workload.name}" is still labelled for the application after the delete, so the Radius ` +
        "application was not torn down."
    );

  return problems;
}

/** A reviewable explanation of a deploy that did not reach `complete`. */
export function describeDeployFailure(
  snapshot: DeployStatusSnapshot,
  logs: readonly string[]
): string {
  const tail = logs.slice(-20);
  return (
    `The deploy finished in state "${snapshot.status}"` +
    (snapshot.errorKind ? ` (${snapshot.errorKind})` : "") +
    (snapshot.error ? `: ${snapshot.error}` : ".") +
    (snapshot.runUrl ? `\nWorkflow run: ${snapshot.runUrl}` : "") +
    (tail.length === 0 ?
      "\nThe deploy produced no log lines at all."
    : `\nLast ${tail.length} log line(s):\n${tail
        .map((line) => `  ${line}`)
        .join("\n")}`)
  );
}

/** Renders a problem list as one failure message, or empty when there is none. */
export function describeProblems(
  headline: string,
  problems: readonly string[]
): string {
  if (problems.length === 0) return "";
  return (
    `${headline}\n` + problems.map((problem) => `  - ${problem}`).join("\n")
  );
}

function optionalText(value: unknown, field: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string")
    throw new Error(
      `The deploy status response carried a non-string "${field}".`
    );
  return value;
}

function rejectEndpointError(
  record: Record<string, unknown> | undefined,
  endpoint: string
): void {
  const error = record?.error;
  if (error === undefined || error === null || error === "") return;
  if (typeof error !== "string")
    throw new Error(`The ${endpoint} carried a non-string "error".`);
  throw new Error(`The ${endpoint} failed: ${error}`);
}

function optionalStringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    throw new Error(
      `The deploy status response carried a non-array "${field}".`
    );
  const strings: string[] = [];
  for (const [index, entry] of value.entries())
    if (typeof entry !== "string")
      throw new Error(
        `The deploy status response carried a non-string "${field}" entry at index ${index}.`
      );
    else strings.push(entry);
  return strings;
}

function countOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function requireName(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === "")
    throw new Error(`The ${label} is empty, so no cluster probe can be built.`);
  return trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}
