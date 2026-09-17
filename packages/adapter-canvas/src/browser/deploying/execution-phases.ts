const PHASES: Readonly<Record<string, string>> = {
  dispatch: "Dispatch",
  checkout: "Checkout",
  restore: "Restore",
  command: "Command",
  "state-save": "State save",
  cleanup: "Cleanup"
};
const OUTCOMES: Readonly<Record<string, string>> = {
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  skipped: "required but skipped",
  unknown: "unknown",
  not_applicable: "not applicable",
  pending: "pending",
  running: "running"
};

export function executionPhaseSummary(value: unknown): string {
  if (value === undefined) return "";
  if (!Array.isArray(value) || value.length === 0 || value.length > 6)
    return "Phase details unavailable.";
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return "Phase details unavailable.";
    const phase: unknown = Reflect.get(item, "phase");
    const status: unknown = Reflect.get(item, "status");
    if (
      typeof phase !== "string" ||
      typeof status !== "string" ||
      !Object.hasOwn(PHASES, phase) ||
      !Object.hasOwn(OUTCOMES, status) ||
      seen.has(phase)
    )
      return "Phase details unavailable.";
    seen.add(phase);
    labels.push(`${PHASES[phase]}: ${OUTCOMES[status]}`);
  }
  return `Execution phases: ${labels.join("; ")}.`;
}
