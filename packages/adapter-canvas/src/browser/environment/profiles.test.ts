import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_PROFILES_ENDPOINT,
  GITHUB_ACCOUNT_ENDPOINT,
  GITHUB_IDENTITY_ENDPOINT,
  GITHUB_IDENTITY_IDS,
  PROFILE_MENU_IDS,
  PROFILE_PLACEHOLDER_TEXT,
  findProfile,
  githubAccountLabel,
  githubIdentityNote,
  initializeCredentialProfilesPanel,
  parseCredentialProfiles,
  parseGithubIdentity,
  profileDetailSpecs,
  providerLabel
} from "./profiles.js";
import type {
  CredentialProfile,
  CredentialProfilesPanelDeps,
  GithubAccountSummary,
  GithubIdentity
} from "./profiles.js";
import {
  createFakeBrowser,
  createFakeElement,
  createFakeInput,
  fakeText,
  fakeTree,
  flushPromises,
  jsonResponse
} from "../../../test/support/browser/fakes.js";
import type { FakeBrowser } from "../../../test/support/browser/fakes.js";
import type { HttpResponse } from "../ports.js";

const HOSTILE = "<img src=x onerror=alert(1)>'\"&";

function textOf(specs: ReturnType<typeof profileDetailSpecs>): string {
  return specs
    .map(
      (spec) =>
        spec.text ?? (spec.children ?? []).map((c) => c.text ?? "").join("")
    )
    .join("|");
}

interface ProfilesPage {
  browser: FakeBrowser;
  button: ReturnType<typeof createFakeElement>;
  menu: ReturnType<typeof createFakeElement>;
  valueEl: ReturnType<typeof createFakeElement>;
  optionsEl: ReturnType<typeof createFakeElement>;
  emptyEl: ReturnType<typeof createFakeElement>;
  hiddenInput: ReturnType<typeof createFakeInput>;
  statusEl: ReturnType<typeof createFakeElement>;
  providerInput: ReturnType<typeof createFakeInput>;
  identityAzureEl: ReturnType<typeof createFakeElement>;
  identityAwsEl: ReturnType<typeof createFakeElement>;
  panelAzureEl: ReturnType<typeof createFakeElement>;
  panelAwsEl: ReturnType<typeof createFakeElement>;
  deployBtn: ReturnType<typeof createFakeInput>;
  azureRefreshBtn: ReturnType<typeof createFakeInput>;
  awsRefreshBtn: ReturnType<typeof createFakeInput>;
  fieldEl: ReturnType<typeof createFakeElement>;
  ghButton: ReturnType<typeof createFakeElement>;
  ghMenu: ReturnType<typeof createFakeElement>;
  ghValueEl: ReturnType<typeof createFakeElement>;
  ghOptionsEl: ReturnType<typeof createFakeElement>;
  ghEmptyEl: ReturnType<typeof createFakeElement>;
  noteEl: ReturnType<typeof createFakeElement>;
  recheckBtn: ReturnType<typeof createFakeInput>;
}

function renderProfilesPage(): ProfilesPage {
  const browser = createFakeBrowser();
  const button = createFakeElement(PROFILE_MENU_IDS.button);
  const menu = createFakeElement(PROFILE_MENU_IDS.menu);
  menu.style.display = "none";
  const valueEl = createFakeElement(PROFILE_MENU_IDS.value);
  const optionsEl = createFakeElement(PROFILE_MENU_IDS.options);
  const emptyEl = createFakeElement(PROFILE_MENU_IDS.empty);
  const hiddenInput = createFakeInput(PROFILE_MENU_IDS.select);
  const statusEl = createFakeElement(PROFILE_MENU_IDS.status);
  const providerInput = createFakeInput("env-selected-provider");
  const identityAzureEl = createFakeElement("env-identity-azure");
  const identityAwsEl = createFakeElement("env-identity-aws");
  const panelAzureEl = createFakeElement("panel-azure");
  const panelAwsEl = createFakeElement("panel-aws");
  const deployBtn = createFakeInput("deploy-btn");
  const azureRefreshBtn = createFakeInput("azure-refresh-btn");
  const awsRefreshBtn = createFakeInput("aws-refresh-btn");

  const fieldEl = createFakeElement(GITHUB_IDENTITY_IDS.field);
  const ghButton = createFakeElement(GITHUB_IDENTITY_IDS.button);
  const ghMenu = createFakeElement(GITHUB_IDENTITY_IDS.menu);
  ghMenu.style.display = "none";
  const ghValueEl = createFakeElement(GITHUB_IDENTITY_IDS.value);
  const ghOptionsEl = createFakeElement(GITHUB_IDENTITY_IDS.options);
  const ghEmptyEl = createFakeElement(GITHUB_IDENTITY_IDS.empty);
  const noteEl = createFakeElement(GITHUB_IDENTITY_IDS.note);
  const recheckBtn = createFakeInput(GITHUB_IDENTITY_IDS.recheck);

  for (const element of [
    button,
    menu,
    valueEl,
    optionsEl,
    emptyEl,
    hiddenInput,
    statusEl,
    providerInput,
    identityAzureEl,
    identityAwsEl,
    panelAzureEl,
    panelAwsEl,
    deployBtn,
    azureRefreshBtn,
    awsRefreshBtn,
    fieldEl,
    ghButton,
    ghMenu,
    ghValueEl,
    ghOptionsEl,
    ghEmptyEl,
    noteEl,
    recheckBtn
  ]) {
    browser.document.add(element);
  }

  return {
    browser,
    button,
    menu,
    valueEl,
    optionsEl,
    emptyEl,
    hiddenInput,
    statusEl,
    providerInput,
    identityAzureEl,
    identityAwsEl,
    panelAzureEl,
    panelAwsEl,
    deployBtn,
    azureRefreshBtn,
    awsRefreshBtn,
    fieldEl,
    ghButton,
    ghMenu,
    ghValueEl,
    ghOptionsEl,
    ghEmptyEl,
    noteEl,
    recheckBtn
  };
}

function makeDeps(overrides: Partial<CredentialProfilesPanelDeps> = {}): {
  deps: CredentialProfilesPanelDeps;
  profileChanges: Array<CredentialProfile | null>;
  discoverCalls: Array<{
    provider: string;
    subscriptionId: string;
    tenantId: string;
  }>;
} {
  const profileChanges: Array<CredentialProfile | null> = [];
  const discoverCalls: Array<{
    provider: string;
    subscriptionId: string;
    tenantId: string;
  }> = [];
  const deps: CredentialProfilesPanelDeps = {
    repo: "octo/cat",
    onProfileChange: (profile) => profileChanges.push(profile),
    discoverResources: (provider, subscriptionId, tenantId) =>
      discoverCalls.push({ provider, subscriptionId, tenantId }),
    ...overrides
  };
  return { deps, profileChanges, discoverCalls };
}

const AZURE_PROFILE: CredentialProfile = {
  name: "azure-prod",
  provider: "azure",
  subscriptionId: "sub-1",
  subscriptionName: "Prod Subscription",
  tenantId: "tenant-1",
  user: "alice@example.com"
};

const AWS_PROFILE: CredentialProfile = {
  name: "aws-prod",
  provider: "aws",
  accountId: "123456789012",
  region: "us-east-1"
};

function profilesResponse(profiles: readonly CredentialProfile[]) {
  return jsonResponse({ profiles });
}

describe("parseCredentialProfiles", () => {
  it("parses well-formed profile entries and drops malformed ones", () => {
    const parsed = parseCredentialProfiles({
      profiles: [
        {
          name: "azure-prod",
          provider: "azure",
          subscriptionId: "sub-1",
          subscriptionName: "Prod",
          tenantId: "tenant-1",
          user: "alice"
        },
        { name: "", provider: "azure" },
        "not-an-object",
        { provider: "aws" },
        null
      ]
    });
    expect(parsed).toEqual([
      {
        name: "azure-prod",
        provider: "azure",
        subscriptionId: "sub-1",
        subscriptionName: "Prod",
        tenantId: "tenant-1",
        accountId: undefined,
        region: undefined,
        roleArn: undefined,
        user: "alice"
      }
    ]);
  });

  it("treats a non-array/missing profiles payload as empty", () => {
    expect(parseCredentialProfiles(null)).toEqual([]);
    expect(parseCredentialProfiles({})).toEqual([]);
    expect(parseCredentialProfiles({ profiles: "nope" })).toEqual([]);
  });

  it("coerces non-string optional fields to undefined instead of throwing", () => {
    const parsed = parseCredentialProfiles({
      profiles: [{ name: "p", provider: "azure", region: 42, user: true }]
    });
    expect(parsed[0].region).toBeUndefined();
    expect(parsed[0].user).toBeUndefined();
  });
});

describe("parseGithubIdentity", () => {
  it("parses a full identity payload including nested accounts", () => {
    const identity = parseGithubIdentity({
      error: "",
      actingLogin: "alice",
      displayLogin: "alice",
      mismatch: false,
      repoAccess: "",
      actingHasWorkflow: true,
      actingHasPackages: true,
      accounts: [
        {
          login: "alice",
          hasWorkflow: true,
          hasPackages: true,
          switchable: true
        },
        { login: "", hasWorkflow: true, hasPackages: true, switchable: true },
        "not-an-object"
      ]
    });
    expect(identity.accounts).toEqual([
      { login: "alice", hasWorkflow: true, hasPackages: true, switchable: true }
    ]);
  });

  it("defaults every field for a malformed payload", () => {
    const identity = parseGithubIdentity(null);
    expect(identity).toEqual({
      error: "",
      actingLogin: "",
      displayLogin: "",
      mismatch: false,
      repoAccess: "",
      actingHasWorkflow: false,
      actingHasPackages: false,
      accounts: []
    });
  });
});

describe("findProfile", () => {
  const profiles = [AZURE_PROFILE, AWS_PROFILE];
  it("finds a profile by exact name", () => {
    expect(findProfile(profiles, "aws-prod")).toBe(AWS_PROFILE);
  });
  it("returns null when no profile matches", () => {
    expect(findProfile(profiles, "missing")).toBeNull();
    expect(findProfile(profiles, "")).toBeNull();
  });
});

describe("providerLabel", () => {
  it.each([
    ["aws", "AWS"],
    ["azure", "Azure"],
    ["gcp", "gcp"],
    ["", "—"],
    [undefined, "—"]
  ])("labels %s as %s", (input, expected) => {
    expect(providerLabel(input)).toBe(expected);
  });
});

describe("githubAccountLabel", () => {
  const base: GithubAccountSummary = {
    login: "bob",
    hasWorkflow: true,
    hasPackages: true,
    switchable: true
  };

  it("marks the active account with a checkmark", () => {
    expect(githubAccountLabel(base, "bob")).toBe("@bob ✓");
  });

  it("lists every missing scope", () => {
    expect(
      githubAccountLabel(
        { ...base, hasWorkflow: false, hasPackages: false },
        "someone-else"
      )
    ).toBe("@bob — missing workflow + packages scopes");
  });

  it("lists a single missing scope without the plural", () => {
    expect(
      githubAccountLabel({ ...base, hasPackages: false }, "someone-else")
    ).toBe("@bob — missing packages scope");
  });

  it("marks a non-switchable account instead of a checkmark", () => {
    expect(githubAccountLabel({ ...base, switchable: false }, "bob")).toBe(
      "@bob (not switchable)"
    );
  });

  it("shows a plain label for an inactive, switchable, fully-scoped account", () => {
    expect(githubAccountLabel(base, "someone-else")).toBe("@bob");
  });
});

describe("githubIdentityNote", () => {
  const base: GithubIdentity = {
    error: "",
    actingLogin: "alice",
    displayLogin: "alice",
    mismatch: false,
    repoAccess: "",
    actingHasWorkflow: true,
    actingHasPackages: true,
    accounts: []
  };

  it("prioritizes a repo-access problem above every other note", () => {
    const note = githubIdentityNote({
      ...base,
      repoAccess: "alice cannot push to this repo",
      mismatch: true,
      displayLogin: "carol",
      actingHasWorkflow: false
    });
    expect(note.tone).toBe("warning");
    expect(note.showRecheck).toBe(true);
    expect(note.specs).toEqual([
      { tag: "span", text: "alice cannot push to this repo" }
    ]);
  });

  it("reports an account mismatch without offering a recheck", () => {
    const note = githubIdentityNote({
      ...base,
      mismatch: true,
      displayLogin: "carol"
    });
    expect(note.tone).toBe("warning");
    expect(note.showRecheck).toBe(false);
    expect(note.specs[0].text).toContain(
      "The app shows @carol but setup will act as @alice"
    );
  });

  it("ignores a mismatch flag when the display login is blank", () => {
    const note = githubIdentityNote({
      ...base,
      mismatch: true,
      displayLogin: ""
    });
    expect(note.specs[0].text).toContain("Acts as");
  });

  it("reports missing workflow and packages scopes together with a recheck", () => {
    const note = githubIdentityNote({
      ...base,
      actingHasWorkflow: false,
      actingHasPackages: false
    });
    expect(note.showRecheck).toBe(true);
    expect(note.specs[0].text).toContain(
      "missing the workflow and write:packages"
    );
    expect(note.specs[0].text).toContain(
      "gh auth switch -h github.com -u alice"
    );
    expect(note.specs[0].text).toContain(
      "-s workflow -s read:packages -s write:packages"
    );
  });

  it("reports a single missing scope without the plural", () => {
    const note = githubIdentityNote({ ...base, actingHasPackages: false });
    expect(note.specs[0].text).toContain("missing the write:packages scope ");
    expect(note.specs[0].text).not.toContain("scopes ");
  });

  it("falls back to the muted acts-as note, rendering the login as a text node only", () => {
    const note = githubIdentityNote({ ...base, actingLogin: HOSTILE });
    expect(note.tone).toBe("muted");
    expect(note.showRecheck).toBe(false);
    const strong = note.specs.find((spec) => spec.tag === "strong");
    expect(strong?.text).toBe(`@${HOSTILE}`);
    for (const spec of note.specs) {
      expect(spec.tag).not.toBe("script");
    }
    expect(textOf(note.specs as never)).toContain(HOSTILE);
  });
});

describe("profileDetailSpecs", () => {
  it("describes an AWS profile with account and region", () => {
    const specs = profileDetailSpecs(AWS_PROFILE, "aws");
    expect(textOf(specs)).toContain("GitHub Actions assumes the IAM role");
    expect(textOf(specs)).toContain("123456789012 · us-east-1");
  });

  it("omits the AWS account line when both fields are blank", () => {
    const specs = profileDetailSpecs(
      { ...AWS_PROFILE, accountId: undefined, region: undefined },
      "aws"
    );
    expect(specs).toHaveLength(2); // intro + verified, no account line
  });

  it("describes an Azure profile with its subscription name", () => {
    const specs = profileDetailSpecs(AZURE_PROFILE, "azure");
    expect(textOf(specs)).toContain("Creates the Entra app");
    expect(textOf(specs)).toContain("Prod Subscription");
  });

  it("falls back to the subscription id when no name is present", () => {
    const specs = profileDetailSpecs(
      {
        ...AZURE_PROFILE,
        subscriptionName: undefined,
        subscriptionId: "sub-only"
      },
      "azure"
    );
    expect(textOf(specs)).toContain("sub-only");
  });

  it("omits the subscription line entirely when both are blank", () => {
    const specs = profileDetailSpecs(
      {
        ...AZURE_PROFILE,
        subscriptionName: undefined,
        subscriptionId: undefined
      },
      "azure"
    );
    expect(specs).toHaveLength(2);
  });

  it("shows the signed-in user as a hostile-safe text node", () => {
    const specs = profileDetailSpecs(
      { ...AZURE_PROFILE, user: HOSTILE },
      "azure"
    );
    const userLine = specs.at(-1);
    const strong = userLine?.children?.find((c) => c.tag === "strong");
    expect(strong?.text).toBe(HOSTILE);
  });

  it("shows a bare verified line when there is no user", () => {
    const specs = profileDetailSpecs(
      { ...AZURE_PROFILE, user: undefined },
      "azure"
    );
    expect(textOf(specs)).toContain("✓ Verified");
  });
});

describe("initializeCredentialProfilesPanel gating", () => {
  it("returns null when the required combo markup is missing", () => {
    const browser = createFakeBrowser();
    const { deps } = makeDeps();
    expect(initializeCredentialProfilesPanel(browser.context, deps)).toBeNull();
  });

  it("returns null when the hidden profile input is not a real input", () => {
    const page = renderProfilesPage();
    // Replace the pre-registered hidden input with a non-input stand-in.
    const nonInput = createFakeElement(PROFILE_MENU_IDS.select);
    page.browser.document.add(nonInput);
    const { deps } = makeDeps();
    expect(
      initializeCredentialProfilesPanel(page.browser.context, deps)
    ).toBeNull();
  });

  it("is idempotent: a second init before teardown returns null, and reinit works after teardown", () => {
    const page = renderProfilesPage();
    const { deps } = makeDeps();
    const first = initializeCredentialProfilesPanel(page.browser.context, deps);
    expect(first).not.toBeNull();
    expect(
      initializeCredentialProfilesPanel(page.browser.context, deps)
    ).toBeNull();

    first?.teardown();
    const second = initializeCredentialProfilesPanel(
      page.browser.context,
      deps
    );
    expect(second).not.toBeNull();
  });

  it("teardown removes every installed listener", () => {
    const page = renderProfilesPage();
    const { deps } = makeDeps();
    const handle = initializeCredentialProfilesPanel(
      page.browser.context,
      deps
    );
    handle?.teardown();

    expect(page.button.listenerCount()).toBe(0);
    expect(page.browser.document.listenerCount()).toBe(0);
    expect(page.ghButton.listenerCount()).toBe(0);
    expect(page.recheckBtn.listenerCount()).toBe(0);
    expect(page.azureRefreshBtn.listenerCount()).toBe(0);
    expect(page.awsRefreshBtn.listenerCount()).toBe(0);
    expect(page.browser.page.listenerCount()).toBe(0);
  });
  it("works without the optional GitHub account, recheck, and refresh markup", async () => {
    const browser = createFakeBrowser();
    const button = createFakeElement(PROFILE_MENU_IDS.button);
    const menu = createFakeElement(PROFILE_MENU_IDS.menu);
    const valueEl = createFakeElement(PROFILE_MENU_IDS.value);
    const optionsEl = createFakeElement(PROFILE_MENU_IDS.options);
    const hiddenInput = createFakeInput(PROFILE_MENU_IDS.select);
    for (const element of [button, menu, valueEl, optionsEl, hiddenInput]) {
      browser.document.add(element);
    }
    const { deps } = makeDeps();

    const handle = initializeCredentialProfilesPanel(browser.context, deps);
    expect(handle).not.toBeNull();
    expect(() => button.dispatch("click", { target: button })).not.toThrow();
    expect(() => browser.page.dispatch("focus")).not.toThrow();
    expect(() => handle?.teardown()).not.toThrow();
  });
});

describe("credential profile combo menu", () => {
  it("toggles open on button click and closes on an outside click", () => {
    const page = renderProfilesPage();
    const { deps } = makeDeps();
    initializeCredentialProfilesPanel(page.browser.context, deps);

    page.button.dispatch("click", { target: page.button });
    expect(page.menu.style.display).toBe("");
    expect(page.button.getAttribute("aria-expanded")).toBe("true");

    page.browser.document.dispatch("click", {
      target: page.browser.document.body
    });
    expect(page.menu.style.display).toBe("none");
    expect(page.button.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not close the profile menu for a click inside its combo", () => {
    const page = renderProfilesPage();
    const { deps } = makeDeps();
    initializeCredentialProfilesPanel(page.browser.context, deps);
    page.button.dispatch("click", { target: page.button });
    page.button.matches.set(`#${PROFILE_MENU_IDS.combo}`, [page.button]);
    page.button.ancestors.set(`#${PROFILE_MENU_IDS.combo}`, page.button);

    page.browser.document.dispatch("click", { target: page.button });
    expect(page.menu.style.display).toBe("");
  });

  it("toggles the GitHub account menu and closes it on an outside click", () => {
    const page = renderProfilesPage();
    const { deps } = makeDeps();
    initializeCredentialProfilesPanel(page.browser.context, deps);

    page.ghButton.dispatch("click", { target: page.ghButton });
    expect(page.ghMenu.style.display).toBe("");
    expect(page.ghButton.getAttribute("aria-expanded")).toBe("true");

    page.browser.document.dispatch("click", {
      target: page.browser.document.body
    });
    expect(page.ghMenu.style.display).toBe("none");
  });

  it("does not close the GitHub account menu for a click inside its combo", () => {
    const page = renderProfilesPage();
    const { deps } = makeDeps();
    initializeCredentialProfilesPanel(page.browser.context, deps);
    page.ghButton.dispatch("click", { target: page.ghButton });
    page.ghButton.matches.set(`#${GITHUB_IDENTITY_IDS.combo}`, [page.ghButton]);
    page.ghButton.ancestors.set(`#${GITHUB_IDENTITY_IDS.combo}`, page.ghButton);

    page.browser.document.dispatch("click", { target: page.ghButton });
    expect(page.ghMenu.style.display).toBe("");
  });
});

describe("loadProfiles", () => {
  it("populates the combo and preselects a matching profile", async () => {
    const page = renderProfilesPage();
    page.browser.net.handle(
      `${CREDENTIAL_PROFILES_ENDPOINT}?repo=${encodeURIComponent("octo/cat")}`,
      () => profilesResponse([AZURE_PROFILE, AWS_PROFILE])
    );
    const { deps, profileChanges, discoverCalls } = makeDeps();
    const handle = initializeCredentialProfilesPanel(
      page.browser.context,
      deps
    );

    await handle?.loadProfiles("aws-prod");

    expect(page.hiddenInput.value).toBe("aws-prod");
    expect(page.valueEl.textContent).toBe("aws-prod (AWS)");
    expect(page.emptyEl.style.display).toBe("none");
    expect(page.optionsEl.children).toHaveLength(2);
    expect(profileChanges.at(-1)).toEqual(AWS_PROFILE);
    expect(discoverCalls.at(-1)).toEqual({
      provider: "aws",
      subscriptionId: "",
      tenantId: ""
    });
    expect(page.statusEl.style.display).toBe("");
    expect(page.deployBtn.disabled).toBe(false);
    expect(page.awsRefreshBtn.disabled).toBe(false);
    expect(page.identityAwsEl.style.display).toBe("");
    expect(page.identityAzureEl.style.display).toBe("none");
  });

  it("falls back to the placeholder when the preselected name is not found", async () => {
    const page = renderProfilesPage();
    page.browser.net.handle(
      `${CREDENTIAL_PROFILES_ENDPOINT}?repo=${encodeURIComponent("octo/cat")}`,
      () => profilesResponse([AZURE_PROFILE])
    );
    const { deps } = makeDeps();
    const handle = initializeCredentialProfilesPanel(
      page.browser.context,
      deps
    );

    await handle?.loadProfiles("does-not-exist");

    expect(page.hiddenInput.value).toBe("");
    expect(page.valueEl.textContent).toBe(PROFILE_PLACEHOLDER_TEXT);
    expect(page.statusEl.style.display).toBe("none");
    expect(page.deployBtn.disabled).toBe(true);
  });

  it("treats a malformed payload as an empty profile list", async () => {
    const page = renderProfilesPage();
    page.browser.net.handle(
      `${CREDENTIAL_PROFILES_ENDPOINT}?repo=${encodeURIComponent("octo/cat")}`,
      () => jsonResponse({ profiles: "not-an-array" })
    );
    const { deps } = makeDeps();
    const handle = initializeCredentialProfilesPanel(
      page.browser.context,
      deps
    );

    await handle?.loadProfiles();

    expect(page.optionsEl.children).toHaveLength(0);
    expect(page.emptyEl.style.display).toBe("");
  });

  it("clears profiles on a network error", async () => {
    const page = renderProfilesPage();
    page.browser.net.handle(
      `${CREDENTIAL_PROFILES_ENDPOINT}?repo=${encodeURIComponent("octo/cat")}`,
      () => Promise.reject(new Error("boom"))
    );
    const { deps } = makeDeps();
    const handle = initializeCredentialProfilesPanel(
      page.browser.context,
      deps
    );

    await handle?.loadProfiles();

    expect(page.optionsEl.children).toHaveLength(0);
    expect(page.valueEl.textContent).toBe(PROFILE_PLACEHOLDER_TEXT);
  });

  it("ignores a stale response when a newer loadProfiles call has since started", async () => {
    const page = renderProfilesPage();
    let resolveFirst: (value: HttpResponse) => void = () => {};
    const first = new Promise<HttpResponse>((resolve) => {
      resolveFirst = resolve;
    });
    let callCount = 0;
    page.browser.net.handle(
      `${CREDENTIAL_PROFILES_ENDPOINT}?repo=${encodeURIComponent("octo/cat")}`,
      () => {
        callCount += 1;
        return callCount === 1 ? first : profilesResponse([AWS_PROFILE]);
      }
    );
    const { deps } = makeDeps();
    const handle = initializeCredentialProfilesPanel(
      page.browser.context,
      deps
    );

    const firstLoad = handle?.loadProfiles("azure-prod");
    const secondLoad = handle?.loadProfiles("aws-prod");
    await secondLoad;
    resolveFirst(profilesResponse([AZURE_PROFILE]));
    await firstLoad;
    await flushPromises();

    // The stale first response must not have overwritten the second's result.
    expect(page.hiddenInput.value).toBe("aws-prod");
    expect(page.optionsEl.children).toHaveLength(1);
  });

  it("drops a stale response from teardown between requests", async () => {
    const page = renderProfilesPage();
    page.browser.net.handle(
      `${CREDENTIAL_PROFILES_ENDPOINT}?repo=${encodeURIComponent("octo/cat")}`,
      () => profilesResponse([AZURE_PROFILE])
    );
    const { deps } = makeDeps();
    const handle = initializeCredentialProfilesPanel(
      page.browser.context,
      deps
    );
    const pending = handle?.loadProfiles();
    handle?.teardown();
    await expect(pending).resolves.toBeUndefined();
    expect(page.optionsEl.children).toHaveLength(0);
  });

  it("ignores a stale rejected response superseded by a newer successful call", async () => {
    const page = renderProfilesPage();
    let rejectFirst: (reason: Error) => void = () => {};
    const first = new Promise<HttpResponse>((_resolve, reject) => {
      rejectFirst = reject;
    });
    let callCount = 0;
    page.browser.net.handle(
      `${CREDENTIAL_PROFILES_ENDPOINT}?repo=${encodeURIComponent("octo/cat")}`,
      () => {
        callCount += 1;
        return callCount === 1 ? first : profilesResponse([AWS_PROFILE]);
      }
    );
    const { deps } = makeDeps();
    const handle = initializeCredentialProfilesPanel(
      page.browser.context,
      deps
    );

    const firstLoad = handle?.loadProfiles("azure-prod");
    const secondLoad = handle?.loadProfiles("aws-prod");
    await secondLoad;
    rejectFirst(new Error("stale failure"));
    await firstLoad;
    await flushPromises();

    // The stale rejected first request must not clear the second's successful result.
    expect(page.hiddenInput.value).toBe("aws-prod");
    expect(page.optionsEl.children).toHaveLength(1);
  });

  it("drops a stale rejected response after teardown", async () => {
    const page = renderProfilesPage();
    page.browser.net.handle(
      `${CREDENTIAL_PROFILES_ENDPOINT}?repo=${encodeURIComponent("octo/cat")}`,
      () => Promise.reject(new Error("boom"))
    );
    const { deps } = makeDeps();
    const handle = initializeCredentialProfilesPanel(
      page.browser.context,
      deps
    );
    const pending = handle?.loadProfiles();
    handle?.teardown();
    await expect(pending).resolves.toBeUndefined();
    expect(page.optionsEl.children).toHaveLength(0);
  });
});

describe("profile selection", () => {
  async function loadAndSelect(
    page: ProfilesPage,
    deps: CredentialProfilesPanelDeps
  ) {
    page.browser.net.handle(
      `${CREDENTIAL_PROFILES_ENDPOINT}?repo=${encodeURIComponent("octo/cat")}`,
      () => profilesResponse([AZURE_PROFILE, AWS_PROFILE])
    );
    const handle = initializeCredentialProfilesPanel(
      page.browser.context,
      deps
    );
    await handle?.loadProfiles();
    return handle;
  }

  it("selects and deselects profiles without any optional status, panel, deploy, or refresh markup", async () => {
    const browser = createFakeBrowser();
    const button = createFakeElement(PROFILE_MENU_IDS.button);
    const menu = createFakeElement(PROFILE_MENU_IDS.menu);
    const valueEl = createFakeElement(PROFILE_MENU_IDS.value);
    const optionsEl = createFakeElement(PROFILE_MENU_IDS.options);
    const hiddenInput = createFakeInput(PROFILE_MENU_IDS.select);
    for (const element of [button, menu, valueEl, optionsEl, hiddenInput]) {
      browser.document.add(element);
    }
    browser.net.handle(
      `${CREDENTIAL_PROFILES_ENDPOINT}?repo=${encodeURIComponent("octo/cat")}`,
      () => profilesResponse([AZURE_PROFILE, AWS_PROFILE])
    );
    const { deps, profileChanges, discoverCalls } = makeDeps();
    const handle = initializeCredentialProfilesPanel(browser.context, deps);

    // Initial load with no matching preselect takes the "!selectedProfile" deselect path.
    await expect(
      handle?.loadProfiles("does-not-exist")
    ).resolves.toBeUndefined();
    expect(hiddenInput.value).toBe("");
    expect(profileChanges).toEqual([null]);

    // Selecting each rendered option exercises the azure and aws selection branches.
    for (const optionButton of optionsEl.children) {
      expect(() => optionButton.dispatch("click")).not.toThrow();
    }
    expect(discoverCalls.length).toBe(2);
    expect(discoverCalls[0]?.provider).toBe("azure");
    expect(discoverCalls[1]?.provider).toBe("aws");
  });

  it("selects a profile from the rendered option list and closes the menu", async () => {
    const page = renderProfilesPage();
    const { deps, profileChanges, discoverCalls } = makeDeps();
    await loadAndSelect(page, deps);
    page.button.dispatch("click", { target: page.button });

    const azureOption = page.optionsEl.children.find(
      (child) => child.getAttribute("data-name") === "azure-prod"
    );
    azureOption?.dispatch("click");

    expect(page.hiddenInput.value).toBe("azure-prod");
    expect(page.menu.style.display).toBe("none");
    expect(profileChanges.at(-1)).toEqual(AZURE_PROFILE);
    expect(discoverCalls.at(-1)).toEqual({
      provider: "azure",
      subscriptionId: "sub-1",
      tenantId: "tenant-1"
    });
    expect(page.providerInput.value).toBe("azure");
    expect(page.panelAzureEl.style.display).toBe("");
    expect(page.panelAwsEl.style.display).toBe("none");
  });

  it("invokes the injected discoverResources again from the refresh buttons", async () => {
    const page = renderProfilesPage();
    const { deps, discoverCalls } = makeDeps();
    await loadAndSelect(page, deps);
    const azureOption = page.optionsEl.children.find(
      (child) => child.getAttribute("data-name") === "azure-prod"
    );
    azureOption?.dispatch("click");
    discoverCalls.splice(0);

    page.azureRefreshBtn.dispatch("click");
    expect(discoverCalls).toEqual([
      { provider: "azure", subscriptionId: "sub-1", tenantId: "tenant-1" }
    ]);

    page.awsRefreshBtn.dispatch("click");
    // Selected profile is azure, so the AWS refresh button re-discovers azure too:
    // both buttons call discoverResources using the *currently selected* profile.
    expect(discoverCalls).toHaveLength(2);
  });

  it("re-discovers with the aws provider once an aws profile is selected", async () => {
    const page = renderProfilesPage();
    const { deps, discoverCalls } = makeDeps();
    await loadAndSelect(page, deps);
    const awsOption = page.optionsEl.children.find(
      (child) => child.getAttribute("data-name") === "aws-prod"
    );
    awsOption?.dispatch("click");
    discoverCalls.splice(0);

    page.awsRefreshBtn.dispatch("click");
    expect(discoverCalls).toEqual([
      { provider: "aws", subscriptionId: "", tenantId: "" }
    ]);
  });

  it("does nothing from a refresh button when no profile is selected", async () => {
    const page = renderProfilesPage();
    const { deps, discoverCalls } = makeDeps();
    await loadAndSelect(page, deps);

    page.azureRefreshBtn.dispatch("click");
    expect(discoverCalls).toEqual([]);
  });
});

describe("github identity loading and rendering", () => {
  function setupIdentity(
    page: ProfilesPage,
    deps: CredentialProfilesPanelDeps
  ) {
    return initializeCredentialProfilesPanel(page.browser.context, deps);
  }

  const IDENTITY_URL = (fresh = false) =>
    `${GITHUB_IDENTITY_ENDPOINT}?repo=${encodeURIComponent("octo/cat")}${fresh ? "&fresh=1" : ""}`;

  it("works when the value, note, and recheck elements are absent from the page", async () => {
    const browser = createFakeBrowser();
    const button = createFakeElement(PROFILE_MENU_IDS.button);
    const menu = createFakeElement(PROFILE_MENU_IDS.menu);
    const valueEl = createFakeElement(PROFILE_MENU_IDS.value);
    const optionsEl = createFakeElement(PROFILE_MENU_IDS.options);
    const hiddenInput = createFakeInput(PROFILE_MENU_IDS.select);
    const fieldEl = createFakeElement(GITHUB_IDENTITY_IDS.field);
    for (const element of [
      button,
      menu,
      valueEl,
      optionsEl,
      hiddenInput,
      fieldEl
    ]) {
      browser.document.add(element);
    }
    browser.net.handle(
      `${GITHUB_IDENTITY_ENDPOINT}?repo=${encodeURIComponent("octo/cat")}&fresh=1`,
      () =>
        jsonResponse({
          actingLogin: "alice",
          displayLogin: "alice",
          actingHasWorkflow: true,
          actingHasPackages: true,
          accounts: []
        })
    );
    const { deps } = makeDeps();
    const handle = initializeCredentialProfilesPanel(browser.context, deps);

    await expect(handle?.loadGithubIdentity(true)).resolves.toBeUndefined();
    expect(fieldEl.style.display).toBe("");
  });

  it("hides the field without a recheck button to toggle when identity has an error", async () => {
    const browser = createFakeBrowser();
    const button = createFakeElement(PROFILE_MENU_IDS.button);
    const menu = createFakeElement(PROFILE_MENU_IDS.menu);
    const valueEl = createFakeElement(PROFILE_MENU_IDS.value);
    const optionsEl = createFakeElement(PROFILE_MENU_IDS.options);
    const hiddenInput = createFakeInput(PROFILE_MENU_IDS.select);
    const fieldEl = createFakeElement(GITHUB_IDENTITY_IDS.field);
    for (const element of [
      button,
      menu,
      valueEl,
      optionsEl,
      hiddenInput,
      fieldEl
    ]) {
      browser.document.add(element);
    }
    browser.net.handle(
      `${GITHUB_IDENTITY_ENDPOINT}?repo=${encodeURIComponent("octo/cat")}`,
      () => jsonResponse({ error: "no identity", actingLogin: "" })
    );
    const { deps } = makeDeps();
    const handle = initializeCredentialProfilesPanel(browser.context, deps);

    await expect(handle?.loadGithubIdentity()).resolves.toBeUndefined();
    expect(fieldEl.style.display).toBe("none");
  });

  it("does not throw when the field element is absent and the identity request fails", async () => {
    const browser = createFakeBrowser();
    const button = createFakeElement(PROFILE_MENU_IDS.button);
    const menu = createFakeElement(PROFILE_MENU_IDS.menu);
    const valueEl = createFakeElement(PROFILE_MENU_IDS.value);
    const optionsEl = createFakeElement(PROFILE_MENU_IDS.options);
    const hiddenInput = createFakeInput(PROFILE_MENU_IDS.select);
    for (const element of [button, menu, valueEl, optionsEl, hiddenInput]) {
      browser.document.add(element);
    }
    browser.net.handle(
      `${GITHUB_IDENTITY_ENDPOINT}?repo=${encodeURIComponent("octo/cat")}`,
      () => Promise.reject(new Error("offline"))
    );
    const { deps } = makeDeps();
    const handle = initializeCredentialProfilesPanel(browser.context, deps);

    await expect(handle?.loadGithubIdentity()).resolves.toBeUndefined();
  });

  it("does not throw rendering identity when the field element is absent on success", async () => {
    const browser = createFakeBrowser();
    const button = createFakeElement(PROFILE_MENU_IDS.button);
    const menu = createFakeElement(PROFILE_MENU_IDS.menu);
    const valueEl = createFakeElement(PROFILE_MENU_IDS.value);
    const optionsEl = createFakeElement(PROFILE_MENU_IDS.options);
    const hiddenInput = createFakeInput(PROFILE_MENU_IDS.select);
    for (const element of [button, menu, valueEl, optionsEl, hiddenInput]) {
      browser.document.add(element);
    }
    browser.net.handle(
      `${GITHUB_IDENTITY_ENDPOINT}?repo=${encodeURIComponent("octo/cat")}`,
      () => jsonResponse({ actingLogin: "alice", displayLogin: "alice" })
    );
    const { deps } = makeDeps();
    const handle = initializeCredentialProfilesPanel(browser.context, deps);

    await expect(handle?.loadGithubIdentity()).resolves.toBeUndefined();
  });

  it("hides the field while detecting and shows the acting account when loaded", async () => {
    const page = renderProfilesPage();
    const { deps } = makeDeps();
    page.browser.net.handle(IDENTITY_URL(), () =>
      jsonResponse({
        error: "",
        actingLogin: "alice",
        displayLogin: "alice",
        mismatch: false,
        repoAccess: "",
        actingHasWorkflow: true,
        actingHasPackages: true,
        accounts: [
          {
            login: "alice",
            hasWorkflow: true,
            hasPackages: true,
            switchable: true
          }
        ]
      })
    );
    const handle = setupIdentity(page, deps);
    const pending = handle?.loadGithubIdentity();
    expect(page.ghValueEl.textContent).toBe("Detecting…");
    await pending;

    expect(page.fieldEl.style.display).toBe("");
    expect(page.ghValueEl.textContent).toBe("@alice");
    expect(page.ghOptionsEl.children).toHaveLength(1);
    expect(page.ghEmptyEl.style.display).toBe("none");
    expect(page.noteEl.style.color).toBe("var(--rad-text-tertiary)");
    expect(fakeText(page.noteEl)).toContain("Acts as");
    expect(page.recheckBtn.style.display).toBe("none");
  });

  it("hides the field entirely when the identity has an error or no acting login", async () => {
    const page = renderProfilesPage();
    const { deps } = makeDeps();
    page.browser.net.handle(IDENTITY_URL(), () =>
      jsonResponse({ error: "no gh cli" })
    );
    const handle = setupIdentity(page, deps);

    await handle?.loadGithubIdentity();

    expect(page.fieldEl.style.display).toBe("none");
    expect(page.recheckBtn.style.display).toBe("none");
  });

  it("hides the field on a network error", async () => {
    const page = renderProfilesPage();
    const { deps } = makeDeps();
    page.browser.net.handle(IDENTITY_URL(), () =>
      Promise.reject(new Error("down"))
    );
    const handle = setupIdentity(page, deps);

    await handle?.loadGithubIdentity();
    expect(page.fieldEl.style.display).toBe("none");
  });

  it("shows the recheck button and warning tone when a scope is missing", async () => {
    const page = renderProfilesPage();
    const { deps } = makeDeps();
    page.browser.net.handle(IDENTITY_URL(), () =>
      jsonResponse({
        actingLogin: "alice",
        displayLogin: "alice",
        actingHasWorkflow: false,
        actingHasPackages: true,
        accounts: []
      })
    );
    const handle = setupIdentity(page, deps);
    await handle?.loadGithubIdentity();

    expect(page.recheckBtn.style.display).toBe("");
    expect(page.noteEl.style.color).toBe("var(--rad-warning, #9a6700)");
  });

  it("shows a repo-access warning note", async () => {
    const page = renderProfilesPage();
    const { deps } = makeDeps();
    page.browser.net.handle(IDENTITY_URL(), () =>
      jsonResponse({
        actingLogin: "alice",
        displayLogin: "alice",
        repoAccess: "alice cannot push here",
        actingHasWorkflow: true,
        actingHasPackages: true,
        accounts: []
      })
    );
    const handle = setupIdentity(page, deps);
    await handle?.loadGithubIdentity();
    expect(fakeText(page.noteEl)).toBe("alice cannot push here");
  });

  it("marks non-actionable rows as disabled and does not bind a switch handler", async () => {
    const page = renderProfilesPage();
    const { deps } = makeDeps();
    page.browser.net.handle(IDENTITY_URL(), () =>
      jsonResponse({
        actingLogin: "alice",
        displayLogin: "alice",
        actingHasWorkflow: true,
        actingHasPackages: true,
        accounts: [
          {
            login: "alice",
            hasWorkflow: true,
            hasPackages: true,
            switchable: true
          },
          {
            login: "bob",
            hasWorkflow: true,
            hasPackages: true,
            switchable: false
          }
        ]
      })
    );
    const handle = setupIdentity(page, deps);
    await handle?.loadGithubIdentity();

    const bobRow = page.ghOptionsEl.children.find((child) =>
      fakeText(child).includes("@bob")
    );
    expect(bobRow?.getAttribute("disabled")).toBe("disabled");
    expect(bobRow?.listenerCount("click")).toBe(0);
  });

  it("skips fetching identity again while one is already in flight", async () => {
    const page = renderProfilesPage();
    const { deps } = makeDeps();
    let calls = 0;
    page.browser.net.handle(IDENTITY_URL(), () => {
      calls += 1;
      return jsonResponse({ actingLogin: "alice", displayLogin: "alice" });
    });
    const handle = setupIdentity(page, deps);
    const first = handle?.loadGithubIdentity();
    const second = handle?.loadGithubIdentity();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });

  it("recheck button requests a fresh identity and toggles its label", async () => {
    const page = renderProfilesPage();
    const { deps } = makeDeps();
    let receivedFresh = false;
    page.browser.net.handle(IDENTITY_URL(true), () => {
      receivedFresh = true;
      return jsonResponse({ actingLogin: "alice", displayLogin: "alice" });
    });
    const handle = setupIdentity(page, deps);
    page.recheckBtn.dispatch("click");
    expect(page.recheckBtn.disabled).toBe(true);
    expect(page.recheckBtn.textContent).toBe("Checking…");
    await flushPromises();

    expect(receivedFresh).toBe(true);
    expect(page.recheckBtn.disabled).toBe(false);
    expect(page.recheckBtn.textContent).toBe("Re-check");
    void handle;
  });
});

describe("switching a github account", () => {
  const IDENTITY_URL_FRESH = `${GITHUB_IDENTITY_ENDPOINT}?repo=${encodeURIComponent("octo/cat")}&fresh=1`;

  function setupWithAccounts(
    page: ProfilesPage,
    deps: CredentialProfilesPanelDeps
  ) {
    page.browser.net.handle(
      `${GITHUB_IDENTITY_ENDPOINT}?repo=${encodeURIComponent("octo/cat")}`,
      () =>
        jsonResponse({
          actingLogin: "alice",
          displayLogin: "alice",
          actingHasWorkflow: true,
          actingHasPackages: true,
          accounts: [
            {
              login: "alice",
              hasWorkflow: true,
              hasPackages: true,
              switchable: true
            },
            {
              login: "bob",
              hasWorkflow: true,
              hasPackages: true,
              switchable: true
            }
          ]
        })
    );
    return initializeCredentialProfilesPanel(page.browser.context, deps);
  }

  it("switches accounts without a value element to update", async () => {
    const browser = createFakeBrowser();
    const button = createFakeElement(PROFILE_MENU_IDS.button);
    const menu = createFakeElement(PROFILE_MENU_IDS.menu);
    const valueEl = createFakeElement(PROFILE_MENU_IDS.value);
    const optionsEl = createFakeElement(PROFILE_MENU_IDS.options);
    const hiddenInput = createFakeInput(PROFILE_MENU_IDS.select);
    const fieldEl = createFakeElement(GITHUB_IDENTITY_IDS.field);
    const ghOptionsEl = createFakeElement(GITHUB_IDENTITY_IDS.options);
    for (const element of [
      button,
      menu,
      valueEl,
      optionsEl,
      hiddenInput,
      fieldEl,
      ghOptionsEl
    ]) {
      browser.document.add(element);
    }
    browser.net.handle(
      `${GITHUB_IDENTITY_ENDPOINT}?repo=${encodeURIComponent("octo/cat")}`,
      () =>
        jsonResponse({
          actingLogin: "alice",
          displayLogin: "alice",
          actingHasWorkflow: true,
          actingHasPackages: true,
          accounts: [
            {
              login: "alice",
              hasWorkflow: true,
              hasPackages: true,
              switchable: true
            },
            {
              login: "bob",
              hasWorkflow: true,
              hasPackages: true,
              switchable: true
            }
          ]
        })
    );
    const { deps } = makeDeps();
    const handle = initializeCredentialProfilesPanel(browser.context, deps);
    await handle?.loadGithubIdentity();
    browser.net.handle(`${GITHUB_ACCOUNT_ENDPOINT}`, () =>
      jsonResponse({ error: "cannot switch" }, false, 400)
    );

    const bobRow = ghOptionsEl.children.find((child) =>
      fakeText(child).includes("@bob")
    );
    expect(() => bobRow?.dispatch("click")).not.toThrow();
    await flushPromises();
  });

  it("switches accounts and re-checks identity with the repo so repoAccess re-runs", async () => {
    const page = renderProfilesPage();
    const { deps } = makeDeps();
    const handle = setupWithAccounts(page, deps);
    await handle?.loadGithubIdentity();

    let postedBody: unknown;
    page.browser.net.handle(GITHUB_ACCOUNT_ENDPOINT, (init) => {
      postedBody = init?.body;
      return jsonResponse({ ok: true });
    });
    page.browser.net.handle(IDENTITY_URL_FRESH, () =>
      jsonResponse({
        actingLogin: "bob",
        displayLogin: "bob",
        actingHasWorkflow: true,
        actingHasPackages: true,
        accounts: []
      })
    );

    const bobRow = page.ghOptionsEl.children.find((child) =>
      fakeText(child).includes("@bob")
    );
    bobRow?.dispatch("click");
    expect(page.ghValueEl.textContent).toBe("Switching…");
    await flushPromises();

    expect(postedBody).toBe(JSON.stringify({ login: "bob" }));
    expect(page.ghValueEl.textContent).toBe("@bob");
  });

  it("shows the server error message and re-renders identity when the switch is rejected", async () => {
    const page = renderProfilesPage();
    const { deps } = makeDeps();
    const handle = setupWithAccounts(page, deps);
    await handle?.loadGithubIdentity();

    page.browser.net.handle(GITHUB_ACCOUNT_ENDPOINT, () =>
      jsonResponse({ error: "cannot switch to bob" }, false, 400)
    );

    const bobRow = page.ghOptionsEl.children.find((child) =>
      fakeText(child).includes("@bob")
    );
    bobRow?.dispatch("click");
    await flushPromises();

    expect(fakeText(page.noteEl)).toBe("cannot switch to bob");
    expect(page.noteEl.style.color).toBe("var(--rad-danger, #cf222e)");
  });

  it("falls back to a generic error message when the server sends none", async () => {
    const page = renderProfilesPage();
    const { deps } = makeDeps();
    const handle = setupWithAccounts(page, deps);
    await handle?.loadGithubIdentity();

    page.browser.net.handle(GITHUB_ACCOUNT_ENDPOINT, () =>
      jsonResponse({}, false, 400)
    );

    const bobRow = page.ghOptionsEl.children.find((child) =>
      fakeText(child).includes("@bob")
    );
    bobRow?.dispatch("click");
    await flushPromises();

    expect(fakeText(page.noteEl)).toBe("Could not switch account.");
  });

  it("re-renders the existing identity without a note change on a network error", async () => {
    const page = renderProfilesPage();
    const { deps } = makeDeps();
    const handle = setupWithAccounts(page, deps);
    await handle?.loadGithubIdentity();

    page.browser.net.handle(GITHUB_ACCOUNT_ENDPOINT, () =>
      Promise.reject(new Error("offline"))
    );

    const bobRow = page.ghOptionsEl.children.find((child) =>
      fakeText(child).includes("@bob")
    );
    bobRow?.dispatch("click");
    await flushPromises();

    expect(page.ghValueEl.textContent).toBe("@alice");
  });

  it("renders the active account's own row as disabled with no switch handler", async () => {
    const page = renderProfilesPage();
    const { deps } = makeDeps();
    const handle = setupWithAccounts(page, deps);
    await handle?.loadGithubIdentity();
    let called = false;
    page.browser.net.handle(GITHUB_ACCOUNT_ENDPOINT, () => {
      called = true;
      return jsonResponse({ ok: true });
    });

    const aliceRow = page.ghOptionsEl.children.find((child) =>
      fakeText(child).includes("@alice")
    );
    aliceRow?.dispatch("click");
    expect(aliceRow?.getAttribute("disabled")).toBe("disabled");
    expect(called).toBe(false);
  });
});

describe("auto-recheck on focus and visibility", () => {
  function setupWarning(page: ProfilesPage, deps: CredentialProfilesPanelDeps) {
    page.browser.net.handle(
      `${GITHUB_IDENTITY_ENDPOINT}?repo=${encodeURIComponent("octo/cat")}`,
      () =>
        jsonResponse({
          actingLogin: "alice",
          displayLogin: "alice",
          actingHasWorkflow: false,
          actingHasPackages: true,
          accounts: []
        })
    );
    return initializeCredentialProfilesPanel(page.browser.context, deps);
  }

  it("re-checks on window focus only while a scope warning is active", async () => {
    const page = renderProfilesPage();
    const { deps } = makeDeps();
    const handle = setupWarning(page, deps);
    await handle?.loadGithubIdentity();

    let rechecks = 0;
    page.browser.net.handle(
      `${GITHUB_IDENTITY_ENDPOINT}?repo=${encodeURIComponent("octo/cat")}&fresh=1`,
      () => {
        rechecks += 1;
        return jsonResponse({
          actingLogin: "alice",
          displayLogin: "alice",
          actingHasWorkflow: true,
          actingHasPackages: true,
          accounts: []
        });
      }
    );

    page.browser.page.dispatch("focus");
    await flushPromises();
    expect(rechecks).toBe(1);

    // Warning cleared after the recheck: focusing again must not re-check.
    page.browser.page.dispatch("focus");
    await flushPromises();
    expect(rechecks).toBe(1);
  });

  it("re-checks on document visibilitychange only when visible", async () => {
    const page = renderProfilesPage();
    const { deps } = makeDeps();
    const handle = setupWarning(page, deps);
    await handle?.loadGithubIdentity();
    let rechecks = 0;
    page.browser.net.handle(
      `${GITHUB_IDENTITY_ENDPOINT}?repo=${encodeURIComponent("octo/cat")}&fresh=1`,
      () => {
        rechecks += 1;
        return jsonResponse({ actingLogin: "alice", displayLogin: "alice" });
      }
    );

    page.browser.document.visibilityState = "hidden";
    page.browser.document.dispatch("visibilitychange");
    expect(rechecks).toBe(0);

    page.browser.document.visibilityState = "visible";
    page.browser.document.dispatch("visibilitychange");
    await flushPromises();
    expect(rechecks).toBe(1);
  });

  it("does not auto-recheck while the field is hidden", async () => {
    const page = renderProfilesPage();
    const { deps } = makeDeps();
    page.browser.net.handle(
      `${GITHUB_IDENTITY_ENDPOINT}?repo=${encodeURIComponent("octo/cat")}`,
      () => jsonResponse({ error: "no gh cli" })
    );
    const handle = initializeCredentialProfilesPanel(
      page.browser.context,
      deps
    );
    await handle?.loadGithubIdentity();

    let rechecks = 0;
    page.browser.net.handle(
      `${GITHUB_IDENTITY_ENDPOINT}?repo=${encodeURIComponent("octo/cat")}&fresh=1`,
      () => {
        rechecks += 1;
        return jsonResponse({ actingLogin: "alice", displayLogin: "alice" });
      }
    );
    page.browser.page.dispatch("focus");
    await flushPromises();
    expect(rechecks).toBe(0);
  });
});

describe("hostile input handling end to end", () => {
  it("renders a hostile profile name and github login as text nodes only", async () => {
    const page = renderProfilesPage();
    page.browser.net.handle(
      `${CREDENTIAL_PROFILES_ENDPOINT}?repo=${encodeURIComponent("octo/cat")}`,
      () => profilesResponse([{ name: HOSTILE, provider: "azure" }])
    );
    const { deps } = makeDeps();
    const handle = initializeCredentialProfilesPanel(
      page.browser.context,
      deps
    );
    await handle?.loadProfiles(HOSTILE);

    for (const node of fakeTree(page.optionsEl)) {
      expect(node.innerHTML).toBe("");
    }
    expect(fakeText(page.optionsEl)).toContain(HOSTILE);

    page.browser.net.handle(
      `${GITHUB_IDENTITY_ENDPOINT}?repo=${encodeURIComponent("octo/cat")}`,
      () =>
        jsonResponse({
          actingLogin: HOSTILE,
          displayLogin: HOSTILE,
          actingHasWorkflow: true,
          actingHasPackages: true,
          accounts: []
        })
    );
    await handle?.loadGithubIdentity();
    for (const node of fakeTree(page.noteEl)) {
      expect(node.innerHTML).toBe("");
    }
    expect(fakeText(page.noteEl)).toContain(HOSTILE);
  });
});
