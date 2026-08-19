// Narrow values received from browser globals and JSON responses before client
// behavior uses them.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCallable(
  value: unknown
): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

export function readString(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const member = value[key];
  return typeof member === "string" ? member : "";
}

export function readBoolean(value: unknown, key: string): boolean {
  return isRecord(value) && value[key] === true;
}

export function readNumber(value: unknown, key: string): number | null {
  if (!isRecord(value)) return null;
  const member = value[key];
  return typeof member === "number" && Number.isFinite(member) ? member : null;
}

export function readArray(value: unknown, key: string): unknown[] {
  if (!isRecord(value)) return [];
  const member = value[key];
  return Array.isArray(member) ? member : [];
}

export function readStringArray(value: unknown, key: string): string[] {
  return readArray(value, key).filter(
    (entry): entry is string => typeof entry === "string"
  );
}

export function readRecord(
  value: unknown,
  key: string
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const member = value[key];
  return isRecord(member) ? member : null;
}
