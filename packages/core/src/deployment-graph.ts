import { projectSafeApplicationGraph } from "./graph/appgraph.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ?
      Object.fromEntries(Object.entries(value))
    : {};
}

const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

export function deploymentGraphResources(values: unknown[]) {
  return values.map((value) => {
    const item = record(value);
    const connections =
      Array.isArray(item.connections) ?
        item.connections.map((connection) => {
          const fields = record(connection);
          return {
            ...fields,
            id: text(fields.id),
            name: text(fields.name),
            direction: text(fields.direction)
          };
        })
      : undefined;
    return {
      ...item,
      id: text(item.id),
      name: text(item.name),
      type: text(item.type),
      ...(connections ? { connections } : {})
    };
  });
}

export function projectDeploymentGraph(graph: unknown) {
  return deploymentGraphResources(projectSafeApplicationGraph(graph).resources);
}
