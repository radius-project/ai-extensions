import { describe, it, expect } from "vitest";
import { DEPLOYING_CLIENT_JS } from "./client-deployments.js";
import { CLIENT_REPO_BRANCH_JS } from "../../client.js";

// The deployments page ships as a browser script string, so these tests
// evaluate the real fragment against a hand-built document. Only the elements
// the deploy form actually reads are modelled; everything else resolves to an
// inert stub so the fragment's load-time wiring runs unchanged.

interface Environment {
  name: string;
  provider?: string;
  status?: string;
}

interface FakeButton {
  disabled: boolean;
  title?: string;
  dataset: Record<string, string>;
  textContent: string;
  removeAttribute(name: string): void;
  addEventListener(): void;
}

function stubElement(): Record<string, unknown> {
  return {
    innerHTML: "",
    textContent: "",
    value: "",
    style: {},
    dataset: {},
    disabled: false,
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener() {},
    removeAttribute() {},
    setAttribute() {},
    appendChild() {},
    querySelectorAll: () => []
  };
}

function harness(environments: Environment[]) {
  const optionsOf = (html: string): { value: string; label: string }[] => {
    const found: { value: string; label: string }[] = [];
    const pattern = /<option value="([^"]*)">([^<]*)<\/option>/g;
    let match = pattern.exec(html);
    while (match) {
      found.push({ value: match[1], label: match[2] });
      match = pattern.exec(html);
    }
    return found;
  };

  const envSelect = {
    _value: "",
    _html: "",
    get innerHTML() {
      return this._html;
    },
    // A real <select> adopts the first option when its markup is replaced, and
    // rejects a value that no option carries. Both matter here: the fix relies
    // on assigning a value, and on what the default would otherwise have been.
    set innerHTML(html: string) {
      this._html = html;
      const first = optionsOf(html)[0];
      this._value = first ? first.value : "";
    },
    get value() {
      return this._value;
    },
    set value(next: string) {
      if (optionsOf(this._html).some((o) => o.value === next))
        this._value = next;
    },
    addEventListener() {}
  };

  const deployBtn: FakeButton = {
    disabled: false,
    title: "",
    dataset: {},
    textContent: "",
    removeAttribute(name: string) {
      if (name === "title") delete this.title;
    },
    addEventListener() {}
  };

  const appSelect = { ...stubElement(), value: "web-app" };
  const elements: Record<string, unknown> = {
    "deploy-now-btn": deployBtn,
    "deploy-app-select": appSelect,
    "deploy-env-select": envSelect,
    "deploy-branch-select": stubElement(),
    "deploy-inline-status": stubElement(),
    "deploy-table-body": stubElement()
  };

  const pending: Promise<unknown>[] = [];
  const respond = (payload: unknown) => {
    const settled = Promise.resolve({ json: () => Promise.resolve(payload) });
    pending.push(settled);
    return settled;
  };
  const fetchFake = (url: string) => {
    if (url.startsWith("/api/list-environments"))
      return respond({ environments });
    if (url.startsWith("/api/list-applications"))
      return respond({ applications: [{ name: "web-app" }] });
    if (url.startsWith("/api/list-deployments")) return respond({ error: "" });
    return respond({});
  };

  const document = {
    getElementById: (id: string) => elements[id] || stubElement(),
    createElement: () => stubElement(),
    querySelectorAll: () => []
  };

  const api = new Function(
    "document",
    "window",
    "fetch",
    "setTimeout",
    "setInterval",
    "clearInterval",
    "CTX_REPO",
    "CTX_BRANCH",
    "radiusCreateDeleteDeploymentDialog",
    // Both scripts share page scope in the real canvas, and the deploying
    // fragment relies on the shared environment-readiness helpers.
    `${CLIENT_REPO_BRANCH_JS}
     ${DEPLOYING_CLIENT_JS}
     return {
       loadEnvironments: loadEnvironmentsDropdown,
       refresh: refreshDeployBtn,
       select: function(name) { envSelect.value = name; refreshDeployBtn(); }
     };`
  )(
    document,
    { location: { search: "" } },
    fetchFake,
    () => 0,
    () => 0,
    () => {},
    "octo/app",
    "main",
    () => null
  );

  const settle = async () => {
    await Promise.all(pending);
    await Promise.resolve();
    await Promise.resolve();
  };

  return { ...api, settle, deployBtn, envSelect };
}

describe("deployments page — Deploy is gated on a usable environment", () => {
  it("refuses to deploy into an environment whose creation failed", async () => {
    const page = harness([{ name: "prod", status: "failed" }]);
    page.loadEnvironments();
    await page.settle();

    expect(page.envSelect.value).toBe("prod");
    expect(page.deployBtn.dataset.mode).toBe("deploy");
    expect(page.deployBtn.disabled).toBe(true);
    expect(page.deployBtn.title).toContain("not created successfully");
  });

  it("refuses to deploy while an environment is still being created", async () => {
    const page = harness([{ name: "prod", status: "pending" }]);
    page.loadEnvironments();
    await page.settle();

    expect(page.deployBtn.disabled).toBe(true);
    expect(page.deployBtn.title).toContain("still being created");
  });

  it("deploys into an environment that was created successfully", async () => {
    const page = harness([{ name: "prod", status: "success" }]);
    page.loadEnvironments();
    await page.settle();

    expect(page.deployBtn.disabled).toBe(false);
    expect(page.deployBtn.title).toBeUndefined();
  });

  it("selects a usable environment instead of whichever is listed first", async () => {
    const page = harness([
      { name: "prod", status: "failed" },
      { name: "staging", status: "success" }
    ]);
    page.loadEnvironments();
    await page.settle();

    expect(page.envSelect.value).toBe("staging");
    expect(page.deployBtn.disabled).toBe(false);
  });

  it("says in the option label why an environment is not selectable", async () => {
    const page = harness([
      { name: "prod", status: "failed" },
      { name: "next", status: "pending" },
      { name: "staging", status: "success" }
    ]);
    page.loadEnvironments();
    await page.settle();

    expect(page.envSelect.innerHTML).toContain("prod (creation failed)");
    expect(page.envSelect.innerHTML).toContain("next (being created…)");
    expect(page.envSelect.innerHTML).toContain(">staging<");
  });

  it("disables Deploy again when the user picks a failed environment", async () => {
    const page = harness([
      { name: "prod", status: "failed" },
      { name: "staging", status: "success" }
    ]);
    page.loadEnvironments();
    await page.settle();
    expect(page.deployBtn.disabled).toBe(false);

    page.select("prod");
    expect(page.deployBtn.disabled).toBe(true);
    expect(page.deployBtn.title).toContain("not created successfully");

    page.select("staging");
    expect(page.deployBtn.disabled).toBe(false);
    expect(page.deployBtn.title).toBeUndefined();
  });

  it("treats an environment with no reported status as not yet usable", async () => {
    const page = harness([{ name: "prod" }]);
    page.loadEnvironments();
    await page.settle();

    expect(page.deployBtn.disabled).toBe(true);
    expect(page.deployBtn.title).toContain("still being created");
  });

  it("still offers Create Environment when the repo has none", async () => {
    const page = harness([]);
    page.loadEnvironments();
    await page.settle();

    expect(page.deployBtn.dataset.mode).toBe("create-env");
    expect(page.deployBtn.disabled).toBe(false);
  });
});
