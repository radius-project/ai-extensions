export const LIFECYCLE_ROUTING_FAMILIES = [
  "definition",
  "environment",
  "deployment",
  "application"
] as const;
export type LifecycleRoutingFamily =
  (typeof LIFECYCLE_ROUTING_FAMILIES)[number];
export type LifecycleRouteOwner = "legacy" | "lifecycle";
export interface KnownLifecycleOperation {
  readonly operationId: string;
  readonly family: LifecycleRoutingFamily;
  readonly owner: LifecycleRouteOwner;
  readonly needsControl: boolean;
}
export interface LifecycleRouteSelection {
  readonly writer: LifecycleRouteOwner;
  readonly readers: readonly LifecycleRouteOwner[];
  readonly controllers: readonly LifecycleRouteOwner[];
}

export function createLifecycleRouting(deps: {
  knownOperations(): readonly KnownLifecycleOperation[];
}) {
  if (typeof deps?.knownOperations !== "function")
    throw new Error("Routing requires an inventory of known operations.");
  const routes = new Map<LifecycleRoutingFamily, LifecycleRouteSelection>(
    LIFECYCLE_ROUTING_FAMILIES.map((family) => [
      family,
      {
        writer: "legacy",
        readers: ["legacy", "lifecycle"],
        controllers: ["legacy", "lifecycle"]
      }
    ])
  );
  const claims = new Map<string, KnownLifecycleOperation>();
  function known() {
    const records = [...deps.knownOperations(), ...claims.values()];
    const unique = new Map<string, KnownLifecycleOperation>();
    for (const record of records) {
      const previous = unique.get(record.operationId);
      if (
        previous &&
        (previous.owner !== record.owner || previous.family !== record.family)
      )
        throw new Error("Conflicting operation routing identity.");
      unique.set(record.operationId, record);
    }
    return [...unique.values()];
  }
  function selection(family: LifecycleRoutingFamily) {
    const route = routes.get(family);
    if (!route) throw new Error("Unknown lifecycle routing family.");
    return route;
  }
  return {
    selection(family: LifecycleRoutingFamily) {
      return structuredClone(selection(family));
    },
    transition(family: LifecycleRoutingFamily, next: LifecycleRouteSelection) {
      selection(family);
      if (
        !["legacy", "lifecycle"].includes(next.writer) ||
        !next.readers.includes(next.writer) ||
        !next.controllers.includes(next.writer)
      )
        throw new Error("A writer requires compatible readers and controls.");
      for (const operation of known().filter(
        (item) => item.family === family
      )) {
        if (
          !next.readers.includes(operation.owner) ||
          (operation.needsControl &&
            !next.controllers.includes(operation.owner))
        )
          throw new Error("Routing transition would orphan a known operation.");
      }
      routes.set(family, structuredClone(next));
    },
    address(operationId: string, control = false): LifecycleRouteOwner {
      const operation = known().find(
        (item) => item.operationId === operationId
      );
      if (!operation)
        throw new Error("Operation is not known to this routing context.");
      const route = selection(operation.family);
      if (
        !(control ? route.controllers : route.readers).includes(operation.owner)
      )
        throw new Error("Known operation has no compatible reader or control.");
      return operation.owner;
    },
    claimDispatch(
      family: LifecycleRoutingFamily,
      operationId: string
    ): LifecycleRouteOwner {
      if (
        !operationId ||
        known().some((item) => item.operationId === operationId)
      )
        throw new Error("Known or uncertain operation cannot be redispatched.");
      const owner = selection(family).writer;
      claims.set(operationId, {
        operationId,
        family,
        owner,
        needsControl: true
      });
      return owner;
    }
  };
}
