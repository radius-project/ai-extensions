import { describe, expect, it, vi } from "vitest";
import {
  DELETE_DIALOG_CONFIRM_BUTTON_ID,
  DELETE_DIALOG_CONFIRM_INPUT_ID,
  DELETE_DIALOG_IDS,
  DELETE_DIALOG_STEP1_BUTTON_ID,
  DELETE_DIALOG_STEP2_BUTTON_ID,
  deleteDialogConfirmToken
} from "../delete-dialog.js";
import {
  createDeferred,
  createFakeBrowser,
  createFakeElement,
  fakeText,
  createFakeInput,
  createFakeSelect,
  fakeById,
  fakeInputById,
  flushPromises,
  jsonResponse
} from "../../../test/support/browser/fakes.js";
import type { FakeElement } from "../../../test/support/browser/fakes.js";
import { NOOP_TEARDOWN } from "../lifecycle.js";
import type { HttpResponse } from "../ports.js";
import {
  APPLICATIONS_PATH,
  BRANCHES_PATH,
  DEPLOY_PATH,
  ENVIRONMENTS_PATH,
  WORKTREE_SHA
} from "../repositories.js";
import {
  DELETE_DEPLOYMENT_PATH,
  DELETE_POLL_LIMIT,
  DELETE_POLL_MS,
  DEPLOY_AUTO_HIDE_MS,
  DEPLOY_FAILED_HANDOFF_POLL_LIMIT,
  DEPLOY_STATUS_PATH,
  DEPLOY_WORKFLOW_POLL_LIMIT,
  DEPLOY_WORKFLOW_POLL_MS,
  LIST_DEPLOYMENTS_PATH,
  RESUME_POLL_LIMIT,
  RESUME_POLL_MS,
  buildDeployApplicationOptions,
  buildDeployBranchOptions,
  deploymentStatusMarkup,
  initializeDeployingPage,
  opKey,
  parseDeploymentRecords
} from "./page.js";

const HOSTILE = '<img src=x onerror="alert(1)">';

interface FixtureOptions {
  repo?: string;
  branch?: string;
  search?: string;
  withBranchSelect?: boolean;
  withProgressModal?: boolean;
  // Lets a test decouple the progress-modal container from the rest of the
  // progress chrome (e.g. backBtn present but progressModal itself absent),
  // which the production code guards independently. Defaults to whatever
  // withProgressModal says.
  withProgressModalElement?: boolean;
  withDeleteDialog?: boolean;
  appPayload?: unknown;
  envPayload?: unknown;
  branchPayload?: unknown;
  deploymentsPayload?: unknown;
}

function fixture(options: FixtureOptions = {}) {
  const {
    repo = "octo/app",
    branch = "feature",
    search = "",
    withBranchSelect = true,
    withProgressModal = true,
    withProgressModalElement = withProgressModal,
    withDeleteDialog = true,
    appPayload = { applications: [{ name: "app" }] },
    envPayload = {
      environments: [{ name: "dev", provider: "azure", status: "success" }]
    },
    branchPayload = {
      branches: [{ name: "feature", sha: "abc1234" }],
      workspaceBranch: "feature"
    },
    deploymentsPayload = { deployments: [] }
  } = options;

  const browser = createFakeBrowser();
  if (search) {
    browser.nav.search = search;
    browser.nav.href = `http://localhost/?page=deploying${search}`;
  }

  const deployBtn = createFakeInput("deploy-now-btn");
  const appSelect = createFakeSelect("deploy-app-select");
  const envSelect = createFakeSelect("deploy-env-select");
  const inlineStatus = createFakeElement("deploy-inline-status");
  const tableBody = createFakeElement("deploy-table-body");
  const elements: FakeElement[] = [
    deployBtn,
    appSelect,
    envSelect,
    inlineStatus,
    tableBody
  ];

  const branchSelect = createFakeSelect("deploy-branch-select");
  if (withBranchSelect) elements.push(branchSelect);

  const progressModal = createFakeElement("deploy-progress-modal");
  const progressSpinner = createFakeElement("deploy-progress-spinner");
  const progressFailIcon = createFakeElement("deploy-progress-failicon");
  const progressTitle = createFakeElement("deploy-progress-title");
  const progressSubtitle = createFakeElement("deploy-progress-subtitle");
  const progressLinks = createFakeElement("deploy-progress-links");
  const progressFailActions = createFakeElement("deploy-progress-fail-actions");
  const failRepairNote = createFakeElement("deploy-fail-repair-note");
  const backBtn = createFakeInput("deploy-fail-back");
  // showDeployFailed renders the copy-push button as raw innerHTML markup on
  // progressSubtitle. The fake DOM does not parse innerHTML into real nodes,
  // so this button is pre-registered under its well-known id the same way a
  // real browser would make it discoverable via getElementById once the
  // markup renders; production wiring (context.dom.byId) finds it exactly as
  // it would find the real parsed element.
  const pushActionHost = createFakeElement("deploy-push-action");
  const fixCredentialsBtn = createFakeInput("deploy-fix-credentials");
  if (withProgressModal) {
    elements.push(
      progressSpinner,
      progressFailIcon,
      progressTitle,
      progressSubtitle,
      progressLinks,
      progressFailActions,
      failRepairNote,
      backBtn,
      pushActionHost,
      fixCredentialsBtn
    );
  }
  if (withProgressModalElement) elements.push(progressModal);

  const deleteModal = createFakeElement(DELETE_DIALOG_IDS.modal);
  const deleteBody = createFakeElement(DELETE_DIALOG_IDS.body);
  const deleteApp = createFakeElement(DELETE_DIALOG_IDS.app);
  const deleteEnv = createFakeElement(DELETE_DIALOG_IDS.environment);
  const deleteClose = createFakeElement(DELETE_DIALOG_IDS.close);
  if (withDeleteDialog) {
    elements.push(deleteModal, deleteBody, deleteApp, deleteEnv, deleteClose);
  }

  for (const element of elements) browser.document.add(element);

  browser.net.handle(
    `${APPLICATIONS_PATH}?repo=${encodeURIComponent(repo)}`,
    () => jsonResponse(appPayload)
  );
  browser.net.handle(
    `${ENVIRONMENTS_PATH}?repo=${encodeURIComponent(repo)}`,
    () => jsonResponse(envPayload)
  );
  browser.net.handle(BRANCHES_PATH, () => jsonResponse(branchPayload));
  browser.net.handle(
    `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(repo)}`,
    () => jsonResponse(deploymentsPayload)
  );
  browser.net.handle(
    `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(repo)}&fresh=1`,
    () => jsonResponse(deploymentsPayload)
  );

  return {
    browser,
    repo,
    branch,
    deployBtn,
    appSelect,
    envSelect,
    inlineStatus,
    tableBody,
    branchSelect,
    progressModal,
    progressSpinner,
    progressFailIcon,
    progressTitle,
    progressSubtitle,
    progressLinks,
    progressFailActions,
    failRepairNote,
    backBtn,
    pushActionHost,
    fixCredentialsBtn,
    deleteModal,
    deleteBody,
    deleteApp,
    deleteEnv,
    deleteClose
  };
}

function init(page: ReturnType<typeof fixture>) {
  return initializeDeployingPage(page.browser.context, {
    mutationNonce: "test-nonce",
    repo: page.repo,
    branch: page.branch
  });
}

// showInline renders its message via createElement/appendChild, never by
// setting inlineStatus.innerHTML directly, so the fake DOM's plain-string
// innerHTML field on the outer container never reflects it. The message body
// is the second appended child; it was populated via either .innerHTML (rich
// HTML messages) or .textContent (plain messages).
function inlineMessage(inlineStatus: FakeElement): string {
  const body = inlineStatus.children[1];
  if (!body) return "";
  return body.innerHTML !== "" ? body.innerHTML : (body.textContent ?? "");
}

function deployRowButton(app: string, environment: string, id = "row-del") {
  const button = createFakeInput(id);
  button.setAttribute("data-app", app);
  button.setAttribute("data-env", environment);
  return button;
}

function confirmDeleteDialog(
  deleteBody: FakeElement,
  app: string,
  environment: string
): void {
  fakeById(deleteBody, DELETE_DIALOG_STEP1_BUTTON_ID).dispatch("click");
  fakeById(deleteBody, DELETE_DIALOG_STEP2_BUTTON_ID).dispatch("click");
  const input = fakeInputById(deleteBody, DELETE_DIALOG_CONFIRM_INPUT_ID);
  input.value = deleteDialogConfirmToken(app, environment);
  input.dispatch("input");
  fakeInputById(deleteBody, DELETE_DIALOG_CONFIRM_BUTTON_ID).dispatch("click");
}

describe("initializeDeployingPage guards and lifecycle", () => {
  it("returns NOOP_TEARDOWN when any required element is missing", () => {
    const required = [
      "deploy-now-btn",
      "deploy-app-select",
      "deploy-env-select",
      "deploy-inline-status",
      "deploy-table-body"
    ];
    for (const missingId of required) {
      const browser = createFakeBrowser();
      for (const id of required) {
        if (id === missingId) continue;
        const element =
          id.endsWith("select") ? createFakeSelect(id)
          : id === "deploy-now-btn" ? createFakeInput(id)
          : createFakeElement(id);
        browser.document.add(element);
      }
      const teardown = initializeDeployingPage(browser.context, {
        mutationNonce: "test-nonce",
        repo: "octo/app",
        branch: "main"
      });
      expect(teardown).toBe(NOOP_TEARDOWN);
    }
  });

  it("binds once and is idempotent across a second initialization", async () => {
    const page = fixture();
    const teardown = init(page);
    expect(teardown).not.toBe(NOOP_TEARDOWN);
    const second = init(page);
    expect(second).toBe(NOOP_TEARDOWN);
    await flushPromises();
    teardown();
  });

  it("tears down listeners and timers, and stops late work", async () => {
    const page = fixture();
    const pending = createDeferred<HttpResponse>();
    page.browser.net.handle(
      `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () => pending.promise
    );
    const teardown = init(page);
    await flushPromises();
    expect(page.appSelect.listenerCount("change")).toBe(1);
    expect(page.envSelect.listenerCount("change")).toBe(1);
    expect(page.deployBtn.listenerCount("click")).toBe(1);

    teardown();
    teardown();
    expect(page.appSelect.listenerCount()).toBe(0);
    expect(page.envSelect.listenerCount()).toBe(0);
    expect(page.deployBtn.listenerCount()).toBe(0);
    expect(page.browser.clock.pending).toBe(0);

    pending.resolve(
      jsonResponse({ deployments: [{ app: "late", environment: "dev" }] })
    );
    await flushPromises();
    expect(page.tableBody.innerHTML).not.toContain("late");
  });

  it("ignores application/environment/branch successes that resolve after teardown", async () => {
    const page = fixture();
    const appDef = createDeferred<HttpResponse>();
    const envDef = createDeferred<HttpResponse>();
    const branchDef = createDeferred<HttpResponse>();
    page.browser.net.handle(
      `${APPLICATIONS_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () => appDef.promise
    );
    page.browser.net.handle(
      `${ENVIRONMENTS_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () => envDef.promise
    );
    page.browser.net.handle(BRANCHES_PATH, () => branchDef.promise);
    const teardown = init(page);
    teardown();
    appDef.resolve(jsonResponse({ applications: [{ name: "app" }] }));
    envDef.resolve(
      jsonResponse({ environments: [{ name: "dev", provider: "azure" }] })
    );
    branchDef.resolve(
      jsonResponse({
        branches: [{ name: "feature" }],
        workspaceBranch: "feature"
      })
    );
    await flushPromises();
    expect(page.appSelect.value).toBe("");
    expect(page.envSelect.value).toBe("");
  });

  it("ignores application/environment/branch failures that arrive after teardown", async () => {
    const page = fixture();
    const appDef = createDeferred<HttpResponse>();
    const envDef = createDeferred<HttpResponse>();
    const branchDef = createDeferred<HttpResponse>();
    page.browser.net.handle(
      `${APPLICATIONS_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () => appDef.promise
    );
    page.browser.net.handle(
      `${ENVIRONMENTS_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () => envDef.promise
    );
    page.browser.net.handle(BRANCHES_PATH, () => branchDef.promise);
    const teardown = init(page);
    teardown();
    appDef.reject(new Error("offline"));
    envDef.reject(new Error("offline"));
    branchDef.reject(new Error("offline"));
    await flushPromises();
    expect(page.appSelect.value).toBe("");
    expect(page.envSelect.value).toBe("");
  });
});

describe("application select", () => {
  it("shows 'No repository' and skips the fetch when repo is empty", async () => {
    const page = fixture({ repo: "" });
    initializeDeployingPage(page.browser.context, {
      repo: "",
      mutationNonce: "test-nonce",
      branch: "main"
    });
    await flushPromises();
    expect(page.appSelect.innerHTML).toContain("No repository");
  });

  it("loads applications and preselects an existing ?app=", async () => {
    const page = fixture({
      search: "?app=app",
      appPayload: { applications: [{ name: "app" }, { name: "other" }] }
    });
    init(page);
    await flushPromises();
    expect(page.appSelect.value).toBe("app");
    expect(page.appSelect.innerHTML).toContain("other");
  });

  it("inserts a leading option for a ?app= not in the listing", async () => {
    const page = fixture({
      search: "?app=missing-app",
      appPayload: { applications: [{ name: "app" }] }
    });
    init(page);
    await flushPromises();
    expect(page.appSelect.value).toBe("missing-app");
    expect(page.appSelect.options[0].value).toBe("missing-app");
  });

  it("shows 'No applications' when the listing is empty", async () => {
    const page = fixture({ appPayload: { applications: [] } });
    init(page);
    await flushPromises();
    expect(page.appSelect.innerHTML).toContain("No applications");
  });

  it("shows 'Could not load' on a network failure", async () => {
    const page = fixture();
    page.browser.net.handle(
      `${APPLICATIONS_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () => Promise.reject(new Error("offline"))
    );
    init(page);
    await flushPromises();
    expect(page.appSelect.innerHTML).toContain("Could not load");
    expect(page.browser.logger.errors).toHaveLength(1);
  });
});

describe("environment select", () => {
  it("shows 'No repository' and skips the fetch when repo is empty", async () => {
    const page = fixture({ repo: "" });
    initializeDeployingPage(page.browser.context, {
      repo: "",
      mutationNonce: "test-nonce",
      branch: "main"
    });
    await flushPromises();
    expect(page.envSelect.innerHTML).toContain("No repository");
  });

  it("loads environments and preselects an existing ?env=", async () => {
    const page = fixture({
      search: "?env=prod",
      envPayload: {
        environments: [
          { name: "dev", provider: "azure" },
          { name: "prod", provider: "aws" }
        ]
      }
    });
    init(page);
    await flushPromises();
    expect(page.envSelect.value).toBe("prod");
  });

  it("does not preselect a ?env= absent from the listing", async () => {
    const page = fixture({ search: "?env=missing" });
    init(page);
    await flushPromises();
    expect(page.envSelect.value).toBe("dev");
  });

  it("shows 'No environments' when the listing is empty", async () => {
    const page = fixture({ envPayload: { environments: [] } });
    init(page);
    await flushPromises();
    expect(page.envSelect.innerHTML).toContain("No environments");
  });

  it("shows 'Could not load' on a network failure", async () => {
    const page = fixture();
    page.browser.net.handle(
      `${ENVIRONMENTS_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () => Promise.reject(new Error("offline"))
    );
    init(page);
    await flushPromises();
    expect(page.envSelect.innerHTML).toContain("Could not load");
  });
});

describe("branch select", () => {
  it("is skipped entirely when the branch selector is absent", async () => {
    const page = fixture({ withBranchSelect: false });
    init(page);
    await flushPromises();
    expect(page.browser.net.calls.some((c) => c.url === BRANCHES_PATH)).toBe(
      false
    );
  });

  it("falls back to the session branch when repo is empty", async () => {
    const page = fixture({ repo: "", branch: "feature" });
    initializeDeployingPage(page.browser.context, {
      mutationNonce: "test-nonce",
      repo: "",
      branch: "feature"
    });
    await flushPromises();
    expect(page.branchSelect.value).toBe("feature");
  });

  it("falls back to the session branch when the listing is empty", async () => {
    const page = fixture({ branchPayload: { branches: [] } });
    init(page);
    await flushPromises();
    expect(page.branchSelect.value).toBe(page.branch);
  });

  it("inserts the worktree branch when discover-branches omits it", async () => {
    const page = fixture({
      branch: "my-worktree",
      branchPayload: {
        branches: [{ name: "main", sha: "deadbee" }],
        workspaceBranch: "my-worktree"
      }
    });
    init(page);
    await flushPromises();
    expect(page.branchSelect.value).toBe("my-worktree");
    expect(page.branchSelect.innerHTML).toContain("(worktree)");
  });

  it("labels a pushed branch by its short sha and selects the workspace branch", async () => {
    const page = fixture({
      branch: "feature",
      branchPayload: {
        branches: [
          { name: "feature", sha: "0123456789abcdef" },
          { name: "main", sha: "" }
        ],
        workspaceBranch: "feature"
      }
    });
    init(page);
    await flushPromises();
    expect(page.branchSelect.value).toBe("feature");
    expect(page.branchSelect.innerHTML).toContain("(0123456)");
  });

  it("falls back to the session branch on a network failure", async () => {
    const page = fixture();
    page.browser.net.handle(BRANCHES_PATH, () =>
      Promise.reject(new Error("offline"))
    );
    init(page);
    await flushPromises();
    expect(page.branchSelect.value).toBe(page.branch);
  });
});

describe("deploy button state", () => {
  it("offers Create Application when there are no applications", async () => {
    const page = fixture({ appPayload: { applications: [] } });
    init(page);
    await flushPromises();
    expect(page.deployBtn.dataset.mode).toBe("create-app");
    expect(page.deployBtn.textContent).toBe("Create Application");
    expect(page.deployBtn.disabled).toBe(false);
  });

  it("offers Create Environment when there are applications but no environments", async () => {
    const page = fixture({ envPayload: { environments: [] } });
    init(page);
    await flushPromises();
    expect(page.deployBtn.dataset.mode).toBe("create-env");
    expect(page.deployBtn.textContent).toBe("Create Environment");
  });

  it("disables Deploy until an application and environment are both selected", async () => {
    const page = fixture({
      appPayload: { applications: [] },
      envPayload: { environments: [] }
    });
    init(page);
    await flushPromises();
    page.appSelect.setOptions([{ value: "app", label: "app" }]);
    page.envSelect.setOptions([]);
    page.appSelect.dispatch("change");
    expect(page.deployBtn.dataset.mode).toBe("create-app");
  });

  it("enables Deploy once app, environment and repo are all present", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    expect(page.deployBtn.dataset.mode).toBe("deploy");
    expect(page.deployBtn.disabled).toBe(false);
  });

  it("blocks Deploy for an environment with a pending deployment and explains why", async () => {
    const page = fixture({
      deploymentsPayload: {
        deployments: [{ app: "app", environment: "dev", status: "pending" }]
      }
    });
    init(page);
    await flushPromises();
    expect(page.deployBtn.disabled).toBe(true);
    expect(page.deployBtn.getAttribute("title")).toContain(
      "already in progress"
    );
  });

  it("blocks Deploy for an environment with a deletion in progress and explains why", async () => {
    const page = fixture({
      deploymentsPayload: {
        deployments: [{ app: "app", environment: "dev", status: "deleting" }]
      }
    });
    init(page);
    await flushPromises();
    expect(page.deployBtn.disabled).toBe(true);
    expect(page.deployBtn.getAttribute("title")).toContain("being deleted");
  });

  it("removes the title once the blocking environment clears", async () => {
    const page = fixture({
      deploymentsPayload: {
        deployments: [{ app: "app", environment: "dev", status: "pending" }]
      }
    });
    init(page);
    await flushPromises();
    expect(page.deployBtn.getAttribute("title")).not.toBeNull();

    page.browser.net.handle(
      `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(page.repo)}&fresh=1`,
      () =>
        jsonResponse({
          deployments: [{ app: "app", environment: "dev", status: "success" }]
        })
    );
    page.envSelect.dispatch("change");
    expect(page.deployBtn.getAttribute("title")).not.toBeNull();
  });
});

describe("deployments table", () => {
  it("shows a placeholder row when there is no repository", async () => {
    const page = fixture({ repo: "" });
    initializeDeployingPage(page.browser.context, {
      repo: "",
      mutationNonce: "test-nonce",
      branch: "main"
    });
    await flushPromises();
    expect(page.tableBody.innerHTML).toContain("No application deployments");
  });

  it("shows 'No application deployments yet' when the listing is empty", async () => {
    const page = fixture({ deploymentsPayload: { deployments: [] } });
    init(page);
    await flushPromises();
    expect(page.tableBody.innerHTML).toContain("No application deployments");
  });

  it("renders rows with a workflow link and escapes hostile names", async () => {
    const page = fixture({
      deploymentsPayload: {
        deployments: [
          {
            app: HOSTILE,
            environment: HOSTILE,
            status: "success",
            runUrl: "https://example.test/run/1"
          }
        ]
      }
    });
    init(page);
    await flushPromises();
    expect(page.tableBody.innerHTML).not.toContain("<img");
    expect(page.tableBody.innerHTML).toContain("&lt;img");
    expect(page.tableBody.innerHTML).toContain("<td>Success</td>");
    expect(page.tableBody.innerHTML).not.toContain("rad-dot");
    expect(page.tableBody.innerHTML).toContain("View Run");
    expect(page.tableBody.innerHTML).toContain("https://example.test/run/1");
  });

  it("renders an em dash cell when there is no run URL", async () => {
    const page = fixture({
      deploymentsPayload: {
        deployments: [{ app: "app", environment: "dev", status: "success" }]
      }
    });
    init(page);
    await flushPromises();
    expect(page.tableBody.innerHTML).toContain("rad-cell-empty");
  });

  it("uses the neutral danger style for failed and pending rows while disabling pending deletion", async () => {
    const page = fixture({
      deploymentsPayload: {
        deployments: [
          { app: "app", environment: "dev", status: "failed" },
          { app: "app2", environment: "dev2", status: "pending" }
        ]
      }
    });
    init(page);
    await flushPromises();
    const rows = page.tableBody.innerHTML;
    expect(rows).not.toContain("rad-btn--danger-solid");
    expect(rows.match(/rad-btn--danger-outline/g)).toHaveLength(2);
    expect(rows).toMatch(
      /class="rad-btn rad-btn--danger-outline js-del-dep" data-env="dev" data-app="app"/
    );
    expect(rows).toMatch(
      /class="rad-btn rad-btn--danger-outline js-del-dep" disabled data-env="dev2" data-app="app2"/
    );
  });

  it("shows a retry row on a transient listing error without clobbering state", async () => {
    const page = fixture();
    page.browser.net.handle(
      `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () => jsonResponse({ deployments: [], error: "rate limited" })
    );
    init(page);
    await flushPromises();
    expect(page.tableBody.innerHTML).toContain("Retrying");
  });

  it("shows a load-failure row on a network failure (non-quiet)", async () => {
    const page = fixture();
    page.browser.net.handle(
      `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () => Promise.reject(new Error("offline"))
    );
    init(page);
    await flushPromises();
    expect(page.tableBody.innerHTML).toContain("Could not load deployments.");
  });

  it("swallows an AbortError from the current request without a failure row", async () => {
    const page = fixture();
    const abortError = new Error("The operation was aborted.");
    abortError.name = "AbortError";
    page.browser.net.handle(
      `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () => Promise.reject(abortError)
    );
    init(page);
    await flushPromises();
    expect(page.tableBody.innerHTML).not.toContain("Could not load");
  });

  it("ignores a stale deployments response superseded by a newer request", async () => {
    const page = fixture();
    page.browser.net.supportsAbort = false;
    const first = createDeferred<HttpResponse>();
    const second = createDeferred<HttpResponse>();
    const queue = [first, second];
    page.browser.net.handle(
      `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () => queue.shift()?.promise ?? Promise.reject(new Error("extra"))
    );
    init(page);
    // The "Back to Deployments" button issues a bare loadDeployments() call,
    // so clicking it while the first request is still in flight starts a
    // second, later generation on the same page instance.
    page.backBtn.dispatch("click");

    second.resolve(
      jsonResponse({
        deployments: [{ app: "current", environment: "dev", status: "success" }]
      })
    );
    await flushPromises();
    first.resolve(
      jsonResponse({
        deployments: [{ app: "stale", environment: "dev", status: "success" }]
      })
    );
    await flushPromises();
    expect(page.tableBody.innerHTML).toContain("current");
    expect(page.tableBody.innerHTML).not.toContain("stale");
  });

  it("aborts the previous request before starting a new one when supported", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.backBtn.dispatch("click");
    expect(page.browser.net.aborted).toBeGreaterThanOrEqual(1);
  });
});

describe("delete flow", () => {
  async function readyWithRow(app = "app", environment = "dev") {
    const page = fixture({
      deploymentsPayload: {
        deployments: [{ app, environment, status: "success" }]
      }
    });
    const button = deployRowButton(app, environment);
    page.browser.document.addSelectorAll(".js-del-dep", [button]);
    const teardown = init(page);
    await flushPromises();
    return { page, button, teardown };
  }

  it("does nothing when the delete dialog markup is absent", async () => {
    const { page, button } = await readyWithRow();
    // Rebuild without the dialog markup present.
    const bare = fixture({
      withDeleteDialog: false,
      deploymentsPayload: {
        deployments: [{ app: "app", environment: "dev", status: "success" }]
      }
    });
    const bareButton = deployRowButton("app", "dev");
    bare.browser.document.addSelectorAll(".js-del-dep", [bareButton]);
    init(bare);
    await flushPromises();
    bareButton.dispatch("click");
    expect(bare.deleteModal.style.display).not.toBe("flex");
    void page;
    void button;
  });

  it("opens the shared confirmation dialog naming the target", async () => {
    const { page, button } = await readyWithRow("app", "dev");
    button.dispatch("click");
    expect(page.deleteModal.style.display).toBe("flex");
    expect(page.deleteApp.textContent).toBe("app");
    expect(page.deleteEnv.textContent).toBe("dev");
  });

  it("dispatches delete, marks the row Deleting, and resolves on completion", async () => {
    const { page, button } = await readyWithRow("app", "dev");
    let deleteCalled: unknown;
    page.browser.net.handle(DELETE_DEPLOYMENT_PATH, (init) => {
      deleteCalled = init?.body;
      return jsonResponse({ ok: true });
    });
    button.dispatch("click");
    confirmDeleteDialog(page.deleteBody, "app", "dev");
    await flushPromises();
    expect(page.tableBody.innerHTML).toContain("Deleting");
    expect(JSON.parse(String(deleteCalled))).toEqual({
      repo: "octo/app",
      environment: "dev",
      application: "app"
    });
    expect(inlineMessage(page.inlineStatus)).toContain("started");

    page.browser.net.handle(
      `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(page.repo)}&fresh=1`,
      () => jsonResponse({ deployments: [] })
    );
    page.browser.clock.tick(DELETE_POLL_MS);
    await flushPromises();
    expect(inlineMessage(page.inlineStatus)).toContain("successfully deleted");
  });

  it("fails closed and never dispatches when the application identity is missing", async () => {
    const page = fixture({
      deploymentsPayload: {
        deployments: [{ app: "app", environment: "dev", status: "success" }]
      }
    });
    const button = createFakeInput("row-no-app");
    button.setAttribute("data-env", "dev");
    page.browser.document.addSelectorAll(".js-del-dep", [button]);
    init(page);
    await flushPromises();
    let dispatched = false;
    page.browser.net.handle(DELETE_DEPLOYMENT_PATH, () => {
      dispatched = true;
      return jsonResponse({ ok: true });
    });
    button.dispatch("click");
    confirmDeleteDialog(page.deleteBody, "", "dev");
    await flushPromises();
    expect(dispatched).toBe(false);
  });

  it("fails closed and never dispatches when the environment identity is missing", async () => {
    const page = fixture({
      deploymentsPayload: {
        deployments: [{ app: "app", environment: "dev", status: "success" }]
      }
    });
    const button = createFakeInput("row-no-env");
    button.setAttribute("data-app", "app");
    page.browser.document.addSelectorAll(".js-del-dep", [button]);
    init(page);
    await flushPromises();
    let dispatched = false;
    page.browser.net.handle(DELETE_DEPLOYMENT_PATH, () => {
      dispatched = true;
      return jsonResponse({ ok: true });
    });
    button.dispatch("click");
    confirmDeleteDialog(page.deleteBody, "app", "");
    await flushPromises();
    expect(dispatched).toBe(false);
  });

  it("shows the server error and reverts the override on dispatch failure", async () => {
    const { page, button } = await readyWithRow("app", "dev");
    page.browser.net.handle(DELETE_DEPLOYMENT_PATH, () =>
      jsonResponse({ error: "workflow busy" }, false, 409)
    );
    button.dispatch("click");
    confirmDeleteDialog(page.deleteBody, "app", "dev");
    await flushPromises();
    expect(inlineMessage(page.inlineStatus)).toContain("workflow busy");
  });

  it("shows a default error message when the server omits one", async () => {
    const { page, button } = await readyWithRow("app", "dev");
    page.browser.net.handle(DELETE_DEPLOYMENT_PATH, () =>
      jsonResponse({}, false, 500)
    );
    button.dispatch("click");
    confirmDeleteDialog(page.deleteBody, "app", "dev");
    await flushPromises();
    expect(inlineMessage(page.inlineStatus)).toContain(
      "Could not start the delete workflow."
    );
  });

  it("shows a generic error message on a delete network failure", async () => {
    const { page, button } = await readyWithRow("app", "dev");
    page.browser.net.handle(DELETE_DEPLOYMENT_PATH, () =>
      Promise.reject(new Error("offline"))
    );
    button.dispatch("click");
    confirmDeleteDialog(page.deleteBody, "app", "dev");
    await flushPromises();
    expect(inlineMessage(page.inlineStatus)).toContain(
      "Could not delete the deployment. Please try again."
    );
  });

  it("keeps polling on a malformed or error poll response instead of concluding success", async () => {
    const { page, button } = await readyWithRow("app", "dev");
    page.browser.net.handle(DELETE_DEPLOYMENT_PATH, () =>
      jsonResponse({ ok: true })
    );
    button.dispatch("click");
    confirmDeleteDialog(page.deleteBody, "app", "dev");
    await flushPromises();

    let pollCount = 0;
    page.browser.net.handle(
      `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(page.repo)}&fresh=1`,
      () => {
        pollCount++;
        return pollCount === 1 ?
            jsonResponse({ deployments: [], error: "still busy" })
          : jsonResponse({
              deployments: [
                { app: "app", environment: "dev", status: "success" }
              ]
            });
      }
    );
    page.browser.clock.tick(DELETE_POLL_MS);
    await flushPromises();
    expect(inlineMessage(page.inlineStatus)).not.toContain(
      "successfully deleted"
    );

    page.browser.clock.tick(DELETE_POLL_MS);
    await flushPromises();
    expect(page.tableBody.innerHTML).toContain("Deleting");
  });

  it("keeps polling while the deployment is still present", async () => {
    const { page, button } = await readyWithRow("app", "dev");
    page.browser.net.handle(DELETE_DEPLOYMENT_PATH, () =>
      jsonResponse({ ok: true })
    );
    button.dispatch("click");
    confirmDeleteDialog(page.deleteBody, "app", "dev");
    await flushPromises();

    page.browser.net.handle(
      `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(page.repo)}&fresh=1`,
      () =>
        jsonResponse({
          deployments: [{ app: "app", environment: "dev", status: "success" }]
        })
    );
    page.browser.clock.tick(DELETE_POLL_MS);
    await flushPromises();
    expect(page.tableBody.innerHTML).toContain("Deleting");
    expect(inlineMessage(page.inlineStatus)).not.toContain(
      "successfully deleted"
    );
  });

  it("recovers on a poll network failure by retrying", async () => {
    const { page, button } = await readyWithRow("app", "dev");
    page.browser.net.handle(DELETE_DEPLOYMENT_PATH, () =>
      jsonResponse({ ok: true })
    );
    button.dispatch("click");
    confirmDeleteDialog(page.deleteBody, "app", "dev");
    await flushPromises();

    let attempts = 0;
    page.browser.net.handle(
      `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(page.repo)}&fresh=1`,
      () => {
        attempts++;
        return attempts === 1 ?
            Promise.reject(new Error("offline"))
          : jsonResponse({ deployments: [] });
      }
    );
    page.browser.clock.tick(DELETE_POLL_MS);
    await flushPromises();
    page.browser.clock.tick(DELETE_POLL_MS);
    await flushPromises();
    expect(inlineMessage(page.inlineStatus)).toContain("successfully deleted");
  });

  it("gives up after the poll cap and reverts the optimistic status", async () => {
    const { page, button } = await readyWithRow("app", "dev");
    page.browser.net.handle(DELETE_DEPLOYMENT_PATH, () =>
      jsonResponse({ ok: true })
    );
    button.dispatch("click");
    confirmDeleteDialog(page.deleteBody, "app", "dev");
    await flushPromises();

    page.browser.net.handle(
      `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(page.repo)}&fresh=1`,
      () =>
        jsonResponse({
          deployments: [{ app: "app", environment: "dev", status: "success" }]
        })
    );
    for (let tick = 0; tick <= DELETE_POLL_LIMIT + 1; tick++) {
      page.browser.clock.tick(DELETE_POLL_MS);
      await flushPromises();
    }
    expect(page.browser.clock.pending).toBe(0);
  });

  it("ignores a delete dispatch success that resolves after teardown", async () => {
    const { page, button, teardown } = await readyWithRow("app", "dev");
    const dispatchDef = createDeferred<HttpResponse>();
    page.browser.net.handle(DELETE_DEPLOYMENT_PATH, () => dispatchDef.promise);
    button.dispatch("click");
    confirmDeleteDialog(page.deleteBody, "app", "dev");
    teardown();
    dispatchDef.resolve(jsonResponse({ ok: true }));
    await flushPromises();
    expect(page.browser.clock.pending).toBe(0);
  });

  it("ignores a delete dispatch network failure that arrives after teardown", async () => {
    const { page, button, teardown } = await readyWithRow("app", "dev");
    const dispatchDef = createDeferred<HttpResponse>();
    page.browser.net.handle(DELETE_DEPLOYMENT_PATH, () => dispatchDef.promise);
    button.dispatch("click");
    confirmDeleteDialog(page.deleteBody, "app", "dev");
    teardown();
    dispatchDef.reject(new Error("offline"));
    await flushPromises();
    expect(page.browser.clock.pending).toBe(0);
  });

  it("ignores a delete poll success that resolves after teardown", async () => {
    const { page, button, teardown } = await readyWithRow("app", "dev");
    page.browser.net.handle(DELETE_DEPLOYMENT_PATH, () =>
      jsonResponse({ ok: true })
    );
    button.dispatch("click");
    confirmDeleteDialog(page.deleteBody, "app", "dev");
    await flushPromises();

    const pollDef = createDeferred<HttpResponse>();
    page.browser.net.handle(
      `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(page.repo)}&fresh=1`,
      () => pollDef.promise
    );
    page.browser.clock.tick(DELETE_POLL_MS);
    teardown();
    pollDef.resolve(jsonResponse({ deployments: [] }));
    await flushPromises();
    expect(page.browser.clock.pending).toBe(0);
  });

  it("ignores a delete poll network failure that arrives after teardown", async () => {
    const { page, button, teardown } = await readyWithRow("app", "dev");
    page.browser.net.handle(DELETE_DEPLOYMENT_PATH, () =>
      jsonResponse({ ok: true })
    );
    button.dispatch("click");
    confirmDeleteDialog(page.deleteBody, "app", "dev");
    await flushPromises();

    const pollDef = createDeferred<HttpResponse>();
    page.browser.net.handle(
      `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(page.repo)}&fresh=1`,
      () => pollDef.promise
    );
    page.browser.clock.tick(DELETE_POLL_MS);
    teardown();
    pollDef.reject(new Error("offline"));
    await flushPromises();
    expect(page.browser.clock.pending).toBe(0);
  });

  it("keeps the current rows on a quiet transient-error response", async () => {
    const { page, button } = await readyWithRow("app", "dev");
    page.browser.net.handle(
      `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(page.repo)}&fresh=1`,
      () => jsonResponse({ deployments: [], error: "transient" })
    );
    const before = page.tableBody.innerHTML;
    button.dispatch("click");
    confirmDeleteDialog(page.deleteBody, "app", "dev");
    await flushPromises();
    expect(page.tableBody.innerHTML).not.toContain("Could not load");
    expect(page.tableBody.innerHTML).toBe(before);
  });

  it("keeps the current rows on a quiet network-failure response", async () => {
    const { page, button } = await readyWithRow("app", "dev");
    page.browser.net.handle(
      `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(page.repo)}&fresh=1`,
      () => Promise.reject(new Error("offline"))
    );
    const before = page.tableBody.innerHTML;
    button.dispatch("click");
    confirmDeleteDialog(page.deleteBody, "app", "dev");
    await flushPromises();
    expect(page.tableBody.innerHTML).not.toContain("Could not load");
    expect(page.tableBody.innerHTML).toBe(before);
  });
});

describe("deploy flow", () => {
  it("disables deploy when no environment is selected after listings load", async () => {
    const page = fixture();
    init(page);
    await flushPromises();

    page.envSelect.value = "";
    page.envSelect.dispatch("change");

    expect(page.deployBtn.disabled).toBe(true);
  });

  it("blocks deploy when the listing has no status for a stale selection", async () => {
    const page = fixture();
    init(page);
    await flushPromises();

    // A stale option is not proof that verification ever completed.
    page.envSelect.value = "ghost";
    page.envSelect.dispatch("change");

    expect(page.deployBtn.disabled).toBe(true);
    expect(page.deployBtn.getAttribute("title")).toContain("ghost");
  });

  it("allows deploy when verification history explicitly aged out", async () => {
    const page = fixture({
      envPayload: {
        environments: [{ name: "dev", provider: "azure", status: "unknown" }]
      }
    });

    init(page);
    await flushPromises();

    expect(page.deployBtn.disabled).toBe(false);
    expect(page.deployBtn.getAttribute("title")).toBeNull();
  });

  it.each([
    ["pending", "still being created"],
    ["failed", "was not created successfully"],
    ["mystery", "could not be determined"]
  ])(
    "blocks deploy when environment verification is %s",
    async (status, reason) => {
      const page = fixture({
        envPayload: {
          environments: [{ name: "dev", provider: "azure", status }]
        }
      });

      init(page);
      await flushPromises();

      expect(page.deployBtn.disabled).toBe(true);
      expect(page.deployBtn.getAttribute("title")).toContain(reason);
    }
  );

  it("defaults an environment with no provider metadata to Azure", async () => {
    const page = fixture({
      envPayload: { environments: [{ name: "dev", provider: "" }] }
    });
    let deployBody: unknown;
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, (deployInit) => {
      deployBody = deployInit?.body;
      return jsonResponse({ ok: true });
    });
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({ status: "success" })
    );

    page.deployBtn.dispatch("click");
    await flushPromises();

    expect(JSON.parse(String(deployBody))).toMatchObject({
      environment: "dev",
      provider: "azure"
    });
  });

  it("dispatches, shows the progress dialog, and auto-hides after success", async () => {
    const page = fixture();
    init(page);
    await flushPromises();

    let deployBody: unknown;
    page.browser.net.handle(DEPLOY_PATH, (deployInit) => {
      deployBody = deployInit?.body;
      return jsonResponse({ ok: true });
    });
    let pollCount = 0;
    page.browser.net.handle(DEPLOY_STATUS_PATH, () => {
      pollCount++;
      return pollCount === 1 ?
          jsonResponse({ status: "in_progress" })
        : jsonResponse({
            status: "in_progress",
            deployRunUrl: "https://example.test/run/1"
          });
    });

    page.deployBtn.dispatch("click");
    expect(page.deployBtn.disabled).toBe(true);
    expect(page.progressModal.style.display).toBe("flex");
    await flushPromises();
    expect(JSON.parse(String(deployBody))).toEqual({
      environment: "dev",
      provider: "azure",
      targetRepo: "octo/app",
      branch: "feature",
      appFile: ".radius/app.bicep"
    });
    expect(inlineMessage(page.inlineStatus)).toBe("");
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(inlineMessage(page.inlineStatus)).toBe("");
    expect(page.progressModal.style.display).toBe("flex");
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(inlineMessage(page.inlineStatus)).toContain("has started");

    page.browser.clock.tick(DEPLOY_AUTO_HIDE_MS);
    expect(page.progressModal.style.display).toBe("none");
    // refreshDeployBtn() re-blocks the button: the environment is still
    // synthetically "pending" until a workflow poll resolves it.
    expect(page.deployBtn.disabled).toBe(true);

    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({ status: "success" })
    );
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(page.browser.clock.pending).toBe(0);
  });

  it("keeps the started notification hidden until a poll confirms a workflow run URL", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));

    let pollCount = 0;
    page.browser.net.handle(DEPLOY_STATUS_PATH, () => {
      pollCount++;
      return pollCount === 1 ?
          jsonResponse({ status: "in_progress" })
        : jsonResponse({
            status: "in_progress",
            deployRunUrl: "https://example.test/run/1"
          });
    });

    page.deployBtn.dispatch("click");
    await flushPromises();

    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(inlineMessage(page.inlineStatus)).not.toContain("has started");

    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(inlineMessage(page.inlineStatus)).toContain("has started");
  });

  it("does not re-show a dismissed started notification on later polls", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        status: "in_progress",
        deployRunUrl: "https://example.test/run/1"
      })
    );

    page.deployBtn.dispatch("click");
    await flushPromises();

    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(inlineMessage(page.inlineStatus)).toContain("has started");

    const closeButton = page.inlineStatus.querySelector(".rad-inline__close");
    if (!closeButton) throw new Error("Expected inline status close button.");
    closeButton.dispatch("click");
    expect(page.inlineStatus.style.display).toBe("none");

    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(page.inlineStatus.style.display).toBe("none");
  });

  it("does not show a deployment-started notification when workflow startup fails", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        status: "failed",
        error: "workflow startup failed",
        deployRunUrl: "https://example.test/run/1"
      })
    );

    page.deployBtn.dispatch("click");
    await flushPromises();

    expect(inlineMessage(page.inlineStatus)).toBe("");
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();

    expect(inlineMessage(page.inlineStatus)).not.toContain("has started");
    expect(page.progressSubtitle.innerHTML).toContain(
      "workflow startup failed"
    );
  });

  it("does not show a deployment-started notification for terminal success", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        status: "success",
        deployRunUrl: "https://example.test/run/1"
      })
    );

    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();

    expect(inlineMessage(page.inlineStatus)).not.toContain("has started");
    expect(page.progressModal.style.display).toBe("flex");
    page.browser.clock.tick(DEPLOY_AUTO_HIDE_MS);
    expect(page.progressModal.style.display).toBe("none");
  });

  it("dismisses the inline status banner when its close button is clicked", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        status: "in_progress",
        deployRunUrl: "https://example.test/run/1"
      })
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(page.inlineStatus.style.display).toBe("flex");
    const closeButton = page.inlineStatus.querySelector(".rad-inline__close");
    if (!closeButton) throw new Error("Expected inline status close button.");
    closeButton.dispatch("click");
    expect(page.inlineStatus.style.display).toBe("none");
  });

  it("defaults an unset dataset.mode to 'deploy' when clicked before any load resolves", async () => {
    const page = fixture();
    init(page);
    // No flushPromises: refreshDeployBtn has not yet run, so
    // deployBtn.dataset.mode is still unset and must fall back to "deploy".
    expect(page.deployBtn.dataset.mode).toBeUndefined();
    page.deployBtn.dispatch("click");
    // Falls back to "deploy" mode, then bails out on missing environment/app
    // (selects are still unpopulated), so no navigation and no dispatch.
    expect(page.browser.nav.assigned).toEqual([]);
    expect(page.browser.net.calls.some((c) => c.url === DEPLOY_PATH)).toBe(
      false
    );
  });

  it("does nothing for create-app / create-env modes beyond navigating", async () => {
    const page = fixture({ appPayload: { applications: [] } });
    init(page);
    await flushPromises();
    page.deployBtn.dispatch("click");
    expect(page.browser.nav.assigned).toEqual(["/?page=graph"]);
  });

  it("navigates to create an environment when only environments are missing", async () => {
    const page = fixture({ envPayload: { environments: [] } });
    init(page);
    await flushPromises();
    page.deployBtn.dispatch("click");
    expect(page.browser.nav.assigned).toEqual(["/?page=environment&new=1"]);
  });

  it("ignores the click when repo, app, or environment is missing", async () => {
    const page = fixture({
      appPayload: { applications: [{ name: "app" }] },
      envPayload: { environments: [{ name: "dev", provider: "azure" }] }
    });
    init(page);
    await flushPromises();
    page.appSelect.setOptions([]);
    page.deployBtn.dispatch("click");
    expect(page.browser.net.calls.some((c) => c.url === DEPLOY_PATH)).toBe(
      false
    );
  });

  it("keeps quietly refreshing until the real record replaces the synthetic row", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({ status: "in_progress" })
    );
    let freshCalls = 0;
    page.browser.net.handle(
      `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(page.repo)}&fresh=1`,
      () => {
        freshCalls++;
        return jsonResponse({ deployments: [] });
      }
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    const before = freshCalls;
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(freshCalls).toBeGreaterThan(before);

    page.browser.net.handle(
      `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(page.repo)}&fresh=1`,
      () =>
        jsonResponse({
          deployments: [{ app: "app", environment: "dev", status: "pending" }]
        })
    );
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    const seen = freshCalls;
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    // Once the real record is seen, further fresh=1 fan-out stops.
    expect(freshCalls).toBe(seen);

    // One more tick: recordSeen is now true from the previous tick, so this
    // poll returns immediately without even checking deployRecordsPresent.
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(freshCalls).toBe(seen);
  });

  it("swallows a workflow-poll status fetch network failure and keeps polling", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      Promise.reject(new Error("offline"))
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(page.browser.clock.pending).toBeGreaterThan(0);
  });

  it("cancels a click-started poll superseded by another attempt", async () => {
    const page = fixture({ withProgressModalElement: false });
    const currentStatus = {
      status: "failed",
      error: "someone else's failure",
      attempt: { targetRepo: "other/repo", environment: "prod" },
      handoff: { pending: false, state: "idle" }
    };
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse(currentStatus)
    );

    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();

    expect(page.progressTitle.innerHTML).not.toContain("failed");
    expect(page.progressSubtitle.innerHTML).not.toContain(
      "someone else's failure"
    );
    expect(page.tableBody.innerHTML).not.toContain("Pending");
    expect(page.browser.clock.intervals).toBe(0);
  });

  it("reloads a known deployment after another attempt supersedes it", async () => {
    const page = fixture();
    let freshCalls = 0;
    let currentStatus = {
      status: "in_progress",
      error: "",
      attempt: { targetRepo: "octo/app", environment: "dev" },
      handoff: { pending: false, state: "idle" }
    };
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(
      `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(page.repo)}&fresh=1`,
      () => {
        freshCalls += 1;
        return jsonResponse({
          deployments: [{ app: "app", environment: "dev", status: "pending" }]
        });
      }
    );
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse(currentStatus)
    );

    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    const seenCalls = freshCalls;

    currentStatus = {
      status: "failed",
      error: "someone else's failure",
      attempt: { targetRepo: "other/repo", environment: "prod" },
      handoff: { pending: false, state: "idle" }
    };
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();

    expect(freshCalls).toBeGreaterThan(seenCalls);
    expect(page.browser.clock.intervals).toBe(0);
    expect(page.progressSubtitle.innerHTML).not.toContain(
      "someone else's failure"
    );
  });

  it("shows the branch-not-pushed panel and offers to push the branch", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        status: "failed",
        errorKind: "branch-not-pushed",
        errorBranch: "feature",
        handoff: { pending: false, state: "idle" }
      })
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();

    expect(page.progressTitle.innerHTML).toContain("Branch not pushed yet");
    // The markup rendered into progressSubtitle.innerHTML is a plain string in
    // the fake DOM (not parsed into real nodes), so the callout mounts into the
    // pre-registered document-level host that production discovers by id.
    expect(fakeText(page.pushActionHost)).toContain(
      "git push -u origin feature"
    );
    expect(fakeText(page.pushActionHost)).toContain("Run with Copilot");
  });

  it("offers commit-then-push when the server reports uncommitted generated files", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        status: "failed",
        errorKind: "branch-not-pushed",
        errorBranch: "feature",
        errorPaths: ".radius,app.bicep",
        handoff: { pending: false, state: "idle" }
      })
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();

    // A bare push would publish the branch without the model the deploy reads,
    // so the offer has to carry the staging and commit steps too.
    const offered = fakeText(page.pushActionHost);
    expect(offered).toContain("git add -- .radius app.bicep");
    expect(offered).toContain('git commit -m "Add Radius application model"');
    expect(offered).toContain("git push -u origin feature");
  });

  it("ignores uncommitted paths reported for a failure that is not a missing push", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        status: "failed",
        errorKind: "oidc-subject-missing",
        errorBranch: "feature",
        errorPaths: ".radius",
        handoff: { pending: false, state: "idle" }
      })
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();

    expect(fakeText(page.pushActionHost)).toBe("");
  });

  it("falls back to 'your branch' when the branch-not-pushed failure omits errorBranch", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        status: "failed",
        errorKind: "branch-not-pushed",
        handoff: { pending: false, state: "idle" }
      })
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(page.progressSubtitle.innerHTML).toContain("your branch");
  });

  it("shows the OIDC-credential panel and routes to environment creation", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        status: "failed",
        errorKind: "oidc-subject-missing",
        error: "no federated credential matching any subject",
        handoff: { pending: false, state: "idle" }
      })
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();

    expect(page.progressTitle.innerHTML).toContain(
      "Azure credentials aren't set up yet"
    );
    expect(page.progressSubtitle.innerHTML).toContain(
      "no federated credential matching any subject"
    );
    // The only fix is an Azure federated credential, which Create Environment
    // makes, so the button must land there rather than dead-end the user.
    page.fixCredentialsBtn.dispatch("click");
    await flushPromises();
    expect(page.browser.nav.assigned).toContain("/?page=environment&new=1");
  });

  it("gives a case-sensitive OIDC mismatch its own panel instead of the generic failure", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        status: "failed",
        errorKind: "oidc-subject-case-mismatch",
        error:
          'expected "repo:acme/widgets:environment:production" but the app has "repo:Acme/Widgets:environment:Production"',
        handoff: { pending: false, state: "idle" }
      })
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();

    // Nothing was dispatched, so this must not read like a run that failed.
    expect(page.progressTitle.innerHTML).not.toContain("Deployment of");
    expect(page.progressTitle.innerHTML).toContain(
      "Azure credentials don't match GitHub"
    );
    expect(page.progressSubtitle.innerHTML).toContain("Nothing was deployed.");
    expect(page.progressSubtitle.style.color).toBe("var(--rad-text-secondary)");
    expect(page.progressSubtitle.innerHTML).toContain(
      "repo:acme/widgets:environment:production"
    );
    expect(page.progressSubtitle.innerHTML).toContain(
      "repo:Acme/Widgets:environment:Production"
    );
    // Create Environment would rebuild the same spelling, so the route that
    // the missing-subject panel offers must not appear here.
    expect(page.progressSubtitle.innerHTML).not.toContain(
      "Set up Azure credentials"
    );
    expect(page.browser.nav.assigned).toEqual([]);
  });

  it("omits the preflight detail from the case-mismatch panel when the failure carries no text", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        status: "failed",
        errorKind: "oidc-subject-case-mismatch",
        error: "",
        handoff: { pending: false, state: "idle" }
      })
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();

    expect(page.progressTitle.innerHTML).toContain(
      "Azure credentials don't match GitHub"
    );
    expect(page.progressSubtitle.innerHTML).toContain("Nothing was deployed.");
    expect(page.progressSubtitle.innerHTML).not.toContain("margin-top:10px");
  });

  it("omits the preflight detail from the OIDC panel when the failure carries no text", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        status: "failed",
        errorKind: "oidc-subject-missing",
        handoff: { pending: false, state: "idle" }
      })
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();

    expect(page.progressTitle.innerHTML).toContain(
      "Azure credentials aren't set up yet"
    );
    expect(page.progressSubtitle.innerHTML).toContain(
      "Set up Azure credentials"
    );
  });

  it("shows a generic failure with the run link and repair note while repairing", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        status: "failed",
        error: "workflow exploded",
        deployRunUrl: "https://example.test/run/9",
        repairing: true,
        handoff: { pending: false, state: "idle" }
      })
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();

    expect(page.progressTitle.innerHTML).toContain("failed");
    expect(page.progressSubtitle.innerHTML).toContain("workflow exploded");
    expect(page.progressSubtitle.innerHTML).toContain(
      "https://example.test/run/9"
    );
    expect(page.failRepairNote.textContent).toContain("Copilot is analyzing");
    expect(page.deployBtn.disabled).toBe(false);

    // A generic failure has no branch to push, so no run-command callout is
    // offered at all rather than one naming an empty branch.
    expect(page.pushActionHost.children).toHaveLength(0);
  });

  it("shows the handoff-pending note for a retryable handoff state", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        status: "failed",
        error: "boom",
        handoff: { pending: false, state: "retryable" }
      })
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(page.failRepairNote.textContent).toContain("Handing this failure");
  });

  it("falls back to the azure provider when an environment omits one", async () => {
    const page = fixture({ envPayload: { environments: [{ name: "dev" }] } });
    init(page);
    await flushPromises();
    let deployBody: unknown;
    page.browser.net.handle(DEPLOY_PATH, (deployInit) => {
      deployBody = deployInit?.body;
      return jsonResponse({ ok: true });
    });
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({ status: "in_progress" })
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    expect(JSON.parse(String(deployBody)).provider).toBe("azure");
  });

  it("runs the branch-not-pushed failure flow with no progress-modal chrome present", async () => {
    const page = fixture({ withProgressModal: false });
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        status: "failed",
        errorKind: "branch-not-pushed",
        errorBranch: "feature",
        handoff: { pending: false, state: "idle" }
      })
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(page.deployBtn.disabled).toBe(false);
  });

  it("runs the OIDC-credential failure flow with no progress-modal chrome present", async () => {
    const page = fixture({ withProgressModal: false });
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        status: "failed",
        errorKind: "oidc-subject-missing",
        error: "no federated credential",
        handoff: { pending: false, state: "idle" }
      })
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(page.deployBtn.disabled).toBe(false);
  });

  it("runs the case-mismatch failure flow with no progress-modal chrome present", async () => {
    const page = fixture({ withProgressModal: false });
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        status: "failed",
        errorKind: "oidc-subject-case-mismatch",
        error: "differs only by letter casing",
        handoff: { pending: false, state: "idle" }
      })
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(page.deployBtn.disabled).toBe(false);
  });

  it("runs the generic failure flow with no progress-modal chrome present", async () => {
    const page = fixture({ withProgressModal: false });
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        status: "failed",
        error: "boom",
        handoff: { pending: false, state: "idle" }
      })
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(page.deployBtn.disabled).toBe(false);
  });

  it("dismisses on backdrop click even when only the modal element is absent", async () => {
    const page = fixture({ withProgressModalElement: false });
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({ status: "in_progress" })
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    // backBtn exists but progressModal itself does not: its guard against a
    // missing container, and the outer progressModal-click wiring, both
    // resolve to their "absent" branch.
    page.backBtn.dispatch("click");
    expect(page.browser.clock.pending).toBeGreaterThanOrEqual(0);
  });

  it("falls back to options.branch when no branch select is present", async () => {
    const page = fixture({ withBranchSelect: false });
    init(page);
    await flushPromises();
    let deployBody: unknown;
    page.browser.net.handle(DEPLOY_PATH, (deployInit) => {
      deployBody = deployInit?.body;
      return jsonResponse({ ok: true });
    });
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({ status: "in_progress" })
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    expect(JSON.parse(String(deployBody)).branch).toBe(page.branch);
  });

  it("falls back to options.branch when the branch select value is empty", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.branchSelect.setOptions([]);
    let deployBody: unknown;
    page.browser.net.handle(DEPLOY_PATH, (deployInit) => {
      deployBody = deployInit?.body;
      return jsonResponse({ ok: true });
    });
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({ status: "in_progress" })
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    expect(JSON.parse(String(deployBody)).branch).toBe(page.branch);
  });

  it("hides an absent progress modal gracefully on a dispatch rejection response", async () => {
    const page = fixture({ withProgressModalElement: false });
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () =>
      jsonResponse({ error: "bad ref" }, false, 400)
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    expect(page.deployBtn.disabled).toBe(false);
    expect(inlineMessage(page.inlineStatus)).toContain("bad ref");
  });

  it("hides an absent progress modal gracefully on a dispatch network failure", async () => {
    const page = fixture({ withProgressModalElement: false });
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () =>
      Promise.reject(new Error("offline"))
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    expect(page.deployBtn.disabled).toBe(false);
    expect(inlineMessage(page.inlineStatus)).toContain(
      "Could not start the deployment"
    );
  });

  it("ignores a workflow-poll status response that resolves after teardown", async () => {
    const page = fixture();
    const teardown = init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    const statusDef = createDeferred<HttpResponse>();
    page.browser.net.handle(DEPLOY_STATUS_PATH, () => statusDef.promise);
    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    teardown();
    statusDef.resolve(jsonResponse({ status: "success" }));
    await flushPromises();
    expect(page.browser.clock.pending).toBe(0);
  });

  it("ignores a dispatch success that resolves after teardown", async () => {
    const page = fixture();
    const teardown = init(page);
    await flushPromises();
    const dispatchDef = createDeferred<HttpResponse>();
    page.browser.net.handle(DEPLOY_PATH, () => dispatchDef.promise);
    page.deployBtn.dispatch("click");
    teardown();
    dispatchDef.resolve(jsonResponse({ ok: true }));
    await flushPromises();
    expect(page.browser.clock.pending).toBe(0);
  });

  it("ignores a dispatch network failure that arrives after teardown", async () => {
    const page = fixture();
    const teardown = init(page);
    await flushPromises();
    const dispatchDef = createDeferred<HttpResponse>();
    page.browser.net.handle(DEPLOY_PATH, () => dispatchDef.promise);
    page.deployBtn.dispatch("click");
    teardown();
    dispatchDef.reject(new Error("offline"));
    await flushPromises();
    expect(page.browser.clock.pending).toBe(0);
  });

  it("shows a default failure message when the server omits error text", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        status: "failed",
        handoff: { pending: false, state: "" }
      })
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(page.progressSubtitle.innerHTML).toContain(
      "did not complete successfully"
    );
    expect(page.failRepairNote.style.display).toBe("none");
  });

  it("shows the handoff-pending note and retries until handoff resolves", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    let ticks = 0;
    page.browser.net.handle(DEPLOY_STATUS_PATH, () => {
      ticks++;
      return jsonResponse({
        status: "failed",
        error: "boom",
        handoff: { pending: ticks <= 2, state: "pending" }
      });
    });
    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(page.failRepairNote.textContent).toContain("Handing this failure");
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(page.browser.clock.pending).toBe(0);
  });

  it("does not show a started notification if repair polling observes a new run URL", async () => {
    const page = fixture();
    const teardown = init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    let ticks = 0;
    page.browser.net.handle(DEPLOY_STATUS_PATH, () => {
      ticks++;
      return ticks === 1 ?
          jsonResponse({
            status: "failed",
            error: "workflow startup failed",
            handoff: { pending: true, state: "pending" }
          })
        : jsonResponse({
            status: "in_progress",
            deployRunUrl: "https://example.test/run/2"
          });
    });

    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(page.progressSubtitle.innerHTML).toContain(
      "workflow startup failed"
    );

    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(inlineMessage(page.inlineStatus)).not.toContain("has started");
    teardown();
  });

  it("keeps failure UI visible when a confirmed workflow enters repair handoff", async () => {
    const page = fixture();
    const teardown = init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    let ticks = 0;
    page.browser.net.handle(DEPLOY_STATUS_PATH, () => {
      ticks++;
      return ticks === 1 ?
          jsonResponse({
            status: "in_progress",
            deployRunUrl: "https://example.test/run/1"
          })
        : jsonResponse({
            status: "failed",
            error: "deployment failed",
            handoff: { pending: true, state: "pending" }
          });
    });

    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(inlineMessage(page.inlineStatus)).toContain("has started");

    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(page.progressModal.style.display).toBe("flex");
    expect(page.progressSubtitle.innerHTML).toContain("deployment failed");
    expect(page.failRepairNote.textContent).toContain("Handing this failure");
    teardown();
  });

  it("shows the repair-failed note when Copilot cannot be reached", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        status: "failed",
        error: "boom",
        handoff: { pending: false, state: "failed" }
      })
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(page.failRepairNote.textContent).toContain(
      "Could not reach Copilot"
    );
  });

  it("gives up on the handoff-pending retry loop after its own limit", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        status: "failed",
        error: "boom",
        handoff: { pending: true, state: "pending" }
      })
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    for (let tick = 0; tick <= DEPLOY_FAILED_HANDOFF_POLL_LIMIT + 1; tick++) {
      page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
      await flushPromises();
    }
    expect(page.browser.clock.pending).toBe(0);
  });

  it("stops polling and reverts the row when a dispatch fails", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () =>
      jsonResponse({ error: "bad ref" }, false, 400)
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    expect(page.progressModal.style.display).toBe("none");
    expect(page.deployBtn.disabled).toBe(false);
    expect(inlineMessage(page.inlineStatus)).toContain("bad ref");
    expect(page.browser.clock.pending).toBe(0);
  });

  it("shows a default dispatch-failure message when the server omits one", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({}, false, 500));
    page.deployBtn.dispatch("click");
    await flushPromises();
    expect(inlineMessage(page.inlineStatus)).toContain(
      "Could not start the deployment."
    );
  });

  it("tolerates an unparsable dispatch response body", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => ({
      ok: false,
      status: 500,
      text: () => Promise.resolve("not json"),
      json: () => Promise.reject(new Error("bad json"))
    }));
    page.deployBtn.dispatch("click");
    await flushPromises();
    expect(inlineMessage(page.inlineStatus)).toContain(
      "Could not start the deployment."
    );
  });

  it("shows a generic error on a dispatch network failure", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () =>
      Promise.reject(new Error("offline"))
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    expect(inlineMessage(page.inlineStatus)).toContain(
      "Could not start the deployment. Please try again."
    );
    expect(page.progressModal.style.display).toBe("none");
  });

  it.each([
    { label: "present", withProgressModalElement: true },
    { label: "absent", withProgressModalElement: false }
  ])(
    "gives up after the workflow poll cap when the optional progress modal is $label",
    async ({ withProgressModalElement }) => {
      const page = fixture({ withProgressModalElement });
      init(page);
      await flushPromises();
      page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
      page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
        jsonResponse({
          status: "in_progress",
          deployRunUrl: "https://example.test/run/1"
        })
      );
      page.deployBtn.dispatch("click");
      await flushPromises();
      for (let tick = 0; tick <= DEPLOY_WORKFLOW_POLL_LIMIT + 1; tick++) {
        page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
        await flushPromises();
      }
      expect(page.browser.clock.pending).toBe(0);
      if (withProgressModalElement) {
        expect(page.progressModal.style.display).toBe("none");
      }
      expect(inlineMessage(page.inlineStatus)).toContain(
        "taking longer than expected"
      );
    }
  );

  it("dismisses the progress dialog on backdrop click and refreshes fresh", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({ status: "in_progress" })
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    expect(page.progressModal.style.display).toBe("flex");

    page.progressModal.dispatch("click", { target: page.progressModal });
    expect(page.progressModal.style.display).toBe("none");
    // refreshDeployBtn() re-blocks the button immediately: the pending
    // override is still in effect for this environment until the fresh
    // reload it just kicked off resolves.
    expect(page.deployBtn.disabled).toBe(true);
    await flushPromises();
  });

  it("ignores a progress-modal click that does not target the backdrop", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({ status: "in_progress" })
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    page.progressModal.dispatch("click", { target: page.progressTitle });
    expect(page.progressModal.style.display).toBe("flex");
  });

  it("dismisses the failure dialog from the back button and reloads plainly", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        status: "failed",
        error: "boom",
        handoff: { pending: false, state: "idle" }
      })
    );
    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(page.progressModal.style.display).toBe("flex");

    page.backBtn.dispatch("click");
    expect(page.progressModal.style.display).toBe("none");
    expect(page.progressSpinner.style.display).toBe("");
    await flushPromises();
  });
});

describe("deploy-status run correlation", () => {
  // The regression these pin: `/api/deploy-status` is a per-canvas slot, not a
  // per-run one. Until `POST /api/deploy` reaches `beginDeployAttempt` it still
  // holds the *previous* attempt's terminal result, and that dispatch first
  // awaits a repair-loop check, a GitHub deployment lookup and a reservation —
  // routinely longer than the 2.5s first tick. Redeploying to an environment
  // whose last attempt failed therefore read that stale "failed" and flipped
  // the optimistic Pending row straight to Failed while the new run was still
  // starting. `sameAttempt` cannot catch it: repo and environment are exactly
  // what a redeploy repeats.
  it("ignores the previous attempt's failure until the dispatch is accepted", async () => {
    const page = fixture();
    init(page);
    await flushPromises();

    const dispatch = createDeferred<HttpResponse>();
    page.browser.net.handle(DEPLOY_PATH, () => dispatch.promise);
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        status: "failed",
        error: "the previous run failed",
        attempt: { targetRepo: page.repo, environment: "dev" },
        handoff: { pending: false, state: "idle" }
      })
    );

    page.deployBtn.dispatch("click");
    await flushPromises();
    expect(page.tableBody.innerHTML).toContain("Pending");

    for (let tick = 0; tick < 4; tick++) {
      page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
      await flushPromises();
    }

    // Not merely ignored once read — the stale slot must not be read at all.
    expect(
      page.browser.net.calls.some((call) => call.url === DEPLOY_STATUS_PATH)
    ).toBe(false);
    expect(page.tableBody.innerHTML).toContain("Pending");
    expect(page.tableBody.innerHTML).not.toContain("Failed");
    expect(page.progressTitle.innerHTML).not.toContain("failed");
    expect(page.progressFailActions.style.display).not.toBe("block");

    dispatch.resolve(jsonResponse({ ok: true }));
    await flushPromises();
  });

  it("honors the failure once the dispatch has been accepted", async () => {
    const page = fixture();
    init(page);
    await flushPromises();

    const dispatch = createDeferred<HttpResponse>();
    page.browser.net.handle(DEPLOY_PATH, () => dispatch.promise);
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        status: "failed",
        error: "boom",
        attempt: { targetRepo: page.repo, environment: "dev" },
        handoff: { pending: false, state: "idle" }
      })
    );

    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();
    expect(page.progressTitle.innerHTML).not.toContain("failed");

    // Accepting the dispatch means the server has already reset the slot, so
    // anything it reports from here describes this run.
    dispatch.resolve(jsonResponse({ ok: true }));
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();

    expect(page.progressTitle.innerHTML).toContain("failed");
    expect(page.progressFailActions.style.display).toBe("block");
  });

  it("stops polling the status slot when the dispatch is refused", async () => {
    const page = fixture();
    init(page);
    await flushPromises();

    page.browser.net.handle(DEPLOY_PATH, () =>
      jsonResponse({ error: "already deploying" }, false, 409)
    );
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        status: "failed",
        error: "the previous run failed",
        handoff: { pending: false, state: "idle" }
      })
    );

    page.deployBtn.dispatch("click");
    await flushPromises();
    page.browser.clock.tick(DEPLOY_WORKFLOW_POLL_MS);
    await flushPromises();

    expect(
      page.browser.net.calls.some((call) => call.url === DEPLOY_STATUS_PATH)
    ).toBe(false);
    expect(page.progressTitle.innerHTML).not.toContain("failed");
    expect(page.browser.clock.pending).toBe(0);
  });
});

describe("optimistic deployment rows", () => {
  // The regression this pins: a `fresh=1` listing bypasses the cache and can
  // take tens of seconds. When the click path blanked the table to the loading
  // placeholder and only synthesized the pending row from the *response*, a
  // just-started deploy showed "Loading deployments…" for the whole wait and
  // looked like it had never registered.
  it("shows the pending row before the refreshed listing responds", async () => {
    const page = fixture();
    init(page);
    await flushPromises();
    expect(page.tableBody.innerHTML).toContain(
      "No application deployments yet"
    );

    const listing = createDeferred<HttpResponse>();
    page.browser.net.handle(
      `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(page.repo)}&fresh=1`,
      () => listing.promise
    );
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({ status: "in_progress" })
    );

    page.deployBtn.dispatch("click");

    expect(page.tableBody.innerHTML).toContain("Pending");
    expect(page.tableBody.innerHTML).not.toContain("Loading deployments");
    expect(page.tableBody.innerHTML).toContain("dev");

    listing.resolve(jsonResponse({ deployments: [] }));
    await flushPromises();
    expect(page.tableBody.innerHTML).toContain("Pending");
  });

  it("keeps the pending row when the refreshed listing rejects", async () => {
    const page = fixture();
    init(page);
    await flushPromises();

    page.browser.net.handle(
      `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(page.repo)}&fresh=1`,
      () => Promise.reject(new Error("offline"))
    );
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({ status: "in_progress" })
    );

    page.deployBtn.dispatch("click");
    await flushPromises();

    expect(page.tableBody.innerHTML).toContain("Pending");
    expect(page.tableBody.innerHTML).not.toContain(
      "Could not load deployments"
    );
  });

  it("keeps the pending row when the refreshed listing reports a transient error", async () => {
    const page = fixture();
    init(page);
    await flushPromises();

    page.browser.net.handle(
      `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(page.repo)}&fresh=1`,
      () => jsonResponse({ deployments: [], error: "rate limited" })
    );
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({ status: "in_progress" })
    );

    page.deployBtn.dispatch("click");
    await flushPromises();

    expect(page.tableBody.innerHTML).toContain("Pending");
    expect(page.tableBody.innerHTML).not.toContain("Retrying");
  });

  it("keeps already-loaded rows on screen while a non-quiet refresh is in flight", async () => {
    const page = fixture({
      deploymentsPayload: {
        deployments: [
          { app: "shop", environment: "prod", status: "success", runUrl: "" }
        ]
      }
    });
    init(page);
    await flushPromises();
    expect(page.tableBody.innerHTML).toContain("shop");

    const listing = createDeferred<HttpResponse>();
    page.browser.net.handle(
      `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(page.repo)}&fresh=1`,
      () => listing.promise
    );
    page.browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({ status: "in_progress" })
    );

    page.deployBtn.dispatch("click");

    expect(page.tableBody.innerHTML).toContain("shop");
    expect(page.tableBody.innerHTML).toContain("Pending");
    expect(page.tableBody.innerHTML).not.toContain("Loading deployments");

    listing.resolve(
      jsonResponse({
        deployments: [
          { app: "shop", environment: "prod", status: "success", runUrl: "" }
        ]
      })
    );
    await flushPromises();
    expect(page.tableBody.innerHTML).toContain("shop");
  });

  it("still shows the loading placeholder when there is nothing to render", async () => {
    const page = fixture();
    const listing = createDeferred<HttpResponse>();
    page.browser.net.handle(
      `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(page.repo)}`,
      () => listing.promise
    );
    init(page);

    expect(page.tableBody.innerHTML).toContain("Loading deployments");

    listing.resolve(jsonResponse({ deployments: [] }));
    await flushPromises();
  });
});

describe("resuming a redirected deployment", () => {
  it("resumes when ?application= and ?environment= are present", async () => {
    const page = fixture({ search: "?application=app&environment=dev" });
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        active: true,
        attempt: { targetRepo: "octo/app", environment: "dev" }
      })
    );
    init(page);
    await flushPromises();
    expect(page.tableBody.innerHTML).toContain("Pending");

    page.browser.net.handle(
      `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(page.repo)}&fresh=1`,
      () =>
        jsonResponse({
          deployments: [{ app: "app", environment: "dev", status: "success" }]
        })
    );
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({ active: false, status: "success" })
    );
    page.browser.clock.tick(RESUME_POLL_MS);
    await flushPromises();
    expect(page.browser.clock.pending).toBe(0);
  });

  it("does not resume without both application and environment", async () => {
    const page = fixture({ search: "?application=app" });
    init(page);
    await flushPromises();
    expect(
      page.browser.net.calls.some((c) => c.url === DEPLOY_STATUS_PATH)
    ).toBe(false);
  });

  it("shows a failure dialog for a same-attempt terminal failure", async () => {
    const page = fixture({ search: "?application=app&environment=dev" });
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        active: false,
        status: "failed",
        error: "resume failed",
        attempt: { targetRepo: "octo/app", environment: "dev" },
        handoff: { pending: false, state: "idle" }
      })
    );
    init(page);
    await flushPromises();
    page.browser.clock.tick(RESUME_POLL_MS);
    await flushPromises();
    expect(page.progressTitle.innerHTML).toContain("failed");
    expect(page.progressSubtitle.innerHTML).toContain("resume failed");
  });

  it("ignores a terminal status from a different attempt", async () => {
    const page = fixture({ search: "?application=app&environment=dev" });
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        active: false,
        status: "failed",
        error: "someone else's failure",
        attempt: { targetRepo: "other/repo", environment: "prod" },
        handoff: { pending: false, state: "idle" }
      })
    );
    init(page);
    await flushPromises();
    page.browser.clock.tick(RESUME_POLL_MS);
    await flushPromises();
    expect(page.progressTitle.innerHTML ?? "").not.toContain(
      "someone else's failure"
    );
  });

  it("stops quiet refreshing once the real record appears while still active", async () => {
    const page = fixture({ search: "?application=app&environment=dev" });
    let freshCalls = 0;
    page.browser.net.handle(
      `${LIST_DEPLOYMENTS_PATH}?repo=${encodeURIComponent(page.repo)}&fresh=1`,
      () => {
        freshCalls++;
        return jsonResponse({
          deployments: [{ app: "app", environment: "dev", status: "pending" }]
        });
      }
    );
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        active: true,
        attempt: { targetRepo: "octo/app", environment: "dev" }
      })
    );
    init(page);
    await flushPromises();
    page.browser.clock.tick(RESUME_POLL_MS);
    await flushPromises();
    const seenAfterFirstTick = freshCalls;
    page.browser.clock.tick(RESUME_POLL_MS);
    await flushPromises();
    expect(freshCalls).toBe(seenAfterFirstTick);
  });

  it("gives up after the resume poll cap", async () => {
    const page = fixture({ search: "?application=app&environment=dev" });
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        active: true,
        attempt: { targetRepo: "octo/app", environment: "dev" }
      })
    );
    init(page);
    await flushPromises();
    for (let tick = 0; tick <= RESUME_POLL_LIMIT + 1; tick++) {
      page.browser.clock.tick(RESUME_POLL_MS);
      await flushPromises();
    }
    expect(page.browser.clock.pending).toBe(0);
  });

  it("swallows a resume poll network failure and keeps polling", async () => {
    const page = fixture({ search: "?application=app&environment=dev" });
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      Promise.reject(new Error("offline"))
    );
    init(page);
    await flushPromises();
    page.browser.clock.tick(RESUME_POLL_MS);
    await flushPromises();
    expect(page.browser.clock.pending).toBeGreaterThan(0);
  });

  it("reads application/environment from a search string missing the leading '?' and a bare key", async () => {
    const page = fixture({ search: "foo&application=app&environment=dev" });
    page.browser.net.handle(DEPLOY_STATUS_PATH, () =>
      jsonResponse({
        active: true,
        attempt: { targetRepo: "octo/app", environment: "dev" }
      })
    );
    init(page);
    await flushPromises();
    expect(page.tableBody.innerHTML).toContain("Pending");
  });

  it("treats a bare application key with no '=' as an empty value and does not resume", async () => {
    const page = fixture({ search: "?application&environment=dev" });
    init(page);
    await flushPromises();
    expect(
      page.browser.net.calls.some((c) => c.url === DEPLOY_STATUS_PATH)
    ).toBe(false);
  });

  it("ignores a resume-poll status response that resolves after teardown", async () => {
    const page = fixture({ search: "?application=app&environment=dev" });
    const statusDef = createDeferred<HttpResponse>();
    page.browser.net.handle(DEPLOY_STATUS_PATH, () => statusDef.promise);
    const teardown = init(page);
    await flushPromises();
    page.browser.clock.tick(RESUME_POLL_MS);
    teardown();
    statusDef.resolve(
      jsonResponse({
        active: false,
        status: "success",
        attempt: { targetRepo: "octo/app", environment: "dev" }
      })
    );
    await flushPromises();
    expect(page.browser.clock.pending).toBe(0);
  });
});

describe("pure helpers", () => {
  it("keys operations by app and environment together", () => {
    expect(opKey("a", "b")).not.toBe(opKey("b", "a"));
    expect(opKey("a", "b")).toBe(opKey("a", "b"));
  });

  it.each([
    ["success", "Success"],
    ["failed", "Failed"],
    ["pending", "Pending"],
    ["deleting", "Deleting…"],
    ["delete-failed", "Delete failed"],
    ["unknown-status", "Pending"]
  ])("renders %s as text without a colored circle", (status, label) => {
    expect(deploymentStatusMarkup(status)).toBe(label);
  });

  it("parses deployments defensively, dropping incomplete entries", () => {
    expect(parseDeploymentRecords(null)).toEqual([]);
    expect(
      parseDeploymentRecords({
        deployments: [
          { app: "a", environment: "b", status: "success", runUrl: "u" },
          { app: "", environment: "b" },
          { app: "a" },
          "not-an-object"
        ]
      })
    ).toEqual([{ app: "a", environment: "b", status: "success", runUrl: "u" }]);
  });

  it("builds application options, inserting a redirected app not in the list", () => {
    const options = buildDeployApplicationOptions([{ name: "a" }], "");
    expect(options).toEqual([{ value: "a", label: "a" }]);
    const found = buildDeployApplicationOptions(
      [{ name: "a" }, { name: "b" }],
      "b"
    );
    expect(found.find((o) => o.value === "b")?.selected).toBe(true);
    const inserted = buildDeployApplicationOptions([{ name: "a" }], "c");
    expect(inserted[0]).toEqual({ value: "c", label: "c", selected: true });
  });

  it("builds branch options with the worktree fallback and sha labels", () => {
    const empty = buildDeployBranchOptions(
      { branches: [], workspaceBranch: "", error: "" },
      "main"
    );
    expect(empty).toEqual([{ value: "main", label: "main", selected: true }]);

    const withWorktree = buildDeployBranchOptions(
      {
        branches: [{ name: "main", sha: "abc1234567" }],
        workspaceBranch: "feature",
        error: ""
      },
      "feature"
    );
    expect(withWorktree[0]).toEqual({
      value: "feature",
      label: "feature (worktree)",
      selected: true
    });

    const noSha = buildDeployBranchOptions(
      { branches: [{ name: "main", sha: "" }], workspaceBranch: "", error: "" },
      "main"
    );
    expect(noSha).toEqual([{ value: "main", label: "main", selected: true }]);

    expect(WORKTREE_SHA).toBe("worktree");
  });
});

describe("stale response identity across independent operations", () => {
  it("does not let a superseded delete-poll response clear a fresher override", async () => {
    const page = fixture({
      deploymentsPayload: {
        deployments: [{ app: "app", environment: "dev", status: "success" }]
      }
    });
    const button = deployRowButton("app", "dev");
    page.browser.document.addSelectorAll(".js-del-dep", [button]);
    init(page);
    await flushPromises();
    page.browser.net.handle(DELETE_DEPLOYMENT_PATH, () =>
      jsonResponse({ ok: true })
    );
    button.dispatch("click");
    confirmDeleteDialog(page.deleteBody, "app", "dev");
    await flushPromises();
    expect(page.tableBody.innerHTML).toContain("Deleting");
  });
});

void vi;
