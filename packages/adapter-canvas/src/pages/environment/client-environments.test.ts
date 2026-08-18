// Behaviour tests for the environment table fragment's edit path. The fragment
// is a browser script string, so it is evaluated with a fake document that
// models only the elements these flows touch. Collaborating fragments are
// injected as recording fakes: anything the scenario did not model is absent
// rather than silently succeeding.

import { describe, expect, it } from "vitest";
import { ENVIRONMENT_TABLE_CLIENT_JS } from "./client-environments.js";

interface FakeElement {
  value: string;
  disabled: boolean;
  textContent: string;
  innerHTML: string;
  style: { display: string };
  focus: () => void;
}

function element(): FakeElement {
  return {
    value: "",
    disabled: false,
    textContent: "",
    innerHTML: "",
    style: { display: "" },
    focus: () => {}
  };
}

class FakeButton {
  private handler: (() => void) | null = null;
  constructor(private readonly env: string) {}
  getAttribute(name: string): string | null {
    return name === "data-env" ? this.env : null;
  }
  addEventListener(_type: string, handler: () => void): void {
    this.handler = handler;
  }
  click(): void {
    if (!this.handler) throw new Error("no click handler wired");
    this.handler.call(this);
  }
}

interface EnvRow {
  name: string;
  credentialProfile?: string;
  config?: Record<string, string>;
}

interface Harness {
  showEnvForm: (preset: Record<string, unknown>) => void;
  showEnvSuccessBanner: (provider: string, name: string) => void;
  switchSubtab: (name: string) => void;
  selectProfile: (profile: unknown) => void;
  captured: string[];
  showEnvLanding: () => void;
  loadEnvTable: () => Promise<void>;
  setEnvs: (next: EnvRow[]) => void;
  editButton: (env: string) => FakeButton;
  el: (id: string) => FakeElement;
  pending: unknown[];
  wizardSteps: number[];
  profileRequests: Array<string | undefined>;
  navigations: string[];
}

const ELEMENT_IDS = [
  "env-landing",
  "env-form",
  "env-name-input",
  "env-profile-select",
  "deploy-btn",
  "az-client-id",
  "deploy-status",
  "env-step2-title",
  "env-name-help",
  "env-profile-button",
  "env-table-body",
  "pane-environments",
  "pane-credentials",
  "env-success-banner",
  "env-success-banner-text"
];

// Builds the fragment's world. `envs` is what /api/list-environments returns.
function harness(envs: EnvRow[] = []): Harness {
  const elements: Record<string, FakeElement> = {};
  for (const id of ELEMENT_IDS) elements[id] = element();
  // The pane ships with the wizard hidden behind the landing view.
  elements["env-form"].style.display = "none";
  const editButtons: Record<string, FakeButton> = {};
  const pending: unknown[] = [];
  const wizardSteps: number[] = [];
  const profileRequests: Array<string | undefined> = [];
  const navigations: string[] = [];
  const captured: string[] = [];

  const document = {
    getElementById: (id: string) => elements[id] ?? null,
    querySelectorAll: (selector: string) => {
      if (selector === ".js-edit-env") return Object.values(editButtons);
      return [];
    }
  };

  const fetchStub = () =>
    Promise.resolve({ json: () => Promise.resolve({ environments: envs }) });

  const api = new Function(
    "document",
    "window",
    "fetch",
    "CTX_REPO",
    "setPendingInfraSelection",
    "currentInfraSelection",
    "hideEnvTerminalBanners",
    "clearSharedAppPin",
    "endCredentialCreation",
    "showEnvWizardStep",
    "loadProfilesIntoEnvSelect",
    "loadGitHubIdentity",
    "loadCredTable",
    `${ENVIRONMENT_TABLE_CLIENT_JS}; return { showEnvForm: showEnvForm, showEnvLanding: showEnvLanding, loadEnvTable: loadEnvTable, switchSubtab: switchSubtab, showEnvSuccessBanner: showEnvSuccessBanner, selectProfile: function(p) { selectedProfile = p; } };`
  )(
    document,
    { location: { href: "" } },
    fetchStub,
    "octo/app",
    (config: unknown) => pending.push(config),
    (provider: string) => {
      captured.push(provider);
      return { namespace: "in-progress" };
    },
    () => {},
    () => {},
    () => {},
    (step: number) => wizardSteps.push(step),
    (preset: string | undefined, done?: (selected: boolean) => void) => {
      profileRequests.push(preset);
      if (done) done(Boolean(preset));
    },
    () => {},
    () => {}
  ) as {
    switchSubtab: (name: string) => void;
    showEnvSuccessBanner: (provider: string, name: string) => void;
    selectProfile: (profile: unknown) => void;
    showEnvForm: (preset: Record<string, unknown>) => void;
    showEnvLanding: () => void;
    loadEnvTable: () => void;
  };

  return {
    showEnvForm: api.showEnvForm,
    switchSubtab: api.switchSubtab,
    showEnvSuccessBanner: api.showEnvSuccessBanner,
    selectProfile: api.selectProfile,
    captured,
    showEnvLanding: api.showEnvLanding,
    // The table renders rows as markup, so the fake document hands back the
    // edit buttons the listing implies rather than parsing the HTML.
    loadEnvTable: async () => {
      for (const env of envs) editButtons[env.name] = new FakeButton(env.name);
      api.loadEnvTable();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    setEnvs: (next) => {
      envs.splice(0, envs.length, ...next);
    },
    editButton: (env) => editButtons[env],
    el: (id) => elements[id],
    pending,
    wizardSteps,
    profileRequests,
    navigations
  };
}

describe("environment table — editing an existing environment", () => {
  const row: EnvRow = {
    name: "prod",
    credentialProfile: "prod-azure",
    config: { resourceGroup: "prod-rg", cluster: "prod-aks" }
  };

  it("renders an in-page edit control rather than a link out to GitHub", () => {
    expect(ENVIRONMENT_TABLE_CLIENT_JS).toContain("js-edit-env");
    expect(ENVIRONMENT_TABLE_CLIENT_JS).not.toContain("href=\"' + e.webUrl");
  });

  it("opens the form on the clicked row's stored values", async () => {
    const dom = harness([{ name: "dev" }, row]);
    await dom.loadEnvTable();
    dom.editButton("prod").click();
    expect(dom.el("env-name-input").value).toBe("prod");
    expect(dom.profileRequests).toEqual(["prod-azure"]);
    expect(dom.pending).toEqual([row.config]);
    expect(dom.el("env-form").style.display).toBe("");
    expect(dom.el("env-landing").style.display).toBe("none");
  });

  it("fixes the name and says why, because the name is the environment's identity", async () => {
    const dom = harness([row]);
    await dom.loadEnvTable();
    dom.editButton("prod").click();
    expect(dom.el("env-name-input").disabled).toBe(true);
    expect(dom.el("env-step2-title").textContent).toBe("Edit Environment");
    expect(dom.el("env-name-help").textContent).toContain("cannot be renamed");
    expect(dom.el("deploy-btn").textContent).toBe("Save Environment");
  });

  it("advances straight to the environment details once the profile resolves", async () => {
    const dom = harness([row]);
    await dom.loadEnvTable();
    dom.editButton("prod").click();
    expect(dom.wizardSteps).toEqual([1, 2]);
  });

  it("ignores an edit click for a row the refreshed listing no longer holds", async () => {
    const dom = harness([row]);
    await dom.loadEnvTable();
    const stale = dom.editButton("prod");
    dom.setEnvs([{ name: "dev" }]);
    await dom.loadEnvTable();
    stale.click();
    expect(dom.el("env-form").style.display).toBe("none");
    expect(dom.el("env-name-input").value).toBe("");
  });
});

describe("environment table — creating a new environment", () => {
  it("leaves the name editable and labels the form for creation", () => {
    const dom = harness();
    dom.showEnvForm({});
    expect(dom.el("env-name-input").value).toBe("");
    expect(dom.el("env-name-input").disabled).toBe(false);
    expect(dom.el("env-step2-title").textContent).toBe("Create Environment");
    expect(dom.el("env-name-help").textContent).toContain("deployment target");
    expect(dom.el("deploy-btn").textContent).toBe("Create Environment");
    expect(dom.pending).toEqual([null]);
  });

  it("clears the edit target when the form closes, so the next open creates", async () => {
    const dom = harness([{ name: "prod", credentialProfile: "p" }]);
    await dom.loadEnvTable();
    dom.editButton("prod").click();
    expect(dom.el("deploy-btn").textContent).toBe("Save Environment");
    dom.showEnvLanding();
    dom.showEnvForm({});
    expect(dom.el("deploy-btn").textContent).toBe("Create Environment");
    expect(dom.el("env-name-input").disabled).toBe(false);
  });
});

describe("environment table — returning from the Credentials sub-tab", () => {
  it("hands the in-progress infrastructure selection back before re-syncing", () => {
    const dom = harness();
    dom.selectProfile({ provider: "azure" });
    dom.showEnvForm({});
    dom.switchSubtab("environments");
    expect(dom.captured).toEqual(["azure"]);
    expect(dom.pending[dom.pending.length - 1]).toEqual({
      namespace: "in-progress"
    });
    // The combo is re-synced too, so a profile added on the Credentials
    // sub-tab shows up without a full canvas reload.
    expect(dom.profileRequests).toHaveLength(2);
  });

  it("does not capture anything while the landing view is showing", () => {
    const dom = harness();
    dom.selectProfile({ provider: "azure" });
    dom.switchSubtab("environments");
    expect(dom.captured).toEqual([]);
    // Refreshing the hidden landing view would fire resource discovery on a
    // form the user is not looking at.
    expect(dom.profileRequests).toEqual([]);
  });
});

describe("environment table — the terminal success banner", () => {
  it("reports the environment as configured, which is true of a save as well as a create", () => {
    const dom = harness();
    dom.showEnvSuccessBanner("azure", "prod");
    expect(dom.el("env-success-banner-text").innerHTML).toBe(
      "Successfully configured <strong>Azure</strong> Environment <strong>prod</strong>"
    );
    expect(dom.el("env-success-banner").style.display).toBe("flex");
  });

  it("escapes an environment name that carries markup", () => {
    const dom = harness();
    dom.showEnvSuccessBanner("aws", '<img src=x onerror="alert(1)">');
    expect(dom.el("env-success-banner-text").innerHTML).toContain(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"
    );
  });
});
