import { describe, it, expect } from "vitest";
import {
  APPLICATIONS_PATH,
  BRANCHES_PATH,
  DEPLOY_PATH,
  DEPLOYMENTS_PATH,
  DIFF_BRANCH_TIMEOUT_MS,
  ENVIRONMENTS_PATH,
  REPOS_PATH,
  REPO_RETRY_MS,
  applyDeployedEnvState,
  applyModeledEnvState,
  applyPlanEnvState,
  branchLabel,
  buildApplicationOptions,
  buildBranchOptions,
  buildDiffBranchOptions,
  buildEnvironmentOptions,
  environmentAllowsDeploy,
  buildRepoOptions,
  createDeployedState,
  environmentIsReady,
  environmentNotReadyPhrase,
  environmentNotReadyReason,
  environmentOptionLabel,
  firstReadyEnvironmentName,
  createPlanScheduler,
  createPlanState,
  deployDeployedApp,
  deployPlannedApp,
  deploymentKey,
  deploymentStatusBlocksMutation,
  loadModeledEnvState,
  modeledPrimaryAction,
  parseApplicationListing,
  parseBranchListing,
  parseDeploymentListing,
  parseRequiredDeploymentListing,
  parseEnvironmentListing,
  populateApplications,
  populateBranches,
  populateDiffBranches,
  populatePlannedSelectors,
  populateRepositories,
  setupRepoBranch
} from "./repositories.js";
import {
  createFakeBrowser,
  createDeferred,
  createFakeElement,
  createFakeInput,
  createFakeSelect,
  flushPromises,
  jsonResponse
} from "../../test/support/browser/fakes.js";
import type { FakeBrowser } from "../../test/support/browser/fakes.js";
import type { ScopeTimer } from "./lifecycle.js";
import type { HttpResponse } from "./ports.js";

function selects(browser: FakeBrowser, ids: string[]) {
  const created: Record<string, ReturnType<typeof createFakeSelect>> = {};
  for (const id of ids) {
    const select = createFakeSelect(id);
    browser.document.add(select);
    created[id] = select;
  }
  return created;
}

function optionValues(innerHTML: string): string[] {
  return [...innerHTML.matchAll(/<option value="([^"]*)"/g)].map(
    (match) => match[1]
  );
}

function selectedOption(innerHTML: string): string | undefined {
  return innerHTML.match(/<option value="([^"]*)" selected>/)?.[1];
}

describe("listing payload parsing", () => {
  it("keeps only branches that name themselves", () => {
    expect(
      parseBranchListing({
        branches: [
          { name: "main", sha: "abcdef1234" },
          { name: "", sha: "zzz" },
          "nonsense",
          { sha: "no-name" }
        ],
        workspaceBranch: "feature",
        error: ""
      })
    ).toEqual({
      branches: [{ name: "main", sha: "abcdef1234" }],
      workspaceBranch: "feature",
      error: ""
    });
  });

  it("reports a listing error and an absent payload without inventing data", () => {
    expect(parseBranchListing({ error: "no token" })).toEqual({
      branches: [],
      workspaceBranch: "",
      error: "no token"
    });
    expect(parseBranchListing(null)).toEqual({
      branches: [],
      workspaceBranch: "",
      error: ""
    });
  });

  it("defaults an environment provider to azure and drops unnamed entries", () => {
    expect(
      parseEnvironmentListing({
        environments: [
          { name: "dev" },
          { name: "prod", provider: "aws" },
          { provider: "azure" }
        ]
      })
    ).toEqual({
      environments: [
        { name: "dev", provider: "azure", status: "" },
        { name: "prod", provider: "aws", status: "" }
      ],
      error: ""
    });
  });

  it("reads applications by name only", () => {
    expect(
      parseApplicationListing({ applications: [{ name: "store" }, {}] })
    ).toEqual([{ name: "store" }]);
  });
});

describe("selector option building", () => {
  it("labels a worktree branch as a worktree and a pushed branch by short sha", () => {
    expect(branchLabel({ name: "feature", sha: "worktree" })).toBe(
      "feature (worktree)"
    );
    expect(branchLabel({ name: "main", sha: "0123456789abcdef" })).toBe(
      "main (0123456)"
    );
  });

  it("offers the session repository even when the listing omits it", () => {
    const options = buildRepoOptions(["octo/one"], "octo/session");
    expect(options.map((option) => option.value)).toEqual([
      "",
      "octo/session",
      "octo/one"
    ]);
    expect(options[1].selected).toBe(true);
  });

  it("selects the session repository from the listing without duplicating it", () => {
    const options = buildRepoOptions(["octo/one", "octo/two"], "octo/two");
    expect(options.map((option) => option.value)).toEqual([
      "",
      "octo/one",
      "octo/two"
    ]);
    expect(options[2].selected).toBe(true);
  });

  it("keeps a placeholder-only list when there is no default repository", () => {
    expect(buildRepoOptions([], "")).toEqual([
      { value: "", label: "-- Select repository --" }
    ]);
  });

  it("selects the requested branch when the listing has it", () => {
    const options = buildBranchOptions(
      [
        { name: "main", sha: "aaaaaaa1" },
        { name: "feature", sha: "bbbbbbb2" }
      ],
      "feature",
      "feature"
    );
    expect(options.find((option) => option.selected)?.value).toBe("feature");
  });

  it("offers an unpushed workspace branch first rather than falling back to main", () => {
    const options = buildBranchOptions(
      [{ name: "main", sha: "aaaaaaa1" }],
      "feature",
      "feature"
    );
    expect(options[0]).toEqual({
      value: "feature",
      label: "feature (worktree)",
      selected: true
    });
    expect(options[1].value).toBe("main");
  });

  it("falls back to the first branch when the wanted branch is not the workspace one", () => {
    const options = buildBranchOptions(
      [
        { name: "main", sha: "aaaaaaa1" },
        { name: "other", sha: "bbbbbbb2" }
      ],
      "gone",
      "feature"
    );
    expect(options[0].selected).toBe(true);
    expect(options.map((option) => option.value)).toEqual(["main", "other"]);
  });

  it("defaults the wanted branch to main when none is given", () => {
    const options = buildBranchOptions(
      [
        { name: "topic", sha: "aaaaaaa1" },
        { name: "main", sha: "bbbbbbb2" }
      ],
      "",
      ""
    );
    expect(options.find((option) => option.selected)?.value).toBe("main");
  });

  it("defaults to the workspace branch before main when one is known", () => {
    const options = buildBranchOptions(
      [
        { name: "main", sha: "aaaaaaa1" },
        { name: "feature", sha: "worktree" }
      ],
      "",
      "feature"
    );
    expect(options.find((option) => option.selected)?.value).toBe("feature");
  });

  it("returns nothing to select for an empty branch listing", () => {
    expect(buildBranchOptions([], "main", "")).toEqual([]);
  });

  it("offers only pushed refs as a diff base and the worktree branch as a head", () => {
    const built = buildDiffBranchOptions(
      {
        branches: [
          { name: "main", sha: "aaaaaaa1" },
          { name: "feature", sha: "worktree" },
          { name: "other", sha: "worktree" },
          { name: "empty", sha: "" }
        ],
        workspaceBranch: "feature",
        error: ""
      },
      "",
      ""
    );
    expect(built.base.map((option) => option.value)).toEqual(["main"]);
    expect(built.head.map((option) => option.value)).toEqual([
      "",
      "main",
      "feature"
    ]);
    expect(built.head.find((option) => option.selected)?.value).toBe("feature");
    expect(built.base[0].selected).toBe(true);
  });

  it("honours explicit base and head preferences", () => {
    const built = buildDiffBranchOptions(
      {
        branches: [
          { name: "main", sha: "aaaaaaa1" },
          { name: "release", sha: "bbbbbbb2" }
        ],
        workspaceBranch: "feature",
        error: ""
      },
      "release",
      "main"
    );
    expect(built.base.find((option) => option.selected)?.value).toBe("release");
    expect(built.head.find((option) => option.selected)?.value).toBe("main");
  });

  it("selects the first pushed base when the requested base is absent", () => {
    const built = buildDiffBranchOptions(
      {
        branches: [
          { name: "main", sha: "aaaaaaa1" },
          { name: "release", sha: "bbbbbbb2" }
        ],
        workspaceBranch: "",
        error: ""
      },
      "missing",
      ""
    );
    expect(built.base[0].selected).toBe(true);
  });

  it("leaves the head unselected when the workspace branch is not offered", () => {
    const built = buildDiffBranchOptions(
      {
        branches: [{ name: "main", sha: "aaaaaaa1" }],
        workspaceBranch: "",
        error: ""
      },
      "",
      ""
    );
    expect(built.head.some((option) => option.selected)).toBe(false);
  });

  it("falls back to the repository short name when no application is listed", () => {
    expect(buildApplicationOptions([], "octo/store")).toEqual([
      { value: "store", label: "store" }
    ]);
    expect(buildApplicationOptions([], "store")).toEqual([
      { value: "store", label: "store" }
    ]);
  });

  it("uses an unqualified repository name as its own application fallback", () => {
    expect(buildApplicationOptions([], "store")).toEqual([
      { value: "store", label: "store" }
    ]);
  });

  it("selects the first ready environment when none is requested", () => {
    const options = buildEnvironmentOptions(
      [
        { name: "pending", provider: "azure" },
        { name: "prod", provider: "aws", status: "success" }
      ],
      ""
    );
    expect(options[0].selected).toBe(false);
    expect(options[1].selected).toBe(true);
  });

  it("marks the requested environment as selected", () => {
    const options = buildEnvironmentOptions(
      [
        { name: "dev", provider: "azure" },
        { name: "prod", provider: "aws" }
      ],
      "prod"
    );
    expect(options[1].selected).toBe(true);
    expect(options[0].selected).toBe(false);
  });
});

describe("repository selector", () => {
  it("does nothing when the page has no repository selector", async () => {
    const browser = createFakeBrowser();
    await populateRepositories(browser.context, "graph-repo", "octo/app");
    expect(browser.net.calls).toHaveLength(0);
  });

  it("loads the repository list and marks the session repository", async () => {
    const browser = createFakeBrowser();
    const { "graph-repo": select } = selects(browser, ["graph-repo"]);
    browser.net.handle(`${REPOS_PATH}?_t=0`, () =>
      jsonResponse({ repos: ["octo/one", "octo/app"] })
    );

    await populateRepositories(browser.context, "graph-repo", "octo/app");

    expect(optionValues(select.innerHTML)).toEqual([
      "",
      "octo/one",
      "octo/app"
    ]);
    expect(select.value).toBe("octo/app");
  });

  it("retries once when the listing is not ready yet", async () => {
    const browser = createFakeBrowser();
    const { "graph-repo": select } = selects(browser, ["graph-repo"]);
    let attempt = 0;
    const answer = () => {
      attempt += 1;
      return attempt === 1 ?
          Promise.reject(new Error("warming up"))
        : jsonResponse({ repos: ["octo/app"] });
    };
    // The cache-busting timestamp advances with the retry delay, so the retry
    // is a distinct request rather than a repeat of a cached one.
    browser.net.handle(`${REPOS_PATH}?_t=0`, answer);
    browser.net.handle(`${REPOS_PATH}?_t=${REPO_RETRY_MS}`, answer);

    const pending = populateRepositories(
      browser.context,
      "graph-repo",
      "octo/app"
    );
    await flushPromises();
    browser.clock.tick(REPO_RETRY_MS);
    await pending;

    expect(attempt).toBe(2);
    expect(browser.net.calls.map((call) => call.url)).toEqual([
      `${REPOS_PATH}?_t=0`,
      `${REPOS_PATH}?_t=${REPO_RETRY_MS}`
    ]);
    expect(select.value).toBe("octo/app");
  });

  it("leaves the current options alone and reports when both attempts fail", async () => {
    const browser = createFakeBrowser();
    const { "graph-repo": select } = selects(browser, ["graph-repo"]);
    select.innerHTML = '<option value="octo/app">octo/app</option>';
    browser.net.handle(`${REPOS_PATH}?_t=0`, () =>
      Promise.reject(new Error("offline"))
    );

    const pending = populateRepositories(
      browser.context,
      "graph-repo",
      "octo/app"
    );
    await flushPromises();
    browser.clock.tick(REPO_RETRY_MS);
    await pending;

    expect(select.innerHTML).toBe('<option value="octo/app">octo/app</option>');
    expect(browser.logger.errors[0].message).toContain(
      "could not list repositories"
    );
  });
});

describe("branch selectors", () => {
  it("does nothing without a repository", async () => {
    const browser = createFakeBrowser();
    await populateBranches(browser.context, ["b"], "", []);
    expect(browser.net.calls).toHaveLength(0);
  });

  it("fills every requested selector with its own default", async () => {
    const browser = createFakeBrowser();
    const created = selects(browser, ["base", "head"]);
    browser.net.handle(BRANCHES_PATH, () =>
      jsonResponse({
        branches: [
          { name: "main", sha: "aaaaaaa1" },
          { name: "feature", sha: "bbbbbbb2" }
        ],
        workspaceBranch: "feature"
      })
    );

    await populateBranches(
      browser.context,
      ["base", "head", "missing"],
      "octo/app",
      ["main", "feature"]
    );

    expect(created.base.value).toBe("main");
    expect(created.head.value).toBe("feature");
    expect(browser.net.calls[0].init?.method).toBe("POST");
    expect(browser.net.calls[0].init?.body).toBe(
      JSON.stringify({ repo: "octo/app" })
    );
  });

  it("uses the workspace default when a selector has no explicit default", async () => {
    const browser = createFakeBrowser();
    const created = selects(browser, ["branch"]);
    browser.net.handle(BRANCHES_PATH, () =>
      jsonResponse({
        branches: [
          { name: "main", sha: "aaaaaaa1" },
          { name: "feature", sha: "worktree" }
        ],
        workspaceBranch: "feature"
      })
    );
    await populateBranches(browser.context, ["branch"], "octo/app", []);
    expect(created.branch.value).toBe("feature");
  });

  it("leaves the selectors untouched when the listing reports an error", async () => {
    const browser = createFakeBrowser();
    const created = selects(browser, ["base"]);
    created.base.innerHTML = '<option value="main">main</option>';
    browser.net.handle(BRANCHES_PATH, () =>
      jsonResponse({ error: "GitHub unavailable" })
    );

    await populateBranches(browser.context, ["base"], "octo/app", ["main"]);

    expect(created.base.innerHTML).toBe('<option value="main">main</option>');
  });

  it("reloads branches when the repository selection changes", async () => {
    const browser = createFakeBrowser();
    const created = selects(browser, ["repo", "branch"]);
    browser.net.handle(`${REPOS_PATH}?_t=0`, () =>
      jsonResponse({ repos: ["octo/app"] })
    );
    browser.net.handle(BRANCHES_PATH, () =>
      jsonResponse({ branches: [{ name: "main", sha: "aaaaaaa1" }] })
    );

    await setupRepoBranch(browser.context, "repo", ["branch"], "octo/app", [
      "main"
    ]);
    expect(created.branch.value).toBe("main");

    created.repo.value = "octo/other";
    created.repo.dispatch("change");
    await flushPromises();

    expect(
      browser.net.calls.filter((call) => call.url === BRANCHES_PATH)
    ).toHaveLength(2);
  });

  it("ignores a slower branch response after the repository changes again", async () => {
    const browser = createFakeBrowser();
    const created = selects(browser, ["repo", "branch"]);
    const first = createDeferred<ReturnType<typeof jsonResponse>>();
    const second = createDeferred<ReturnType<typeof jsonResponse>>();
    browser.net.handle(`${REPOS_PATH}?_t=0`, () =>
      jsonResponse({ repos: ["octo/app", "octo/one", "octo/two"] })
    );
    browser.net.handle(BRANCHES_PATH, (init) => {
      const repo = JSON.parse(String(init?.body)).repo;
      if (repo === "octo/app") {
        return jsonResponse({ branches: [{ name: "main", sha: "aaaaaaa1" }] });
      }
      return repo === "octo/one" ? first.promise : second.promise;
    });

    await setupRepoBranch(browser.context, "repo", ["branch"], "octo/app", [
      "main"
    ]);

    created.repo.value = "octo/one";
    created.repo.dispatch("change");
    created.repo.value = "octo/two";
    created.repo.dispatch("change");
    second.resolve(
      jsonResponse({ branches: [{ name: "two", sha: "2222222" }] })
    );
    await flushPromises();
    first.resolve(
      jsonResponse({ branches: [{ name: "one", sha: "1111111" }] })
    );
    await flushPromises();

    expect(created.branch.value).toBe("two");
  });

  it("does not let a late repository listing replace a user selection", async () => {
    const browser = createFakeBrowser();
    const created = selects(browser, ["repo", "branch"]);
    const repositories = createDeferred<ReturnType<typeof jsonResponse>>();
    browser.net.handle(`${REPOS_PATH}?_t=0`, () => repositories.promise);
    browser.net.handle(BRANCHES_PATH, () =>
      jsonResponse({
        branches: [{ name: "topic", sha: "worktree" }],
        workspaceBranch: "topic"
      })
    );
    const setup = setupRepoBranch(
      browser.context,
      "repo",
      ["branch"],
      "octo/app",
      []
    );

    created.repo.value = "octo/other";
    created.repo.dispatch("change");
    await flushPromises();
    repositories.resolve(jsonResponse({ repos: ["octo/app"] }));
    await setup;

    expect(created.repo.value).toBe("octo/other");
    expect(created.branch.value).toBe("topic");
  });

  it("does not load branches when the repository selection is cleared", async () => {
    const browser = createFakeBrowser();
    const created = selects(browser, ["repo", "branch"]);
    browser.net.handle(`${REPOS_PATH}?_t=0`, () => jsonResponse({ repos: [] }));

    await setupRepoBranch(browser.context, "repo", ["branch"], "", []);
    created.repo.value = "";
    created.repo.dispatch("change");
    await flushPromises();

    expect(
      browser.net.calls.filter((call) => call.url === BRANCHES_PATH)
    ).toHaveLength(0);
  });

  it("survives a page with no repository selector at all", async () => {
    const browser = createFakeBrowser();
    await setupRepoBranch(browser.context, "repo", ["branch"], "octo/app", []);
    expect(browser.net.calls).toHaveLength(0);
  });
});

describe("application selector", () => {
  it("reports a missing repository context instead of loading", async () => {
    const browser = createFakeBrowser();
    const created = selects(browser, ["diff-app"]);

    await populateApplications(browser.context, "", "diff-app");

    expect(created["diff-app"].innerHTML).toContain("No application context");
    expect(browser.net.calls).toHaveLength(0);
  });

  it("lists applications and falls back to the repository short name", async () => {
    const browser = createFakeBrowser();
    const created = selects(browser, ["diff-app"]);
    browser.net.handle(`${APPLICATIONS_PATH}?repo=octo%2Fstore`, () =>
      jsonResponse({ applications: [] })
    );

    await populateApplications(browser.context, "octo/store", "diff-app");

    expect(created["diff-app"].value).toBe("store");
  });

  it("shows an explicit failure when applications cannot be loaded", async () => {
    const browser = createFakeBrowser();
    const created = selects(browser, ["diff-app"]);
    browser.net.handle(`${APPLICATIONS_PATH}?repo=octo%2Fstore`, () =>
      Promise.reject(new Error("offline"))
    );

    await populateApplications(browser.context, "octo/store", "diff-app");

    expect(created["diff-app"].innerHTML).toContain(
      "Unable to load applications"
    );
  });

  it("ignores a page without the selector", async () => {
    const browser = createFakeBrowser();
    await populateApplications(browser.context, "octo/store", "missing");
    expect(browser.net.calls).toHaveLength(0);
  });
});

describe("planned selectors", () => {
  function plannedPage() {
    const browser = createFakeBrowser();
    const created = selects(browser, [
      "planned-app",
      "planned-branch",
      "planned-env"
    ]);
    const button = createFakeInput("plan-btn");
    const hint = createFakeElement("planned-subtitle-hint");
    browser.document.add(button);
    browser.document.add(hint);
    browser.net.handle(`${DEPLOYMENTS_PATH}?repo=octo%2Fapp&fresh=1`, () =>
      jsonResponse({ deployments: [] })
    );
    return { browser, created, button, hint };
  }

  it("reports no repository across all three selectors", async () => {
    const { browser, created } = plannedPage();

    await populatePlannedSelectors(browser.context, createPlanState(), {
      repo: "",
      environmentProviders: {}
    });

    for (const select of Object.values(created)) {
      expect(select.innerHTML).toContain("No repository");
    }
    expect(browser.net.calls).toHaveLength(0);
  });

  it("reports no repository without requiring any selector markup", async () => {
    const browser = createFakeBrowser();
    await expect(
      populatePlannedSelectors(browser.context, createPlanState(), {
        repo: "",
        environmentProviders: {}
      })
    ).resolves.toBeUndefined();
  });

  it("loads applications, branches and environments and records providers", async () => {
    const { browser, created, button, hint } = plannedPage();
    const providers: Record<string, unknown> = {};
    browser.net.handle(`${APPLICATIONS_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ applications: [{ name: "store" }] })
    );
    browser.net.handle(BRANCHES_PATH, () =>
      jsonResponse({
        branches: [{ name: "feature", sha: "worktree" }],
        workspaceBranch: "feature"
      })
    );
    browser.net.handle(`${ENVIRONMENTS_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({
        environments: [
          { name: "dev", provider: "aws", status: "success" },
          { name: "pending", provider: "aws" }
        ]
      })
    );

    const state = createPlanState();
    await populatePlannedSelectors(browser.context, state, {
      repo: "octo/app",
      environmentProviders: providers,
      defaultBranch: "feature",
      defaultEnvironment: "dev"
    });

    expect(created["planned-app"].value).toBe("store");
    expect(created["planned-branch"].value).toBe("feature");
    expect(created["planned-env"].value).toBe("dev");
    expect(providers).toEqual({ dev: "aws", pending: "aws" });
    expect(state.hasEnv).toBe(true);
    expect(button.textContent).toBe("Deploy Application");
    expect(button.disabled).toBe(false);
    expect(hint.innerHTML).toContain("<strong>store</strong>");
  });

  it("loads deployment states and blocks the selected pending application and environment pair", async () => {
    const { browser, created, button, hint } = plannedPage();
    browser.net.handle(`${APPLICATIONS_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ applications: [{ name: "store" }] })
    );
    browser.net.handle(BRANCHES_PATH, () =>
      jsonResponse({
        branches: [{ name: "feature", sha: "worktree" }],
        workspaceBranch: "feature"
      })
    );
    browser.net.handle(`${ENVIRONMENTS_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({
        environments: [{ name: "dev", provider: "azure", status: "success" }]
      })
    );
    browser.net.handle(`${DEPLOYMENTS_PATH}?repo=octo%2Fapp&fresh=1`, () =>
      jsonResponse({
        deployments: [
          { app: "store", environment: "dev", status: "pending", runUrl: "" },
          { app: "other", environment: "dev", status: "pending", runUrl: "" }
        ]
      })
    );

    const state = createPlanState();
    await populatePlannedSelectors(browser.context, state, {
      repo: "octo/app",
      environmentProviders: {},
      defaultBranch: "feature",
      defaultEnvironment: "dev"
    });

    expect(created["planned-app"].value).toBe("store");
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toContain("already in progress");
    expect(hint.innerHTML).toContain("Deployments tab");
    expect(state.deploymentStatuses[deploymentKey("store", "dev")]).toBe(
      "pending"
    );
  });

  it("fails closed when deployment states cannot be loaded", async () => {
    const { browser, button } = plannedPage();
    browser.net.handle(`${APPLICATIONS_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ applications: [{ name: "store" }] })
    );
    browser.net.handle(BRANCHES_PATH, () =>
      jsonResponse({
        branches: [{ name: "feature", sha: "worktree" }],
        workspaceBranch: "feature"
      })
    );
    browser.net.handle(`${ENVIRONMENTS_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({
        environments: [{ name: "dev", provider: "azure", status: "success" }]
      })
    );
    browser.net.handle(`${DEPLOYMENTS_PATH}?repo=octo%2Fapp&fresh=1`, () =>
      jsonResponse({ deployments: [], error: "unavailable" })
    );

    const state = createPlanState();
    await populatePlannedSelectors(browser.context, state, {
      repo: "octo/app",
      environmentProviders: {},
      defaultBranch: "feature",
      defaultEnvironment: "dev"
    });

    expect(state.deploymentsStale).toBe(true);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toContain(
      "Deployment states could not be loaded"
    );
  });

  it("fails closed when the deployment listing request rejects", async () => {
    const { browser, button } = plannedPage();
    browser.net.handle(`${APPLICATIONS_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ applications: [{ name: "store" }] })
    );
    browser.net.handle(BRANCHES_PATH, () =>
      jsonResponse({
        branches: [{ name: "feature", sha: "worktree" }],
        workspaceBranch: "feature"
      })
    );
    browser.net.handle(`${ENVIRONMENTS_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({
        environments: [{ name: "dev", provider: "azure", status: "success" }]
      })
    );
    browser.net.handle(`${DEPLOYMENTS_PATH}?repo=octo%2Fapp&fresh=1`, () =>
      Promise.reject(new Error("offline"))
    );

    const state = createPlanState();
    await populatePlannedSelectors(browser.context, state, {
      repo: "octo/app",
      environmentProviders: {},
      defaultBranch: "feature",
      defaultEnvironment: "dev"
    });

    expect(state.deploymentsStale).toBe(true);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toContain(
      "Deployment states could not be loaded"
    );
  });

  it("honours ?app= only for an application that exists", async () => {
    const { browser, created } = plannedPage();
    browser.nav.search = "?page=planned&app=cart";
    browser.net.handle(`${APPLICATIONS_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ applications: [{ name: "store" }, { name: "cart" }] })
    );
    browser.net.handle(BRANCHES_PATH, () => jsonResponse({ branches: [] }));
    browser.net.handle(`${ENVIRONMENTS_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ environments: [] })
    );

    await populatePlannedSelectors(browser.context, createPlanState(), {
      repo: "octo/app",
      environmentProviders: {}
    });

    expect(created["planned-app"].value).toBe("cart");
  });

  it("reads an app query without a leading question mark and skips empty pairs", async () => {
    const { browser, created } = plannedPage();
    browser.nav.search = "&&app=store";
    browser.net.handle(`${APPLICATIONS_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ applications: [{ name: "other" }, { name: "store" }] })
    );
    browser.net.handle(BRANCHES_PATH, () => jsonResponse({ branches: [] }));
    browser.net.handle(`${ENVIRONMENTS_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ environments: [] })
    );
    await populatePlannedSelectors(browser.context, createPlanState(), {
      repo: "octo/app",
      environmentProviders: {}
    });
    expect(created["planned-app"].value).toBe("store");
  });

  it("treats an app query without a value as no requested application", async () => {
    const { browser, created } = plannedPage();
    browser.nav.search = "?app";
    browser.net.handle(`${APPLICATIONS_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ applications: [{ name: "other" }] })
    );
    browser.net.handle(BRANCHES_PATH, () => jsonResponse({ branches: [] }));
    browser.net.handle(`${ENVIRONMENTS_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ environments: [] })
    );
    await populatePlannedSelectors(browser.context, createPlanState(), {
      repo: "octo/app",
      environmentProviders: {}
    });
    expect(created["planned-app"].value).toBe("other");
  });

  it("ignores ?app= for an application the repository does not have", async () => {
    const { browser, created } = plannedPage();
    browser.nav.search = "?app=ghost";
    browser.net.handle(`${APPLICATIONS_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ applications: [{ name: "store" }] })
    );
    browser.net.handle(BRANCHES_PATH, () => jsonResponse({ branches: [] }));
    browser.net.handle(`${ENVIRONMENTS_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ environments: [] })
    );

    await populatePlannedSelectors(browser.context, createPlanState(), {
      repo: "octo/app",
      environmentProviders: {}
    });

    expect(created["planned-app"].value).toBe("store");
  });

  it("marks environments stale when the listing reports an error", async () => {
    const { browser, created, button, hint } = plannedPage();
    browser.net.handle(`${APPLICATIONS_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ applications: [{ name: "store" }] })
    );
    browser.net.handle(BRANCHES_PATH, () => jsonResponse({ branches: [] }));
    browser.net.handle(`${ENVIRONMENTS_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ error: "GitHub unavailable" })
    );

    const state = createPlanState();
    await populatePlannedSelectors(browser.context, state, {
      repo: "octo/app",
      environmentProviders: {}
    });

    expect(created["planned-env"].innerHTML).toContain(
      "Unable to load environments"
    );
    expect(state.envsStale).toBe(true);
    expect(button.disabled).toBe(true);
    expect(hint.textContent).toContain("temporarily unavailable");
  });

  it("distinguishes an empty environment list from an unreadable one", async () => {
    const { browser, created, button } = plannedPage();
    browser.net.handle(`${APPLICATIONS_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ applications: [] })
    );
    browser.net.handle(BRANCHES_PATH, () => jsonResponse({ branches: [] }));
    browser.net.handle(`${ENVIRONMENTS_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ environments: [] })
    );

    const state = createPlanState();
    await populatePlannedSelectors(browser.context, state, {
      repo: "octo/app",
      environmentProviders: {}
    });

    expect(created["planned-env"].innerHTML).toContain("No environments");
    expect(state.envsStale).toBe(false);
    expect(state.hasEnv).toBe(false);
    expect(button.textContent).toBe("Create Environment");
  });

  it("shows each selector's own failure text when a request rejects", async () => {
    const { browser, created } = plannedPage();
    browser.net.handle(`${APPLICATIONS_PATH}?repo=octo%2Fapp`, () =>
      Promise.reject(new Error("offline"))
    );
    browser.net.handle(BRANCHES_PATH, () =>
      Promise.reject(new Error("offline"))
    );
    browser.net.handle(`${ENVIRONMENTS_PATH}?repo=octo%2Fapp`, () =>
      Promise.reject(new Error("offline"))
    );

    const state = createPlanState();
    await populatePlannedSelectors(browser.context, state, {
      repo: "octo/app",
      environmentProviders: {}
    });

    expect(created["planned-app"].innerHTML).toContain(
      "Unable to load applications"
    );
    expect(created["planned-branch"].innerHTML).toContain(
      "Unable to load branches"
    );
    expect(created["planned-env"].innerHTML).toContain(
      "Unable to load environments"
    );
    expect(state.envsStale).toBe(true);
  });

  it("works on a page that has only some of the selectors", async () => {
    const browser = createFakeBrowser();
    const created = selects(browser, ["planned-env"]);
    browser.net.handle(`${ENVIRONMENTS_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ environments: [{ name: "dev", provider: "azure" }] })
    );

    await populatePlannedSelectors(browser.context, createPlanState(), {
      repo: "octo/app",
      environmentProviders: {}
    });

    expect(created["planned-env"].value).toBe("dev");
    expect(browser.net.calls).toHaveLength(1);
  });

  it.each(["planned-app", "planned-branch"])(
    "works when %s is the only selector",
    async (selectorId) => {
      const browser = createFakeBrowser();
      const created = selects(browser, [selectorId]);
      if (selectorId === "planned-app") {
        browser.net.handle(`${APPLICATIONS_PATH}?repo=octo%2Fapp`, () =>
          jsonResponse({ applications: [{ name: "store" }] })
        );
      } else {
        browser.net.handle(BRANCHES_PATH, () =>
          jsonResponse({
            branches: [{ name: "feature", sha: "worktree" }],
            workspaceBranch: "feature"
          })
        );
      }
      await populatePlannedSelectors(browser.context, createPlanState(), {
        repo: "octo/app",
        environmentProviders: {}
      });
      expect(created[selectorId].value).not.toBe("");
      expect(browser.net.calls).toHaveLength(1);
    }
  );
});

describe("deployment listings", () => {
  it("parses complete records and drops entries without an application or environment", () => {
    expect(
      parseDeploymentListing({
        deployments: [
          {
            app: "store",
            environment: "dev",
            status: "pending",
            runUrl: "https://example.test/run"
          },
          { app: "", environment: "dev", status: "pending" },
          { app: "store", environment: "", status: "pending" },
          null
        ]
      })
    ).toEqual([
      {
        app: "store",
        environment: "dev",
        status: "pending",
        runUrl: "https://example.test/run"
      }
    ]);
  });

  it.each([
    null,
    {},
    { deployments: "not-an-array" },
    { deployments: [null] },
    {
      deployments: [
        { app: "store", environment: "dev", status: "", runUrl: "" }
      ]
    },
    {
      deployments: [{ app: "store", environment: "dev", status: "pending" }]
    }
  ])("rejects an incomplete required deployment listing", (payload) => {
    expect(parseRequiredDeploymentListing(payload)).toEqual({
      deployments: [],
      error: "Invalid deployment listing."
    });
  });

  it("accepts complete required deployment records", () => {
    expect(
      parseRequiredDeploymentListing({
        deployments: [
          {
            app: "store",
            environment: "dev",
            status: "pending",
            runUrl: ""
          }
        ]
      })
    ).toEqual({
      deployments: [
        {
          app: "store",
          environment: "dev",
          status: "pending",
          runUrl: ""
        }
      ],
      error: ""
    });
  });

  it.each([
    ["pending", true],
    ["in_progress", true],
    ["deleting", true],
    ["success", false],
    ["failed", false],
    ["", false]
  ])("treats %s as mutation-blocking=%s", (status, blocked) => {
    expect(deploymentStatusBlocksMutation(status)).toBe(blocked);
  });
});

describe("planned primary button state", () => {
  function plannedButtons() {
    const browser = createFakeBrowser();
    const button = createFakeInput("plan-btn");
    const hint = createFakeElement("planned-subtitle-hint");
    browser.document.add(button);
    browser.document.add(hint);
    const created = selects(browser, [
      "planned-app",
      "planned-branch",
      "planned-env"
    ]);
    return { browser, button, hint, created };
  }

  function readyPlanState(environment = "dev") {
    const state = createPlanState();
    state.environmentStatuses[environment] = "success";
    return state;
  }

  it.each(["pending", "in_progress", "deleting"])(
    "blocks a selected deployment with %s status",
    (status) => {
      const { browser, button, hint, created } = plannedButtons();
      created["planned-app"].value = "store";
      created["planned-branch"].value = "feature";
      created["planned-env"].value = "dev";
      const state = readyPlanState();
      state.deploymentStatuses[deploymentKey("store", "dev")] = status;

      applyPlanEnvState(browser.context, state, true, false);

      expect(button.disabled).toBe(true);
      expect(button.getAttribute("title")).toContain("already in progress");
      expect(hint.innerHTML).toContain("Deployments tab");
    }
  );

  it("does not block a different application or environment pair", () => {
    const { browser, button, created } = plannedButtons();
    created["planned-app"].value = "store";
    created["planned-branch"].value = "feature";
    created["planned-env"].value = "dev";
    const state = readyPlanState();
    state.deploymentStatuses[deploymentKey("other", "dev")] = "pending";
    state.deploymentStatuses[deploymentKey("store", "prod")] = "pending";

    applyPlanEnvState(browser.context, state, true, false);

    expect(button.disabled).toBe(false);
    expect(button.getAttribute("title")).toBeNull();
  });

  it("requires an application before enabling deployment", () => {
    const { browser, button, created } = plannedButtons();
    created["planned-branch"].value = "feature";
    created["planned-env"].value = "dev";

    applyPlanEnvState(browser.context, readyPlanState(), true, false);

    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe(
      "Select the application to deploy."
    );
  });

  it("offers environment creation when the repository has none", () => {
    const { browser, button, hint } = plannedButtons();
    const state = createPlanState();

    applyPlanEnvState(browser.context, state, false, false);

    expect(button.dataset.mode).toBe("create-env");
    expect(button.textContent).toBe("Create Environment");
    expect(button.disabled).toBe(false);
    expect(hint.textContent).toContain("must first create an environment");
  });

  it.each([
    ["", "", "Select a branch and an environment to deploy."],
    ["", "dev", "Select the branch to deploy."],
    ["feature", "", "Select the environment to deploy to."]
  ])(
    "refuses to deploy with branch %s and environment %s",
    (branch, environment, reason) => {
      const { browser, button, created } = plannedButtons();
      created["planned-app"].value = "store";
      created["planned-branch"].value = branch;
      created["planned-env"].value = environment;

      applyPlanEnvState(browser.context, createPlanState(), true, false);

      expect(button.disabled).toBe(true);
      expect(button.getAttribute("title")).toBe(reason);
    }
  );

  it.each([["pending"], ["failed"], [""]])(
    "refuses to plan a deploy into a %s environment",
    (status) => {
      const { browser, button, created } = plannedButtons();
      created["planned-app"].value = "store";
      created["planned-branch"].value = "feature";
      created["planned-env"].value = "dev";
      const state = createPlanState();
      if (status !== "") state.environmentStatuses.dev = status;

      applyPlanEnvState(browser.context, state, true, false);

      expect(button.dataset.mode).toBe("deploy");
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("title")).toBe(
        environmentNotReadyReason("dev", status)
      );
    }
  );

  it("allows a planned deploy when verification history is unavailable", () => {
    const { browser, button, created } = plannedButtons();
    created["planned-app"].value = "store";
    created["planned-branch"].value = "feature";
    created["planned-env"].value = "dev";
    const state = createPlanState();
    state.environmentStatuses.dev = "unknown";

    applyPlanEnvState(browser.context, state, true, false);

    expect(button.dataset.mode).toBe("deploy");
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("title")).toBeNull();
  });

  it("disables deployment while the last plan request failed", () => {
    const { browser, button, created } = plannedButtons();
    created["planned-app"].value = "store";
    created["planned-branch"].value = "feature";
    created["planned-env"].value = "dev";
    const state = createPlanState();
    state.environmentStatuses.dev = "success";
    state.requestFailed = true;

    applyPlanEnvState(browser.context, state, true, false);

    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toContain("could not be generated");
  });

  it("clears a stale title when the state becomes deployable", () => {
    const { browser, button, created } = plannedButtons();
    created["planned-app"].value = "store";
    applyPlanEnvState(browser.context, readyPlanState(), true, false);
    expect(button.getAttribute("title")).not.toBeNull();

    created["planned-branch"].value = "feature";
    created["planned-env"].value = "dev";
    applyPlanEnvState(browser.context, readyPlanState(), true, false);

    expect(button.getAttribute("title")).toBeNull();
    expect(button.disabled).toBe(false);
  });

  it("escapes the application and environment names in the hint", () => {
    const { browser, hint, created } = plannedButtons();
    created["planned-app"].value = "<script>bad</script>";
    created["planned-branch"].value = "feature";
    created["planned-env"].value = "d&v";

    applyPlanEnvState(browser.context, readyPlanState("d&v"), true, false);

    expect(hint.innerHTML).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(hint.innerHTML).toContain("d&amp;v");
    expect(hint.innerHTML).not.toContain("<script>");
  });

  it("names generic fallbacks when nothing is selected yet", () => {
    const { browser, hint } = plannedButtons();

    applyPlanEnvState(browser.context, createPlanState(), true, false);

    expect(hint.innerHTML).toContain("<strong>this application</strong>");
    expect(hint.innerHTML).toContain(
      "<strong>the selected environment</strong>"
    );
  });

  it("does nothing on a page without the button or hint", () => {
    const browser = createFakeBrowser();
    expect(() =>
      applyPlanEnvState(browser.context, createPlanState(), true, false)
    ).not.toThrow();
  });
});

describe("plan scheduler", () => {
  it("debounces rapid changes into one request for the latest values", async () => {
    const browser = createFakeBrowser();
    const runs: number[] = [];
    const schedule = createPlanScheduler(browser.context, () => {
      runs.push(browser.clock.now());
      return Promise.resolve();
    });

    schedule();
    schedule();
    schedule();
    browser.clock.tick(150);
    await flushPromises();

    expect(runs).toHaveLength(1);
  });

  it("runs immediately when asked", async () => {
    const browser = createFakeBrowser();
    let ran = false;
    const schedule = createPlanScheduler(browser.context, () => {
      ran = true;
      return Promise.resolve();
    });

    schedule(true);
    browser.clock.tick(0);
    await flushPromises();

    expect(ran).toBe(true);
  });

  it("invalidates an in-flight request when the selection changes again", async () => {
    const browser = createFakeBrowser();
    const currency: boolean[] = [];
    const gate: Array<() => void> = [];
    const schedule = createPlanScheduler(browser.context, (isCurrent) => {
      return new Promise<void>((resolve) => {
        gate.push(() => {
          currency.push(isCurrent());
          resolve();
        });
      });
    });

    schedule();
    browser.clock.tick(150);
    await flushPromises();
    schedule();
    gate.shift()?.();
    await flushPromises();

    expect(currency).toEqual([false]);

    browser.clock.tick(150);
    await flushPromises();
    gate.shift()?.();
    await flushPromises();
    expect(currency).toEqual([false, true]);
  });

  it("reports a failing run and keeps scheduling", async () => {
    const browser = createFakeBrowser();
    let calls = 0;
    const schedule = createPlanScheduler(browser.context, () => {
      calls += 1;
      return Promise.reject(new Error("plan failed"));
    });

    schedule();
    browser.clock.tick(150);
    await flushPromises();
    expect(browser.logger.errors[0].message).toBe(
      "Planned graph request failed."
    );

    schedule();
    browser.clock.tick(150);
    await flushPromises();
    expect(calls).toBe(2);
  });

  it("calls back when the queue drains", async () => {
    const browser = createFakeBrowser();
    let idle = 0;
    const schedule = createPlanScheduler(
      browser.context,
      () => Promise.resolve(),
      () => {
        idle += 1;
      },
      10
    );

    schedule();
    browser.clock.tick(10);
    await flushPromises();

    expect(idle).toBe(1);
  });

  it("queues exactly one follow-up run for changes made during a request", async () => {
    const browser = createFakeBrowser();
    let runs = 0;
    const gate: Array<() => void> = [];
    const schedule = createPlanScheduler(
      browser.context,
      () => {
        runs += 1;
        return new Promise<void>((resolve) => {
          gate.push(resolve);
        });
      },
      undefined,
      10
    );

    schedule();
    browser.clock.tick(10);
    await flushPromises();
    schedule();
    schedule();
    gate.shift()?.();
    await flushPromises();
    browser.clock.tick(10);
    await flushPromises();

    expect(runs).toBe(2);
  });
});

describe("planned deployment dispatch", () => {
  function deployPage() {
    const browser = createFakeBrowser();
    const button = createFakeInput("plan-btn");
    browser.document.add(button);
    const created = selects(browser, [
      "planned-app",
      "planned-branch",
      "planned-env"
    ]);
    created["planned-app"].value = "store";
    created["planned-branch"].value = "feature";
    created["planned-env"].value = "dev";
    return { browser, button, created };
  }

  it("dispatches the selected application, branch and environment", async () => {
    const { browser, button } = deployPage();
    browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));

    await deployPlannedApp(
      browser.context,
      button,
      "octo/app",
      { dev: "aws" },
      "azure"
    );

    expect(JSON.parse(String(browser.net.calls[0].init?.body))).toEqual({
      environment: "dev",
      provider: "aws",
      targetRepo: "octo/app",
      branch: "feature",
      appFile: ".radius/app.bicep"
    });
    expect(browser.nav.assigned[0]).toBe(
      "/?page=deploying&application=store&environment=dev"
    );
  });

  it("falls back to the page provider when the environment has none", async () => {
    const { browser, button } = deployPage();
    browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));

    await deployPlannedApp(browser.context, button, "octo/app", {}, "aws");

    expect(JSON.parse(String(browser.net.calls[0].init?.body)).provider).toBe(
      "aws"
    );
  });

  it("defaults to azure when neither the environment nor the page names a provider", async () => {
    const { browser, button } = deployPage();
    browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));

    await deployPlannedApp(browser.context, button, "octo/app", {}, "");

    expect(JSON.parse(String(browser.net.calls[0].init?.body)).provider).toBe(
      "azure"
    );
  });

  it.each([
    ["no branch", "planned-branch"],
    ["no environment", "planned-env"]
  ])("refuses to dispatch with %s", async (_name, id) => {
    const { browser, button, created } = deployPage();
    created[id].value = "";

    await deployPlannedApp(browser.context, button, "octo/app", {}, "azure");

    expect(browser.net.calls).toHaveLength(0);
    expect(browser.nav.assigned).toHaveLength(0);
  });

  it("refuses to dispatch without a repository", async () => {
    const { browser, button } = deployPage();
    await deployPlannedApp(browser.context, button, "", {}, "azure");
    expect(browser.net.calls).toHaveLength(0);
  });

  it("ignores a missing or already-disabled button", async () => {
    const { browser, button } = deployPage();
    button.disabled = true;

    await deployPlannedApp(browser.context, button, "octo/app", {}, "azure");
    await deployPlannedApp(browser.context, null, "octo/app", {}, "azure");

    expect(browser.net.calls).toHaveLength(0);
  });

  it("restores the button and shows the server's reason when the deploy is refused", async () => {
    const { browser, button } = deployPage();
    browser.net.handle(DEPLOY_PATH, () =>
      jsonResponse({ error: "environment is busy" }, false, 409)
    );

    await deployPlannedApp(browser.context, button, "octo/app", {}, "azure");

    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Deploy Application");
    expect(button.getAttribute("title")).toBe("environment is busy");
    expect(browser.nav.assigned).toHaveLength(0);
  });

  it("restores the button with a generic reason when the response is unreadable", async () => {
    const { browser, button } = deployPage();
    browser.net.handle(DEPLOY_PATH, () => ({
      ok: false,
      status: 500,
      text: () => Promise.resolve(""),
      json: () => Promise.reject(new Error("not json"))
    }));

    await deployPlannedApp(browser.context, button, "octo/app", {}, "azure");

    expect(button.getAttribute("title")).toBe(
      "Could not start the deployment."
    );
  });

  it("restores the button when the request itself fails", async () => {
    const { browser, button } = deployPage();
    browser.net.handle(DEPLOY_PATH, () => Promise.reject(new Error("offline")));

    await deployPlannedApp(browser.context, button, "octo/app", {}, "azure");

    expect(button.disabled).toBe(false);
    expect(button.getAttribute("title")).toBe(
      "Could not start the deployment."
    );
  });

  it.each(["success", "failure"])(
    "ignores a stale deploy %s after its page is torn down",
    async (outcome) => {
      const { browser, button } = deployPage();
      const deployment = createDeferred<HttpResponse>();
      browser.net.handle(DEPLOY_PATH, () => deployment.promise);
      let current = true;
      const pending = deployPlannedApp(
        browser.context,
        button,
        "octo/app",
        {},
        "azure",
        () => current
      );

      current = false;
      if (outcome === "success") {
        deployment.resolve(jsonResponse({ ok: true }));
      } else {
        deployment.reject(new Error("offline"));
      }
      await pending;

      expect(browser.nav.assigned).toHaveLength(0);
      expect(button.disabled).toBe(true);
      expect(button.textContent).toBe("Starting deployment…");
    }
  );
});

describe("deployed pane state", () => {
  function deployedPage() {
    const browser = createFakeBrowser();
    const button = createFakeInput("deployed-delete-btn");
    const hint = createFakeElement("deployed-subtitle-hint");
    browser.document.add(button);
    browser.document.add(hint);
    const created = selects(browser, [
      "deployed-app-select",
      "deployed-env-select"
    ]);
    created["deployed-app-select"].value = "store";
    created["deployed-env-select"].value = "dev";
    return { browser, button, hint, created };
  }

  it("offers environment creation regardless of an unreadable deployment listing", () => {
    const { browser, button, hint } = deployedPage();

    const mode = applyDeployedEnvState(
      browser.context,
      createDeployedState(),
      false,
      false,
      "",
      true
    );

    expect(mode).toBe("create-env");
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Create Environment");
    expect(hint.textContent).toContain("must first create an environment");
  });

  it("fails deployment actions closed when environments are unavailable", () => {
    const { browser, button, hint } = deployedPage();

    const mode = applyDeployedEnvState(
      browser.context,
      createDeployedState(),
      false,
      false,
      "",
      false,
      true
    );

    expect(mode).toBe("deploy");
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toContain(
      "Environments could not be loaded"
    );
    expect(hint.textContent).toContain("temporarily unavailable");
  });

  it("offers a deploy when an environment exists but nothing is deployed", () => {
    const { browser, button, hint } = deployedPage();

    const mode = applyDeployedEnvState(
      browser.context,
      createDeployedState(),
      true,
      false,
      "",
      false,
      false,
      "success"
    );

    expect(mode).toBe("deploy");
    expect(button.className).toBe("rad-btn rad-btn--primary");
    expect(button.disabled).toBe(false);
    expect(hint.innerHTML).toContain("<strong>store</strong>");
  });

  it("blocks a deploy while the deployment state cannot be read", () => {
    const { browser, button } = deployedPage();

    applyDeployedEnvState(
      browser.context,
      createDeployedState(),
      true,
      false,
      "",
      true
    );

    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toContain("could not be loaded");
  });

  it.each([
    ["pending", "Deploying…", "still in progress"],
    ["deleting", "Deleting…", "already being deleted"]
  ])("blocks deletion while the deployment is %s", (status, label, reason) => {
    const { browser, button, hint } = deployedPage();

    const mode = applyDeployedEnvState(
      browser.context,
      createDeployedState(),
      true,
      true,
      status,
      false
    );

    expect(mode).toBe("delete");
    expect(button.textContent).toBe(label);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toContain(reason);
    expect(hint.innerHTML).toContain("Deployments tab");
  });

  it("offers deletion for a settled deployment", () => {
    const { browser, button, hint } = deployedPage();

    applyDeployedEnvState(
      browser.context,
      createDeployedState(),
      true,
      true,
      "succeeded",
      false
    );

    expect(button.textContent).toBe("Delete Deployment");
    expect(button.className).toBe("rad-btn rad-btn--danger-outline");
    expect(button.disabled).toBe(false);
    expect(hint.innerHTML).toContain("Delete Deployment");
  });

  it("blocks deletion when the deployment state cannot be read", () => {
    const { browser, button } = deployedPage();

    applyDeployedEnvState(
      browser.context,
      createDeployedState(),
      true,
      true,
      "succeeded",
      true
    );

    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toContain("could not be loaded");
  });

  it("blocks deletion when no application or environment is selected", () => {
    const { browser, button, created } = deployedPage();
    created["deployed-env-select"].value = "";

    applyDeployedEnvState(
      browser.context,
      createDeployedState(),
      true,
      true,
      "succeeded",
      false
    );

    expect(button.disabled).toBe(true);
  });

  it("records the last known state for later refreshes", () => {
    const { browser } = deployedPage();
    const state = createDeployedState();

    applyDeployedEnvState(browser.context, state, true, true, "", false);

    expect(state).toEqual({ hasEnv: true, hasDeployment: true });
  });

  it.each([
    ["success", true],
    ["pending", false],
    ["failed", false],
    ["", false]
  ])("treats %s as ready=%s", (status, ready) => {
    expect(environmentIsReady(status)).toBe(ready);
  });

  it.each([
    ["success", true],
    ["unknown", true],
    ["", false],
    ["pending", false],
    ["failed", false]
  ])("treats %s as deployable=%s", (status, allowed) => {
    expect(environmentAllowsDeploy(status)).toBe(allowed);
  });

  it.each([
    [
      "pending",
      'Environment "dev" is still being created. Wait for its credential verification to finish before deploying.',
      "is still being created"
    ],
    [
      "failed",
      'Environment "dev" was not created successfully, so it cannot be deployed to. Fix or recreate it first.',
      "was not created successfully"
    ],
    [
      "",
      'The status of environment "dev" could not be determined, so it cannot be deployed to. Refresh to try again.',
      "has an unknown status"
    ]
  ])("explains the environment's %s status", (status, reason, phrase) => {
    expect(environmentNotReadyReason("dev", status)).toBe(reason);
    expect(environmentNotReadyPhrase(status)).toBe(phrase);
  });

  it("gives no reason for a ready environment", () => {
    expect(environmentNotReadyReason("dev", "success")).toBe("");
  });

  it("selects an environment with unknown verification history as a fallback", () => {
    expect(
      firstReadyEnvironmentName([
        { name: "pending", provider: "azure", status: "pending" },
        { name: "legacy", provider: "azure", status: "unknown" }
      ])
    ).toBe("legacy");
  });

  it("leaves every explicitly blocked environment unselected", () => {
    expect(
      firstReadyEnvironmentName([
        { name: "pending", provider: "azure", status: "pending" },
        { name: "failed", provider: "azure", status: "failed" }
      ])
    ).toBe("");
  });

  it("describes an unrecognized blocking status without treating it as pending", () => {
    expect(environmentNotReadyReason("dev", "mystery")).toBe(
      'The status of environment "dev" could not be determined, so it cannot be deployed to. Refresh to try again.'
    );
  });

  it.each([["pending"], ["failed"], [""]])(
    "blocks the deploy while the environment is %s",
    (status) => {
      const { browser, button, hint } = deployedPage();

      const mode = applyDeployedEnvState(
        browser.context,
        createDeployedState(),
        true,
        false,
        "",
        false,
        false,
        status
      );

      expect(mode).toBe("deploy");
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("title")).toBe(
        environmentNotReadyReason("dev", status)
      );
      expect(hint.innerHTML).toContain(
        `The environment (<strong>dev</strong>) ${environmentNotReadyPhrase(status)}, so this application cannot be deployed to it yet.`
      );
    }
  );

  it("allows deploy when verification history is no longer available", () => {
    const { browser, button, hint } = deployedPage();

    const mode = applyDeployedEnvState(
      browser.context,
      createDeployedState(),
      true,
      false,
      "",
      false,
      false,
      "unknown"
    );

    expect(mode).toBe("deploy");
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("title")).toBeNull();
    expect(hint.innerHTML).toContain('click "Deploy Application"');
  });

  it("blocks the deploy when environments could not be loaded at all", () => {
    const { browser, button, hint } = deployedPage();

    const mode = applyDeployedEnvState(
      browser.context,
      createDeployedState(),
      false,
      false,
      "",
      false,
      true,
      "success"
    );

    // An unreadable environment listing cannot prove the environment is
    // missing, so the pane offers a blocked deploy rather than inviting the
    // user to create a duplicate environment.
    expect(mode).toBe("deploy");
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe(
      "Environments could not be loaded. Try again before deploying."
    );
    expect(hint.textContent).toBe(
      " Environments could not be loaded, so deployment actions are temporarily unavailable."
    );
  });

  it("labels environment options by readiness", () => {
    expect(
      environmentOptionLabel({
        name: "dev",
        provider: "azure",
        status: "success"
      })
    ).toBe("dev");
    expect(
      environmentOptionLabel({
        name: "dev",
        provider: "azure",
        status: "failed"
      })
    ).toBe("dev (creation failed)");
    expect(
      environmentOptionLabel({
        name: "dev",
        provider: "azure",
        status: "pending"
      })
    ).toBe("dev (being created…)");
    // A missing status is genuinely unknown, not evidence of an in-flight
    // creation, so it must not claim the environment is being created.
    expect(environmentOptionLabel({ name: "dev", provider: "azure" })).toBe(
      "dev (status unknown)"
    );
    expect(
      environmentOptionLabel({
        name: "dev",
        provider: "azure",
        status: "unknown"
      })
    ).toBe("dev (available)");
    expect(
      environmentOptionLabel({
        name: "dev",
        provider: "azure",
        status: "mystery"
      })
    ).toBe("dev (status unknown)");
  });

  it("escapes selector values in the hint", () => {
    const { browser, hint, created } = deployedPage();
    created["deployed-app-select"].value = '<img src=x onerror="x">';

    applyDeployedEnvState(
      browser.context,
      createDeployedState(),
      true,
      false,
      "",
      false,
      false,
      "success"
    );

    expect(hint.innerHTML).not.toContain("<img");
    expect(hint.innerHTML).toContain("&lt;img");
  });

  it("uses generic hint labels when deployed selectors are absent", () => {
    const browser = createFakeBrowser();
    const hint = createFakeElement("deployed-subtitle-hint");
    browser.document.add(hint);
    applyDeployedEnvState(
      browser.context,
      createDeployedState(),
      true,
      true,
      "success",
      false
    );
    expect(hint.innerHTML).toContain("<strong>this application</strong>");
    expect(hint.innerHTML).toContain(
      "<strong>the selected environment</strong>"
    );
  });

  it("computes deployed mode without optional button or hint markup", () => {
    const browser = createFakeBrowser();
    expect(
      applyDeployedEnvState(
        browser.context,
        createDeployedState(),
        false,
        false,
        "",
        false
      )
    ).toBe("create-env");
  });

  it("dispatches a deployed deploy with the resolved branch", async () => {
    const { browser, button } = deployedPage();
    browser.net.handle(DEPLOY_PATH, () => jsonResponse({ ok: true }));

    await deployDeployedApp(
      browser.context,
      button,
      "octo/app",
      " feature ",
      {},
      "azure"
    );

    expect(JSON.parse(String(browser.net.calls[0].init?.body)).branch).toBe(
      "feature"
    );
    expect(browser.nav.assigned[0]).toContain("page=deploying");
  });

  it("refuses a deployed deploy with no branch", async () => {
    const { browser, button } = deployedPage();

    await deployDeployedApp(browser.context, button, "octo/app", "  ", {}, "");

    expect(browser.net.calls).toHaveLength(0);
  });

  it("ignores a disabled deployed button", async () => {
    const { browser, button } = deployedPage();
    button.disabled = true;

    await deployDeployedApp(
      browser.context,
      button,
      "octo/app",
      "main",
      {},
      ""
    );

    expect(browser.net.calls).toHaveLength(0);
  });
});

describe("modeled pane state", () => {
  function modeledPage() {
    const browser = createFakeBrowser();
    const button = createFakeInput("deploy-app-btn");
    const hint = createFakeElement("modeled-subtitle-hint");
    browser.document.add(button);
    browser.document.add(hint);
    return { browser, button, hint };
  }

  it("switches between planning and environment creation", () => {
    const { browser, button, hint } = modeledPage();

    applyModeledEnvState(browser.context, true);
    expect(button.dataset.mode).toBe("plan");
    expect(button.textContent).toBe("Plan Deployment");
    expect(hint.textContent).toContain("Plan Deployment");

    applyModeledEnvState(browser.context, false);
    expect(button.dataset.mode).toBe("create-env");
    expect(button.disabled).toBe(false);
    expect(hint.textContent).toContain("must first create an environment");
  });

  it("does nothing on a page without the button", () => {
    const browser = createFakeBrowser();
    expect(() => applyModeledEnvState(browser.context, true)).not.toThrow();
  });

  it("routes the primary action to the environment form or the planned graph", () => {
    const { browser, button } = modeledPage();
    const appSelect = createFakeSelect("graph-app");
    appSelect.value = "store";
    browser.document.add(appSelect);

    button.dataset.mode = "create-env";
    modeledPrimaryAction(browser.context, button);
    expect(browser.nav.assigned.at(-1)).toBe("/?page=environment&new=1");

    button.dataset.mode = "plan";
    modeledPrimaryAction(browser.context, button);
    expect(browser.nav.assigned.at(-1)).toBe("/?page=planned&app=store");
  });

  it("navigates without an application when none is selected", () => {
    const { browser, button } = modeledPage();
    button.dataset.mode = "plan";

    modeledPrimaryAction(browser.context, button);

    expect(browser.nav.assigned).toEqual(["/?page=planned"]);
  });

  it("ignores a missing or disabled primary button", () => {
    const { browser, button } = modeledPage();
    button.disabled = true;

    modeledPrimaryAction(browser.context, button);
    modeledPrimaryAction(browser.context, null);

    expect(browser.nav.assigned).toHaveLength(0);
  });

  it("adapts the pane from the environment listing", async () => {
    const { browser, button } = modeledPage();
    browser.net.handle(`${ENVIRONMENTS_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ environments: [{ name: "dev" }] })
    );

    await loadModeledEnvState(browser.context, "octo/app");

    expect(button.dataset.mode).toBe("plan");
  });

  it("fails the pane closed when the listing cannot be read", async () => {
    const { browser, button, hint } = modeledPage();
    browser.net.handle(`${ENVIRONMENTS_PATH}?repo=octo%2Fapp`, () =>
      Promise.reject(new Error("offline"))
    );

    await loadModeledEnvState(browser.context, "octo/app");
    await loadModeledEnvState(browser.context, "");

    expect(button.dataset.mode).toBe("unavailable");
    expect(button.disabled).toBe(true);
    expect(hint.textContent).toContain("temporarily unavailable");
    expect(browser.net.calls).toHaveLength(1);
  });

  it("fails the pane closed when the listing reports an error", async () => {
    const { browser, button, hint } = modeledPage();
    browser.net.handle(`${ENVIRONMENTS_PATH}?repo=octo%2Fapp`, () =>
      jsonResponse({ environments: [], error: "credentials expired" })
    );

    await loadModeledEnvState(browser.context, "octo/app");

    expect(button.dataset.mode).toBe("unavailable");
    expect(button.disabled).toBe(true);
    expect(hint.textContent).toContain("temporarily unavailable");
    expect(browser.logger.errors).toHaveLength(1);
  });

  it.each(["success", "failure"])(
    "ignores a stale modeled environment %s",
    async (outcome) => {
      const { browser, button } = modeledPage();
      button.textContent = "untouched";
      browser.net.handle(`${ENVIRONMENTS_PATH}?repo=octo%2Fapp`, () =>
        outcome === "success" ?
          jsonResponse({ environments: [{ name: "dev" }] })
        : Promise.reject(new Error("offline"))
      );
      await loadModeledEnvState(browser.context, "octo/app", () => false);
      expect(button.textContent).toBe("untouched");
    }
  );

  it("reports a modeled environment failure without optional pane markup", async () => {
    const browser = createFakeBrowser();
    browser.net.handle(`${ENVIRONMENTS_PATH}?repo=octo%2Fapp`, () =>
      Promise.reject(new Error("offline"))
    );
    await loadModeledEnvState(browser.context, "octo/app");
    expect(browser.logger.errors).toHaveLength(1);
  });
});

describe("diff branch selectors", () => {
  function diffPage() {
    const browser = createFakeBrowser();
    const created = selects(browser, ["base-branch", "head-branch"]);
    const status = createFakeElement("diff-status");
    browser.document.add(status);
    return { browser, created, status };
  }

  it("reports a missing repository context", async () => {
    const { browser, status } = diffPage();

    await populateDiffBranches(browser.context, "");

    expect(status.textContent).toBe("No repository context.");
    expect(browser.net.calls).toHaveLength(0);
  });

  it("selects the workspace branch as head and compares automatically", async () => {
    const { browser, created, status } = diffPage();
    browser.net.handle(BRANCHES_PATH, () =>
      jsonResponse({
        branches: [
          { name: "main", sha: "aaaaaaa1" },
          { name: "feature", sha: "worktree" }
        ],
        workspaceBranch: "feature"
      })
    );
    let changes = 0;
    created["head-branch"].addEventListener("change", () => {
      changes += 1;
    });

    await populateDiffBranches(browser.context, "octo/app");

    expect(created["base-branch"].value).toBe("main");
    expect(created["head-branch"].value).toBe("feature");
    expect(status.className).toBe("status info");
    expect(status.textContent).toBe("Comparing main → feature…");
    expect(changes).toBe(1);
    expect(browser.clock.pending).toBe(0);
  });

  it("asks for a head branch when none resolved", async () => {
    const { browser, status } = diffPage();
    browser.net.handle(BRANCHES_PATH, () =>
      jsonResponse({
        branches: [{ name: "main", sha: "aaaaaaa1" }],
        workspaceBranch: ""
      })
    );

    await populateDiffBranches(browser.context, "octo/app");

    expect(status.textContent).toBe(
      "Select a head branch to compare against main."
    );
  });

  it("does not auto-compare when the caller asked not to", async () => {
    const { browser, created } = diffPage();
    browser.net.handle(BRANCHES_PATH, () =>
      jsonResponse({
        branches: [{ name: "main", sha: "aaaaaaa1" }],
        workspaceBranch: "main"
      })
    );
    let changes = 0;
    created["head-branch"].addEventListener("change", () => {
      changes += 1;
    });

    await populateDiffBranches(browser.context, "octo/app", {
      autoCompare: false
    });

    expect(changes).toBe(0);
  });

  it("preserves an error already on screen when repopulating without comparing", async () => {
    const { browser, status } = diffPage();
    status.className = "status error";
    status.textContent = "Error: base and head are the same";
    browser.net.handle(BRANCHES_PATH, () =>
      jsonResponse({
        branches: [{ name: "main", sha: "aaaaaaa1" }],
        workspaceBranch: "main"
      })
    );

    await populateDiffBranches(browser.context, "octo/app", {
      autoCompare: false
    });

    expect(status.textContent).toBe("Error: base and head are the same");
    expect(status.className).toBe("status error");
  });

  it("treats a null status as no error to preserve", async () => {
    const { browser, status } = diffPage();
    status.className = "status error";
    status.textContent = null;
    browser.net.handle(BRANCHES_PATH, () =>
      jsonResponse({
        branches: [{ name: "main", sha: "aaaaaaa1" }],
        workspaceBranch: ""
      })
    );
    await populateDiffBranches(browser.context, "octo/app", {
      autoCompare: false
    });
    expect(status.textContent).toContain("Select a head branch");
  });

  it("shows the listing error", async () => {
    const { browser, status } = diffPage();
    browser.net.handle(BRANCHES_PATH, () =>
      jsonResponse({ error: "no GitHub token" })
    );

    await populateDiffBranches(browser.context, "octo/app");

    expect(status.textContent).toBe("Error: no GitHub token");
    expect(status.className).toBe("status error");
  });

  it("handles a listing error when no status element exists", async () => {
    const browser = createFakeBrowser();
    browser.net.handle(BRANCHES_PATH, () =>
      jsonResponse({ error: "unavailable" })
    );
    await expect(
      populateDiffBranches(browser.context, "octo/app")
    ).resolves.toBeUndefined();
  });

  it("shows a network failure", async () => {
    const { browser, status } = diffPage();
    browser.net.handle(BRANCHES_PATH, () =>
      Promise.reject(new Error("offline"))
    );

    await populateDiffBranches(browser.context, "octo/app");

    expect(status.textContent).toBe(
      "Failed to load branches. Network or backend error."
    );
    expect(browser.clock.pending).toBe(0);
  });

  it("reports a listing that never answers", async () => {
    const { browser, created, status } = diffPage();
    browser.net.handle(BRANCHES_PATH, () => new Promise(() => {}));

    void populateDiffBranches(browser.context, "octo/app");
    await flushPromises();
    browser.clock.tick(DIFF_BRANCH_TIMEOUT_MS);

    expect(status.textContent).toBe(
      "Loading branches is taking longer than expected…"
    );
    expect(status.className).toBe("status error");
    expect(created["base-branch"].innerHTML).toContain("Timeout");
    expect(created["head-branch"].innerHTML).toContain("Timeout");
  });

  it("does not replace a preserved error when its timeout elapses", async () => {
    const { browser, status } = diffPage();
    status.className = "status error";
    status.textContent = "Existing error";
    browser.net.handle(BRANCHES_PATH, () => new Promise(() => {}));
    void populateDiffBranches(browser.context, "octo/app", {
      autoCompare: false
    });
    await flushPromises();
    browser.clock.tick(DIFF_BRANCH_TIMEOUT_MS);
    expect(status.textContent).toBe("Existing error");
  });

  it("cancels the diff timeout and ignores late work after its page lifecycle ends", async () => {
    const { browser, status } = diffPage();
    const listing = createDeferred<ReturnType<typeof jsonResponse>>();
    browser.net.handle(BRANCHES_PATH, () => listing.promise);
    const lifecycle = {
      active: true,
      after: (timeoutMs: number, handler: () => void) =>
        ({
          kind: "timeout",
          handle: browser.clock.setTimeout(handler, timeoutMs)
        }) satisfies ScopeTimer,
      cancel: (timer: ScopeTimer) => browser.clock.clearTimeout(timer.handle)
    };
    const pending = populateDiffBranches(browser.context, "octo/app", {
      lifecycle
    });

    lifecycle.active = false;
    browser.clock.tick(DIFF_BRANCH_TIMEOUT_MS);
    listing.resolve(
      jsonResponse({
        branches: [{ name: "main", sha: "aaaaaaa1" }],
        workspaceBranch: "main"
      })
    );
    await pending;

    expect(status.textContent).toBe("Loading branches…");
    expect(browser.clock.pending).toBe(0);
  });

  it("ignores a late diff request failure after its lifecycle ends", async () => {
    const { browser, status } = diffPage();
    const listing = createDeferred<ReturnType<typeof jsonResponse>>();
    browser.net.handle(BRANCHES_PATH, () => listing.promise);
    const lifecycle = {
      active: true,
      after: (timeoutMs: number, handler: () => void) =>
        ({
          kind: "timeout",
          handle: browser.clock.setTimeout(handler, timeoutMs)
        }) satisfies ScopeTimer,
      cancel: (timer: ScopeTimer) => browser.clock.clearTimeout(timer.handle)
    };
    const pending = populateDiffBranches(browser.context, "octo/app", {
      lifecycle
    });
    lifecycle.active = false;
    listing.reject(new Error("late"));
    await pending;
    expect(status.textContent).toBe("Loading branches…");
  });

  it("handles missing status when no repository context exists", async () => {
    const browser = createFakeBrowser();
    await expect(
      populateDiffBranches(browser.context, "")
    ).resolves.toBeUndefined();
  });

  it("handles a network failure when no status element exists", async () => {
    const browser = createFakeBrowser();
    browser.net.handle(BRANCHES_PATH, () =>
      Promise.reject(new Error("offline"))
    );
    await expect(
      populateDiffBranches(browser.context, "octo/app")
    ).resolves.toBeUndefined();
  });

  it("handles an unselected head when the status element is absent", async () => {
    const browser = createFakeBrowser();
    selects(browser, ["base-branch", "head-branch"]);
    browser.net.handle(BRANCHES_PATH, () =>
      jsonResponse({
        branches: [{ name: "main", sha: "aaaaaaa1" }],
        workspaceBranch: ""
      })
    );
    await populateDiffBranches(browser.context, "octo/app");
    expect(browser.net.calls).toHaveLength(1);
  });

  it("times out safely when the diff selectors are absent", async () => {
    const browser = createFakeBrowser();
    const status = createFakeElement("diff-status");
    browser.document.add(status);
    browser.net.handle(BRANCHES_PATH, () => new Promise(() => {}));
    void populateDiffBranches(browser.context, "octo/app");
    await flushPromises();
    browser.clock.tick(DIFF_BRANCH_TIMEOUT_MS);
    expect(status.className).toBe("status error");
  });

  it("leaves a settled status alone when the timeout fires late", async () => {
    const { browser, status } = diffPage();
    browser.net.handle(BRANCHES_PATH, () =>
      jsonResponse({ branches: [], workspaceBranch: "" })
    );

    await populateDiffBranches(browser.context, "octo/app");
    browser.clock.tick(DIFF_BRANCH_TIMEOUT_MS);

    expect(status.textContent).not.toContain("longer than expected");
  });

  it("does nothing when the page has no diff selectors", async () => {
    const browser = createFakeBrowser();
    browser.net.handle(BRANCHES_PATH, () =>
      jsonResponse({ branches: [{ name: "main", sha: "aaaaaaa1" }] })
    );

    await populateDiffBranches(browser.context, "octo/app");

    expect(browser.net.calls).toHaveLength(1);
  });

  it("keeps a base selection that the listing still offers", async () => {
    const { browser, created } = diffPage();
    browser.net.handle(BRANCHES_PATH, () =>
      jsonResponse({
        branches: [
          { name: "main", sha: "aaaaaaa1" },
          { name: "release", sha: "bbbbbbb2" }
        ],
        workspaceBranch: "release"
      })
    );

    await populateDiffBranches(browser.context, "octo/app", {
      preferBase: "release",
      preferHead: "main"
    });

    expect(created["base-branch"].value).toBe("release");
    expect(created["head-branch"].value).toBe("main");
    expect(selectedOption(created["base-branch"].innerHTML)).toBe("release");
  });
});
