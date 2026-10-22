import type { CanvasGraphResource } from "./shared.js";
import { optionalString, record } from "./runtime/util.js";

export function canvasGraphResources(values: unknown[]): CanvasGraphResource[] {
  return values.map((value) => {
    const item = record(value);
    const connections =
      Array.isArray(item.connections) ?
        item.connections.map((connection) => {
          const fields = record(connection);
          return {
            ...fields,
            id: optionalString(fields.id),
            name: optionalString(fields.name),
            direction: optionalString(fields.direction)
          };
        })
      : undefined;
    return {
      ...item,
      id: optionalString(item.id),
      name: optionalString(item.name),
      type: optionalString(item.type),
      ...(connections ? { connections } : {})
    };
  });
}
