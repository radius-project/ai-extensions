import { toClientView } from "../operations.js";
import type { KnownLifecycleOperation } from "./lifecycle-routing.js";

export interface LegacySetupRegistry {
  get(operationId: string): unknown;
  all(): unknown[];
  persist(): Promise<void>;
}
export interface LegacySetupControl {
  readonly kind: string;
  readonly method: "POST";
  readonly path: string;
  readonly requiresConfirmation: boolean;
}
export interface LegacySetupView {
  readonly operationId: string;
  readonly repo: string;
  readonly kind: "create" | "delete";
  readonly state: string;
  readonly reader: { readonly method: "GET"; readonly path: string };
  readonly controls: readonly LegacySetupControl[];
  readonly projection: unknown;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function identity(
  value: unknown
): Pick<LegacySetupView, "operationId" | "repo" | "kind" | "state"> {
  if (
    !object(value) ||
    typeof value.operationId !== "string" ||
    !value.operationId ||
    typeof value.repo !== "string" ||
    !value.repo ||
    (value.kind !== "create" && value.kind !== "delete") ||
    typeof value.state !== "string"
  )
    throw new Error(
      "Legacy setup identity is unavailable; routing must not discard it."
    );
  return {
    operationId: value.operationId,
    repo: value.repo,
    kind: value.kind,
    state: value.state
  };
}

/** Existing setup/deletion persistence and controls remain owned by their routes. */
export function createLifecycleSetupStore(deps: {
  registry(): LegacySetupRegistry;
}) {
  if (typeof deps?.registry !== "function")
    throw new Error("Setup bridge requires the existing registry.");
  function read(
    operationId: string,
    repo: string
  ): LegacySetupView | undefined {
    const value = deps.registry().get(operationId);
    if (value === null || value === undefined) return undefined;
    const id = identity(value);
    if (
      id.operationId !== operationId ||
      id.repo.toLowerCase() !== repo.toLowerCase()
    )
      throw new Error(
        "Legacy setup target does not match the authorized selection."
      );
    const projection: unknown = toClientView(value);
    if (!object(projection) || !Array.isArray(projection.actions))
      throw new Error("Legacy setup projection is unavailable.");
    const controls = projection.actions.map(
      (action: unknown): LegacySetupControl => {
        if (
          !object(action) ||
          typeof action.kind !== "string" ||
          action.method !== "POST" ||
          typeof action.path !== "string" ||
          typeof action.requiresConfirmation !== "boolean" ||
          !action.path.startsWith(
            `/api/operations/${encodeURIComponent(operationId)}/`
          )
        )
          throw new Error("Legacy setup control is not compatible.");
        return {
          kind: action.kind,
          method: "POST",
          path: action.path,
          requiresConfirmation: action.requiresConfirmation
        };
      }
    );
    return {
      ...id,
      reader: {
        method: "GET",
        path: `/api/operations/${encodeURIComponent(operationId)}`
      },
      controls,
      projection: structuredClone(projection)
    };
  }
  return {
    read,
    control(
      operationId: string,
      repo: string,
      kind: string
    ): LegacySetupControl {
      const view = read(operationId, repo);
      const action = view?.controls.find((control) => control.kind === kind);
      if (!action)
        throw new Error("This legacy control is not currently available.");
      return action;
    },
    knownOperations(): readonly KnownLifecycleOperation[] {
      return deps
        .registry()
        .all()
        .map((value) => {
          const id = identity(value);
          return {
            operationId: id.operationId,
            family: "environment",
            owner: "legacy",
            // A terminal legacy record can retain cleanup/retry authority.
            // Keep its owning controls until that record is actually retired.
            needsControl: true
          };
        });
    },
    async persist() {
      // Use the existing serialized save queue and schema; never reinterpret
      // setup records as a general deployment history or migrate their store.
      await deps.registry().persist();
    }
  };
}
