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

interface ConfirmOptions {
  title?: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: string;
  onConfirm?: () => void;
}

interface DeleteResult {
  ok: boolean;
  body: Record<string, unknown>;
}

interface Harness {
  deleteEnvironment: (name: string, button: FakeElement) => Promise<void>;
  dialogs: ConfirmOptions[];
  alerts: string[];
  location: { href: string };
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
function harness(
  envs: EnvRow[] = [],
  deleteResult: DeleteResult = { ok: true, body: {} }
): Harness {
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

  const dialogs: ConfirmOptions[] = [];
  const alerts: string[] = [];
  const location = { href: "/?page=environment" };
  const fetchStub = (url: string) =>
    url.startsWith("/api/delete-environment") ?
      Promise.resolve({
        ok: deleteResult.ok,
        json: () => Promise.resolve(deleteResult.body)
      })
    : Promise.resolve({ json: () => Promise.resolve({ environments: envs }) });

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
    "showConfirmDialog",
    "alert",
    `${ENVIRONMENT_TABLE_CLIENT_JS}; return { showEnvForm: showEnvForm, showEnvLanding: showEnvLanding, loadEnvTable: loadEnvTable, switchSubtab: switchSubtab, showEnvSuccessBanner: showEnvSuccessBanner, deleteEnvironment: deleteEnvironment, selectProfile: function(p) { selectedProfile = p; } };`
  )(
    document,
    { location },
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
    () => {},
    (options: ConfirmOptions) => dialogs.push(options),
    (message: string) => alerts.push(message)
  ) as {
    deleteEnvironment: (name: string, button: FakeElement) => void;
    switchSubtab: (name: string) => void;
    showEnvSuccessBanner: (provider: string, name: string) => void;
    selectProfile: (profile: unknown) => void;
    showEnvForm: (preset: Record<string, unknown>) => void;
    showEnvLanding: () => void;
    loadEnvTable: () => void;
  };

  return {
    showEnvForm: api.showEnvForm,
    deleteEnvironment: async (name, button) => {
      api.deleteEnvironment(name, button);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    dialogs,
    alerts,
    location,
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

describe("environment table — deleting an environment that still has a deployment", () => {
  const conflict = {
    ok: false,
    body: {
      code: "app-deployed",
      error: 'Application "storefront" is still deployed to "prod".',
      redirect: "/?page=deploying&env=prod"
    }
  };

  it("explains the conflict in a dialog and navigates nowhere on its own", async () => {
    const dom = harness([], conflict);
    const button = element();
    await dom.deleteEnvironment("prod", button);
    expect(dom.dialogs).toHaveLength(1);
    const dialog = dom.dialogs[0];
    expect(dialog.title).toBe("Delete the application first");
    expect(dialog.message).toContain('Application "storefront" is still');
    expect(dialog.message).toContain("Nothing has been deleted");
    expect(dialog.confirmLabel).toBe("Go to Deployments");
    expect(dialog.cancelLabel).toBe("Stay here");
    // Navigating is a choice, not a destruction, so the button is not red.
    expect(dialog.confirmVariant).toBe("primary");
    expect(dom.location.href).toBe("/?page=environment");
    expect(dom.alerts).toEqual([]);
  });

  it("leaves the row's Delete button usable while the dialog is open", async () => {
    const dom = harness([], conflict);
    const button = element();
    await dom.deleteEnvironment("prod", button);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Delete Env");
  });

  it("navigates to the deployment the server pointed at, once the user asks", async () => {
    const dom = harness([], conflict);
    await dom.deleteEnvironment("prod", element());
    dom.dialogs[0].onConfirm?.();
    expect(dom.location.href).toBe("/?page=deploying&env=prod");
  });

  it("falls back to the deployments page when the server names no target", async () => {
    const dom = harness([], {
      ok: false,
      body: { code: "app-deployed" }
    });
    await dom.deleteEnvironment("prod", element());
    expect(dom.dialogs[0].message).toContain(
      "An application is still deployed to this environment."
    );
    dom.dialogs[0].onConfirm?.();
    expect(dom.location.href).toBe("/?page=deploying");
  });

  it("still alerts on a failure that is not a deployment conflict", async () => {
    const dom = harness([], {
      ok: false,
      body: { error: "Insufficient permissions." }
    });
    const button = element();
    await dom.deleteEnvironment("prod", button);
    expect(dom.dialogs).toEqual([]);
    expect(dom.alerts).toEqual(["Insufficient permissions."]);
    expect(button.disabled).toBe(false);
  });
});
