// Browser component layer (P1-A): the run-command callout in a real DOM.
//
// The collocated unit suite drives `createCommandAction` through recorded fakes,
// which cannot show whether a real click reaches the handler, whether a disabled
// button actually suppresses one, or whether the rebuilt DOM survives a
// re-render. Everything here runs the shipped module in Chromium through the
// production `resolveBrowserContext`, with only the network and clipboard edges
// controlled.
//
// Network interception is the scope's own `fetch` rather than Mock Service
// Worker: `msw` is not a dependency of this repository and the component config
// has never installed a worker. The boundary is still the browser's outward
// edge, and every request is asserted, so a request that escaped the callout
// would fail here.

import { describe, it, expect, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { remediationView } from "@radius-project/core/remediations";
import { createCommandAction } from "../../src/browser/command-action.js";
import { createRealScope, jsonResponse } from "./support/real-scope.js";
import type { CommandActionHandle } from "../../src/browser/command-action.js";
import type { DomElement } from "../../src/browser/ports.js";
import type { RealScope, RealScopeOptions } from "./support/real-scope.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const NONCE = "nonce-1";

const LOW = remediationView("azure-cli-login", { tenantId: TENANT });
const HIGH = remediationView("git-push-branch", { branch: "feature-branch" });
// A branch name that could not be pushed safely is refused by the registry,
// so the callout has to offer the action disabled rather than enabled.
const UNSUPPORTED = remediationView("git-push-branch", {
  branch: "feature; rm -rf /"
});

interface Mounted {
  readonly scope: RealScope;
  readonly action: CommandActionHandle;
}

const open: Mounted[] = [];

afterEach(() => {
  for (const mounted of open.splice(0).reverse()) {
    mounted.action.dispose();
    mounted.scope.dispose();
  }
});

function mount(
  remediation = LOW,
  options: RealScopeOptions = {},
  idPrefix = "run"
): Mounted {
  const scope = createRealScope(options);
  const action = createCommandAction(scope.context, {
    host: scope.host as unknown as DomElement,
    remediation,
    mutationNonce: NONCE,
    idPrefix
  });
  const mounted = { scope, action };
  open.push(mounted);
  return mounted;
}

function button(name: RegExp): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

describe("run-command callout in Chromium", () => {
  it("shows the command and hands a low-impact one off on a single click", async () => {
    const user = userEvent.setup();
    const { scope } = mount();

    expect(scope.host.textContent).toContain(LOW.command);

    await user.click(button(/^Run with Copilot$/));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain(
        "Copilot was asked to run this command"
      );
    });
    expect(scope.requests).toHaveLength(1);
    expect(scope.requests[0]).toMatchObject({
      url: "/api/run-remediation",
      method: "POST",
      body: {
        id: "azure-cli-login",
        params: { tenantId: TENANT },
        confirmed: false
      }
    });
    expect(scope.requests[0].headers["x-radius-mutation-nonce"]).toBe(NONCE);
  });

  it("copies the command to the clipboard and restores the label", async () => {
    const user = userEvent.setup();
    const { scope } = mount();

    await user.click(button(/^Copy$/));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Copied$/ })).toBeTruthy();
    });
    expect(scope.copied).toEqual([LOW.command]);
    expect(scope.requests).toEqual([]);

    await waitFor(
      () => {
        expect(screen.getByRole("button", { name: /^Copy$/ })).toBeTruthy();
      },
      { timeout: 5_000 }
    );
  });

  it("keeps the label unchanged when the browser refuses the clipboard", async () => {
    const user = userEvent.setup();
    const { scope } = mount(LOW, { clipboardWorks: false });

    await user.click(button(/^Copy$/));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Copy$/ })).toBeTruthy();
    });
    expect(scope.copied).toEqual([]);
  });

  it("asks a second time before sending a high-impact command", async () => {
    const user = userEvent.setup();
    const { scope } = mount(HIGH);

    await user.click(button(/^Run with Copilot$/));

    expect(screen.getByRole("alert").textContent).toBe(HIGH.confirmBody);
    expect(document.activeElement).toBe(
      button(new RegExp(`^${HIGH.confirmLabel}$`))
    );
    expect(scope.requests).toEqual([]);

    await user.click(button(new RegExp(`^${HIGH.confirmLabel}$`)));

    await waitFor(() => {
      expect(scope.requests).toHaveLength(1);
    });
    expect(document.activeElement).toBe(screen.getByRole("status"));
    expect(scope.requests[0].body).toMatchObject({
      id: "git-push-branch",
      confirmed: true
    });
  });

  it("cancels a high-impact confirmation without sending anything", async () => {
    const user = userEvent.setup();
    const { scope } = mount(HIGH);

    await user.click(button(/^Run with Copilot$/));
    await user.click(button(/^Cancel$/));

    expect(screen.getByRole("status").textContent).toBe(
      "Cancelled. Nothing was run."
    );
    expect(scope.requests).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("status"));
  });

  it("reports the server's reason when the hand-off is refused", async () => {
    const user = userEvent.setup();
    mount(LOW, {
      route: () => jsonResponse(503, { error: "No Copilot session is joined." })
    });

    await user.click(button(/^Run with Copilot$/));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain(
        "No Copilot session is joined."
      );
    });
    expect(screen.getByRole("button", { name: /^Try again$/ })).toBeTruthy();
  });

  it("recovers from a transport failure and can be retried", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const { scope } = mount(LOW, {
      route: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("offline");
        return jsonResponse(200, { status: "handed-off" });
      }
    });

    await user.click(button(/^Run with Copilot$/));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain(
        "The canvas could not reach the Radius server."
      );
    });

    await user.click(button(/^Try again$/));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain(
        "Copilot was asked to run this command"
      );
    });
    expect(scope.requests).toHaveLength(2);
  });

  it("offers a disabled run with a stated reason when the command is not supported", async () => {
    // A disabled button has no pointer events, which user-event refuses to
    // click by default; the check is relaxed so the click really is dispatched
    // and the button's own disabled state is what suppresses it.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { scope } = mount(UNSUPPORTED);

    const run = button(/^Run with Copilot$/);
    expect(run.disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe(
      UNSUPPORTED.unsupportedReason
    );

    await user.click(run);

    expect(scope.requests).toEqual([]);
    expect(screen.queryByRole("button", { name: /^Copy$/ })).toBeNull();
  });

  it("empties the host and ignores a late response once disposed", async () => {
    const user = userEvent.setup();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The response resolves only after dispose, so a callout that still
    // rendered would repopulate a host the surface already tore down.
    const { scope, action } = mount(LOW, {
      route: async () => {
        await gate;
        return jsonResponse(200, { status: "handed-off" });
      }
    });

    await user.click(button(/^Run with Copilot$/));
    await waitFor(() => {
      expect(scope.requests).toHaveLength(1);
    });

    action.dispose();
    expect(scope.host.childNodes.length).toBe(0);

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scope.host.childNodes.length).toBe(0);
  });
});
