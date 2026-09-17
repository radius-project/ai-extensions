import { readString, isRecord } from "./json.js";
import { beginEntry } from "./lifecycle.js";
import type { BrowserContext } from "./ports.js";

const inactiveControls = {
  observe: (_id: string, _state?: string) => {},
  teardown: () => {}
};
const unconfirmedControl =
  "The control could not be confirmed. Read the same operation before trying another action.";
class LifecycleControlFailure extends Error {
  constructor(readonly code: string) {
    super(
      code === "REPAIR_LIMIT_REACHED" ?
        "The shared repair budget is exhausted. No new repair was started."
      : code === "FORBIDDEN" ?
        "Current authorization does not allow this control. Review the operation and obtain fresh approval."
      : code === "SOURCE_CHANGED" || code === "EVIDENCE_MISMATCH" ?
        "Source or execution evidence changed. Review the current operation before authorizing another control."
      : unconfirmedControl
    );
  }
}
export function isLifecycleAction(kind: string): boolean {
  return [
    "lifecycle.authenticate",
    "lifecycle.configure",
    "lifecycle.repair",
    "lifecycle.cancel"
  ].includes(kind);
}
export function lifecycleControlRequest(
  operationId: string,
  action: { readonly id: string; readonly kind: string; readonly path: string }
): { readonly path: string; readonly body: string } | null {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(operationId) ||
    !action.id ||
    !isLifecycleAction(action.kind)
  )
    return null;
  const suffix =
    action.kind === "lifecycle.repair" ? "retry/repair"
    : action.kind === "lifecycle.cancel" ? "cancel-workflow"
    : "continue";
  const path = `/api/operations/${encodeURIComponent(operationId)}/${suffix}`;
  if (action.path !== path) return null;
  return {
    path,
    body: JSON.stringify(
      action.kind === "lifecycle.repair" ?
        { repairPolicy: { mode: "manual", maxAttempts: 5 } }
      : action.kind === "lifecycle.cancel" ? {}
      : { actionId: action.id, choice: "continue" }
    )
  };
}

export function createLifecycleControls(
  context: BrowserContext,
  mutationNonce: string
) {
  const panel = context.dom.byId("lifecycle-controls");
  const status = context.dom.byId("lifecycle-control-status");
  const repair = context.dom.inputById("lifecycle-repair");
  const cancel = context.dom.inputById("lifecycle-cancel");
  if (!panel || !status || !repair || !cancel) return inactiveControls;
  const scope = beginEntry(context, "lifecycle-controls");
  if (!scope) return inactiveControls;
  let operationId = "";
  let observedState = "";
  const superseded = new Set<string>();
  const allowed = new Map<string, { path: string; body: string }>();
  let generation = 0;
  let pending = false;
  const requests = new Set<
    NonNullable<ReturnType<BrowserContext["net"]["createAbort"]>>
  >();
  async function fetchJson(path: string, body?: string) {
    const abort = context.net.createAbort();
    if (abort) requests.add(abort);
    try {
      const response = await context.net.fetch(path, {
        ...(body !== undefined ?
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Radius-Mutation-Nonce": mutationNonce
            },
            body
          }
        : {}),
        ...(abort ? { signal: abort.signal } : {})
      });
      const payload: unknown = await response.json();
      if (!response.ok)
        throw new LifecycleControlFailure(readString(payload, "code"));
      return payload;
    } finally {
      if (abort) requests.delete(abort);
    }
  }
  const hideControls = () => {
    allowed.clear();
    repair.style.display = "none";
    cancel.style.display = "none";
  };
  const render = (payload: unknown) => {
    const operation = isRecord(payload) ? payload.operation : undefined;
    if (
      !isRecord(operation) ||
      readString(operation, "operationId") !== operationId
    )
      throw new Error("Operation evidence does not match.");
    panel.style.display = "block";
    status.textContent = readString(operation, "summary");
    hideControls();
    const actions = operation.actions;
    if (Array.isArray(actions))
      for (const action of actions) {
        if (!isRecord(action)) continue;
        const kind = readString(action, "kind");
        const request = lifecycleControlRequest(operationId, {
          id: readString(action, "id"),
          kind,
          path: readString(action, "path")
        });
        if (!request) continue;
        const button =
          kind === "lifecycle.repair" ? repair
          : kind === "lifecycle.cancel" ? cancel
          : undefined;
        if (button) {
          allowed.set(kind, request);
          button.style.display = "";
          button.disabled = pending;
        }
      }
  };
  const refresh = async (id: string, expected: number) => {
    try {
      const payload = await fetchJson(
        `/api/operations/${encodeURIComponent(id)}`
      );
      if (!scope.active || expected !== generation) return;
      render(payload);
    } catch {
      if (!scope.active || expected !== generation) return;
      status.textContent =
        "Operation evidence is unavailable. No repair, cancellation confirmation or rollback is inferred.";
      panel.style.display = "block";
      hideControls();
    }
  };
  const observe = (id: string, state = "") => {
    if (
      !scope.active ||
      pending ||
      superseded.has(id) ||
      (id === operationId && state === observedState) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(id)
    )
      return;
    operationId = id;
    observedState = state;
    hideControls();
    void refresh(id, ++generation);
  };
  const submit = (kind: "lifecycle.repair" | "lifecycle.cancel") => {
    const request = allowed.get(kind);
    if (!scope.active || pending || !operationId || !request) return;
    const expected = ++generation;
    pending = true;
    status.setAttribute("tabindex", "-1");
    context.focus.focus(status);
    repair.disabled = true;
    cancel.disabled = true;
    status.textContent =
      kind === "lifecycle.repair" ?
        "Requesting approved bounded repair; publication and deployment are not authorized."
      : "Requesting cancellation; termination and cleanup are not yet confirmed.";
    void fetchJson(request.path, request.body)
      .then(async (payload) => {
        if (!scope.active) return;
        const id = readString(payload, "operationId");
        if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(id))
          throw new Error("Invalid operation acceptance.");
        if (operationId !== id) superseded.add(operationId);
        operationId = id;
        pending = false;
        await refresh(id, expected);
      })
      .catch((error: unknown) => {
        if (!scope.active) return;
        pending = false;
        repair.disabled = !allowed.has("lifecycle.repair");
        cancel.disabled = !allowed.has("lifecycle.cancel");
        if (
          error instanceof LifecycleControlFailure &&
          error.code === "REPAIR_LIMIT_REACHED"
        )
          hideControls();
        status.textContent =
          error instanceof LifecycleControlFailure ?
            error.message
          : unconfirmedControl;
      });
  };
  scope.on(repair, "click", () => submit("lifecycle.repair"));
  scope.on(cancel, "click", () => submit("lifecycle.cancel"));
  return {
    observe,
    teardown() {
      generation++;
      scope.teardown();
      for (const request of requests) request.abort();
      requests.clear();
    }
  };
}
