// Ordering for the Radius version an app model was generated with.
//
// The value is the tag of the Radius Bicep extension the app model compiled
// against, as it appears after `br:biceptypes.azurecr.io/radius:`. A stable
// release is recorded as `major.minor` (0.60), because Radius publishes one set
// of types per minor version. A prerelease is recorded as its exact tag
// (0.61.0-rc1). An edge build is recorded as `latest`.
//
// Kept free of imports so the bundled show-radius-type.mjs script can load this
// file directly, the same way it loads adapter-shared's rad-release.ts.

interface RadiusVersion {
  major: number;
  minor: number;
  // Only a prerelease carries a patch and prerelease identifiers. A stable
  // value covers every patch of its minor version.
  prerelease: { patch: number; identifiers: string[] } | null;
}

const RADIUS_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*)-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

function parseRadiusVersion(value: string): RadiusVersion | null {
  const match = RADIUS_VERSION.exec(value.trim());
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    prerelease:
      match[4] === undefined ?
        null
      : { patch: Number(match[3]), identifiers: match[4].split(".") }
  };
}

function compareNumbers(a: number, b: number): number {
  return Math.sign(a - b);
}

// Semantic Versioning precedence for two prerelease identifier lists: numeric
// identifiers compare as numbers and sort before alphanumeric ones, and a
// shorter list sorts first when every shared identifier is equal.
function comparePrerelease(a: string[], b: string[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === right) continue;
    const leftNumeric = /^\d+$/u.test(left);
    const rightNumeric = /^\d+$/u.test(right);
    if (leftNumeric && rightNumeric) {
      return compareNumbers(Number(left), Number(right));
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return compareNumbers(a.length, b.length);
}

// Returns a negative number when `a` is older than `b`, zero when they name the
// same Radius types, and a positive number when `a` is newer. Returns null when
// either value cannot be ordered: blank, `latest`, or anything else that is not
// a Radius version. Callers treat null as "unknown" and skip their check.
//
// A stable value is newer than any prerelease of the same minor version, since
// it names the released types that prerelease led up to.
export function compareRadiusVersions(a: string, b: string): number | null {
  const left = parseRadiusVersion(a);
  const right = parseRadiusVersion(b);
  if (left === null || right === null) return null;

  const byMinor =
    compareNumbers(left.major, right.major) ||
    compareNumbers(left.minor, right.minor);
  if (byMinor !== 0) return byMinor;

  if (left.prerelease === null || right.prerelease === null) {
    if (left.prerelease === right.prerelease) return 0;
    return left.prerelease === null ? 1 : -1;
  }
  return (
    compareNumbers(left.prerelease.patch, right.prerelease.patch) ||
    comparePrerelease(left.prerelease.identifiers, right.prerelease.identifiers)
  );
}
