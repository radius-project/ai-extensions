import { beginEntry, NOOP_TEARDOWN } from "./lifecycle.js";
import { isRecord, readString } from "./json.js";
import type { BrowserTeardown } from "./lifecycle.js";
import type { BrowserContext, DomElement } from "./ports.js";

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
}

export function parseOperationStatus(payload: unknown): OperationStatus | null {
  if (!isRecord(payload)) return null;
  const operation = payload.operation;
  if (!isRecord(operation)) return null;
  const state = readString(operation, "state");
  if (state === "") return null;
  return {
    operationId: readString(operation, "operationId"),
    state,
    environment: readString(operation, "environment"),
    summary: readString(operation, "summary")
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
      return `${environment} setup stopped`;
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
    if (panelIsOnScreen(context.dom.byId(OPERATION_PANEL_ID))) return hide();
    if (!status) return hide();
    const text = operationChipLabel(status);
    if (text === "") return hide();
    const terminal = status.state !== "running";
    if (terminal && acknowledged(status.operationId)) return hide();
    chip.className = `rad-opchip ${operationChipTone(status.state)}`;
    if (label) label.textContent = text;
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
