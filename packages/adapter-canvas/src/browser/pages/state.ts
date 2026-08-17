import { isRecord } from "../json.js";
import type { BrowserContext } from "../ports.js";

export function readPageState(
  context: BrowserContext,
  elementId: string
): Record<string, unknown> {
  const element = context.dom.byId(elementId);
  if (!element) {
    throw new Error(`Radius browser page state "${elementId}" is missing.`);
  }
  const source = element.textContent ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Radius browser page state "${elementId}" is invalid.`, {
      cause: error
    });
  }
  if (!isRecord(parsed)) {
    throw new Error(
      `Radius browser page state "${elementId}" is not an object.`
    );
  }
  return parsed;
}
