import { describe, expect, it, vi } from "vitest";
import { createEnvironmentConfirmDialog } from "./confirm-dialog.js";
import {
  createFakeBrowser,
  createFakeElement,
  fakeText
} from "../../../test/support/browser/fakes.js";
import type { FakeElement } from "../../../test/support/browser/fakes.js";

const REQUIRED_IDS = [
  "env-confirm-modal",
  "env-confirm-title",
  "env-confirm-message",
  "env-confirm-usage",
  "env-confirm-usage-label",
  "env-confirm-usage-list",
  "env-confirm-cancel",
  "env-confirm-ok"
] as const;

function dialogPage(omit?: (typeof REQUIRED_IDS)[number]) {
  const browser = createFakeBrowser();
  const elements: Record<string, FakeElement> = {};
  for (const id of REQUIRED_IDS) {
    if (id === omit) continue;
    const element = createFakeElement(id);
    // The page renders the modal hidden, and the dialog only ever reveals it.
    if (id === "env-confirm-modal") element.style.display = "none";
    elements[id] = element;
    browser.document.add(element);
  }
  return { browser, elements };
}

function openDialog() {
  const page = dialogPage();
  const dialog = createEnvironmentConfirmDialog(page.browser.context);
  if (!dialog) throw new Error("Expected a confirm dialog.");
  return { ...page, dialog };
}

describe("createEnvironmentConfirmDialog", () => {
  it.each(REQUIRED_IDS)("refuses to build without %s", (missing) => {
    const page = dialogPage(missing);
    expect(createEnvironmentConfirmDialog(page.browser.context)).toBeNull();
  });

  it("presents a destructive confirmation by default", () => {
    const { dialog, elements } = openDialog();
    const onConfirm = vi.fn();

    dialog.show({
      title: "Delete environment?",
      message: "This deletes the GitHub environment.",
      confirmLabel: "Delete environment",
      onConfirm
    });

    expect(elements["env-confirm-modal"].style.display).toBe("flex");
    expect(elements["env-confirm-title"].textContent).toBe(
      "Delete environment?"
    );
    expect(elements["env-confirm-message"].textContent).toBe(
      "This deletes the GitHub environment."
    );
    expect(elements["env-confirm-ok"].textContent).toBe("Delete environment");
    expect(elements["env-confirm-ok"].className).toBe(
      "rad-btn rad-btn--danger-outline"
    );
    // Cancel is focused so the destructive action is never the default target
    // of a stray Enter press.
    expect(elements["env-confirm-cancel"].textContent).toBe("Cancel");
    expect(elements["env-confirm-cancel"].focusCount).toBe(1);
    expect(elements["env-confirm-usage"].style.display).toBe("none");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("presents a navigational confirmation as the primary action", () => {
    const { dialog, elements } = openDialog();

    dialog.show({
      title: "Delete the application first",
      message: "Nothing has been deleted.",
      confirmLabel: "Go to Deployments",
      confirmVariant: "primary",
      cancelLabel: "Stay here",
      onConfirm: vi.fn()
    });

    expect(elements["env-confirm-ok"].className).toBe(
      "rad-btn rad-btn--primary"
    );
    expect(elements["env-confirm-cancel"].textContent).toBe("Stay here");
  });

  it("hides cancel and focuses confirm for an acknowledgement dialog", () => {
    const { dialog, elements, browser } = openDialog();

    dialog.show({
      title: "Environment deleted",
      message: "The app registration was left in place.",
      confirmLabel: "Done",
      confirmVariant: "primary",
      hideCancel: true,
      onConfirm: vi.fn()
    });

    expect(elements["env-confirm-modal"].style.display).toBe("flex");
    expect(elements["env-confirm-cancel"].style.display).toBe("none");
    // Confirm is the only actionable button, so it takes focus rather than
    // cancel.
    expect(elements["env-confirm-ok"].focusCount).toBe(1);
    expect(elements["env-confirm-cancel"].focusCount).toBe(0);

    // Tab keeps focus on confirm instead of cycling onto the hidden cancel.
    browser.document.activeElement = elements["env-confirm-ok"];
    browser.document.dispatch("keydown", { key: "Tab" });
    expect(elements["env-confirm-ok"].focusCount).toBe(2);
    expect(elements["env-confirm-cancel"].focusCount).toBe(0);
  });

  it("renders an external link inline with an acknowledgement message", () => {
    const { dialog, elements } = openDialog();

    dialog.show({
      title: "Environment deleted",
      message: "Delete the retained app registration in the ",
      messageLink: {
        label: "Azure portal",
        href: "https://portal.azure.com/#view/apps",
        suffix: "."
      },
      confirmLabel: "Done",
      hideCancel: true,
      onConfirm: vi.fn()
    });

    const message = elements["env-confirm-message"];
    expect(fakeText(message)).toBe(
      "Delete the retained app registration in the Azure portal."
    );
    const link = message.children[1];
    expect(link?.textContent).toBe("Azure portal");
    expect(link?.getAttribute("href")).toBe(
      "https://portal.azure.com/#view/apps"
    );
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("restores the cancel button on a later dialog after hiding it once", () => {
    const { dialog, elements } = openDialog();

    dialog.show({
      title: "Environment deleted",
      message: "Acknowledgement only.",
      confirmLabel: "Done",
      hideCancel: true,
      onConfirm: vi.fn()
    });
    expect(elements["env-confirm-cancel"].style.display).toBe("none");

    dialog.show({
      title: "Delete environment?",
      message: "This deletes the GitHub environment.",
      confirmLabel: "Delete environment",
      onConfirm: vi.fn()
    });
    expect(elements["env-confirm-cancel"].style.display).toBe("");
  });

  it("lists the usage it was given and hides the block without any", () => {
    const { dialog, elements } = openDialog();

    dialog.show({
      title: "Delete credential profile?",
      message: "This deletes the profile.",
      usageLabel: "These environments were created from it:",
      usage: ["dev", "prod"],
      confirmLabel: "Delete profile",
      onConfirm: vi.fn()
    });

    expect(elements["env-confirm-usage"].style.display).toBe("");
    expect(elements["env-confirm-usage-label"].textContent).toBe(
      "These environments were created from it:"
    );
    expect(fakeText(elements["env-confirm-usage-list"])).toBe("devprod");

    dialog.show({
      title: "Delete credential profile?",
      message: "This deletes the profile.",
      confirmLabel: "Delete profile",
      onConfirm: vi.fn()
    });

    expect(elements["env-confirm-usage"].style.display).toBe("none");
    expect(fakeText(elements["env-confirm-usage-list"])).toBe("");
    expect(elements["env-confirm-usage-label"].textContent).toBe("");
  });

  // A standalone caution, such as the forced-delete orphan warning, has no
  // list behind it but must still be shown.
  it("shows the caution block for a label with no usage entries", () => {
    const { dialog, elements } = openDialog();

    dialog.show({
      title: "Force delete this deployment?",
      message: "It may still be updating.",
      usageLabel: "Resources may be left behind.",
      confirmLabel: "Force delete",
      onConfirm: vi.fn()
    });

    expect(elements["env-confirm-usage"].style.display).toBe("");
    expect(elements["env-confirm-usage-label"].textContent).toBe(
      "Resources may be left behind."
    );
    expect(fakeText(elements["env-confirm-usage-list"])).toBe("");
  });

  it("does not leak one caller's presentation into the next dialog", () => {
    const { dialog, elements } = openDialog();

    dialog.show({
      title: "Delete the application first",
      message: "Nothing has been deleted.",
      confirmLabel: "Go to Deployments",
      confirmVariant: "primary",
      cancelLabel: "Stay here",
      onConfirm: vi.fn()
    });
    dialog.show({
      title: "Delete environment?",
      message: "This deletes the GitHub environment.",
      confirmLabel: "Delete environment",
      onConfirm: vi.fn()
    });

    expect(elements["env-confirm-ok"].className).toBe(
      "rad-btn rad-btn--danger-outline"
    );
    expect(elements["env-confirm-cancel"].textContent).toBe("Cancel");
  });

  it("runs the pending action exactly once on confirmation", () => {
    const { dialog, elements } = openDialog();
    const onConfirm = vi.fn();
    dialog.show({
      title: "Delete environment?",
      message: "This deletes the GitHub environment.",
      confirmLabel: "Delete environment",
      onConfirm
    });

    elements["env-confirm-ok"].dispatch("click");
    elements["env-confirm-ok"].dispatch("click");

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(elements["env-confirm-modal"].style.display).toBe("none");
  });

  it("closes without error when confirmed with no onConfirm handler", () => {
    const { dialog, elements } = openDialog();
    // A pure acknowledgement dialog (e.g. the "Environment deleted" notice)
    // supplies no onConfirm: confirming simply closes it.
    dialog.show({
      title: "Environment deleted",
      message: "The environment was deleted.",
      confirmLabel: "Done",
      hideCancel: true
    });

    expect(elements["env-confirm-modal"].style.display).toBe("flex");
    expect(() => elements["env-confirm-ok"].dispatch("click")).not.toThrow();
    expect(elements["env-confirm-modal"].style.display).toBe("none");
  });

  it.each([
    [
      "cancel",
      (elements: Record<string, FakeElement>) =>
        elements["env-confirm-cancel"].dispatch("click")
    ],
    [
      "Escape",
      (
        _: Record<string, FakeElement>,
        browser: ReturnType<typeof createFakeBrowser>
      ) => browser.document.dispatch("keydown", { key: "Escape" })
    ]
  ])("dismisses without acting on %s", (_name, dismiss) => {
    const { dialog, elements, browser } = openDialog();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    dialog.show({
      title: "Delete environment?",
      message: "This deletes the GitHub environment.",
      confirmLabel: "Delete environment",
      onConfirm,
      onCancel
    });

    dismiss(elements, browser);

    expect(elements["env-confirm-modal"].style.display).toBe("none");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
    // The dismissed action stays dismissed even if the confirm button is
    // somehow clicked afterwards.
    elements["env-confirm-ok"].dispatch("click");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("traps Tab between the dialog's two buttons", () => {
    const { dialog, elements, browser } = openDialog();
    dialog.show({
      title: "Delete environment?",
      message: "This deletes the GitHub environment.",
      confirmLabel: "Delete environment",
      onConfirm: vi.fn()
    });

    // The dialog is aria-modal, so Tab must cycle inside it rather than walk
    // into the page behind it.
    browser.document.activeElement = elements["env-confirm-cancel"];
    browser.document.dispatch("keydown", { key: "Tab" });
    expect(elements["env-confirm-ok"].focusCount).toBe(1);

    browser.document.activeElement = elements["env-confirm-ok"];
    browser.document.dispatch("keydown", { key: "Tab" });
    expect(elements["env-confirm-cancel"].focusCount).toBe(2);
  });

  it("traps Shift+Tab in the opposite direction", () => {
    const { dialog, elements, browser } = openDialog();
    dialog.show({
      title: "Delete environment?",
      message: "This deletes the GitHub environment.",
      confirmLabel: "Delete environment",
      onConfirm: vi.fn()
    });

    browser.document.activeElement = elements["env-confirm-cancel"];
    browser.document.dispatch("keydown", { key: "Tab", shiftKey: true });
    expect(elements["env-confirm-ok"].focusCount).toBe(1);

    browser.document.activeElement = elements["env-confirm-ok"];
    browser.document.dispatch("keydown", { key: "Tab", shiftKey: true });
    expect(elements["env-confirm-cancel"].focusCount).toBe(2);
  });

  it("leaves Tab alone while the dialog is closed", () => {
    const { elements, browser } = openDialog();

    browser.document.activeElement = elements["env-confirm-cancel"];
    browser.document.dispatch("keydown", { key: "Tab" });

    expect(elements["env-confirm-ok"].focusCount).toBe(0);
  });

  it("returns focus to the element that opened it", () => {
    const { dialog, elements, browser } = openDialog();
    const trigger = createFakeElement("delete-btn");
    browser.document.add(trigger);
    browser.document.activeElement = trigger;

    dialog.show({
      title: "Delete environment?",
      message: "This deletes the GitHub environment.",
      confirmLabel: "Delete environment",
      onConfirm: vi.fn()
    });
    browser.document.activeElement = elements["env-confirm-cancel"];
    browser.document.dispatch("keydown", { key: "Escape" });

    // Keyboard users must land back on the trigger, not at the top of the page.
    expect(trigger.focusCount).toBe(1);
  });

  it("does not steal focus back when torn down", () => {
    const { dialog, browser } = openDialog();
    const trigger = createFakeElement("delete-btn");
    browser.document.add(trigger);
    browser.document.activeElement = trigger;

    dialog.show({
      title: "Delete environment?",
      message: "This deletes the GitHub environment.",
      confirmLabel: "Delete environment",
      onConfirm: vi.fn()
    });
    dialog.teardown();

    expect(trigger.focusCount).toBe(0);
  });

  it("ignores keys other than Escape while open", () => {
    const { dialog, elements, browser } = openDialog();
    dialog.show({
      title: "Delete environment?",
      message: "This deletes the GitHub environment.",
      confirmLabel: "Delete environment",
      onConfirm: vi.fn()
    });

    browser.document.dispatch("keydown", { key: "Enter" });

    expect(elements["env-confirm-modal"].style.display).toBe("flex");
  });

  it("leaves the page alone when Escape is pressed while closed", () => {
    const { elements, browser } = openDialog();

    browser.document.dispatch("keydown", { key: "Escape" });

    // Escape belongs to whatever is actually on screen, so a dialog that was
    // never opened stays hidden and stays inert.
    expect(elements["env-confirm-modal"].style.display).toBe("none");
  });

  it("closes on request and drops the pending action", () => {
    const { dialog, elements } = openDialog();
    const onConfirm = vi.fn();
    dialog.show({
      title: "Delete environment?",
      message: "This deletes the GitHub environment.",
      confirmLabel: "Delete environment",
      onConfirm
    });

    dialog.close();

    expect(elements["env-confirm-modal"].style.display).toBe("none");
    elements["env-confirm-ok"].dispatch("click");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("releases every listener on teardown and stays inert afterwards", () => {
    const { dialog, elements, browser } = openDialog();
    const onConfirm = vi.fn();
    dialog.show({
      title: "Delete environment?",
      message: "This deletes the GitHub environment.",
      confirmLabel: "Delete environment",
      onConfirm
    });

    dialog.teardown();
    dialog.teardown();

    expect(elements["env-confirm-modal"].style.display).toBe("none");
    expect(elements["env-confirm-ok"].listenerCount()).toBe(0);
    expect(elements["env-confirm-cancel"].listenerCount()).toBe(0);
    expect(browser.document.listenerCount("keydown")).toBe(0);
    elements["env-confirm-ok"].dispatch("click");
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
