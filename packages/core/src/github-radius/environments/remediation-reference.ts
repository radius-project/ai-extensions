export interface RemediationReference {
  id: string;
  params: Record<string, string>;
}

// Only the reference travels. Rebuilding from the fixed command registry at
// the point of use prevents persisted data from smuggling executable text.
export function remediationReference(
  value: unknown
): RemediationReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { id?: unknown; params?: unknown };
  if (typeof candidate.id !== "string" || candidate.id === "") return null;
  const params: Record<string, string> = {};
  if (
    candidate.params &&
    typeof candidate.params === "object" &&
    !Array.isArray(candidate.params)
  ) {
    for (const [key, raw] of Object.entries(
      candidate.params as Record<string, unknown>
    )) {
      if (typeof raw === "string") params[key] = raw;
    }
  }
  return { id: candidate.id, params };
}
