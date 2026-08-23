import { describe, expect, it } from "vitest";
import { remediationView } from "@radius-project/core";
import type { RemediationView } from "@radius-project/core";
import {
  COMMAND_COPIED_LABEL,
  COMMAND_COPY_LABEL,
  COMMAND_COPY_RESET_MS,
  COMMAND_RUN_LABEL,
  COMMAND_SENDING_LABEL,
  commandActionSpecs,
  commandActionView,
  createCommandAction,
  initialCommandActionState
} from "./command-action.js";
import type { CommandActionPhase } from "./command-action.js";
import {
  createFakeBrowser,
  createFakeElement
} from "../../test/support/browser/fakes.js";
import type { FakeElement } from "../../test/support/browser/fakes.js";
import type { BrowserContext, HttpResponse } from "./ports.js";

const NONCE = "browser-nonce";
const LOW = remediationView("azure-cli-login", {});
const HIGH = remediationView("git-push-branch", { branch: "feature/cache" });
const UNSUPPORTED = remediationView("git-push-branch", { branch: "../evil" });

function stateWith(
  remediation: RemediationView,
  phase: CommandActionPhase,
  error = ""
) {
  return { ...initialCommandActionState(remediation), phase, error };
}

describe("commandActionView", () => {
  it("offers Copy and Run for a runnable command at rest", () => {
    const view = commandActionView(initialCommandActionState(LOW));

    expect(view.command).toBe("az login --use-device-code");
    expect(view.copy).toEqual({
      label: COMMAND_COPY_LABEL,
      disabled: false,
      title: "Copy `az login --use-device-code` to the clipboard"
    });
    expect(view.run.label).toBe(COMMAND_RUN_LABEL);
    expect(view.run.disabled).toBe(false);
    expect(view.cancelVisible).toBe(false);
    expect(view.statusText).toBe("");
  });

  it("shows the copied label once the command was copied", () => {
    const view = commandActionView({
      ...initialCommandActionState(LOW),
      copied: true
    });

    expect(view.copy.label).toBe(COMMAND_COPIED_LABEL);
    expect(view.copy.disabled).toBe(false);
  });

  it("asks for confirmation before a high-impact command", () => {
    const view = commandActionView(stateWith(HIGH, "confirming"));

    expect(view.run.label).toBe(HIGH.confirmLabel);
    expect(view.confirmText).toBe(HIGH.confirmBody);
    expect(view.cancelVisible).toBe(true);
  });

  it("disables Run while sending but keeps Copy available", () => {
    const view = commandActionView(stateWith(LOW, "sending"));

    expect(view.run.label).toBe(COMMAND_SENDING_LABEL);
    expect(view.run.disabled).toBe(true);
    expect(view.copy.disabled).toBe(false);
    expect(view.statusTone).toBe("pending");
  });

  it("reports a hand-off without claiming the command succeeded", () => {
    const view = commandActionView(stateWith(LOW, "sent"));

    expect(view.statusText).toContain("Copilot was asked to run this command");
    expect(view.statusText).toContain(LOW.followUp);
    expect(view.statusText).not.toContain("succeeded");
    expect(view.statusTone).toBe("success");
    expect(view.run.label).toBe("Ask again");
  });

  it("reports a hand-off failure with its detail and offers a retry", () => {
    const view = commandActionView(stateWith(LOW, "failed", "No session."));

    expect(view.statusText).toBe(
      "Copilot could not be asked to run this command. No session."
    );
    expect(view.statusTone).toBe("danger");
    expect(view.run.label).toBe("Try again");
  });

  it("reports a cancellation as nothing having run", () => {
    const view = commandActionView(stateWith(HIGH, "cancelled"));

    expect(view.statusText).toBe("Cancelled. Nothing was run.");
    expect(view.statusTone).toBe("neutral");
    expect(view.cancelVisible).toBe(false);
  });

  it("disables Run with a stated reason when the command is not offered", () => {
    const view = commandActionView(initialCommandActionState(UNSUPPORTED));

    expect(UNSUPPORTED.runnable).toBe(false);
    expect(view.run.disabled).toBe(true);
    expect(view.run.title).toBe(UNSUPPORTED.unsupportedReason);
    expect(view.statusText).toBe(UNSUPPORTED.unsupportedReason);
    // Copy is the fallback and must survive the disabled action.
    expect(view.copy.disabled).toBe(false);
  });

  it("keeps a reported outcome visible for a non-runnable command", () => {
    const view = commandActionView(stateWith(UNSUPPORTED, "cancelled"));

    expect(view.statusText).toBe("Cancelled. Nothing was run.");
  });

  it("notes the workspace requirement only for workspace commands", () => {
    expect(commandActionView(initialCommandActionState(HIGH)).cwdNote).toBe(
      "Runs in this repository's workspace."
    );
    expect(commandActionView(initialCommandActionState(LOW)).cwdNote).toBe("");
  });
});

describe("commandActionSpecs", () => {
  it("renders the command, buttons and no status at rest", () => {
    const specs = commandActionSpecs(
      commandActionView(initialCommandActionState(LOW)),
      "azure"
    );

    expect(specs.container.children?.[0]).toMatchObject({
      tag: "code",
      text: "az login --use-device-code"
    });
    expect(specs.buttons.map((button) => button.id)).toEqual([
      "azure-copy",
      "azure-run"
    ]);
    expect(specs.buttons[1].attrs?.disabled).toBeUndefined();
    expect(specs.status).toBeNull();
  });

  it("adds a cancel button and a confirmation block while confirming", () => {
    const specs = commandActionSpecs(
      commandActionView(stateWith(HIGH, "confirming")),
      "push"
    );

    expect(specs.buttons.map((button) => button.id)).toEqual([
      "push-copy",
      "push-run",
      "push-cancel"
    ]);
    expect(
      specs.container.children?.some(
        (child) => child.className === "rad-command-action-confirm"
      )
    ).toBe(true);
  });

  it("marks the run button disabled and renders a status when one exists", () => {
    const specs = commandActionSpecs(
      commandActionView(stateWith(LOW, "sending")),
      "azure"
    );

    expect(specs.buttons[1].attrs?.disabled).toBe("disabled");
    expect(specs.status).toMatchObject({
      attrs: { role: "status", style: "color:var(--rad-text-secondary)" }
    });
  });

  it.each([
    ["sent", "color:var(--rad-primary)"],
    ["failed", "color:var(--rad-danger)"],
    ["cancelled", "color:var(--rad-text-tertiary)"]
  ] as const)("tones the %s status", (phase, style) => {
    const specs = commandActionSpecs(
      commandActionView(stateWith(LOW, phase, "boom")),
      "azure"
    );

    expect(specs.status?.attrs?.style).toBe(style);
  });
});

interface MountResponse {
  ok: boolean;
  status: number;
  /** `undefined` models a body that is not JSON. */
  body: unknown;
}

interface MountOptions {
  remediation?: RemediationView;
  responses?: MountResponse[];
  fetchThrows?: boolean;
  clipboardOk?: boolean;
}

function mount(options: MountOptions = {}) {
  const browser = createFakeBrowser();
  const host = createFakeElement("host");
  const responses = [...(options.responses ?? [])];

  browser.net.handle("/api/run-remediation", () => {
    if (options.fetchThrows) throw new Error("offline");
    const next = responses.shift() ?? { ok: true, status: 200, body: {} };
    const response: HttpResponse = {
      ok: next.ok,
      status: next.status,
      text: () => Promise.resolve(JSON.stringify(next.body ?? "")),
      json: () =>
        next.body === undefined ?
          Promise.reject(new Error("not json"))
        : Promise.resolve(next.body)
    };
    return response;
  });

  const context: BrowserContext = {
    ...browser.context,
    clipboard: {
      write: (text: string) => {
        browser.clipboard.writes.push(text);
        return Promise.resolve(options.clipboardOk !== false);
      }
    }
  };

  const handle = createCommandAction(context, {
    host,
    remediation: options.remediation ?? LOW,
    mutationNonce: NONCE,
    idPrefix: "callout"
  });

  function button(role: "copy" | "run" | "cancel"): FakeElement | undefined {
    const root = host.children[0];
    const row = root.children.find(
      (child) => child.className === "rad-command-action-buttons"
    );
    return row?.children.find((child) => child.id === `callout-${role}`);
  }

  function statusText(): string {
    const root = host.children[0];
    return (
      root.children.find(
        (child) => child.className === "rad-command-action-status"
      )?.textContent ?? ""
    );
  }

  // Three microtask turns drain fetch -> json -> state update.
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  }

  return {
    browser,
    host,
    handle,
    requests: browser.net.calls,
    errors: browser.logger.errors,
    button,
    statusText,
    settle
  };
}

describe("createCommandAction", () => {
  it("mounts the callout immediately", () => {
    const mounted = mount();

    expect(mounted.host.children).toHaveLength(1);
    expect(mounted.button("copy")?.textContent).toBe(COMMAND_COPY_LABEL);
    expect(mounted.button("cancel")).toBeUndefined();
  });

  it("copies the command and restores the label after the reset delay", async () => {
    const mounted = mount();

    mounted.button("copy")?.dispatch("click");
    await mounted.settle();

    expect(mounted.button("copy")?.textContent).toBe(COMMAND_COPIED_LABEL);
    mounted.browser.clock.tick(COMMAND_COPY_RESET_MS);
    expect(mounted.button("copy")?.textContent).toBe(COMMAND_COPY_LABEL);
  });

  it("restarts the reset timer when the command is copied twice", async () => {
    const mounted = mount();

    mounted.button("copy")?.dispatch("click");
    await mounted.settle();
    mounted.button("copy")?.dispatch("click");
    await mounted.settle();

    expect(mounted.button("copy")?.textContent).toBe(COMMAND_COPIED_LABEL);
    mounted.browser.clock.tick(COMMAND_COPY_RESET_MS);
    expect(mounted.button("copy")?.textContent).toBe(COMMAND_COPY_LABEL);
  });

  it("leaves the label alone when the clipboard refuses", async () => {
    const mounted = mount({ clipboardOk: false });

    mounted.button("copy")?.dispatch("click");
    await mounted.settle();

    expect(mounted.button("copy")?.textContent).toBe(COMMAND_COPY_LABEL);
  });

  it("sends a low-impact command straight to the session", async () => {
    const mounted = mount({
      responses: [{ ok: true, status: 200, body: { success: true } }]
    });

    mounted.button("run")?.dispatch("click");
    await mounted.settle();

    expect(mounted.requests).toHaveLength(1);
    expect(mounted.requests[0].url).toBe("/api/run-remediation");
    const init = mounted.requests[0].init as {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    };
    expect(init.method).toBe("POST");
    expect(init.headers?.["X-Radius-Mutation-Nonce"]).toBe(NONCE);
    expect(JSON.parse(String(init.body))).toEqual({
      id: LOW.id,
      params: LOW.params,
      confirmed: false
    });
    expect(mounted.statusText()).toContain("Copilot was asked to run");
  });

  it("takes a second confirmation before a high-impact command", async () => {
    const mounted = mount({ remediation: HIGH });

    mounted.button("run")?.dispatch("click");
    expect(mounted.requests).toHaveLength(0);
    expect(mounted.button("run")?.textContent).toBe(HIGH.confirmLabel);
    expect(mounted.button("cancel")).toBeDefined();

    mounted.button("run")?.dispatch("click");
    await mounted.settle();

    expect(mounted.requests).toHaveLength(1);
    const body = JSON.parse(
      String((mounted.requests[0].init as { body?: string }).body)
    ) as { confirmed: boolean };
    expect(body.confirmed).toBe(true);
  });

  it("cancels a high-impact command without sending anything", () => {
    const mounted = mount({ remediation: HIGH });

    mounted.button("run")?.dispatch("click");
    mounted.button("cancel")?.dispatch("click");

    expect(mounted.requests).toHaveLength(0);
    expect(mounted.statusText()).toBe("Cancelled. Nothing was run.");
  });

  it("reports the server's reason when the hand-off is refused", async () => {
    const mounted = mount({
      responses: [
        { ok: false, status: 503, body: { error: "No Copilot session." } }
      ]
    });

    mounted.button("run")?.dispatch("click");
    await mounted.settle();

    expect(mounted.statusText()).toBe(
      "Copilot could not be asked to run this command. No Copilot session."
    );
  });

  it.each([
    ["a payload without an error field", {}],
    ["a non-object payload", "nope"]
  ])("falls back to the status code for %s", async (_label, body) => {
    const mounted = mount({ responses: [{ ok: false, status: 502, body }] });

    mounted.button("run")?.dispatch("click");
    await mounted.settle();

    expect(mounted.statusText()).toContain("Request failed (502).");
  });

  it("falls back to the status code when the failure body is not JSON", async () => {
    const mounted = mount({
      responses: [{ ok: false, status: 400, body: undefined }]
    });

    mounted.button("run")?.dispatch("click");
    await mounted.settle();

    expect(mounted.statusText()).toContain("Request failed (400).");
  });

  it("reports a transport failure and logs it", async () => {
    const mounted = mount({ fetchThrows: true });

    mounted.button("run")?.dispatch("click");
    await mounted.settle();

    expect(mounted.statusText()).toContain(
      "The canvas could not reach the Radius server."
    );
    expect(mounted.errors).toHaveLength(1);
  });

  it("ignores a click on a command Radius does not offer to run", () => {
    const mounted = mount({ remediation: UNSUPPORTED });

    mounted.button("run")?.dispatch("click");

    expect(mounted.requests).toHaveLength(0);
    expect(mounted.statusText()).toBe(UNSUPPORTED.unsupportedReason);
  });

  it("ignores a second run click while a hand-off is in flight", async () => {
    const mounted = mount();

    mounted.button("run")?.dispatch("click");
    mounted.button("run")?.dispatch("click");
    await mounted.settle();

    expect(mounted.requests).toHaveLength(1);
  });

  it("exposes its state and re-renders on demand", () => {
    const mounted = mount();

    expect(mounted.handle.state().phase).toBe("idle");
    mounted.handle.render();
    expect(mounted.host.children).toHaveLength(1);
  });

  it("clears the callout and any pending timer when disposed", async () => {
    const mounted = mount();

    mounted.button("copy")?.dispatch("click");
    await mounted.settle();
    expect(mounted.browser.clock.pending).toBeGreaterThan(0);

    mounted.handle.dispose();

    expect(mounted.browser.clock.pending).toBe(0);
    expect(mounted.host.children).toHaveLength(0);
  });

  it("stays empty when a hand-off resolves after it was disposed", async () => {
    const mounted = mount();

    mounted.button("run")?.dispatch("click");
    mounted.handle.dispose();
    await mounted.settle();

    expect(mounted.host.children).toHaveLength(0);
  });

  it("can be disposed more than once", () => {
    const mounted = mount();

    mounted.handle.dispose();

    expect(() => mounted.handle.dispose()).not.toThrow();
  });
});
