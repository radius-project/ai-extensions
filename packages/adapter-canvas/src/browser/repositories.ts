// Canvas adapter — repository, branch, application and environment selectors.
//
// Every graph pane picks the same things: which repository, which branch, which
// application, which environment. The option lists are built by pure functions
// here so the interesting parts — the workspace-branch default, the "pushed
// refs only" rule for a diff base, and the stale/error states — are unit tested
// without a DOM, and only the last step writes to a selector.
//
// The workspace branch is never silently replaced by "main": a worktree branch
// is offered as itself, labelled as a worktree, and a deploy is refused rather
// than dispatched with an empty branch the server would resolve to the
// repository default.

import { escapeBrowserHtml, hasClassToken } from "./html.js";
import { isRecord, readArray, readString } from "./json.js";
import type { EntryScope } from "./lifecycle.js";
import type {
  BrowserContext,
  DomInputElement,
  DomSelectElement,
  OptionSpec
} from "./ports.js";

export const REPOS_PATH = "/api/user-repos";
export const BRANCHES_PATH = "/api/discover-branches";
export const APPLICATIONS_PATH = "/api/list-applications";
export const ENVIRONMENTS_PATH = "/api/list-environments";
export const DEPLOYMENTS_PATH = "/api/list-deployments";
export const DEPLOY_PATH = "/api/deploy";
export const REPO_RETRY_MS = 1000;
export const DIFF_BRANCH_TIMEOUT_MS = 8000;
export const DEFAULT_APP_FILE = ".radius/app.bicep";
export const WORKTREE_SHA = "worktree";

export interface BranchInfo {
  name: string;
  sha: string;
}

export interface BranchListing {
  branches: BranchInfo[];
  workspaceBranch: string;
  error: string;
}

export interface ApplicationInfo {
  name: string;
}

export interface EnvironmentInfo {
  name: string;
  provider: string;
  status?: string;
}

// The listing parser always resolves a status string, so consumers of a parsed
// listing never have to re-apply a fallback for it.
export interface ParsedEnvironmentInfo extends EnvironmentInfo {
  status: string;
}

export interface EnvironmentListing {
  environments: ParsedEnvironmentInfo[];
  error: string;
}

export interface DeploymentInfo {
  app: string;
  environment: string;
  status: string;
  runUrl: string;
}

export function deploymentKey(
  application: string,
  environment: string
): string {
  return `${application}\u0000${environment}`;
}

export function deploymentStatusBlocksMutation(status: string): boolean {
  return (
    status === "pending" || status === "in_progress" || status === "deleting"
  );
}

// A page hands this object in and only this module writes to it, so values are
// read back defensively rather than assumed to be provider strings.
export type EnvironmentProviders = Record<string, unknown>;

export interface PlanState {
  hasEnv: boolean;
  envsStale: boolean;
  deploymentsStale: boolean;
  requestFailed: boolean;
  environmentStatuses: Record<string, string>;
  deploymentStatuses: Record<string, string>;
}

export function createPlanState(): PlanState {
  return {
    hasEnv: false,
    envsStale: false,
    deploymentsStale: false,
    requestFailed: false,
    environmentStatuses: {},
    deploymentStatuses: {}
  };
}

export function parseBranchListing(payload: unknown): BranchListing {
  const branches = readArray(payload, "branches")
    .map((entry) => ({
      name: readString(entry, "name"),
      sha: readString(entry, "sha")
    }))
    .filter((branch) => branch.name !== "");
  return {
    branches,
    workspaceBranch: readString(payload, "workspaceBranch"),
    error: readString(payload, "error")
  };
}

export function parseApplicationListing(payload: unknown): ApplicationInfo[] {
  return readArray(payload, "applications")
    .map((entry) => ({ name: readString(entry, "name") }))
    .filter((application) => application.name !== "");
}

export function parseEnvironmentListing(payload: unknown): EnvironmentListing {
  return {
    environments: readArray(payload, "environments")
      .map((entry) => ({
        name: readString(entry, "name"),
        provider: readString(entry, "provider") || "azure",
        status: readString(entry, "status")
      }))
      .filter((environment) => environment.name !== ""),
    error: readString(payload, "error")
  };
}

export function parseDeploymentListing(payload: unknown): DeploymentInfo[] {
  return readArray(payload, "deployments")
    .map((entry) => ({
      app: readString(entry, "app"),
      environment: readString(entry, "environment"),
      status: readString(entry, "status"),
      runUrl: readString(entry, "runUrl")
    }))
    .filter((entry) => entry.app !== "" && entry.environment !== "");
}

// A worktree branch has no pushed commit, so it is labelled as such instead of
// showing a truncated SHA that does not exist on the remote.
export function branchLabel(branch: BranchInfo): string {
  return branch.sha === WORKTREE_SHA ?
      `${branch.name} (worktree)`
    : `${branch.name} (${branch.sha.slice(0, 7)})`;
}

export function buildRepoOptions(
  repositories: readonly string[],
  defaultRepo: string
): OptionSpec[] {
  const options: OptionSpec[] = [
    { value: "", label: "-- Select repository --" }
  ];
  let found = false;
  for (const repository of repositories) {
    const selected = repository === defaultRepo && defaultRepo !== "";
    if (selected) found = true;
    options.push({ value: repository, label: repository, selected });
  }
  // A repository the listing does not know about is still the session's
  // repository, so it is offered rather than quietly dropped.
  if (defaultRepo !== "" && !found) {
    options.splice(1, 0, {
      value: defaultRepo,
      label: defaultRepo,
      selected: true
    });
  }
  return options;
}

export function buildBranchOptions(
  branches: readonly BranchInfo[],
  defaultValue: string,
  workspaceBranch: string
): OptionSpec[] {
  const wanted = defaultValue || workspaceBranch || "main";
  const options = branches.map((branch) => ({
    value: branch.name,
    label: branchLabel(branch),
    selected: branch.name === wanted
  }));
  if (options.some((option) => option.selected)) return options;
  // The workspace branch may not be pushed yet; it is still the branch the
  // session is on, so it leads the list rather than being replaced by main.
  if (wanted !== "" && wanted === workspaceBranch) {
    return [
      { value: wanted, label: `${wanted} (worktree)`, selected: true },
      ...options
    ];
  }
  if (options.length > 0) options[0].selected = true;
  return options;
}

export interface DiffBranchOptions {
  base: OptionSpec[];
  head: OptionSpec[];
}

// The diff base must be a pushed ref because the comparison is computed from
// GitHub. The head may additionally be the local worktree branch, whose
// app.bicep the backend reads straight from the workspace.
export function buildDiffBranchOptions(
  listing: BranchListing,
  preferBase: string,
  preferHead: string
): DiffBranchOptions {
  const pushed = listing.branches.filter(
    (branch) => branch.sha !== "" && branch.sha !== WORKTREE_SHA
  );
  const headBranches = listing.branches.filter(
    (branch) =>
      branch.sha !== "" &&
      (branch.sha !== WORKTREE_SHA || branch.name === listing.workspaceBranch)
  );
  const desiredBase = preferBase || "main";
  const desiredHead = preferHead || listing.workspaceBranch;
  const base = pushed.map((branch) => ({
    value: branch.name,
    label: `${branch.name} (${branch.sha.slice(0, 7)})`,
    selected: branch.name === desiredBase
  }));
  if (base.length > 0 && !base.some((option) => option.selected)) {
    base[0].selected = true;
  }
  const head: OptionSpec[] = [
    { value: "", label: "— Select a branch —" },
    ...headBranches.map((branch) => ({
      value: branch.name,
      label: branchLabel(branch),
      selected: desiredHead !== "" && branch.name === desiredHead
    }))
  ];
  return { base, head };
}

export function buildApplicationOptions(
  applications: readonly ApplicationInfo[],
  repo: string
): OptionSpec[] {
  if (applications.length > 0) {
    return applications.map((application) => ({
      value: application.name,
      label: application.name
    }));
  }
  // A repository hosts a single Radius application in this model, so its short
  // name is the honest fallback.
  const slash = repo.lastIndexOf("/");
  const fallback = slash >= 0 ? repo.slice(slash + 1) : repo;
  return [{ value: fallback, label: fallback }];
}

export function buildEnvironmentOptions(
  environments: readonly EnvironmentInfo[],
  defaultEnvironment: string
): OptionSpec[] {
  const selectedEnvironment =
    defaultEnvironment || firstReadyEnvironmentName(environments);
  return environments.map((environment) => ({
    value: environment.name,
    label: environmentOptionLabel(environment),
    selected: environment.name === selectedEnvironment
  }));
}

export function environmentIsReady(status: string): boolean {
  return status === "success";
}

export function environmentAllowsDeploy(status: string): boolean {
  return environmentIsReady(status) || status === "unknown";
}

// The server reports "success", "failed", or "pending". Anything else — an
// empty string, or a value from a newer server — is genuinely unknown, so it is
// labelled as such instead of being explained away as still being created.
function environmentIsPending(status: string): boolean {
  return status === "pending";
}

export function environmentOptionLabel(environment: EnvironmentInfo): string {
  const status = environment.status ?? "";
  if (environmentIsReady(status)) return environment.name;
  if (status === "failed") return `${environment.name} (creation failed)`;
  if (environmentIsPending(status))
    return `${environment.name} (being created…)`;
  if (status === "unknown") return `${environment.name} (available)`;
  return `${environment.name} (status unknown)`;
}

export function firstReadyEnvironmentName(
  environments: readonly EnvironmentInfo[]
): string {
  return (
    environments.find((environment) =>
      environmentIsReady(environment.status ?? "")
    )?.name ??
    environments.find((environment) =>
      environmentAllowsDeploy(environment.status ?? "")
    )?.name ??
    ""
  );
}

export function environmentNotReadyReason(
  name: string,
  status: string
): string {
  if (environmentAllowsDeploy(status)) return "";
  if (status === "failed") {
    return `Environment "${name}" was not created successfully, so it cannot be deployed to. Fix or recreate it first.`;
  }
  if (environmentIsPending(status)) {
    return `Environment "${name}" is still being created. Wait for its credential verification to finish before deploying.`;
  }
  return `The status of environment "${name}" could not be determined, so it cannot be deployed to. Refresh to try again.`;
}

export function environmentNotReadyPhrase(status: string): string {
  if (status === "failed") return "was not created successfully";
  if (environmentIsPending(status)) return "is still being created";
  return "has an unknown status";
}

function selectValue(select: DomSelectElement | null): string {
  return select ? select.value : "";
}

function getJson(context: BrowserContext, url: string): Promise<unknown> {
  return context.net.fetch(url).then((response) => response.json());
}

function postJson(
  context: BrowserContext,
  url: string,
  body: unknown
): Promise<unknown> {
  return context.net
    .fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
    .then((response) => response.json());
}

function branchListingFor(
  context: BrowserContext,
  repo: string
): Promise<BranchListing> {
  return postJson(context, BRANCHES_PATH, { repo }).then(parseBranchListing);
}

// Fill a repository selector, retrying once for a listing that has not warmed
// up yet. A second failure leaves the current options alone — an empty
// selector would look like "you have no repositories".
export function populateRepositories(
  context: BrowserContext,
  selectId: string,
  defaultRepo: string,
  isCurrent: () => boolean = () => true
): Promise<void> {
  const select = context.dom.selectById(selectId);
  if (!select) return Promise.resolve();
  const load = (): Promise<void> =>
    getJson(context, `${REPOS_PATH}?_t=${context.clock.now()}`).then(
      (payload) => {
        if (!isCurrent()) return;
        const repositories = readArray(payload, "repos").filter(
          (entry): entry is string => typeof entry === "string"
        );
        context.dom.setOptions(
          select,
          buildRepoOptions(repositories, defaultRepo)
        );
      }
    );
  return load().catch(() =>
    new Promise<void>((resolve) => {
      context.clock.setTimeout(resolve, REPO_RETRY_MS);
    })
      .then(load)
      .catch((error: unknown) => {
        context.logger.error("Radius could not list repositories.", error);
      })
  );
}

export function populateBranches(
  context: BrowserContext,
  selectIds: readonly string[],
  repo: string,
  defaults: readonly string[],
  isCurrent: () => boolean = () => true
): Promise<void> {
  if (!repo) return Promise.resolve();
  return branchListingFor(context, repo).then((listing) => {
    if (!isCurrent()) return;
    if (listing.error !== "") return;
    selectIds.forEach((selectId, index) => {
      const select = context.dom.selectById(selectId);
      if (!select) return;
      context.dom.setOptions(
        select,
        buildBranchOptions(
          listing.branches,
          defaults[index] ?? "",
          listing.workspaceBranch
        )
      );
    });
  });
}

// Wire a repository selector to one or more branch selectors: load both now,
// and reload the branches whenever the repository changes.
export function setupRepoBranch(
  context: BrowserContext,
  repoSelectId: string,
  branchSelectIds: readonly string[],
  defaultRepo: string,
  defaultBranches: readonly string[]
): Promise<void> {
  const select = context.dom.selectById(repoSelectId);
  let generation = 0;
  const load = (repo: string): Promise<void> => {
    const requestGeneration = ++generation;
    return populateBranches(
      context,
      branchSelectIds,
      repo,
      defaultBranches,
      () => requestGeneration === generation
    );
  };
  if (select) {
    select.addEventListener("change", () => {
      if (select.value) {
        void load(select.value);
      } else {
        generation++;
      }
    });
  }
  const initialGeneration = generation;
  return populateRepositories(
    context,
    repoSelectId,
    defaultRepo,
    () => generation === initialGeneration
  ).then(() => {
    if (generation !== initialGeneration) return undefined;
    const repoSelect = context.dom.selectById(repoSelectId);
    if (repoSelect && repoSelect.value) {
      return load(repoSelect.value);
    }
    return undefined;
  });
}

export function populateApplications(
  context: BrowserContext,
  repo: string,
  selectId: string
): Promise<void> {
  const select = context.dom.selectById(selectId);
  if (!select) return Promise.resolve();
  if (!repo) {
    context.dom.setOptions(select, [
      { value: "", label: "No application context" }
    ]);
    return Promise.resolve();
  }
  return getJson(
    context,
    `${APPLICATIONS_PATH}?repo=${encodeURIComponent(repo)}`
  )
    .then((payload) => {
      context.dom.setOptions(
        select,
        buildApplicationOptions(parseApplicationListing(payload), repo)
      );
    })
    .catch(() => {
      context.dom.setOptions(select, [
        { value: "", label: "Unable to load applications" }
      ]);
    });
}

export interface PlannedSelectorOptions {
  repo: string;
  environmentProviders: EnvironmentProviders;
  defaultBranch?: string;
  defaultEnvironment?: string;
}

// Populate the Application / Branch / Environment selectors on the Planned
// pane. The button and hint state is applied only after the application and
// environment lists have both settled, so the hint can name the selection
// instead of falling back to generic text.
export function populatePlannedSelectors(
  context: BrowserContext,
  state: PlanState,
  options: PlannedSelectorOptions
): Promise<void> {
  const dom = context.dom;
  const appSelect = dom.selectById("planned-app");
  const branchSelect = dom.selectById("planned-branch");
  const envSelect = dom.selectById("planned-env");
  const repo = options.repo;
  if (!repo) {
    const empty = [{ value: "", label: "No repository" }];
    if (appSelect) dom.setOptions(appSelect, empty);
    if (branchSelect) dom.setOptions(branchSelect, empty);
    if (envSelect) dom.setOptions(envSelect, empty);
    return Promise.resolve();
  }

  const appPromise =
    appSelect ?
      getJson(context, `${APPLICATIONS_PATH}?repo=${encodeURIComponent(repo)}`)
        .then((payload) => {
          const applications = parseApplicationListing(payload);
          dom.setOptions(
            appSelect,
            buildApplicationOptions(applications, repo)
          );
          // Honour ?app= (for example from the Modeled graph's "Plan
          // Deployment"), but only for an application that actually exists.
          const requested = readQueryParameter(context.nav.search, "app");
          if (
            requested !== "" &&
            applications.some((application) => application.name === requested)
          ) {
            appSelect.value = requested;
          }
        })
        .catch(() => {
          dom.setOptions(appSelect, [
            { value: "", label: "Unable to load applications" }
          ]);
        })
    : Promise.resolve();

  const branchPromise =
    branchSelect ?
      branchListingFor(context, repo)
        .then((listing) => {
          dom.setOptions(branchSelect, [
            { value: "", label: "— Select a branch —" },
            ...buildBranchOptions(
              listing.branches,
              options.defaultBranch ?? "",
              listing.workspaceBranch
            )
          ]);
        })
        .catch(() => {
          dom.setOptions(branchSelect, [
            { value: "", label: "Unable to load branches" }
          ]);
        })
    : Promise.resolve();

  let hasEnvironments = false;
  let environmentsUnavailable = false;
  const envPromise =
    envSelect ?
      getJson(context, `${ENVIRONMENTS_PATH}?repo=${encodeURIComponent(repo)}`)
        .then((payload) => {
          const listing = parseEnvironmentListing(payload);
          if (listing.error !== "") {
            environmentsUnavailable = true;
            dom.setOptions(envSelect, [
              { value: "", label: "Unable to load environments" }
            ]);
            return;
          }
          if (listing.environments.length === 0) {
            dom.setOptions(envSelect, [
              { value: "", label: "No environments" }
            ]);
            return;
          }
          for (const environment of listing.environments) {
            options.environmentProviders[environment.name] =
              environment.provider;
            state.environmentStatuses[environment.name] = environment.status;
          }
          dom.setOptions(
            envSelect,
            buildEnvironmentOptions(
              listing.environments,
              options.defaultEnvironment ?? ""
            )
          );
          hasEnvironments = true;
        })
        .catch(() => {
          environmentsUnavailable = true;
          dom.setOptions(envSelect, [
            { value: "", label: "Unable to load environments" }
          ]);
        })
    : Promise.resolve();

  const deploymentsPromise =
    appSelect && envSelect ?
      getJson(context, `${DEPLOYMENTS_PATH}?repo=${encodeURIComponent(repo)}`)
        .then((payload) => {
          if (readString(payload, "error") !== "") {
            state.deploymentsStale = true;
            return;
          }
          state.deploymentsStale = false;
          state.deploymentStatuses = {};
          for (const deployment of parseDeploymentListing(payload)) {
            state.deploymentStatuses[
              deploymentKey(deployment.app, deployment.environment)
            ] = deployment.status;
          }
        })
        .catch(() => {
          state.deploymentsStale = true;
        })
    : Promise.resolve();

  return Promise.all([
    appPromise,
    branchPromise,
    envPromise,
    deploymentsPromise
  ]).then(() => {
    applyPlanEnvState(context, state, hasEnvironments, environmentsUnavailable);
  });
}

function readQueryParameter(search: string, name: string): string {
  const query = search.startsWith("?") ? search.slice(1) : search;
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const separator = pair.indexOf("=");
    const key = separator < 0 ? pair : pair.slice(0, separator);
    if (decodeURIComponent(key) !== name) continue;
    const value = separator < 0 ? "" : pair.slice(separator + 1);
    return decodeURIComponent(value.replace(/\+/g, " "));
  }
  return "";
}

// Toggle the Planned primary button between "Create Environment" and "Deploy
// Application". In deploy mode it stays disabled until both a branch and an
// environment are chosen: an empty branch is not inert, because the server
// would fall back to the repository default and deploy something other than
// the graph the user just previewed.
export function applyPlanEnvState(
  context: BrowserContext,
  state: PlanState,
  hasEnv: boolean,
  statesUnavailable: boolean
): void {
  state.hasEnv = hasEnv;
  state.envsStale = statesUnavailable;
  const dom = context.dom;
  const button = dom.inputById("plan-btn");
  const hint = dom.byId("planned-subtitle-hint");
  const appSelect = dom.selectById("planned-app");
  const branchSelect = dom.selectById("planned-branch");
  const envSelect = dom.selectById("planned-env");
  const branch = selectValue(branchSelect).trim();
  const environment = selectValue(envSelect);
  const application = selectValue(appSelect);
  const environmentStatus = state.environmentStatuses[environment] ?? "";
  const deploymentStatus =
    state.deploymentStatuses[deploymentKey(application, environment)] ?? "";
  const deploymentBlocked = deploymentStatusBlocksMutation(deploymentStatus);

  if (button) {
    button.removeAttribute("title");
    if (statesUnavailable) {
      button.dataset.mode = "unavailable";
      button.textContent = "Deploy Application";
      button.disabled = true;
      button.setAttribute(
        "title",
        "Environments could not be loaded. Try again before deploying."
      );
    } else if (hasEnv) {
      button.dataset.mode = "deploy";
      button.textContent = "Deploy Application";
      const environmentReady =
        environment === "" || environmentAllowsDeploy(environmentStatus);
      button.disabled =
        !(branch && environment) ||
        !environmentReady ||
        state.deploymentsStale ||
        deploymentBlocked;
      if (!branch && !environment) {
        button.setAttribute(
          "title",
          "Select a branch and an environment to deploy."
        );
      } else if (!branch) {
        button.setAttribute("title", "Select the branch to deploy.");
      } else if (!environment) {
        button.setAttribute("title", "Select the environment to deploy to.");
      } else if (!environmentReady) {
        button.setAttribute(
          "title",
          environmentNotReadyReason(environment, environmentStatus)
        );
      } else if (state.deploymentsStale) {
        button.setAttribute(
          "title",
          "Deployment states could not be loaded. Try again before deploying."
        );
      } else if (deploymentBlocked) {
        button.setAttribute(
          "title",
          `A deployment of application "${application}" to environment "${environment}" is already in progress. Wait for it to finish before deploying again.`
        );
      } else if (state.requestFailed) {
        button.disabled = true;
        button.setAttribute(
          "title",
          "The selected deployment plan could not be generated. Try another selection."
        );
      }
    } else {
      button.dataset.mode = "create-env";
      button.textContent = "Create Environment";
      button.disabled = false;
    }
  }

  if (hint) {
    if (statesUnavailable) {
      hint.textContent =
        " Environments could not be loaded, so deployment planning is temporarily unavailable.";
    } else if (hasEnv) {
      const appName = application || "this application";
      const envName = environment || "the selected environment";
      hint.innerHTML =
        environment !== "" && !environmentAllowsDeploy(environmentStatus) ?
          ` The environment (<strong>${escapeBrowserHtml(envName)}</strong>) ${environmentNotReadyPhrase(environmentStatus)}, so it cannot be deployed to yet.`
        : state.deploymentsStale ?
          " Deployment states could not be loaded, so deployment is temporarily unavailable."
        : deploymentBlocked ?
          ` A deployment of this application (<strong>${escapeBrowserHtml(appName)}</strong>) to the environment (<strong>${escapeBrowserHtml(envName)}</strong>) is already in progress. Watch its progress on the Deployments tab.`
        : ` To deploy this application (<strong>${escapeBrowserHtml(appName)}</strong>) to the environment (<strong>${escapeBrowserHtml(envName)}</strong>), click "Deploy Application".`;
    } else {
      hint.textContent =
        " To plan the deployment of this application, you must first create an environment.";
    }
  }
}

export type PlanRunner = (isCurrent: () => boolean) => Promise<unknown> | void;

export interface PlanScheduler {
  (immediate?: boolean): void;
}

// Coalesce rapid selector changes and serialize plan requests. A selection made
// while a request is active invalidates that response and queues exactly one
// request for the latest values, so an older plan can never overwrite a newer
// selection in the browser or in the server's canvas state.
export function createPlanScheduler(
  context: BrowserContext,
  run: PlanRunner,
  onIdle?: () => void,
  debounceMs = 150
): PlanScheduler {
  let version = 0;
  let active = false;
  let queued = false;
  let timer: number | null = null;

  const drain = (): void => {
    timer = null;
    queued = false;
    active = true;
    const requestVersion = version;
    Promise.resolve()
      .then(() => run(() => requestVersion === version))
      .catch((error: unknown) => {
        context.logger.error("Planned graph request failed.", error);
      })
      .then(() => {
        active = false;
        if (queued) {
          timer = context.clock.setTimeout(drain, debounceMs);
        } else if (onIdle) {
          onIdle();
        }
      });
  };

  return (immediate?: boolean) => {
    version++;
    queued = true;
    if (timer !== null) context.clock.clearTimeout(timer);
    if (active) return;
    timer = context.clock.setTimeout(
      drain,
      immediate === true ? 0 : debounceMs
    );
  };
}

interface DeployDispatch {
  button: DomInputElement;
  repo: string;
  branch: string;
  environment: string;
  application: string;
  provider: string;
}

function resolveProvider(
  providers: EnvironmentProviders,
  environment: string,
  fallbackProvider: string
): string {
  const configured = providers[environment];
  const named = typeof configured === "string" ? configured : "";
  return named || fallbackProvider || "azure";
}

function dispatchDeploy(
  context: BrowserContext,
  request: DeployDispatch,
  isCurrent: () => boolean
): Promise<void> {
  const button = request.button;
  button.disabled = true;
  button.textContent = "Starting deployment…";
  return context.net
    .fetch(DEPLOY_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        environment: request.environment,
        provider: request.provider,
        targetRepo: request.repo,
        branch: request.branch,
        appFile: DEFAULT_APP_FILE
      })
    })
    .then((response) =>
      response
        .json()
        .catch(() => null)
        .then((payload) => ({ ok: response.ok, payload }))
    )
    .then((result) => {
      if (!isCurrent()) return;
      if (!result.ok) {
        restoreDeployButton(
          button,
          readString(isRecord(result.payload) ? result.payload : {}, "error") ||
            "Could not start the deployment."
        );
        return;
      }
      context.nav.assign(
        `/?page=deploying&application=${encodeURIComponent(request.application)}&environment=${encodeURIComponent(request.environment)}`
      );
    })
    .catch(() => {
      if (!isCurrent()) return;
      restoreDeployButton(button, "Could not start the deployment.");
    });
}

function restoreDeployButton(button: DomInputElement, reason: string): void {
  button.textContent = "Deploy Application";
  button.disabled = false;
  button.setAttribute("title", reason);
}

// Deploy the Planned pane's current selection. The dispatch itself refuses an
// empty branch even though the button is already disabled in that state.
export function deployPlannedApp(
  context: BrowserContext,
  button: DomInputElement | null,
  repo: string,
  environmentProviders: EnvironmentProviders,
  fallbackProvider: string,
  isCurrent: () => boolean = () => true
): Promise<void> {
  if (!button || button.disabled) return Promise.resolve();
  const dom = context.dom;
  const branch = selectValue(dom.selectById("planned-branch")).trim();
  const environment = selectValue(dom.selectById("planned-env"));
  const application = selectValue(dom.selectById("planned-app"));
  if (!repo || !environment || !branch) return Promise.resolve();
  return dispatchDeploy(
    context,
    {
      button,
      repo,
      branch,
      environment,
      application,
      provider: resolveProvider(
        environmentProviders,
        environment,
        fallbackProvider
      )
    },
    isCurrent
  );
}

export interface DeployedEnvState {
  hasEnv: boolean;
  hasDeployment: boolean;
}

export function createDeployedState(): DeployedEnvState {
  return { hasEnv: false, hasDeployment: false };
}

export type DeployedMode = "create-env" | "deploy" | "delete";

// Adapt the Deployed primary button to the user's actual setup: no environment
// at all, an environment without a deployment, or an existing deployment. A
// deployment listing that could not be read disables the destructive path
// rather than acting on state we cannot confirm.
export function applyDeployedEnvState(
  context: BrowserContext,
  state: DeployedEnvState,
  hasEnv: boolean,
  hasDeployment: boolean,
  deploymentStatus: string,
  statesUnavailable: boolean,
  environmentsUnavailable = false,
  environmentCreationStatus = ""
): DeployedMode {
  state.hasEnv = hasEnv;
  state.hasDeployment = hasDeployment;
  const dom = context.dom;
  const button = dom.inputById("deployed-delete-btn");
  const hint = dom.byId("deployed-subtitle-hint");
  const application = selectValue(dom.selectById("deployed-app-select"));
  const environment = selectValue(dom.selectById("deployed-env-select"));
  const pending = deploymentStatus === "pending";
  const deleting = deploymentStatus === "deleting";
  const mode: DeployedMode =
    environmentsUnavailable ? "deploy"
    : !hasEnv ? "create-env"
    : hasDeployment ? "delete"
    : "deploy";

  if (button) {
    button.dataset.mode = mode;
    button.removeAttribute("title");
    if (mode === "create-env") {
      button.textContent = "Create Environment";
      button.className = "rad-btn rad-btn--primary";
      // Creating an environment does not act on deployment state, so an
      // unreadable listing is no reason to block it.
      button.disabled = false;
    } else if (mode === "deploy") {
      button.textContent = "Deploy Application";
      button.className = "rad-btn rad-btn--primary";
      button.disabled =
        !(application && environment) ||
        statesUnavailable ||
        environmentsUnavailable ||
        !environmentAllowsDeploy(environmentCreationStatus);
      if (environmentsUnavailable) {
        button.setAttribute(
          "title",
          "Environments could not be loaded. Try again before deploying."
        );
      } else if (statesUnavailable) {
        button.setAttribute(
          "title",
          "The current deployment state could not be loaded. Retrying…"
        );
      } else if (!environmentAllowsDeploy(environmentCreationStatus)) {
        button.setAttribute(
          "title",
          environmentNotReadyReason(environment, environmentCreationStatus)
        );
      }
    } else {
      button.textContent =
        pending ? "Deploying…"
        : deleting ? "Deleting…"
        : "Delete Deployment";
      button.className = "rad-btn rad-btn--danger-outline";
      button.disabled =
        !(application && environment) ||
        pending ||
        deleting ||
        statesUnavailable;
      if (pending) {
        button.setAttribute(
          "title",
          "This deployment is still in progress. Wait for it to finish before deleting it."
        );
      } else if (deleting) {
        button.setAttribute(
          "title",
          `This deployment is already being deleted from environment "${environment}". Wait for the delete to finish.`
        );
      } else if (statesUnavailable) {
        button.setAttribute(
          "title",
          "The current deployment state could not be loaded. Retrying…"
        );
      }
    }
  }

  if (hint) {
    const appLabel = `<strong>${escapeBrowserHtml(application || "this application")}</strong>`;
    const envLabel = `<strong>${escapeBrowserHtml(environment || "the selected environment")}</strong>`;
    if (environmentsUnavailable) {
      hint.textContent =
        " Environments could not be loaded, so deployment actions are temporarily unavailable.";
    } else if (mode === "create-env") {
      hint.textContent =
        " To deploy this application, you must first create an environment.";
    } else if (mode === "deploy") {
      hint.innerHTML =
        !environmentAllowsDeploy(environmentCreationStatus) ?
          ` The environment (${envLabel}) ${environmentNotReadyPhrase(environmentCreationStatus)}, so this application cannot be deployed to it yet.`
        : ` To deploy this application (${appLabel}) to the environment (${envLabel}), click "Deploy Application".`;
    } else if (pending) {
      hint.innerHTML = ` The application (${appLabel}) is currently being deployed to the environment (${envLabel}). Watch its progress on the Deployments tab.`;
    } else if (deleting) {
      hint.innerHTML = ` The application (${appLabel}) is currently being deleted from the environment (${envLabel}). Watch its progress on the Deployments tab.`;
    } else {
      hint.innerHTML = ` Click the name of any application component to deep link into the cloud portal for its infrastructure. To delete the application (${appLabel}) currently deployed to the environment (${envLabel}), click "Delete Deployment".`;
    }
  }
  return mode;
}

// Deploy the Deployed pane's current selection. The branch is resolved
// server-side before it reaches the page, but an empty one is still refused:
// /api/deploy would resolve it to the repository default.
export function deployDeployedApp(
  context: BrowserContext,
  button: DomInputElement | null,
  repo: string,
  branch: string,
  environmentProviders: EnvironmentProviders,
  fallbackProvider: string,
  isCurrent: () => boolean = () => true
): Promise<void> {
  if (!button || button.disabled) return Promise.resolve();
  const dom = context.dom;
  const environment = selectValue(dom.selectById("deployed-env-select"));
  const application = selectValue(dom.selectById("deployed-app-select"));
  const deployBranch = branch.trim();
  if (!repo || !environment || !deployBranch) return Promise.resolve();
  return dispatchDeploy(
    context,
    {
      button,
      repo,
      branch: deployBranch,
      environment,
      application,
      provider: resolveProvider(
        environmentProviders,
        environment,
        fallbackProvider
      )
    },
    isCurrent
  );
}

export function applyModeledEnvState(
  context: BrowserContext,
  hasEnv: boolean
): void {
  const button = context.dom.inputById("deploy-app-btn");
  const hint = context.dom.byId("modeled-subtitle-hint");
  if (button) {
    if (hasEnv) {
      button.dataset.mode = "plan";
      button.textContent = "Plan Deployment";
    } else {
      button.dataset.mode = "create-env";
      button.textContent = "Create Environment";
      button.disabled = false;
    }
  }
  if (hint) {
    hint.textContent =
      hasEnv ?
        ' To see how this application would be deployed to one of your existing environments, click "Plan Deployment".'
      : " To plan the deployment of this application, you must first create an environment.";
  }
}

function applyModeledEnvUnavailable(
  context: BrowserContext,
  error: unknown
): void {
  context.logger.error("Radius environments could not be loaded.", error);
  const button = context.dom.inputById("deploy-app-btn");
  if (button) {
    button.dataset.mode = "unavailable";
    button.disabled = true;
    button.setAttribute(
      "title",
      "Environments could not be loaded. Try again before planning a deployment."
    );
  }
  const hint = context.dom.byId("modeled-subtitle-hint");
  if (hint) {
    hint.textContent =
      " Environments could not be loaded, so deployment planning is temporarily unavailable.";
  }
}

export function modeledPrimaryAction(
  context: BrowserContext,
  button: DomInputElement | null
): void {
  if (!button || button.disabled) return;
  if (button.dataset.mode === "create-env") {
    context.nav.assign("/?page=environment&new=1");
    return;
  }
  const application = selectValue(context.dom.selectById("graph-app"));
  context.nav.assign(
    `/?page=planned${application ? `&app=${encodeURIComponent(application)}` : ""}`
  );
}

export function loadModeledEnvState(
  context: BrowserContext,
  repo: string,
  isCurrent: () => boolean = () => true
): Promise<void> {
  if (!repo) return Promise.resolve();
  return getJson(
    context,
    `${ENVIRONMENTS_PATH}?repo=${encodeURIComponent(repo)}`
  )
    .then((payload) => {
      if (!isCurrent()) return;
      const listing = parseEnvironmentListing(payload);
      if (listing.error !== "") {
        applyModeledEnvUnavailable(context, listing.error);
        return;
      }
      applyModeledEnvState(context, listing.environments.length > 0);
    })
    .catch((error: unknown) => {
      if (!isCurrent()) return;
      applyModeledEnvUnavailable(context, error);
    });
}

export interface DiffBranchLoadOptions {
  preferBase?: string;
  preferHead?: string;
  autoCompare?: boolean;
  lifecycle?: Pick<EntryScope, "active" | "after" | "cancel">;
}

// Populate the Base/Head selectors on the Graph Diff pane, then hand off to the
// compare flow when a head resolved. An error already on screen is preserved
// when the caller asked not to auto-compare, so a repopulate cannot erase the
// reason the previous comparison failed.
export function populateDiffBranches(
  context: BrowserContext,
  repo: string,
  options: DiffBranchLoadOptions = {}
): Promise<void> {
  const dom = context.dom;
  const baseSelect = dom.selectById("base-branch");
  const headSelect = dom.selectById("head-branch");
  const status = dom.byId("diff-status");
  const autoCompare = options.autoCompare !== false;
  const isCurrent = (): boolean => options.lifecycle?.active !== false;
  const preserveError =
    !autoCompare &&
    status !== null &&
    hasClassToken(status.className, "error") &&
    (status.textContent ?? "").trim() !== "";

  if (!repo) {
    if (status) status.textContent = "No repository context.";
    return Promise.resolve();
  }
  if (status && !preserveError) status.textContent = "Loading branches…";

  let cancelTimeout: () => void;
  if (options.lifecycle) {
    const lifecycle = options.lifecycle;
    const timeout = lifecycle.after(DIFF_BRANCH_TIMEOUT_MS, onTimeout);
    cancelTimeout = () => lifecycle.cancel(timeout);
  } else {
    const timeout = context.clock.setTimeout(onTimeout, DIFF_BRANCH_TIMEOUT_MS);
    cancelTimeout = () => context.clock.clearTimeout(timeout);
  }

  function onTimeout(): void {
    if (!isCurrent()) return;
    if (
      !preserveError &&
      status &&
      status.textContent === "Loading branches…"
    ) {
      status.style.display = "";
      status.textContent = "Loading branches is taking longer than expected…";
      status.className = "status error";
      const timeoutOption = [{ value: "", label: "Timeout" }];
      if (baseSelect) dom.setOptions(baseSelect, timeoutOption);
      if (headSelect) dom.setOptions(headSelect, timeoutOption);
    }
  }

  return branchListingFor(context, repo)
    .then((listing) => {
      cancelTimeout();
      if (!isCurrent()) return;
      if (listing.error !== "") {
        if (status) {
          status.style.display = "";
          status.textContent = `Error: ${listing.error}`;
          status.className = "status error";
        }
        return;
      }
      if (!baseSelect || !headSelect) return;
      const built = buildDiffBranchOptions(
        listing,
        options.preferBase ?? "",
        options.preferHead ?? ""
      );
      dom.setOptions(baseSelect, built.base);
      dom.setOptions(headSelect, built.head);

      if (headSelect.value) {
        if (status && !preserveError) {
          status.className = "status info";
          status.textContent = `Comparing ${baseSelect.value} → ${headSelect.value}…`;
        }
        if (autoCompare) dom.dispatch(headSelect, "change");
      } else if (status && !preserveError) {
        status.className = "status info";
        status.textContent = `Select a head branch to compare against ${baseSelect.value || "main"}.`;
      }
    })
    .catch(() => {
      cancelTimeout();
      if (!isCurrent()) return;
      if (status) {
        status.textContent =
          "Failed to load branches. Network or backend error.";
        status.className = "status error";
      }
    });
}
