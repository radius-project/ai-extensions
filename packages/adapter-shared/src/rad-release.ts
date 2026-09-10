export const RADIUS_EXTENSION_REGISTRY = "br:biceptypes.azurecr.io/radius";

const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identityField(
  value: Record<string, unknown>,
  field: "release" | "commit"
): string | null {
  const cli = isObject(value.cli) ? value.cli : {};
  const selected = value[field] ?? cli[field];
  return typeof selected === "string" && selected.trim() ?
      selected.trim()
    : null;
}

export function radiusCliIdentity(value: unknown): {
  release: string | null;
  commit: string | null;
} {
  const identity = isObject(value) ? value : {};
  return {
    release: identityField(identity, "release"),
    commit: identityField(identity, "commit")
  };
}

export function isRadiusEdgeRelease(
  release: string | null | undefined
): boolean {
  return release?.trim() === "edge";
}

export function isRadiusPullRequestRelease(
  release: string | null | undefined
): boolean {
  return /^pr-/u.test(release?.trim() ?? "");
}

export function radiusExtensionRefForRelease(
  release: string | null | undefined
): string | null {
  const value = release?.trim() ?? "";
  if (isRadiusEdgeRelease(value)) {
    return `${RADIUS_EXTENSION_REGISTRY}:latest`;
  }
  if (isRadiusPullRequestRelease(value)) return null;

  const match = SEMVER.exec(value);
  if (match === null || (match[4] !== undefined && match[5] !== undefined)) {
    return null;
  }
  const tag =
    match[4] === undefined ?
      `${match[1]}.${match[2]}`
    : `${match[1]}.${match[2]}.${match[3]}-${match[4]}`;
  return `${RADIUS_EXTENSION_REGISTRY}:${tag}`;
}
