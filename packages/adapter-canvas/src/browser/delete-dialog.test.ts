import { describe, expect, it } from "vitest";
import {
  DELETE_DIALOG_CONFIRM_BUTTON_ID,
  DELETE_DIALOG_CONFIRM_INPUT_ID,
  DELETE_DIALOG_FOCUSABLE_SELECTOR,
  DELETE_DIALOG_IDS,
  DELETE_DIALOG_RESOURCE_LIMIT,
  DELETE_DIALOG_STEP1_BUTTON_ID,
  DELETE_DIALOG_STEP2_BUTTON_ID,
  createDeleteDeploymentDialog,
  deleteDialogConfirmSpecs,
  deleteDialogConfirmToken,
  deleteDialogEffectsSpecs,
  deleteDialogIntentSpecs,
  deleteDialogResourceSummary
} from "./delete-dialog.js";
import type { ElementSpec } from "./dom.js";
import type { DomEvent } from "./ports.js";
import {
  createFakeBrowser,
  createFakeElement,
  fakeById,
  fakeInputById,
  fakeText,
  fakeTree
} from "../../test/support/browser/fakes.js";

const HOSTILE = '<img src=x onerror="alert(1)">';

function setup() {
  const browser = createFakeBrowser();
  const modal = createFakeElement(DELETE_DIALOG_IDS.modal);
  const body = createFakeElement(DELETE_DIALOG_IDS.body);
  const app = createFakeElement(DELETE_DIALOG_IDS.app);
  const environment = createFakeElement(DELETE_DIALOG_IDS.environment);
  const closer = createFakeElement(DELETE_DIALOG_IDS.close);
  for (const element of [modal, body, app, environment, closer]) {
    browser.document.add(element);
  }
  return { ...browser, modal, body, app, environment, closer };
}

function advanceToConfirmation(browser: ReturnType<typeof setup>) {
  fakeById(browser.body, DELETE_DIALOG_STEP1_BUTTON_ID).dispatch("click");
  fakeById(browser.body, DELETE_DIALOG_STEP2_BUTTON_ID).dispatch("click");
  return {
    input: fakeInputById(browser.body, DELETE_DIALOG_CONFIRM_INPUT_ID),
    confirm: fakeInputById(browser.body, DELETE_DIALOG_CONFIRM_BUTTON_ID)
  };
}

function trapControls(browser: ReturnType<typeof setup>) {
  const first = createFakeElement("del-trap-first", "button");
  const last = createFakeElement("del-trap-last", "button");
  browser.modal.matches.set(DELETE_DIALOG_FOCUSABLE_SELECTOR, [first, last]);
  return [first, last] as const;
}

function keydown(
  browser: ReturnType<typeof setup>,
  key: string,
  shiftKey = false
): boolean {
  let prevented = false;
  const event: Partial<DomEvent> = Object.assign(
    {
      key,
      preventDefault: () => {
        prevented = true;
      }
    },
    { shiftKey }
  );
  browser.document.dispatch("keydown", event);
  return prevented;
}

function resourceList(specs: readonly ElementSpec[]): ElementSpec | undefined {
  return specs.find((spec) => spec.className === "rad-ddlg__resources");
}

function resourceCaption(specs: readonly ElementSpec[]): string | undefined {
  return specs.find((spec) => spec.className === "rad-ddlg__resource-caption")
    ?.text;
}

function resourceItems(specs: readonly ElementSpec[]): string[][] {
  return (resourceList(specs)?.children ?? [])
    .filter((item) => item.className === "rad-ddlg__resource")
    .map((item) => (item.children ?? []).map((child) => child.text ?? ""));
}

function resourceMore(specs: readonly ElementSpec[]): string | undefined {
  return (resourceList(specs)?.children ?? []).find(
    (item) => item.className === "rad-ddlg__resource-more"
  )?.text;
}

describe("delete dialog step specs", () => {
  it("carries the confirmation control on the intent step", () => {
    const specs = deleteDialogIntentSpecs();
    expect(specs.map((spec) => spec.id)).toEqual([
      undefined,
      DELETE_DIALOG_STEP1_BUTTON_ID
    ]);
    expect(specs[0].text).toContain("tear down running containers");
  });

  it("keeps the target names as text rather than markup", () => {
    const specs = deleteDialogEffectsSpecs({
      app: HOSTILE,
      environment: "prod&test"
    });
    const bullet = specs[1].children?.[0].children ?? [];
    expect(bullet.map((child) => child.text)).toEqual([
      "This will permanently delete the deployment of ",
      HOSTILE,
      " from environment ",
      "prod&test",
      ", including all associated resources."
    ]);
  });

  it("places the token in the label and the placeholder attribute only", () => {
    const specs = deleteDialogConfirmSpecs({ app: 'a"b', environment: "e<f" });
    expect(specs[0].text).toBe('To confirm, type "a"b/e<f" in the box below');
    expect(specs[1].attrs?.placeholder).toBe('a"b/e<f');
    expect(specs[2].attrs?.disabled).toBeUndefined();
  });

  it("builds the confirmation token from the target pair", () => {
    expect(deleteDialogConfirmToken("store", "prod")).toBe("store/prod");
    expect(deleteDialogConfirmToken("store", "prod", "abandon")).toBe(
      "store/prod"
    );
  });

  it("builds a distinct stop-tracking warning and confirmation state", () => {
    const intent = deleteDialogIntentSpecs("abandon");
    const effects = deleteDialogEffectsSpecs(
      { app: "store", environment: "prod" },
      "abandon"
    );
    const confirm = deleteDialogConfirmSpecs(
      { app: "store", environment: "prod" },
      "abandon"
    );

    expect(intent[0].text).toContain("does not delete cloud resources");
    expect(intent[1].text).toBe("I want to stop tracking this deployment");
    expect(effects[0].children?.[1].text).toContain(
      "Resources created before the deployment failed may remain"
    );
    expect(
      effects[1].children?.[0].children?.map((child) => child.text)
    ).toEqual([
      "This will stop tracking ",
      "store",
      " in environment ",
      "prod",
      " without changing any cloud resources."
    ]);
    expect(confirm[0].text).toContain('"store/prod"');
    expect(confirm[2].text).toBe("Stop tracking deployment");
  });
});

describe("delete dialog resource list", () => {
  const named = (count: number): { name: string; type: string }[] =>
    Array.from({ length: count }, (_, index) => ({
      name: `resource-${index + 1}`,
      type: "Applications.Core/containers"
    }));

  it("keeps the existing sentence and renders no list without resources", () => {
    for (const resources of [undefined, []]) {
      const specs = deleteDialogEffectsSpecs({
        app: "store",
        environment: "prod",
        resources
      });
      expect(specs.map((spec) => spec.className)).toEqual([
        "rad-ddlg__warn",
        "rad-ddlg__bullet",
        "rad-ddlg__btn"
      ]);
      expect(
        specs[1].children?.[0].children?.map((child) => child.text)
      ).toEqual([
        "This will permanently delete the deployment of ",
        "store",
        " from environment ",
        "prod",
        ", including all associated resources."
      ]);
    }
  });

  it("names each resource and its type as text nodes", () => {
    const specs = deleteDialogEffectsSpecs({
      app: "store",
      environment: "prod",
      resources: [
        { name: "frontend", type: "Applications.Core/containers" },
        { name: "cart", displayType: "Redis cache", type: "Radius.Data/redis" }
      ]
    });

    expect(resourceCaption(specs)).toBe(
      "2 resources last reported for this deployment:"
    );
    expect(resourceList(specs)?.attrs).toEqual({
      tabindex: "0",
      "aria-label": "Resources to be deleted"
    });
    expect(resourceItems(specs)).toEqual([
      ["frontend", "Applications.Core/containers"],
      ["cart", "Redis cache"]
    ]);
    expect(specs[specs.length - 1].id).toBe(DELETE_DIALOG_STEP2_BUTTON_ID);
  });

  it("counts a single resource in the singular", () => {
    const specs = deleteDialogEffectsSpecs({
      app: "store",
      environment: "prod",
      resources: [{ name: "frontend" }]
    });
    expect(resourceCaption(specs)).toBe(
      "1 resource last reported for this deployment:"
    );
    expect(resourceItems(specs)).toEqual([["frontend"]]);
  });

  it("lists every resource up to the limit without a remainder line", () => {
    const specs = deleteDialogEffectsSpecs({
      app: "store",
      environment: "prod",
      resources: named(DELETE_DIALOG_RESOURCE_LIMIT)
    });
    expect(resourceItems(specs)).toHaveLength(DELETE_DIALOG_RESOURCE_LIMIT);
    expect(resourceMore(specs)).toBeUndefined();
  });

  it("truncates past the limit with an accurate remainder", () => {
    const oneOver = deleteDialogEffectsSpecs({
      app: "store",
      environment: "prod",
      resources: named(DELETE_DIALOG_RESOURCE_LIMIT + 1)
    });
    expect(resourceItems(oneOver)).toHaveLength(DELETE_DIALOG_RESOURCE_LIMIT);
    expect(resourceMore(oneOver)).toBe("+1 more");

    const many = deleteDialogEffectsSpecs({
      app: "store",
      environment: "prod",
      resources: named(250)
    });
    expect(resourceCaption(many)).toBe(
      "250 resources last reported for this deployment:"
    );
    expect(resourceItems(many)).toHaveLength(DELETE_DIALOG_RESOURCE_LIMIT);
    expect(resourceMore(many)).toBe(
      `+${250 - DELETE_DIALOG_RESOURCE_LIMIT} more`
    );
  });

  it("drops entries that cannot be named rather than rendering a blank row", () => {
    const specs = deleteDialogEffectsSpecs({
      app: "store",
      environment: "prod",
      resources: [
        { name: "frontend" },
        { name: "   " },
        { name: 42 },
        { type: "Applications.Core/containers" },
        null,
        "cart",
        { name: "  worker  " }
      ]
    });
    expect(resourceCaption(specs)).toBe(
      "2 resources last reported for this deployment:"
    );
    expect(resourceItems(specs)).toEqual([["frontend"], ["worker"]]);
  });

  it("falls back to the sentence when nothing can be named", () => {
    const specs = deleteDialogEffectsSpecs({
      app: "store",
      environment: "prod",
      resources: [{ name: "" }, undefined, { type: "Radius.Data/redis" }]
    });
    expect(specs.map((spec) => spec.className)).toEqual([
      "rad-ddlg__warn",
      "rad-ddlg__bullet",
      "rad-ddlg__btn"
    ]);
  });

  it("keeps duplicate names and their original order", () => {
    const specs = deleteDialogEffectsSpecs({
      app: "store",
      environment: "prod",
      resources: [{ name: "cart" }, { name: "frontend" }, { name: "cart" }]
    });
    expect(resourceItems(specs)).toEqual([["cart"], ["frontend"], ["cart"]]);
  });

  it("keeps a hostile resource name as a text node", () => {
    const specs = deleteDialogEffectsSpecs({
      app: "store",
      environment: "prod",
      resources: [{ name: HOSTILE, type: HOSTILE }]
    });
    expect(resourceItems(specs)).toEqual([[HOSTILE, HOSTILE]]);
    for (const item of resourceList(specs)?.children ?? []) {
      for (const child of item.children ?? []) {
        expect(child.children).toBeUndefined();
      }
    }
  });

  it("summarises the resources the list is built from", () => {
    expect(deleteDialogResourceSummary(undefined)).toEqual([]);
    expect(
      deleteDialogResourceSummary([
        { name: " cart ", displayType: " Redis cache " },
        { name: "worker" }
      ])
    ).toEqual([
      { name: "cart", type: "Redis cache" },
      { name: "worker", type: "" }
    ]);
  });

  it("leaves the stop-tracking step without a resource list", () => {
    const specs = deleteDialogEffectsSpecs(
      {
        app: "store",
        environment: "prod",
        resources: [{ name: "frontend", type: "Applications.Core/containers" }]
      },
      "abandon"
    );
    expect(specs.map((spec) => spec.className)).toEqual([
      "rad-ddlg__warn",
      "rad-ddlg__bullet",
      "rad-ddlg__btn"
    ]);
    expect(resourceList(specs)).toBeUndefined();
  });
});

describe("delete deployment dialog", () => {
  it("returns nothing when the page has no dialog markup", () => {
    const browser = createFakeBrowser();
    expect(createDeleteDeploymentDialog(browser.context)).toBeNull();
    const modalOnly = createFakeBrowser();
    modalOnly.document.add(createFakeElement(DELETE_DIALOG_IDS.modal));
    expect(createDeleteDeploymentDialog(modalOnly.context)).toBeNull();
  });

  it("opens on the first step and names the target", () => {
    const browser = setup();
    const dialog = createDeleteDeploymentDialog(browser.context);
    dialog?.open("store", "prod");

    expect(browser.modal.style.display).toBe("flex");
    expect(browser.app.textContent).toBe("store");
    expect(browser.environment.textContent).toBe("prod");
    expect(fakeText(browser.body)).toContain("confirm your intention");
  });

  it("shows the resources a delete would destroy and still gates on the token", () => {
    const browser = setup();
    const confirmed: Array<[string, string]> = [];
    const dialog = createDeleteDeploymentDialog(browser.context, {
      onConfirm: (app, environment) => confirmed.push([app, environment])
    });
    dialog?.open("store", "prod", [
      { name: "frontend", type: "Applications.Core/containers" },
      ...Array.from({ length: DELETE_DIALOG_RESOURCE_LIMIT }, (_, index) => ({
        name: `extra-${index}`
      }))
    ]);
    fakeById(browser.body, DELETE_DIALOG_STEP1_BUTTON_ID).dispatch("click");

    expect(
      fakeById(browser.body, DELETE_DIALOG_STEP2_BUTTON_ID).focusCount
    ).toBe(1);
    const rendered = fakeTree(browser.body);
    expect(
      rendered
        .filter((element) => element.className === "rad-ddlg__resource")
        .map(fakeText)
    ).toEqual([
      "frontendApplications.Core/containers",
      ...Array.from(
        { length: DELETE_DIALOG_RESOURCE_LIMIT - 1 },
        (_, index) => `extra-${index}`
      )
    ]);
    expect(
      rendered.find(
        (element) => element.className === "rad-ddlg__resource-more"
      )?.textContent
    ).toBe("+1 more");

    fakeById(browser.body, DELETE_DIALOG_STEP2_BUTTON_ID).dispatch("click");
    const confirm = fakeInputById(
      browser.body,
      DELETE_DIALOG_CONFIRM_BUTTON_ID
    );
    expect(confirm.disabled).toBe(true);
    confirm.dispatch("click");
    expect(confirmed).toEqual([]);

    const input = fakeInputById(browser.body, DELETE_DIALOG_CONFIRM_INPUT_ID);
    input.value = "store/prod";
    input.dispatch("input");
    confirm.dispatch("click");
    expect(confirmed).toEqual([["store", "prod"]]);
  });

  it("requires all three steps before confirming", () => {
    const browser = setup();
    const confirmed: Array<[string, string]> = [];
    const dialog = createDeleteDeploymentDialog(browser.context, {
      onConfirm: (app, environment) => confirmed.push([app, environment])
    });

    dialog?.open("store", "prod");
    fakeById(browser.body, DELETE_DIALOG_STEP1_BUTTON_ID).dispatch("click");
    expect(fakeText(browser.body)).toContain("cannot be undone");
    fakeById(browser.body, DELETE_DIALOG_STEP2_BUTTON_ID).dispatch("click");
    const input = fakeInputById(browser.body, DELETE_DIALOG_CONFIRM_INPUT_ID);
    const confirm = fakeInputById(
      browser.body,
      DELETE_DIALOG_CONFIRM_BUTTON_ID
    );
    expect(confirm.disabled).toBe(true);
    expect(confirmed).toEqual([]);

    confirm.dispatch("click");
    expect(confirmed).toEqual([]);

    input.value = "store/prod";
    input.dispatch("input");
    expect(confirm.disabled).toBe(false);
    confirm.dispatch("click");

    expect(confirmed).toEqual([["store", "prod"]]);
    expect(browser.modal.style.display).toBe("none");
    expect(browser.body.children).toHaveLength(0);
  });

  it("requires the abandonment token and supports keyboard confirmation", () => {
    const browser = setup();
    const confirmed: Array<[string, string]> = [];
    const dialog = createDeleteDeploymentDialog(browser.context, {
      variant: "abandon",
      onConfirm: (app, environment) => confirmed.push([app, environment])
    });

    dialog?.open("store", "prod");
    expect(fakeText(browser.body)).toContain("does not delete cloud resources");
    fakeById(browser.body, DELETE_DIALOG_STEP1_BUTTON_ID).dispatch("click");
    expect(fakeText(browser.body)).toContain(
      "Resources created before the deployment failed may remain"
    );
    fakeById(browser.body, DELETE_DIALOG_STEP2_BUTTON_ID).dispatch("click");
    const input = fakeInputById(browser.body, DELETE_DIALOG_CONFIRM_INPUT_ID);
    const confirm = fakeInputById(
      browser.body,
      DELETE_DIALOG_CONFIRM_BUTTON_ID
    );
    expect(input.value).toBe("");
    expect(confirm.disabled).toBe(true);

    input.value = "store/prod";
    input.dispatch("input");
    input.dispatch("keydown", { key: "Enter" });

    expect(confirmed).toEqual([["store", "prod"]]);
    expect(browser.modal.style.display).toBe("none");
  });

  it("keeps deletion disabled until the token matches exactly", () => {
    const browser = setup();
    const dialog = createDeleteDeploymentDialog(browser.context);
    dialog?.open("store", "prod");
    const { input, confirm } = advanceToConfirmation(browser);

    input.value = "store/pro";
    input.dispatch("input");
    expect(confirm.disabled).toBe(true);

    input.value = "  store/prod  ";
    input.dispatch("input");
    expect(confirm.disabled).toBe(false);
  });

  it("confirms on Enter only when the token matches", () => {
    const browser = setup();
    const confirmed: string[] = [];
    const dialog = createDeleteDeploymentDialog(browser.context, {
      onConfirm: (app) => confirmed.push(app)
    });
    dialog?.open("store", "prod");
    const { input } = advanceToConfirmation(browser);

    input.value = "nope";
    input.dispatch("keydown", { key: "Enter" });
    expect(confirmed).toEqual([]);

    input.value = "store/prod";
    input.dispatch("keydown", { key: "Escape" });
    expect(confirmed).toEqual([]);

    input.dispatch("keydown", { key: "Enter" });
    expect(confirmed).toEqual(["store"]);
  });

  it("closes without a callback when none was supplied", () => {
    const browser = setup();
    const dialog = createDeleteDeploymentDialog(browser.context);
    dialog?.open("store", "prod");
    const { input, confirm } = advanceToConfirmation(browser);
    input.value = "store/prod";
    input.dispatch("input");

    expect(() => confirm.dispatch("click")).not.toThrow();
    expect(browser.modal.style.display).toBe("none");
  });

  it("moves focus into the confirmation field", () => {
    const browser = setup();
    const dialog = createDeleteDeploymentDialog(browser.context);
    dialog?.open("store", "prod");
    const { input } = advanceToConfirmation(browser);

    expect(input.focusCount).toBe(1);
  });

  it("renders hostile target names as text nodes only", () => {
    const browser = setup();
    const dialog = createDeleteDeploymentDialog(browser.context);
    dialog?.open(HOSTILE, "prod&test");
    fakeById(browser.body, DELETE_DIALOG_STEP1_BUTTON_ID).dispatch("click");

    expect(fakeText(browser.body)).toContain(HOSTILE);
    for (const node of fakeTree(browser.body)) {
      expect(node.innerHTML).toBe("");
      expect(node.tagName).not.toBe("img");
    }
  });

  it("closes on control, backdrop, and Escape", () => {
    const browser = setup();
    const dialog = createDeleteDeploymentDialog(browser.context);

    dialog?.open("store", "prod");
    browser.closer.dispatch("click");
    expect(browser.modal.style.display).toBe("none");

    dialog?.open("store", "prod");
    browser.modal.dispatch("click", { target: browser.modal });
    expect(browser.modal.style.display).toBe("none");

    dialog?.open("store", "prod");
    browser.modal.dispatch("click", { target: browser.body });
    expect(browser.modal.style.display).toBe("flex");

    browser.document.dispatch("keydown", { key: "Escape" });
    expect(browser.modal.style.display).toBe("none");
  });

  it("ignores Escape and other keys when already closed", () => {
    const browser = setup();
    const dialog = createDeleteDeploymentDialog(browser.context);
    dialog?.open("store", "prod");
    browser.document.dispatch("keydown", { key: "Enter" });
    expect(browser.modal.style.display).toBe("flex");

    dialog?.close();
    browser.document.dispatch("keydown", { key: "Escape" });
    expect(browser.body.children).toHaveLength(0);
  });

  it("restarts at the first step after reopening", () => {
    const browser = setup();
    const dialog = createDeleteDeploymentDialog(browser.context);
    dialog?.open("store", "prod");
    fakeById(browser.body, DELETE_DIALOG_STEP1_BUTTON_ID).dispatch("click");
    dialog?.close();

    dialog?.open("cart", "staging");
    expect(fakeText(browser.body)).toContain("confirm your intention");
    expect(browser.app.textContent).toBe("cart");
  });

  it("prefers the current step's own controls over the close affordance", () => {
    const browser = setup();
    const modalControls = trapControls(browser);
    const stepControl = createFakeElement("del-step-primary", "button");
    browser.body.matches.set(DELETE_DIALOG_FOCUSABLE_SELECTOR, [stepControl]);
    const dialog = createDeleteDeploymentDialog(browser.context);

    dialog?.open("store", "prod");

    expect(stepControl.focusCount).toBe(1);
    expect(modalControls[0].focusCount).toBe(0);
  });

  it("focuses the first dialog control when it opens", () => {
    const browser = setup();
    const controls = trapControls(browser);
    const dialog = createDeleteDeploymentDialog(browser.context);

    dialog?.open("store", "prod");

    expect(controls[0].focusCount).toBe(1);
  });

  it("returns focus to the control that opened it", () => {
    const browser = setup();
    const opener = createFakeElement("deploy-delete-open", "button");
    browser.document.add(opener);
    browser.document.activeElement = opener;
    const dialog = createDeleteDeploymentDialog(browser.context);

    dialog?.open("store", "prod");
    dialog?.close();

    expect(opener.focusCount).toBe(1);
  });

  it("keeps Tab inside the dialog at both edges", () => {
    const browser = setup();
    const controls = trapControls(browser);
    const dialog = createDeleteDeploymentDialog(browser.context);
    dialog?.open("store", "prod");

    browser.document.activeElement = controls[0];
    expect(keydown(browser, "Tab")).toBe(false);
    expect(controls[1].focusCount).toBe(0);

    browser.document.activeElement = controls[1];
    expect(keydown(browser, "Tab")).toBe(true);
    expect(controls[0].focusCount).toBe(2);

    browser.document.activeElement = controls[0];
    expect(keydown(browser, "Tab", true)).toBe(true);
    expect(controls[1].focusCount).toBe(1);
  });

  it("pulls stray focus back into the dialog on Tab", () => {
    const browser = setup();
    const controls = trapControls(browser);
    const dialog = createDeleteDeploymentDialog(browser.context);
    dialog?.open("store", "prod");
    browser.document.activeElement = null;

    keydown(browser, "Tab");
    expect(controls[0].focusCount).toBe(2);

    keydown(browser, "Tab", true);
    expect(controls[1].focusCount).toBe(1);
  });

  it("skips disabled controls and tolerates a dialog with none", () => {
    const browser = setup();
    const controls = trapControls(browser);
    Object.assign(controls[0], { disabled: true });
    const dialog = createDeleteDeploymentDialog(browser.context);
    dialog?.open("store", "prod");
    expect(controls[1].focusCount).toBe(1);

    browser.modal.matches.set(DELETE_DIALOG_FOCUSABLE_SELECTOR, []);
    expect(() => keydown(browser, "Tab")).not.toThrow();
  });

  it("drops the previous step's listeners when the step changes", () => {
    const browser = setup();
    const dialog = createDeleteDeploymentDialog(browser.context);
    dialog?.open("store", "prod");
    const intent = fakeById(browser.body, DELETE_DIALOG_STEP1_BUTTON_ID);
    intent.dispatch("click");

    expect(intent.listenerCount("click")).toBe(0);
    expect(
      fakeById(browser.body, DELETE_DIALOG_STEP2_BUTTON_ID).listenerCount(
        "click"
      )
    ).toBe(1);
  });

  it("teardown removes every installed listener", () => {
    const browser = setup();
    const dialog = createDeleteDeploymentDialog(browser.context);
    dialog?.open("store", "prod");
    const intent = fakeById(browser.body, DELETE_DIALOG_STEP1_BUTTON_ID);
    dialog?.teardown();

    expect(browser.modal.listenerCount()).toBe(0);
    expect(browser.closer.listenerCount()).toBe(0);
    expect(browser.document.listenerCount()).toBe(0);
    expect(intent.listenerCount()).toBe(0);
  });

  it("works without the optional label and close elements", () => {
    const browser = createFakeBrowser();
    const modal = createFakeElement(DELETE_DIALOG_IDS.modal);
    const body = createFakeElement(DELETE_DIALOG_IDS.body);
    browser.document.add(modal);
    browser.document.add(body);

    const dialog = createDeleteDeploymentDialog(browser.context);
    dialog?.open("store", "prod");
    expect(modal.style.display).toBe("flex");
    expect(fakeText(body)).toContain("confirm your intention");
  });

  it("accepts custom element ids", () => {
    const browser = createFakeBrowser();
    const modal = createFakeElement("custom-modal");
    const body = createFakeElement("custom-body");
    const app = createFakeElement("custom-app");
    const environment = createFakeElement("custom-env");
    const closer = createFakeElement("custom-close");
    for (const element of [modal, body, app, environment, closer]) {
      browser.document.add(element);
    }

    const dialog = createDeleteDeploymentDialog(browser.context, {
      modalId: "custom-modal",
      bodyId: "custom-body",
      appId: "custom-app",
      envId: "custom-env",
      closeId: "custom-close"
    });
    dialog?.open("store", "prod");

    expect(modal.style.display).toBe("flex");
    expect(app.textContent).toBe("store");
    expect(environment.textContent).toBe("prod");
    closer.dispatch("click");
    expect(modal.style.display).toBe("none");
  });

  it("fails loudly when the host cannot create a real input control", () => {
    const browser = setup();
    browser.document.createElement = (tagName: string) =>
      createFakeElement("", tagName);
    const dialog = createDeleteDeploymentDialog(browser.context);
    dialog?.open("store", "prod");

    expect(() =>
      fakeById(browser.body, DELETE_DIALOG_STEP1_BUTTON_ID).dispatch("click")
    ).not.toThrow();
    expect(() =>
      fakeById(browser.body, DELETE_DIALOG_STEP2_BUTTON_ID).dispatch("click")
    ).toThrow(/could not create the "del-confirm-input" control/);
  });
});
