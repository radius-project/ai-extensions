import { applicationGraphToResources } from "../graph/appgraph.js";
import { computeGraphDiff } from "../graph/diff.js";
import {
  graphResourceSchema,
  type CanonicalGraph,
  type ConcreteResourceRecord
} from "./contracts/common.js";
import { portFailure, portSuccess, type PortResult } from "./errors.js";
import type { ReadonlyData } from "./ports.js";
import { validateSourcePath } from "./source.js";

type Resource = CanonicalGraph["resources"][number];
type Connection = Resource["connections"][number];
const hashPattern = new RegExp(graphResourceSchema.properties.diffHash.pattern);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function optionalText(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}
function diffStatus(value: unknown): value is Resource["diffStatus"] {
  return (
    value === undefined ||
    value === "added" ||
    value === "removed" ||
    value === "modified" ||
    value === "unchanged"
  );
}
function connection(value: unknown): Connection | undefined {
  if (
    !record(value) ||
    !text(value.id) ||
    (value.direction !== "Inbound" && value.direction !== "Outbound") ||
    !diffStatus(value.diffStatus) ||
    value.diffStatus === "modified"
  )
    return undefined;
  return {
    id: value.id,
    direction: value.direction,
    ...(value.diffStatus === undefined ? {} : { diffStatus: value.diffStatus })
  };
}
function output(value: unknown): ConcreteResourceRecord | undefined {
  if (
    !record(value) ||
    !text(value.type) ||
    typeof value.name !== "string" ||
    typeof value.displayType !== "string" ||
    typeof value.provider !== "string" ||
    typeof value.apiVersion !== "string"
  )
    return undefined;
  return {
    name: value.name,
    type: value.type,
    displayType: value.displayType,
    provider: value.provider,
    apiVersion: value.apiVersion
  };
}
function resource(value: unknown): Resource | undefined {
  if (
    !record(value) ||
    !text(value.id) ||
    typeof value.name !== "string" ||
    !text(value.type) ||
    typeof value.diffHash !== "string" ||
    !hashPattern.test(value.diffHash) ||
    !Array.isArray(value.connections) ||
    !Array.isArray(value.outputResources) ||
    !optionalText(value.provisioningState) ||
    !optionalText(value.definitionFile) ||
    !optionalText(value.codeReference) ||
    !diffStatus(value.diffStatus) ||
    (value.definitionLine !== undefined &&
      (typeof value.definitionLine !== "number" ||
        !Number.isInteger(value.definitionLine) ||
        value.definitionLine < 0))
  )
    return undefined;
  const connections: Connection[] = [];
  for (const candidate of value.connections) {
    const parsed = connection(candidate);
    if (!parsed) return undefined;
    connections.push(parsed);
  }
  const outputResources: ConcreteResourceRecord[] = [];
  for (const candidate of value.outputResources) {
    const parsed = output(candidate);
    if (!parsed) return undefined;
    outputResources.push(parsed);
  }
  return {
    id: value.id,
    name: value.name,
    type: value.type,
    diffHash: value.diffHash,
    connections,
    outputResources,
    ...(value.provisioningState === undefined ?
      {}
    : { provisioningState: value.provisioningState }),
    ...(value.definitionFile === undefined ?
      {}
    : { definitionFile: value.definitionFile }),
    ...(value.definitionLine === undefined ?
      {}
    : { definitionLine: value.definitionLine }),
    ...(value.codeReference === undefined ?
      {}
    : { codeReference: value.codeReference }),
    ...(value.diffStatus === undefined ? {} : { diffStatus: value.diffStatus })
  };
}
function canonical(value: readonly unknown[]): PortResult<CanonicalGraph> {
  const resources: Resource[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    const parsed = resource(candidate);
    if (!parsed || ids.has(parsed.id)) return portFailure("EVIDENCE_MISMATCH");
    ids.add(parsed.id);
    resources.push(parsed);
  }
  return portSuccess({ resources });
}

export function projectRadiusGraph(
  raw: unknown,
  definition: string,
  content = ""
): PortResult<CanonicalGraph> {
  const path = validateSourcePath(definition);
  if (path.status !== "ok") return path;
  const values =
    Array.isArray(raw) ? raw
    : record(raw) ? raw.resources
    : undefined;
  if (!Array.isArray(values)) return portFailure("EVIDENCE_MISMATCH");
  // Validate before the legacy converter, which deliberately skips malformed
  // nodes. A lifecycle observation must not silently turn them into absence.
  for (const value of values) {
    if (
      !record(value) ||
      !resource({
        ...value,
        name: value.name === undefined ? "" : value.name,
        connections:
          Array.isArray(value.connections) ?
            value.connections.map((entry: unknown) =>
              record(entry) ?
                { ...entry, direction: entry.direction ?? "Outbound" }
              : entry
            )
          : value.connections === undefined ? []
          : value.connections,
        outputResources:
          value.outputResources === undefined ? [] : value.outputResources
      })
    )
      return portFailure("EVIDENCE_MISMATCH");
  }
  const converted: unknown[] = applicationGraphToResources(
    raw,
    definition,
    content
  );
  return canonical(converted);
}

export function compareRadiusGraphs(
  base: ReadonlyData<CanonicalGraph>,
  head: ReadonlyData<CanonicalGraph>
): PortResult<CanonicalGraph> {
  const left = canonical(base.resources);
  if (left.status !== "ok") return left;
  const right = canonical(head.resources);
  if (right.status !== "ok") return right;
  const compared: unknown[] = computeGraphDiff(
    left.value.resources,
    right.value.resources
  );
  return canonical(compared);
}
