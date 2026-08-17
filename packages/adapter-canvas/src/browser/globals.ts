import { isRecord } from "./json.js";

export const PAGE_REGISTRY_GLOBAL = "radiusPageRegistry";

export type PageRegistryGlobal = typeof PAGE_REGISTRY_GLOBAL;

export function publishBrowserGlobals(
  scope: unknown,
  values: Readonly<Record<string, unknown>>,
  intendedNames: readonly string[]
): void {
  if (!isRecord(scope)) {
    throw new Error("Radius browser globals need a global object.");
  }
  const actualNames = Object.keys(values).sort();
  const expectedNames = [...intendedNames].sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(
      `Radius browser globals must publish exactly: ${expectedNames.join(", ")}.`
    );
  }
  for (const name of actualNames) {
    scope[name] = values[name];
  }
}

export function readBrowserGlobal(scope: unknown, name: string): unknown {
  return isRecord(scope) ? scope[name] : undefined;
}
