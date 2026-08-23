// Shared "run this command" affordance for canvas warnings and suggestions.
//
// Several surfaces tell the user to run a terminal command. This turns that
// prose into an action: the command is shown verbatim, Copy always works, and
// Run hands the command to the Copilot session through
// `POST /api/run-remediation`.
//
// Two constraints shape the state model:
//
//  1. The canvas never runs the command itself and cannot observe its exit
//     status, so this reports only what it genuinely owns — confirming,
//     sending, handed off, hand-off failed, cancelled — and points at the chat
//     for the run. It must never claim a success it did not observe.
//  2. A high-impact command (machine-wide account switch, granted token scope,
//     remote write) takes a second explicit confirmation in the callout before
//     anything is sent. The server independently refuses an unconfirmed
//     high-impact request, so this is guidance, not the security boundary.

import type { RemediationView } from "@radius-project/core/remediations";
import { buildElement } from "./dom.js";
import type { ElementSpec } from "./dom.js";
import type { BrowserContext, DomElement } from "./ports.js";

export type CommandActionPhase =
  "idle" | "confirming" | "sending" | "sent" | "failed" | "cancelled";

export interface CommandActionState {
  readonly remediation: RemediationView;
  readonly phase: CommandActionPhase;
  /** Failure detail from the hand-off attempt. Empty in every other phase. */
  readonly error: string;
  readonly copied: boolean;
}

export interface CommandActionButtonView {
  readonly label: string;
  readonly disabled: boolean;
  readonly title: string;
}

export interface CommandActionView {
  readonly command: string;
  readonly cwdNote: string;
  readonly copy: CommandActionButtonView;
  readonly run: CommandActionButtonView;
  readonly cancelVisible: boolean;
  readonly confirmText: string;
  readonly statusText: string;
  readonly statusTone: "neutral" | "pending" | "success" | "danger";
}

export const COMMAND_COPY_LABEL = "Copy";
export const COMMAND_COPIED_LABEL = "Copied";
export const COMMAND_RUN_LABEL = "Run with Copilot";
export const COMMAND_SENDING_LABEL = "Sending…";
export const COMMAND_COPY_RESET_MS = 1500;

export function initialCommandActionState(
  remediation: RemediationView
): CommandActionState {
  return { remediation, phase: "idle", error: "", copied: false };
}

function runLabelFor(state: CommandActionState): string {
  if (state.phase === "sending") return COMMAND_SENDING_LABEL;
  if (state.phase === "confirming") return state.remediation.confirmLabel;
  if (state.phase === "failed") return "Try again";
  if (state.phase === "sent") return "Ask again";
  return COMMAND_RUN_LABEL;
}

function statusFor(state: CommandActionState): {
  text: string;
  tone: CommandActionView["statusTone"];
} {
  switch (state.phase) {
    case "sending":
      return { text: "Asking Copilot to run this command…", tone: "pending" };
    case "sent":
      return {
        text: `Copilot was asked to run this command. Follow it in the chat. ${state.remediation.followUp}`,
        tone: "success"
      };
    case "failed":
      return {
        text: `Copilot could not be asked to run this command. ${state.error}`.trim(),
        tone: "danger"
      };
    case "cancelled":
      return { text: "Cancelled. Nothing was run.", tone: "neutral" };
    default:
      return { text: "", tone: "neutral" };
  }
}

/**
 * Project the callout state onto exactly what the DOM shows.
 *
 * Pure and total: every phase, and the non-runnable case, resolves to a
 * complete view, so a surface never has to decide what a state looks like.
 */
export function commandActionView(
  state: CommandActionState
): CommandActionView {
  const { remediation } = state;
  const status = statusFor(state);
  const runnable = remediation.runnable;
  return {
    command: remediation.command,
    cwdNote:
      remediation.cwd === "workspace" ?
        "Runs in this repository's workspace."
      : "",
    copy: {
      label: state.copied ? COMMAND_COPIED_LABEL : COMMAND_COPY_LABEL,
      // Copy is never taken away: it is the fallback when the action cannot
      // run at all, including when Radius does not offer to run this command.
      disabled: false,
      title: `Copy \`${remediation.command}\` to the clipboard`
    },
    run: {
      label: runLabelFor(state),
      disabled: !runnable || state.phase === "sending",
      title:
        !runnable ? remediation.unsupportedReason
        : state.phase === "confirming" ? remediation.confirmBody
        : `Ask Copilot to run \`${remediation.command}\``
    },
    cancelVisible: runnable && state.phase === "confirming",
    confirmText: state.phase === "confirming" ? remediation.confirmBody : "",
    statusText:
      !runnable && status.text === "" ?
        remediation.unsupportedReason
      : status.text,
    statusTone: !runnable && status.text === "" ? "neutral" : status.tone
  };
}

const TONE_COLORS: Readonly<Record<CommandActionView["statusTone"], string>> = {
  neutral: "var(--rad-text-tertiary)",
  pending: "var(--rad-text-secondary)",
  success: "var(--rad-primary)",
  danger: "var(--rad-danger)"
};

/**
 * The callout's markup, split into the pieces a caller has to wire.
 *
 * Buttons are returned separately rather than nested in one spec so the mount
 * can hold direct references to them: several callouts can share a page, so
 * looking them up by document id would be ambiguous.
 */
export interface CommandActionSpecs {
  readonly container: ElementSpec;
  readonly buttons: readonly ElementSpec[];
  readonly status: ElementSpec | null;
}

export function commandActionSpecs(
  view: CommandActionView,
  idPrefix: string
): CommandActionSpecs {
  const children: ElementSpec[] = [
    {
      tag: "code",
      className: "rad-command-action-command",
      text: view.command
    }
  ];
  if (view.cwdNote !== "") {
    children.push({
      tag: "div",
      className: "rad-command-action-cwd",
      text: view.cwdNote
    });
  }
  if (view.confirmText !== "") {
    children.push({
      tag: "div",
      className: "rad-command-action-confirm",
      attrs: { role: "alert" },
      text: view.confirmText
    });
  }
  const buttons: ElementSpec[] = [
    {
      tag: "button",
      id: `${idPrefix}-copy`,
      className: "rad-btn rad-btn-secondary",
      text: view.copy.label,
      attrs: { type: "button", title: view.copy.title }
    },
    {
      tag: "button",
      id: `${idPrefix}-run`,
      className: "rad-btn rad-btn-primary",
      text: view.run.label,
      attrs: {
        type: "button",
        title: view.run.title,
        ...(view.run.disabled ? { disabled: "disabled" } : {})
      }
    }
  ];
  if (view.cancelVisible) {
    buttons.push({
      tag: "button",
      id: `${idPrefix}-cancel`,
      className: "rad-btn rad-btn-secondary",
      text: "Cancel",
      attrs: { type: "button" }
    });
  }
  return {
    container: {
      tag: "div",
      className: "rad-command-action",
      children
    },
    buttons,
    status:
      view.statusText === "" ?
        null
      : {
          tag: "div",
          className: "rad-command-action-status",
          attrs: {
            role: "status",
            style: `color:${TONE_COLORS[view.statusTone]}`
          },
          text: view.statusText
        }
  };
}

export interface CommandActionOptions {
  readonly host: DomElement;
  readonly remediation: RemediationView;
  /** Nonce for `X-Radius-Mutation-Nonce`; the route rejects a request without it. */
  readonly mutationNonce: string;
  readonly idPrefix: string;
}

export interface CommandActionHandle {
  render(): void;
  readonly state: () => CommandActionState;
  /** Clear the callout and any pending timer. Safe to call more than once. */
  dispose(): void;
}

interface RunResponsePayload {
  error?: unknown;
}

function messageOf(payload: unknown, fallback: string): string {
  if (typeof payload === "object" && payload !== null) {
    const error = (payload as RunResponsePayload).error;
    if (typeof error === "string" && error !== "") return error;
  }
  return fallback;
}

/**
 * Mount a command callout into `host` and keep it in sync with its own state.
 *
 * The handle is intentionally small: surfaces mount a callout and let it own
 * its interaction, rather than reaching into its phases.
 */
export function createCommandAction(
  context: BrowserContext,
  options: CommandActionOptions
): CommandActionHandle {
  let state = initialCommandActionState(options.remediation);
  let copyReset: number | null = null;
  let disposed = false;

  function render(): void {
    const view = commandActionView(state);
    const specs = commandActionSpecs(view, options.idPrefix);
    const root = buildElement(context.dom, specs.container);
    const row = buildElement(context.dom, {
      tag: "div",
      className: "rad-command-action-buttons"
    });
    const listeners = [onCopy, onRun, onCancel];
    specs.buttons.forEach((spec, index) => {
      const button = buildElement(context.dom, spec);
      // Real buttons need the property, not only the attribute, for the click
      // to be suppressed.
      Reflect.set(button, "disabled", spec.attrs?.disabled !== undefined);
      button.addEventListener("click", listeners[index]);
      row.appendChild(button);
    });
    root.appendChild(row);
    if (specs.status !== null) {
      root.appendChild(buildElement(context.dom, specs.status));
    }
    options.host.replaceChildren(root);
  }

  function update(next: Partial<CommandActionState>): void {
    // A response can land after the surface tore the callout down; dropping it
    // keeps the disposed host empty.
    if (disposed) return;
    state = { ...state, ...next };
    render();
  }

  function onCopy(): void {
    void context.clipboard.write(state.remediation.command).then((ok) => {
      if (!ok) return;
      update({ copied: true });
      if (copyReset !== null) context.clock.clearTimeout(copyReset);
      copyReset = context.clock.setTimeout(() => {
        copyReset = null;
        update({ copied: false });
      }, COMMAND_COPY_RESET_MS);
    });
  }

  function onCancel(): void {
    update({ phase: "cancelled", error: "" });
  }

  function onRun(): void {
    if (!state.remediation.runnable || state.phase === "sending") return;
    // A high-impact command asks once more, in place, before anything is sent.
    if (state.remediation.impact === "high" && state.phase !== "confirming") {
      update({ phase: "confirming", error: "" });
      return;
    }
    const confirmed = state.remediation.impact === "high";
    update({ phase: "sending", error: "" });
    void send(confirmed);
  }

  async function send(confirmed: boolean): Promise<void> {
    try {
      const response = await context.net.fetch("/api/run-remediation", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Radius-Mutation-Nonce": options.mutationNonce
        },
        body: JSON.stringify({
          id: state.remediation.id,
          params: state.remediation.params,
          confirmed
        })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        update({
          phase: "failed",
          error: messageOf(payload, `Request failed (${response.status}).`)
        });
        return;
      }
      update({ phase: "sent", error: "" });
    } catch (e) {
      context.logger.error("Radius could not run a suggested command.", e);
      update({
        phase: "failed",
        error: "The canvas could not reach the Radius server."
      });
    }
  }

  function dispose(): void {
    if (copyReset !== null) {
      context.clock.clearTimeout(copyReset);
      copyReset = null;
    }
    disposed = true;
    options.host.replaceChildren();
  }

  render();
  return { render, state: () => state, dispose };
}
