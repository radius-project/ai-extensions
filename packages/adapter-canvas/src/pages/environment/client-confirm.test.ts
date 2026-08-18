// Behaviour tests for the shared confirmation dialog fragment. The fragment is
// a browser script string, so it is evaluated with a fake document modelling
// only the dialog's own elements; anything else it reached for would be absent
// rather than silently succeeding.

import { describe, expect, it } from "vitest";
import { ENVIRONMENT_CONFIRM_CLIENT_JS } from "./client-confirm.js";

// A real element drops its children when textContent is assigned, which is how
// the fragment empties the usage list. The fake has to do the same or a stale
// list would look correct.
class FakeNode {
  className = "";
  style = { display: "" };
  children: FakeNode[] = [];
  private text = "";
  get textContent(): string {
    return this.text;
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
}

function node(): FakeNode {
  return new FakeNode();
}

const IDS = [
  "env-confirm-modal",
  "env-confirm-title",
  "env-confirm-message",
  "env-confirm-ok",
  "env-confirm-cancel",
  "env-confirm-usage",
  "env-confirm-usage-label",
  "env-confirm-usage-list"
];

interface ConfirmOptions {
  title?: string;
  message?: string;
  usageLabel?: string;
  usage?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: string;
  onConfirm?: () => void;
}

function harness() {
  const elements: Record<string, FakeNode & Record<string, unknown>> = {};
  const clicks: Record<string, () => void> = {};
  let keydown: ((event: { key: string }) => void) | null = null;
  for (const id of IDS) {
    const el = node() as FakeNode & Record<string, unknown>;
    el.focus = () => {
      focused.push(id);
    };
    el.addEventListener = (_type: string, handler: () => void) => {
      clicks[id] = handler;
    };
    el.appendChild = (child: FakeNode) => {
      el.children.push(child);
    };
    elements[id] = el;
  }
  const focused: string[] = [];
  elements["env-confirm-modal"].style.display = "none";

  const document = {
    getElementById: (id: string) => elements[id] ?? null,
    createElement: () => node(),
    addEventListener: (
      _type: string,
      handler: (event: { key: string }) => void
    ) => {
      keydown = handler;
    }
  };

  const api = new Function(
    "document",
    `${ENVIRONMENT_CONFIRM_CLIENT_JS}; return { showConfirmDialog: showConfirmDialog };`
  )(document) as { showConfirmDialog: (options: ConfirmOptions) => void };

  return {
    show: api.showConfirmDialog,
    el: (id: string) => elements[id],
    click: (id: string) => clicks[id](),
    pressEscape: () => keydown?.({ key: "Escape" }),
    pressEnter: () => keydown?.({ key: "Enter" }),
    focused
  };
}

describe("confirmation dialog", () => {
  it("defaults to a destructive confirm and a plain Cancel", () => {
    const dom = harness();
    dom.show({ title: "Delete environment?", message: "This is permanent." });
    expect(dom.el("env-confirm-title").textContent).toBe("Delete environment?");
    expect(dom.el("env-confirm-message").textContent).toBe(
      "This is permanent."
    );
    expect(dom.el("env-confirm-ok").textContent).toBe("Delete");
    expect(dom.el("env-confirm-ok").className).toBe(
      "rad-btn rad-btn--danger-outline"
    );
    expect(dom.el("env-confirm-cancel").textContent).toBe("Cancel");
    expect(dom.el("env-confirm-modal").style.display).toBe("flex");
    // Focus never starts on the destructive button.
    expect(dom.focused).toEqual(["env-confirm-cancel"]);
  });

  it("describes a navigation choice with its own labels and a non-destructive button", () => {
    const dom = harness();
    dom.show({
      title: "Delete the application first",
      confirmLabel: "Go to Deployments",
      cancelLabel: "Stay here",
      confirmVariant: "primary"
    });
    expect(dom.el("env-confirm-ok").textContent).toBe("Go to Deployments");
    expect(dom.el("env-confirm-ok").className).toBe("rad-btn rad-btn--primary");
    expect(dom.el("env-confirm-cancel").textContent).toBe("Stay here");
  });

  it("does not leave one caller's variant or labels on the next dialog", () => {
    const dom = harness();
    dom.show({
      confirmVariant: "primary",
      confirmLabel: "Go",
      cancelLabel: "Stay"
    });
    dom.show({ title: "Delete profile?" });
    expect(dom.el("env-confirm-ok").className).toBe(
      "rad-btn rad-btn--danger-outline"
    );
    expect(dom.el("env-confirm-ok").textContent).toBe("Delete");
    expect(dom.el("env-confirm-cancel").textContent).toBe("Cancel");
  });

  it("lists what the action affects, and hides the block when nothing does", () => {
    const dom = harness();
    dom.show({ usageLabel: "Used by:", usage: ["prod", "staging"] });
    expect(dom.el("env-confirm-usage").style.display).toBe("");
    expect(
      dom.el("env-confirm-usage-list").children.map((c) => c.textContent)
    ).toEqual(["prod", "staging"]);
    dom.show({});
    expect(dom.el("env-confirm-usage").style.display).toBe("none");
    expect(dom.el("env-confirm-usage-list").children).toEqual([]);
  });

  it("runs the action once confirmed, and closes first so the dialog cannot re-fire", () => {
    const runs: number[] = [];
    const dom = harness();
    dom.show({ onConfirm: () => runs.push(1) });
    dom.click("env-confirm-ok");
    expect(runs).toEqual([1]);
    expect(dom.el("env-confirm-modal").style.display).toBe("none");
    dom.click("env-confirm-ok");
    expect(runs).toEqual([1]);
  });

  it("dismisses without running the action, through Cancel or Escape", () => {
    const runs: number[] = [];
    const cancelled = harness();
    cancelled.show({ onConfirm: () => runs.push(1) });
    cancelled.click("env-confirm-cancel");
    expect(cancelled.el("env-confirm-modal").style.display).toBe("none");

    const escaped = harness();
    escaped.show({ onConfirm: () => runs.push(1) });
    escaped.pressEscape();
    expect(escaped.el("env-confirm-modal").style.display).toBe("none");
    expect(runs).toEqual([]);
  });

  it("ignores other keys, and Escape while no dialog is open", () => {
    const dom = harness();
    dom.show({});
    dom.pressEnter();
    expect(dom.el("env-confirm-modal").style.display).toBe("flex");
    dom.click("env-confirm-cancel");
    dom.pressEscape();
    expect(dom.el("env-confirm-modal").style.display).toBe("none");
  });
});
