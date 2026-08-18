// Canvas adapter — the Deployments page: application/environment/branch
// selection, the deployment table, deploy dispatch with progress and failure
// reporting, delete confirmation, and resuming a redirected in-flight
// deployment. Translated from the legacy inline script at
// src/pages/deploying/client-deployments.ts into one importable, testable
// module per the Radius Canvas re-architecture.

import { createDeleteDeploymentDialog } from "../delete-dialog.js";
import { escapeBrowserHtml } from "../html.js";
import {
  isRecord,
  readArray,
  readBoolean,
  readRecord,
  readString
} from "../json.js";
import { beginEntry, NOOP_TEARDOWN } from "../lifecycle.js";
import { queryValue } from "../query.js";
import { DEPLOYING_PAGE_STATE_ID } from "../../pages/browser-state-ids.js";
import {
  APPLICATIONS_PATH,
  BRANCHES_PATH,
  DEFAULT_APP_FILE,
  DEPLOY_PATH,
  ENVIRONMENTS_PATH,
  WORKTREE_SHA,
  buildEnvironmentOptions,
  environmentIsReady,
  environmentNotReadyReason,
  parseApplicationListing,
  parseBranchListing,
  parseEnvironmentListing
} from "../repositories.js";
import type { BrowserTeardown } from "../lifecycle.js";
import type {
  AbortHandle,
  BrowserContext,
  DomEventListener,
  DomEventTarget,
  OptionSpec
} from "../ports.js";

import type { ApplicationInfo, BranchListing } from "../repositories.js";

const ENTRY_KEY = "deploying-page";

export { DEPLOYING_PAGE_STATE_ID };
export const LIST_DEPLOYMENTS_PATH = "/api/list-deployments";
export const DELETE_DEPLOYMENT_PATH = "/api/delete-deployment";
export const DEPLOY_STATUS_PATH = "/api/deploy-status";

// Safety caps mirror the legacy script exactly: a deploy-status poll that
// never reaches a terminal state falls back to whatever the deployments
// listing already shows, rather than polling forever.
export const DEPLOY_WORKFLOW_POLL_MS = 2500;
export const DEPLOY_WORKFLOW_POLL_LIMIT = 720; // ~30 min at 2.5s/tick
export const DEPLOY_FAILED_HANDOFF_POLL_LIMIT = 20;
export const DEPLOY_AUTO_HIDE_MS = 2500;
export const RESUME_POLL_MS = 2500;
export const RESUME_POLL_LIMIT = 720; // ~30 min at 2.5s/tick
export const DELETE_POLL_MS = 4000;
export const DELETE_POLL_LIMIT = 45; // ~3 min at 4s/tick

const ARROW_SVG =
  '<svg class="rad-applink-arrow" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 17L17 7M17 7H8M17 7V16" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const NO_DEPLOYMENTS_ROW =
  '<tr><td class="rad-table__env" colspan="6">No application deployments yet.</td></tr>';
const LOADING_ROW =
  '<tr><td colspan="6" style="color:var(--rad-text-tertiary);">Loading deployments…</td></tr>';
const RETRY_ROW =
  '<tr><td colspan="6" style="color:var(--rad-text-tertiary);">Could not load deployments. Retrying…</td></tr>';
const LOAD_FAILURE_ROW =
  '<tr><td colspan="6" style="color:var(--rad-text-tertiary);">Could not load deployments.</td></tr>';

export interface DeployingPageOptions {
  repo: string;
  // The current worktree/session branch. Never defaulted to "main" here: the
  // caller (the page renderer) supplies it, matching the branch the session
  // is actually on.
  branch: string;
}

export interface DeploymentRecord {
  app: string;
  environment: string;
  status: string;
  runUrl: string;
}

interface DeploymentRow extends DeploymentRecord {
  synthetic: boolean;
}

interface DeploymentOverride {
  app: string;
  environment: string;
  status: "pending" | "deleting";
}

interface DeployHandoff {
  pending: boolean;
  state: string;
}

interface DeployStatusPayload {
  status: string;
  error: string;
  deployRunUrl: string;
  errorKind: string;
  errorBranch: string;
  repairing: boolean;
  handoff: DeployHandoff;
  active: boolean;
  attempt: { targetRepo: string; environment: string };
}

interface DeployFailureDetails {
  app: string;
  environment: string;
  errorText: string;
  runUrl: string;
  errorKind: string;
  errorBranch: string;
  repairing: boolean;
  handoff: DeployHandoff;
}

interface Registration {
  target: DomEventTarget;
  type: string;
  listener: DomEventListener;
}

function bind(
  registrations: Registration[],
  target: DomEventTarget,
  type: string,
  listener: DomEventListener
): void {
  target.addEventListener(type, listener);
  registrations.push({ target, type, listener });
}

function release(registrations: Registration[]): void {
  for (const registration of registrations.splice(0)) {
    registration.target.removeEventListener(
      registration.type,
      registration.listener
    );
  }
}

// Optimistic per-row overrides are keyed by app AND environment together so
// an in-flight operation on one pair can never be mistaken for, or clobber,
// the state of a different app/environment pair.
export function opKey(app: string, environment: string): string {
  return `${app}\u0000${environment}`;
}

function envIsBlocked(status: string): boolean {
  return status === "pending" || status === "deleting";
}

export function deploymentStatusMarkup(status: string): string {
  const mapped: Record<string, readonly [string, string]> = {
    success: ["success", "Success"],
    failed: ["failed", "Failed"],
    pending: ["pending", "Pending"],
    deleting: ["deleting", "Deleting…"]
  };
  const [tone, label] = mapped[status] ?? mapped.pending;
  return `<span class="rad-dot rad-dot--${tone}"></span><span class="rad-status-label">${label}</span>`;
}

function hasDeploymentsArray(payload: unknown): boolean {
  return isRecord(payload) && Array.isArray(payload.deployments);
}

export function parseDeploymentRecords(payload: unknown): DeploymentRecord[] {
  return readArray(payload, "deployments")
    .map((entry) => ({
      app: readString(entry, "app"),
      environment: readString(entry, "environment"),
      status: readString(entry, "status"),
      runUrl: readString(entry, "runUrl")
    }))
    .filter((entry) => entry.app !== "" && entry.environment !== "");
}

function parseHandoff(payload: unknown): DeployHandoff {
  const handoff = readRecord(payload, "handoff");
  return {
    pending: readBoolean(handoff, "pending"),
    state: readString(handoff, "state") || "idle"
  };
}

function parseDeployStatus(payload: unknown): DeployStatusPayload {
  const attempt = readRecord(payload, "attempt");
  return {
    status: readString(payload, "status"),
    error: readString(payload, "error"),
    deployRunUrl: readString(payload, "deployRunUrl"),
    errorKind: readString(payload, "errorKind"),
    errorBranch: readString(payload, "errorBranch"),
    repairing: readBoolean(payload, "repairing"),
    handoff: parseHandoff(payload),
    active: readBoolean(payload, "active"),
    attempt: {
      targetRepo: readString(attempt, "targetRepo"),
      environment: readString(attempt, "environment")
    }
  };
}

function providerFor(
  providers: Readonly<Record<string, string>>,
  environment: string
): string {
  // The environment selector and this map are populated from the same parsed
  // listing, whose parser normalizes missing providers to Azure.
  return providers[environment];
}

// A redirect (e.g. from the Planned or Deployed graph) may carry ?app= for an
// application not yet in the listing; offer it rather than silently ignoring
// the redirect's intent.
export function buildDeployApplicationOptions(
  applications: readonly ApplicationInfo[],
  preselect: string
): OptionSpec[] {
  const options: OptionSpec[] = applications.map((application) => ({
    value: application.name,
    label: application.name
  }));
  if (preselect === "") return options;
  const index = options.findIndex((option) => option.value === preselect);
  if (index >= 0) {
    options[index] = { ...options[index], selected: true };
    return options;
  }
  return [{ value: preselect, label: preselect, selected: true }, ...options];
}

// Bespoke rather than repositories.ts's buildBranchOptions: the desired-branch
// precedence and the empty/failed-listing fallback to a single CTX_BRANCH
// option are both specific to this page's legacy behavior.
export function buildDeployBranchOptions(
  listing: BranchListing,
  ctxBranch: string
): OptionSpec[] {
  if (listing.branches.length === 0) {
    return [{ value: ctxBranch, label: ctxBranch, selected: true }];
  }
  const desired = listing.workspaceBranch || ctxBranch;
  const branches = listing.branches.slice();
  if (desired !== "" && !branches.some((branch) => branch.name === desired)) {
    branches.unshift({ name: desired, sha: WORKTREE_SHA });
  }
  return branches.map((branch) => ({
    value: branch.name,
    label:
      branch.name +
      (branch.sha === WORKTREE_SHA ? " (worktree)"
      : branch.sha ? ` (${branch.sha.slice(0, 7)})`
      : ""),
    selected: branch.name === desired
  }));
}

function buildDeploymentRows(
  deployments: readonly DeploymentRecord[],
  overrides: ReadonlyMap<string, DeploymentOverride>
): { rows: DeploymentRow[]; present: Set<string> } {
  const present = new Set<string>();
  for (const deployment of deployments) {
    present.add(opKey(deployment.app, deployment.environment));
  }
  // Surface just-started operations GitHub hasn't recorded yet as synthetic
  // rows. "deleting" is excluded: a delete always acts on an existing row, so
  // its record is recolored in place rather than shown as a phantom.
  const synthetic: DeploymentRow[] = [];
  for (const override of overrides.values()) {
    const key = opKey(override.app, override.environment);
    if (present.has(key) || override.status === "deleting") continue;
    synthetic.push({
      app: override.app,
      environment: override.environment,
      status: override.status,
      runUrl: "",
      synthetic: true
    });
  }
  const rows: DeploymentRow[] = [
    ...synthetic,
    ...deployments.map((deployment) => ({ ...deployment, synthetic: false }))
  ];
  return { rows, present };
}

function computeBlockedEnvironments(
  rows: readonly DeploymentRow[],
  overrides: ReadonlyMap<string, DeploymentOverride>
): Map<string, string> {
  const blocked = new Map<string, string>();
  for (const row of rows) {
    const forced = overrides.get(opKey(row.app, row.environment))?.status;
    const status = forced ?? row.status;
    if (envIsBlocked(status)) blocked.set(row.environment, status);
  }
  return blocked;
}

function renderDeploymentRow(
  row: DeploymentRow,
  overrides: ReadonlyMap<string, DeploymentOverride>
): string {
  const forced = overrides.get(opKey(row.app, row.environment))?.status;
  const status = forced ?? row.status;
  const statusHtml = deploymentStatusMarkup(status);
  const deployedHref = `/?page=deployed&environment=${encodeURIComponent(row.environment)}&application=${encodeURIComponent(row.app)}`;
  const monitorCell = `<a class="rad-monitor-link" href="${escapeBrowserHtml(deployedHref)}" title="Monitor the deployed application graph">Monitor Graph</a>`;
  const workflowCell =
    row.runUrl ?
      `<a class="rad-deploy-applink" href="${escapeBrowserHtml(row.runUrl)}" target="_blank" rel="noopener noreferrer" title="View workflow run on GitHub">${ARROW_SVG}View Run</a>`
    : '<span class="rad-cell-empty">—</span>';
  const deleteClass =
    status === "failed" ? "rad-btn--danger-solid" : "rad-btn--danger-outline";
  const deleteDisabled =
    status === "pending" || status === "deleting" || row.synthetic ?
      " disabled"
    : "";
  const appName = escapeBrowserHtml(row.app);
  const envName = escapeBrowserHtml(row.environment);
  return (
    "<tr>" +
    `<td class="rad-table__env"><a class="rad-deploy-applink" href="${escapeBrowserHtml(deployedHref)}" title="View deployed application graph">${ARROW_SVG}${appName}</a></td>` +
    `<td>${envName}</td>` +
    `<td>${statusHtml}</td>` +
    `<td>${monitorCell}</td>` +
    `<td>${workflowCell}</td>` +
    `<td class="rad-table__actions"><button class="rad-btn ${deleteClass} js-del-dep"${deleteDisabled} data-env="${envName}" data-app="${appName}" style="margin:0;">Delete Deployment</button></td>` +
    "</tr>"
  );
}

export function initializeDeployingPage(
  context: BrowserContext,
  options: DeployingPageOptions
): BrowserTeardown {
  const deployBtn = context.dom.inputById("deploy-now-btn");
  const appSelect = context.dom.selectById("deploy-app-select");
  const envSelect = context.dom.selectById("deploy-env-select");
  const inlineStatus = context.dom.byId("deploy-inline-status");
  const tableBody = context.dom.byId("deploy-table-body");
  if (!deployBtn || !appSelect || !envSelect || !inlineStatus || !tableBody) {
    return NOOP_TEARDOWN;
  }

  const branchSelect = context.dom.selectById("deploy-branch-select");
  const progressModal = context.dom.byId("deploy-progress-modal");
  const progressSpinner = context.dom.byId("deploy-progress-spinner");
  const progressFailIcon = context.dom.byId("deploy-progress-failicon");
  const progressTitle = context.dom.byId("deploy-progress-title");
  const progressSubtitle = context.dom.byId("deploy-progress-subtitle");
  const progressLinks = context.dom.byId("deploy-progress-links");
  const progressFailActions = context.dom.byId("deploy-progress-fail-actions");
  const failRepairNote = context.dom.byId("deploy-fail-repair-note");
  const backBtn = context.dom.byId("deploy-fail-back");

  const entry = beginEntry(context, ENTRY_KEY);
  if (!entry) return NOOP_TEARDOWN;

  let providers: Record<string, string> = {};
  let environmentStatuses: Record<string, string> = {};
  let hasApplications = false;
  let hasEnvironments = false;
  const overrides = new Map<string, DeploymentOverride>();
  let deployRecordsPresent = new Set<string>();
  let deployedEnvs = new Map<string, string>();
  let lastRecords: readonly DeploymentRecord[] = [];

  const inlineBindings: Registration[] = [];
  const rowBindings: Registration[] = [];
  const copyBindings: Registration[] = [];

  let deploymentsAbort: AbortHandle | null = null;
  let deploymentsRequest = 0;

  // Renders the dismissible success/error banner (green check / red warning).
  // The message uses textContent by default so server-provided strings can
  // never inject markup; isHtml is only for intentionally-built, escaped
  // markup produced below.
  const showInline = (
    kind: "success" | "error",
    message: string,
    isHtml = false
  ): void => {
    inlineStatus.style.display = "flex";
    inlineStatus.className = `rad-inline rad-inline--${kind === "error" ? "error" : "success"}`;
    release(inlineBindings);
    inlineStatus.replaceChildren();
    const icon = context.dom.createElement("span");
    icon.className = "rad-inline__icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = kind === "error" ? "⚠" : "✓";
    const body = context.dom.createElement("span");
    body.className = "rad-inline__msg";
    if (isHtml) body.innerHTML = message;
    else body.textContent = message;
    const close = context.dom.createElement("button");
    close.setAttribute("type", "button");
    close.className = "rad-inline__close";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "✕";
    bind(inlineBindings, close, "click", () => {
      inlineStatus.style.display = "none";
    });
    inlineStatus.appendChild(icon);
    inlineStatus.appendChild(body);
    inlineStatus.appendChild(close);
  };

  // The primary button adapts to what's missing: no applications → "Create
  // Application"; an application but no environments → "Create Environment";
  // otherwise "Deploy", enabled once app+env are chosen and the selected
  // environment has no in-progress operation blocking a new deploy.
  const refreshDeployBtn = (): void => {
    if (!hasApplications) {
      deployBtn.dataset.mode = "create-app";
      deployBtn.textContent = "Create Application";
      deployBtn.disabled = false;
      return;
    }
    if (!hasEnvironments) {
      deployBtn.dataset.mode = "create-env";
      deployBtn.textContent = "Create Environment";
      deployBtn.disabled = false;
      return;
    }
    deployBtn.dataset.mode = "deploy";
    deployBtn.textContent = "Deploy";
    const selectedEnvironment = envSelect.value;
    const blockedStatus =
      selectedEnvironment ? deployedEnvs.get(selectedEnvironment) : undefined;
    const environmentReady =
      selectedEnvironment !== "" &&
      environmentIsReady(environmentStatuses[selectedEnvironment] ?? "");
    deployBtn.disabled =
      !(options.repo && appSelect.value && selectedEnvironment) ||
      Boolean(blockedStatus) ||
      !environmentReady;
    if (blockedStatus) {
      deployBtn.setAttribute(
        "title",
        blockedStatus === "deleting" ?
          `Application is being deleted from environment "${selectedEnvironment}". Wait for the delete to finish before deploying again.`
        : `A deployment is already in progress in environment "${selectedEnvironment}". Wait for it to finish before deploying again.`
      );
    } else if (!environmentReady && selectedEnvironment !== "") {
      deployBtn.setAttribute(
        "title",
        environmentNotReadyReason(
          selectedEnvironment,
          environmentStatuses[selectedEnvironment] ?? ""
        )
      );
    } else {
      deployBtn.removeAttribute("title");
    }
  };

  const loadApplications = (): Promise<void> => {
    if (!options.repo) {
      context.dom.setOptions(appSelect, [
        { value: "", label: "No repository" }
      ]);
      return Promise.resolve();
    }
    return context.net
      .fetch(`${APPLICATIONS_PATH}?repo=${encodeURIComponent(options.repo)}`)
      .then((response) => response.json())
      .then((payload) => {
        if (!entry.active) return;
        const applications = parseApplicationListing(payload);
        hasApplications = applications.length > 0;
        if (applications.length === 0) {
          context.dom.setOptions(appSelect, [
            { value: "", label: "No applications" }
          ]);
          refreshDeployBtn();
          return;
        }
        context.dom.setOptions(
          appSelect,
          buildDeployApplicationOptions(
            applications,
            queryValue(context.nav.search, "app")
          )
        );
        refreshDeployBtn();
      })
      .catch((error: unknown) => {
        if (!entry.active) return;
        context.logger.error("Radius applications could not load.", error);
        context.dom.setOptions(appSelect, [
          { value: "", label: "Could not load" }
        ]);
      });
  };

  const loadEnvironmentsDropdown = (): Promise<void> => {
    if (!options.repo) {
      context.dom.setOptions(envSelect, [
        { value: "", label: "No repository" }
      ]);
      return Promise.resolve();
    }
    return context.net
      .fetch(`${ENVIRONMENTS_PATH}?repo=${encodeURIComponent(options.repo)}`)
      .then((response) => response.json())
      .then((payload) => {
        if (!entry.active) return;
        const listing = parseEnvironmentListing(payload);
        hasEnvironments = listing.environments.length > 0;
        if (listing.environments.length === 0) {
          context.dom.setOptions(envSelect, [
            { value: "", label: "No environments" }
          ]);
          refreshDeployBtn();
          return;
        }
        const nextProviders: Record<string, string> = {};
        const nextStatuses: Record<string, string> = {};
        for (const environment of listing.environments) {
          nextProviders[environment.name] = environment.provider;
          nextStatuses[environment.name] = environment.status;
        }
        providers = nextProviders;
        environmentStatuses = nextStatuses;
        context.dom.setOptions(
          envSelect,
          buildEnvironmentOptions(
            listing.environments,
            queryValue(context.nav.search, "env")
          )
        );
        refreshDeployBtn();
      })
      .catch((error: unknown) => {
        if (!entry.active) return;
        context.logger.error("Radius environments could not load.", error);
        context.dom.setOptions(envSelect, [
          { value: "", label: "Could not load" }
        ]);
      });
  };

  // Populates the Branch dropdown the deploy dispatch reads its --ref from,
  // defaulting to the session/worktree branch.
  const loadBranches = (): Promise<void> => {
    if (!branchSelect) return Promise.resolve();
    if (!options.repo) {
      context.dom.setOptions(branchSelect, [
        { value: options.branch, label: options.branch, selected: true }
      ]);
      return Promise.resolve();
    }
    return context.net
      .fetch(BRANCHES_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: options.repo })
      })
      .then((response) => response.json())
      .then((payload) => {
        if (!entry.active) return;
        const listing = parseBranchListing(payload);
        context.dom.setOptions(
          branchSelect,
          buildDeployBranchOptions(listing, options.branch)
        );
      })
      .catch((error: unknown) => {
        if (!entry.active) return;
        context.logger.error("Radius branches could not load.", error);
        context.dom.setOptions(branchSelect, [
          { value: options.branch, label: options.branch, selected: true }
        ]);
      });
  };

  const wireDeleteButtons = (): void => {
    release(rowBindings);
    for (const button of context.dom.all(context.dom.document, ".js-del-dep")) {
      bind(rowBindings, button, "click", () => {
        openDeleteModal(
          button.getAttribute("data-app") ?? "",
          button.getAttribute("data-env") ?? ""
        );
      });
    }
  };

  // Repaints the table from the newest records already held plus the local
  // overrides, so an optimistic row never waits on a round trip. A `fresh=1`
  // listing bypasses the cache and can take tens of seconds, and a just-started
  // deploy that shows no row for that long reads as a deploy that never
  // registered.
  const renderDeployments = (): void => {
    const { rows, present } = buildDeploymentRows(lastRecords, overrides);
    deployRecordsPresent = present;
    if (rows.length === 0) {
      deployedEnvs = new Map();
      refreshDeployBtn();
      tableBody.innerHTML = NO_DEPLOYMENTS_ROW;
      return;
    }
    deployedEnvs = computeBlockedEnvironments(rows, overrides);
    refreshDeployBtn();
    tableBody.innerHTML = rows
      .map((row) => renderDeploymentRow(row, overrides))
      .join("");
    wireDeleteButtons();
  };

  // True once there is something real to show. A placeholder — loading, retry
  // or failure — must never replace it: blanking the table would discard a
  // pending row for an operation that is still running.
  const hasRenderableRows = (): boolean =>
    overrides.size > 0 || lastRecords.length > 0;

  // A background refresh (quiet) keeps the current rows on screen until the
  // new data arrives, so periodic in-flight polling doesn't flash the table
  // back to a loading placeholder on every tick. Requests are aborted and
  // superseded by identity so a slow, out-of-order response can never
  // overwrite a table already repainted by a newer request.
  const loadDeployments = (fresh = false, quiet = false): Promise<void> => {
    if (!options.repo) {
      tableBody.innerHTML = NO_DEPLOYMENTS_ROW;
      return Promise.resolve();
    }
    if (!quiet) {
      if (hasRenderableRows()) renderDeployments();
      else tableBody.innerHTML = LOADING_ROW;
    }
    deploymentsAbort?.abort();
    deploymentsAbort = context.net.createAbort();
    const request = ++deploymentsRequest;
    const url = `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(options.repo)}${fresh ? "&fresh=1" : ""}`;
    return context.net
      .fetch(
        url,
        deploymentsAbort ? { signal: deploymentsAbort.signal } : undefined
      )
      .then((response) => response.json())
      .then((payload) => {
        if (!entry.active || request !== deploymentsRequest) return;
        // A transient failure returns { deployments: [], error }. Don't
        // render that as "no deployments" (which would hide real rows).
        if (readString(payload, "error")) {
          if (!quiet && !hasRenderableRows()) tableBody.innerHTML = RETRY_ROW;
          return;
        }
        lastRecords = parseDeploymentRecords(payload);
        renderDeployments();
      })
      .catch((error: unknown) => {
        if (!entry.active || request !== deploymentsRequest) return;
        if (error instanceof Error && error.name === "AbortError") return;
        context.logger.error("Radius deployments could not load.", error);
        if (!quiet && !hasRenderableRows()) {
          tableBody.innerHTML = LOAD_FAILURE_ROW;
        }
      });
  };

  const openDeleteModal = (app: string, environment: string): void => {
    dialog?.open(app, environment);
  };

  // Dispatch the delete, then let the row reflect "Deleting…" while the
  // workflow runs. Fails closed: a missing repository, application, or
  // environment identity never reaches the delete endpoint.
  const runDelete = (app: string, environment: string): void => {
    if (!options.repo || app === "" || environment === "") return;
    const key = opKey(app, environment);
    overrides.set(key, { app, environment, status: "deleting" });
    void loadDeployments(true, true);
    showInline(
      "success",
      `Deleting deployment of application <strong>${escapeBrowserHtml(app)}</strong> in environment <strong>${escapeBrowserHtml(environment)}</strong> has started.`,
      true
    );
    void context.net
      .fetch(DELETE_DEPLOYMENT_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: options.repo,
          environment,
          application: app
        })
      })
      .then((response) =>
        response.json().then((payload) => ({ ok: response.ok, payload }))
      )
      .then((result) => {
        if (!entry.active) return;
        if (!result.ok) {
          overrides.delete(key);
          void loadDeployments(true, true);
          showInline(
            "error",
            readString(result.payload, "error") ||
              "Could not start the delete workflow."
          );
          return;
        }
        pollDeleteCompletion(app, environment, 0);
      })
      .catch(() => {
        if (!entry.active) return;
        overrides.delete(key);
        void loadDeployments(true, true);
        showInline(
          "error",
          "Could not delete the deployment. Please try again."
        );
      });
  };

  // Poll the deployments listing until the target app/env is gone (a
  // successful delete removes it). Bounded so a stuck or failed delete never
  // polls forever; on timeout the override is cleared and the row reverts to
  // its real status.
  const pollDeleteCompletion = (
    app: string,
    environment: string,
    tries: number
  ): void => {
    if (tries > DELETE_POLL_LIMIT) {
      overrides.delete(opKey(app, environment));
      void loadDeployments(true, true);
      return;
    }
    entry.after(DELETE_POLL_MS, () => {
      void context.net
        .fetch(
          `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(options.repo)}&fresh=1`
        )
        .then((response) =>
          response.json().then((payload) => ({ ok: response.ok, payload }))
        )
        .then((result) => {
          if (!entry.active) return;
          // Only trust a complete, successful listing. A transient failure
          // or a malformed deployments field must not be read as "row gone".
          if (
            !result.ok ||
            readString(result.payload, "error") ||
            !hasDeploymentsArray(result.payload)
          ) {
            pollDeleteCompletion(app, environment, tries + 1);
            return;
          }
          const deployments = parseDeploymentRecords(result.payload);
          const stillThere = deployments.some(
            (deployment) =>
              deployment.app === app && deployment.environment === environment
          );
          if (!stillThere) {
            overrides.delete(opKey(app, environment));
            void loadDeployments(true, true);
            showInline(
              "success",
              `Deployment of application <strong>${escapeBrowserHtml(app)}</strong> in environment <strong>${escapeBrowserHtml(environment)}</strong> has been successfully deleted.`,
              true
            );
            return;
          }
          void loadDeployments(true, true);
          pollDeleteCompletion(app, environment, tries + 1);
        })
        .catch(() => {
          if (!entry.active) return;
          pollDeleteCompletion(app, environment, tries + 1);
        });
    });
  };

  const dialog = createDeleteDeploymentDialog(context, {
    onConfirm: runDelete
  });
  if (dialog) entry.onTeardown(() => dialog.teardown());

  // Restores the deploy modal to its default "in progress" (spinner) layout;
  // the modal is mutated in place on failure, so this runs before each attempt.
  const resetDeployModal = (): void => {
    if (progressSpinner) progressSpinner.style.display = "";
    if (progressFailIcon) progressFailIcon.style.display = "none";
    if (progressSubtitle) {
      progressSubtitle.textContent = "This may take a few minutes…";
      progressSubtitle.style.color = "var(--rad-text-secondary)";
    }
    if (progressLinks) progressLinks.style.display = "flex";
    if (progressFailActions) progressFailActions.style.display = "none";
  };

  // Switches the deploy modal into a "failed" state. errorKind lets a
  // well-known failure (an unpushed branch) render a tailored panel instead
  // of raw workflow error text.
  const showDeployFailed = (details: DeployFailureDetails): void => {
    if (progressSpinner) progressSpinner.style.display = "none";
    if (progressFailIcon) progressFailIcon.style.display = "";
    if (details.errorKind === "branch-not-pushed") {
      const branchName = details.errorBranch || "your branch";
      const pushCmd = `git push -u origin ${branchName}`;
      if (progressTitle) progressTitle.innerHTML = "Branch not pushed yet";
      if (progressSubtitle) {
        progressSubtitle.style.color = "var(--rad-text-secondary)";
        progressSubtitle.innerHTML =
          `<div style="color:var(--rad-text);">The branch <code style="background:var(--rad-code-bg); padding:1px 5px; border-radius:4px;">${escapeBrowserHtml(branchName)}</code> hasn't been pushed to GitHub yet, so there's nothing to deploy for <strong>${escapeBrowserHtml(details.app)}</strong>.</div>` +
          `<div style="margin-top:10px; color:var(--rad-text-secondary);">Push it, then deploy again:</div>` +
          `<div style="margin-top:8px; display:flex; align-items:center; gap:8px; background:var(--rad-code-bg); border:1px solid var(--rad-stroke); border-radius:6px; padding:8px 10px;">` +
          `<code style="flex:1; font-family:var(--font-mono, monospace); font-size:12px; color:var(--rad-text); white-space:nowrap; overflow-x:auto;">${escapeBrowserHtml(pushCmd)}</code>` +
          `<button type="button" id="deploy-copy-push" class="rad-btn rad-btn--neutral" style="margin:0; padding:2px 10px; font-size:12px; flex:none;">Copy</button>` +
          `</div>`;
      }
    } else {
      if (progressTitle) {
        progressTitle.innerHTML = `Deployment of <strong>${escapeBrowserHtml(details.app)}</strong> to <strong>${escapeBrowserHtml(details.environment)}</strong> failed`;
      }
      if (progressSubtitle) {
        let message =
          details.errorText ?
            escapeBrowserHtml(details.errorText)
          : "The deploy workflow run did not complete successfully.";
        if (details.runUrl) {
          message += `<br><a href="${escapeBrowserHtml(details.runUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--rad-link);">View workflow run in GitHub ↗</a>`;
        }
        progressSubtitle.innerHTML = message;
        progressSubtitle.style.color = "var(--rad-danger)";
      }
    }
    if (progressLinks) progressLinks.style.display = "none";
    if (progressFailActions) progressFailActions.style.display = "block";
    if (progressModal) progressModal.style.display = "flex";
    if (failRepairNote) {
      const state = details.handoff.state;
      let note = "";
      if (details.repairing) {
        note =
          "Copilot is analyzing the failure and will repair and redeploy if the app model caused it — follow along in the chat.";
      } else if (state === "pending" || state === "retryable") {
        note = "Handing this failure to Copilot…";
      } else if (state === "failed") {
        note =
          "Could not reach Copilot to repair this deploy. Ask Copilot in the chat to fix .radius/app.bicep and redeploy.";
      }
      failRepairNote.style.display = note ? "block" : "none";
      failRepairNote.textContent = note;
    }
    // Rebind rather than accumulate: showDeployFailed can run repeatedly
    // while Copilot's repair handoff keeps retrying.
    release(copyBindings);
    const copyButton = context.dom.byId("deploy-copy-push");
    if (copyButton) {
      bind(copyBindings, copyButton, "click", () => {
        const cmd = `git push -u origin ${details.errorBranch || ""}`;
        void context.clipboard.write(cmd).then((copied) => {
          if (!copied || !entry.active) return;
          copyButton.textContent = "Copied";
          entry.after(1500, () => {
            copyButton.textContent = "Copy";
          });
        });
      });
    }
    deployBtn.disabled = false;
    refreshDeployBtn();
  };

  // Deploys started from the Planned or Deployed graph redirect here,
  // carrying the app/environment in the URL so this page can restore the
  // same optimistic row and polling used for a locally started deploy.
  const resumeRedirectedDeployment = (): boolean => {
    const app = queryValue(context.nav.search, "application");
    const environment = queryValue(context.nav.search, "environment");
    if (app === "" || environment === "" || !options.repo) return false;

    const key = opKey(app, environment);
    overrides.set(key, { app, environment, status: "pending" });
    deployedEnvs.set(environment, "pending");
    refreshDeployBtn();
    void loadDeployments(true);

    let ticks = 0;
    let recordSeen = false;
    const poll = entry.every(RESUME_POLL_MS, () => {
      ticks++;
      if (ticks > RESUME_POLL_LIMIT) {
        entry.cancel(poll);
        overrides.delete(key);
        void loadDeployments(true);
        return;
      }
      void context.net
        .fetch(DEPLOY_STATUS_PATH)
        .then((response) => response.json())
        .then((payload) => {
          if (!entry.active) return;
          const status = parseDeployStatus(payload);
          const sameAttempt =
            (status.attempt.targetRepo === "" ||
              status.attempt.targetRepo === options.repo) &&
            (status.attempt.environment === "" ||
              status.attempt.environment === environment);
          if (status.active && sameAttempt) {
            // Once the real record replaces the synthetic row, keep polling
            // for the terminal transition but stop fanning out fresh=1 list
            // fetches every tick.
            if (!recordSeen && deployRecordsPresent.has(key)) {
              recordSeen = true;
            }
            if (!recordSeen) void loadDeployments(true, true);
            return;
          }
          entry.cancel(poll);
          overrides.delete(key);
          if (status.status === "failed" && sameAttempt) {
            showDeployFailed({
              app,
              environment,
              errorText: status.error,
              runUrl: status.deployRunUrl,
              errorKind: status.errorKind,
              errorBranch: status.errorBranch,
              repairing: status.repairing,
              handoff: status.handoff
            });
          }
          void loadDeployments(true);
        })
        .catch(() => {});
    });
    return true;
  };

  entry.on(appSelect, "change", refreshDeployBtn);
  entry.on(envSelect, "change", refreshDeployBtn);

  if (backBtn) {
    entry.on(backBtn, "click", () => {
      if (progressModal) progressModal.style.display = "none";
      resetDeployModal();
      void loadDeployments();
    });
  }

  if (progressModal) {
    entry.on(progressModal, "click", (event) => {
      if (event.target === progressModal) {
        progressModal.style.display = "none";
        resetDeployModal();
        deployBtn.disabled = false;
        refreshDeployBtn();
        void loadDeployments(true);
      }
    });
  }

  entry.on(deployBtn, "click", () => {
    const mode = deployBtn.dataset.mode || "deploy";
    if (mode === "create-app") {
      context.nav.assign("/?page=graph");
      return;
    }
    if (mode === "create-env") {
      context.nav.assign("/?page=environment&new=1");
      return;
    }
    const environment = envSelect.value;
    const app = appSelect.value;
    if (!options.repo || !environment || !app) return;
    const provider = providerFor(providers, environment);
    resetDeployModal();
    // Optimistically show this row as "Pending" for the duration of the run;
    // a real GitHub deployment record doesn't exist until the job starts.
    const key = opKey(app, environment);
    overrides.set(key, { app, environment, status: "pending" });
    void loadDeployments(true);
    deployBtn.disabled = true;
    deployBtn.textContent = "Deploying…";

    if (progressTitle) {
      progressTitle.innerHTML = `Deploying <strong>${escapeBrowserHtml(app)}</strong> to environment <strong>${escapeBrowserHtml(environment)}</strong>`;
    }
    if (progressSubtitle) {
      progressSubtitle.textContent =
        "Track progress in the deployments list below.";
    }
    if (progressModal) progressModal.style.display = "flex";
    showInline(
      "success",
      `Deployment of application <strong>${escapeBrowserHtml(app)}</strong> to environment <strong>${escapeBrowserHtml(environment)}</strong> has started.`,
      true
    );
    // Auto-dismiss the transient dialog; the deploy keeps running (tracked in
    // the list below), so the button returns to normal.
    const autoHide = entry.after(DEPLOY_AUTO_HIDE_MS, () => {
      if (progressModal) progressModal.style.display = "none";
      deployBtn.disabled = false;
      refreshDeployBtn();
    });

    let failedPolls = 0;
    let wfTicks = 0;
    let recordSeen = false;
    // The deploy-status slot is per-canvas, not per-run: it keeps the previous
    // attempt's terminal result until `POST /api/deploy` reaches
    // `beginDeployAttempt`, which resets the status and mints a fresh attempt
    // id. That reset is synchronous and lands strictly before the 200 is
    // written, so any status read after the dispatch is accepted describes
    // this attempt or a later one — never an earlier one.
    //
    // Before that point it describes the previous one, and the dispatch is not
    // instant: it awaits a repair-loop check, a GitHub deployment lookup and a
    // reservation, which routinely outlasts the 2.5s first tick. Redeploying
    // to an environment whose last attempt failed therefore read that stale
    // `failed` and flipped the optimistic Pending row straight to Failed for a
    // run that was still starting — and `sameAttempt` cannot catch it, because
    // repo and environment are exactly what a redeploy repeats.
    let dispatchAccepted = false;
    const wfPoll = entry.every(DEPLOY_WORKFLOW_POLL_MS, () => {
      wfTicks++;
      if (wfTicks > DEPLOY_WORKFLOW_POLL_LIMIT) {
        entry.cancel(wfPoll);
        entry.cancel(autoHide);
        overrides.delete(key);
        void loadDeployments(true);
        return;
      }
      if (!dispatchAccepted) return;
      void context.net
        .fetch(DEPLOY_STATUS_PATH)
        .then((response) => response.json())
        .then((payload) => {
          if (!entry.active) return;
          const status = parseDeployStatus(payload);
          const sameAttempt =
            (status.attempt.targetRepo === "" ||
              status.attempt.targetRepo === options.repo) &&
            (status.attempt.environment === "" ||
              status.attempt.environment === environment);
          if (!sameAttempt) {
            entry.cancel(wfPoll);
            entry.cancel(autoHide);
            overrides.delete(key);
            void loadDeployments(true);
            return;
          }
          if (status.status === "failed") {
            // Delivery of the repair handoff is asynchronous; keep polling
            // until it lands or the server stops retrying.
            if (
              status.handoff.pending &&
              failedPolls < DEPLOY_FAILED_HANDOFF_POLL_LIMIT
            ) {
              failedPolls++;
              showDeployFailed({
                app,
                environment,
                errorText: status.error,
                runUrl: status.deployRunUrl,
                errorKind: status.errorKind,
                errorBranch: status.errorBranch,
                repairing: false,
                handoff: status.handoff
              });
              return;
            }
            entry.cancel(wfPoll);
            entry.cancel(autoHide);
            overrides.delete(key);
            showDeployFailed({
              app,
              environment,
              errorText: status.error,
              runUrl: status.deployRunUrl,
              errorKind: status.errorKind,
              errorBranch: status.errorBranch,
              repairing: status.repairing,
              handoff: status.handoff
            });
            void loadDeployments(true);
            return;
          }
          if (status.status === "success" || status.status === "complete") {
            entry.cancel(wfPoll);
            overrides.delete(key);
            void loadDeployments(true);
            return;
          }
          // Still in flight. Quietly refresh only until the real record
          // (with its "View Run" link) replaces the optimistic synthetic
          // row; after that, further fresh=1 fetches are wasted.
          if (recordSeen) return;
          if (deployRecordsPresent.has(key)) {
            recordSeen = true;
            return;
          }
          void loadDeployments(true, true);
        })
        .catch(() => {});
    });

    // The deploy runs against the branch the user selected, defaulting to
    // the session/worktree branch. This value becomes the workflow --ref.
    const deployBranch =
      (branchSelect ? branchSelect.value : "") || options.branch;
    void context.net
      .fetch(DEPLOY_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          environment,
          provider,
          targetRepo: options.repo,
          branch: deployBranch,
          appFile: DEFAULT_APP_FILE
        })
      })
      .then((response) =>
        response
          .json()
          .catch(() => ({}))
          .then((payload) => ({ ok: response.ok, payload }))
      )
      .then((result) => {
        if (!entry.active) return;
        if (result.ok) {
          dispatchAccepted = true;
          return;
        }
        entry.cancel(wfPoll);
        entry.cancel(autoHide);
        overrides.delete(key);
        if (progressModal) progressModal.style.display = "none";
        deployBtn.disabled = false;
        refreshDeployBtn();
        showInline(
          "error",
          readString(result.payload, "error") ||
            "Could not start the deployment."
        );
        void loadDeployments(true);
      })
      .catch(() => {
        if (!entry.active) return;
        entry.cancel(wfPoll);
        entry.cancel(autoHide);
        overrides.delete(key);
        if (progressModal) progressModal.style.display = "none";
        deployBtn.disabled = false;
        refreshDeployBtn();
        showInline(
          "error",
          "Could not start the deployment. Please try again."
        );
        void loadDeployments(true);
      });
  });

  entry.onTeardown(() => {
    release(rowBindings);
    release(inlineBindings);
    release(copyBindings);
    deploymentsAbort?.abort();
  });

  void loadApplications();
  void loadEnvironmentsDropdown();
  void loadBranches();
  if (!resumeRedirectedDeployment()) void loadDeployments();

  return () => entry.teardown();
}
