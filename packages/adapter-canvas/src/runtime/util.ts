// Small pure helpers shared by the runtime factories (canvas.ts, tools.ts,
// extension.ts). No dependencies, no I/O — safe to import from anywhere,
// including tests, without constructing a single fake.

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value));
}

export function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
