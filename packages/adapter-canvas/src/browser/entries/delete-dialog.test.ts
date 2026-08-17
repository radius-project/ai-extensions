import { describe, expect, it } from "vitest";
import {
  createFakeBrowserScope,
  createFakeElement,
  fakeById,
  fakeInputById,
  fakeText
} from "../../../test/support/browser/fakes.js";
import {
  DELETE_DIALOG_CONFIRM_BUTTON_ID,
  DELETE_DIALOG_CONFIRM_INPUT_ID,
  DELETE_DIALOG_IDS,
  DELETE_DIALOG_STEP1_BUTTON_ID,
  DELETE_DIALOG_STEP2_BUTTON_ID
} from "../delete-dialog.js";
import { PAGE_REGISTRY_GLOBAL, requireBrowserFunction } from "../globals.js";
import { resolvePageRegistry } from "../registry.js";
import {
  DELETE_DIALOG_FACTORY_GLOBAL,
  installDeleteDialogEntry
} from "./delete-dialog.js";

interface OpenableDialog {
  open(app: string, environment: string): void;
  close(): void;
}

function asDialog(value: unknown): OpenableDialog {
  if (
    typeof value === "object" &&
    value !== null &&
    "open" in value &&
    typeof value.open === "function" &&
    "close" in value &&
    typeof value.close === "function"
  ) {
    return value as OpenableDialog;
  }
  throw new Error("The factory did not return a dialog.");
}

function dialogMarkup(browser: ReturnType<typeof createFakeBrowserScope>) {
  const modal = createFakeElement(DELETE_DIALOG_IDS.modal);
  const body = createFakeElement(DELETE_DIALOG_IDS.body);
  for (const element of [
    modal,
    body,
    createFakeElement(DELETE_DIALOG_IDS.app),
    createFakeElement(DELETE_DIALOG_IDS.environment),
    createFakeElement(DELETE_DIALOG_IDS.close)
  ]) {
    browser.document.add(element);
  }
  return { modal, body };
}

describe("delete dialog browser entry", () => {
  it("publishes only the factory alongside the shared page registry", () => {
    const browser = createFakeBrowserScope();
    const { modal, body } = dialogMarkup(browser);

    installDeleteDialogEntry(browser.scope);

    expect(browser.scope[PAGE_REGISTRY_GLOBAL]).toBe(
      resolvePageRegistry(browser.scope)
    );
    expect(
      Object.keys(browser.scope).filter((name) => name.startsWith("radius"))
    ).toEqual([PAGE_REGISTRY_GLOBAL, DELETE_DIALOG_FACTORY_GLOBAL]);

    const dialog = asDialog(
      requireBrowserFunction(browser.scope, DELETE_DIALOG_FACTORY_GLOBAL)(null)
    );
    dialog.open("store", "prod");
    expect(modal.style.display).toBe("flex");
    expect(fakeText(body)).toContain("confirm your intention");
  });

  it("forwards a callable confirmation handler through all three steps", () => {
    const browser = createFakeBrowserScope();
    const { body } = dialogMarkup(browser);
    const confirmed: Array<[string, string]> = [];

    installDeleteDialogEntry(browser.scope);
    const dialog = asDialog(
      requireBrowserFunction(
        browser.scope,
        DELETE_DIALOG_FACTORY_GLOBAL
      )({
        onConfirm: (app: string, environment: string) => {
          confirmed.push([app, environment]);
        }
      })
    );

    dialog.open("store", "prod");
    fakeById(body, DELETE_DIALOG_STEP1_BUTTON_ID).dispatch("click");
    fakeById(body, DELETE_DIALOG_STEP2_BUTTON_ID).dispatch("click");
    const input = fakeInputById(body, DELETE_DIALOG_CONFIRM_INPUT_ID);
    input.value = "store/prod";
    input.dispatch("input");
    fakeInputById(body, DELETE_DIALOG_CONFIRM_BUTTON_ID).dispatch("click");

    expect(confirmed).toEqual([["store", "prod"]]);
  });

  it("forwards custom element ids", () => {
    const browser = createFakeBrowserScope();
    const ids = {
      modalId: "modal",
      bodyId: "body",
      appId: "app",
      envId: "env",
      closeId: "close"
    };
    const elements = new Map(
      Object.values(ids).map((id) => [id, createFakeElement(id)])
    );
    for (const element of elements.values()) browser.document.add(element);

    installDeleteDialogEntry(browser.scope);
    const dialog = asDialog(
      requireBrowserFunction(
        browser.scope,
        DELETE_DIALOG_FACTORY_GLOBAL
      )({ ...ids })
    );

    dialog.open("store", "prod");
    expect(elements.get("modal")?.style.display).toBe("flex");
    expect(elements.get("app")?.textContent).toBe("store");
    expect(elements.get("env")?.textContent).toBe("prod");
    elements.get("close")?.dispatch("click");
    expect(elements.get("modal")?.style.display).toBe("none");
  });

  it("ignores malformed option fields and non-callable handlers", () => {
    const browser = createFakeBrowserScope();
    const { modal, body } = dialogMarkup(browser);

    installDeleteDialogEntry(browser.scope);
    const dialog = asDialog(
      requireBrowserFunction(
        browser.scope,
        DELETE_DIALOG_FACTORY_GLOBAL
      )({
        modalId: 7,
        bodyId: false,
        appId: [],
        envId: {},
        closeId: null,
        onConfirm: "not callable"
      })
    );

    dialog.open("store", "prod");
    fakeById(body, DELETE_DIALOG_STEP1_BUTTON_ID).dispatch("click");
    fakeById(body, DELETE_DIALOG_STEP2_BUTTON_ID).dispatch("click");
    const input = fakeInputById(body, DELETE_DIALOG_CONFIRM_INPUT_ID);
    input.value = "store/prod";
    input.dispatch("input");

    expect(() =>
      fakeInputById(body, DELETE_DIALOG_CONFIRM_BUTTON_ID).dispatch("click")
    ).not.toThrow();
    expect(modal.style.display).toBe("none");
  });

  it("returns nothing on a page without dialog markup", () => {
    const browser = createFakeBrowserScope();

    installDeleteDialogEntry(browser.scope);

    expect(
      requireBrowserFunction(
        browser.scope,
        DELETE_DIALOG_FACTORY_GLOBAL
      )(undefined)
    ).toBeNull();
  });
});
