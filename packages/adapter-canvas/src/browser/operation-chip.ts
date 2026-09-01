import { beginEntry, NOOP_TEARDOWN } from "./lifecycle.js";
import { isRecord, readString } from "./json.js";
import type { BrowserTeardown } from "./lifecycle.js";
import type { BrowserContext, DomElement } from "./ports.js";
import {
  isSetupDeletedReason,
  SETUP_EXITED_REASON
} from "../operation-terminal-reasons.js";

// ─── Operation status chip ───────────────────────────────────────────────────
// The ambient tier of the notification model. Environment creation takes
// minutes, and the panel that narrates it lives on one page — so a user who
// goes to look at the app graph while it runs would otherwise have no way of
// knowing it finished. That is the failure the non-blocking panel would
// introduce: we would have traded trapping the user for losing them.
//
// This chip is deliberately the quietest thing that closes that gap. It never
// takes focus, never navigates on its own, and never moves the page. It appears
// in the corner of the nav bar, says what is happening in three or four words,
// and links back to the environments page. Auto-focusing the panel on
// completion was considered and rejected: it re-creates the modal's sin with
// worse timing, yanking the user out of whatever they moved on to.

export const OPERATION_CHIP_ENTRY_KEY = "operation-chip";
export const OPERATION_CHIP_ID = "rad-opchip";
export const OPERATION_CHIP_LABEL_ID = "rad-opchip-label";
export const OPERATION_PANEL_ID = "env-progress-panel";
export const OPERATION_CHIP_ACK_KEY = "radiusOpChipAck";
export const OPERATION_STATUS_PATH = "/api/operations";
export const OPERATION_POLL_MS = 5000;

export interface OperationStatus {
  operationId: string;
  state: string;
  environment: string;
  summary: string;
  terminalReason: string;
}

export function parseOperationStatus(payload: unknown): OperationStatus | null {
  if (!isRecord(payload)) return null;
  const operation = payload.operation;
  if (!isRecord(operation)) return null;
  const state = readString(operation, "state");
  if (state === "") return null;
  const terminal = operation.terminal;
  return {
    operationId: readString(operation, "operationId"),
    state,
    environment: readString(operation, "environment"),
    summary: readString(operation, "summary"),
    terminalReason: isRecord(terminal) ? readString(terminal, "reason") : ""
  };
}

export function operationChipLabel(status: OperationStatus): string {
  const environment = status.environment || "environment";
  switch (status.state) {
    case "running":
      return `Setting up ${environment}…`;
    case "succeeded":
      return `${environment} ready`;
    case "succeeded_with_warnings":
      return `${environment} ready · warnings`;
    case "action_required":
      return `${environment} needs you`;
    case "failed":
    case "failed_partial":
      return `${environment} setup failed`;
    case "cancelled":
      if (isSetupDeletedReason(status.terminalReason)) {
        return `${environment} setup deleted`;
      }
      if (status.terminalReason === SETUP_EXITED_REASON) {
        return `${environment} setup closed`;
      }
      return `${environment} setup paused`;
    default:
      return "";
  }
}

export function operationChipTone(state: string): string {
  if (state === "running") return "rad-opchip--running";
  if (state === "succeeded") return "rad-opchip--done";
  if (state === "succeeded_with_warnings" || state === "action_required") {
    return "rad-opchip--warn";
  }
  if (state === "failed" || state === "failed_partial") {
    return "rad-opchip--failed";
  }
  return "";
}

function panelIsOnScreen(panel: DomElement | null): boolean {
  return (
    panel !== null &&
    panel.style.display !== "none" &&
    panel.offsetParent !== null
  );
}

export interface OperationChipOptions {
  pollMs?: number;
}

export function initializeOperationChip(
  context: BrowserContext,
  options: OperationChipOptions = {}
): BrowserTeardown {
  const chip = context.dom.byId(OPERATION_CHIP_ID);
  if (!chip) return NOOP_TEARDOWN;
  const scope = beginEntry(context, OPERATION_CHIP_ENTRY_KEY);
  if (!scope) return NOOP_TEARDOWN;

  const pollMs = options.pollMs ?? OPERATION_POLL_MS;
  const label = context.dom.byId(OPERATION_CHIP_LABEL_ID);
  let issued = 0;
  let applied = 0;
  let outstanding = 0;

  const hide = (): void => {
    chip.hidden = true;
  };

  // A terminal chip is dismissed once, per operation, for the life of the
  // canvas session. Records are retained server-side for an hour so a returning
  // user can still find out what happened; without this the chip would nag for
  // that whole hour.
  const acknowledge = (operationId: string | undefined): void => {
    if (!operationId) return;
    try {
      context.storage.set(OPERATION_CHIP_ACK_KEY, operationId);
    } catch (error) {
      context.logger.error(
        "Radius could not persist the operation acknowledgement.",
        error
      );
    }
  };

  const acknowledged = (operationId: string): boolean => {
    if (!operationId) return false;
    try {
      return context.storage.get(OPERATION_CHIP_ACK_KEY) === operationId;
    } catch (error) {
      context.logger.error(
        "Radius could not read the operation acknowledgement.",
        error
      );
      return false;
    }
  };

  const render = (status: OperationStatus | null): void => {
    // The inline panel is the better surface whenever it is on screen, and two
    // widgets narrating the same operation is noise, not redundancy.
    if (panelIsOnScreen(context.dom.byId(OPERATION_PANEL_ID))) return hide();
    if (!status) return hide();
    const text = operationChipLabel(status);
    if (text === "") return hide();
    const terminal = status.state !== "running";
    if (terminal && acknowledged(status.operationId)) return hide();
    chip.className = `rad-opchip ${operationChipTone(status.state)}`;
    if (label) label.textContent = text;
    // The full sentence goes in the tooltip and the accessible name, so the
    // three-word chip is never the only thing on offer.
    chip.setAttribute("title", status.summary || text);
    chip.setAttribute("aria-label", status.summary || text);
    chip.hidden = false;
    chip.dataset.operationId = status.operationId;
    chip.dataset.state = status.state;
  };

  const poll = (force = false): Promise<void> => {
    if (!force && outstanding > 0) return Promise.resolve();
    outstanding += 1;
    const token = ++issued;
    return context.net
      .fetch(OPERATION_STATUS_PATH, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (payload) => {
          if (!scope.active || token <= applied) return;
          applied = token;
          render(parseOperationStatus(payload));
        },
        // A dropped poll means the server is idle or restarting, which the
        // heartbeat already handles. Leaving the chip as it was is more honest
        // than inventing a failure state for it.
        () => {}
      )
      .then(() => {
        outstanding -= 1;
      });
  };

  scope.on(chip, "click", () => {
    acknowledge(chip.dataset.operationId);
  });
  scope.on(context.dom.document, "visibilitychange", () => {
    if (context.dom.document.visibilityState === "visible") void poll(true);
  });
  scope.every(pollMs, () => {
    void poll();
  });
  void poll();

  return () => {
    scope.teardown();
  };
}
