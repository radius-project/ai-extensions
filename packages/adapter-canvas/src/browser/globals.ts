import { isCallable, isRecord } from "./json.js";

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

export interface GlobalAccessor {
  get(): unknown;
  set(value: unknown): void;
}

export function publishBrowserAccessor(
  scope: unknown,
  name: string,
  accessor: GlobalAccessor
): void {
  if (!isRecord(scope)) {
    throw new Error("Radius browser globals need a global object.");
  }
  Object.defineProperty(scope, name, {
    configurable: true,
    enumerable: true,
    get: accessor.get,
    set: accessor.set
  });
}

export function requireBrowserFunction(
  scope: unknown,
  name: string
): (...args: unknown[]) => unknown {
  const value = readBrowserGlobal(scope, name);
  if (!isCallable(value)) {
    throw new Error(`Radius browser global "${name}" is not available.`);
  }
  return value;
}

export function optionalBrowserFunction(
  scope: unknown,
  name: string
): ((...args: unknown[]) => unknown) | null {
  const value = readBrowserGlobal(scope, name);
  return isCallable(value) ? value : null;
}
