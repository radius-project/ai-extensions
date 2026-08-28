// Pre-flight validation for the Create Environment form (exception 4.1). These
// are pure, DOM-free checks run before the verify workflow is dispatched so a
// malformed value is caught with a field-specific message instead of surfacing
// as an opaque workflow failure minutes later. Each function returns an empty
// string when the value is acceptable, or a human-readable message naming what
// to fix. This covers the fields the user types directly on the form; values
// carried over from a saved credential profile (client ID, tenant, subscription,
// role ARN, account, region) are validated where the profile is created.

// GitHub Environment names cannot contain spaces or the characters that GitHub
// rejects; Radius additionally requires a name it can use as a Kubernetes
// namespace-friendly identifier. Allow letters, digits, and the separators
// `-`, `_`, and `.`, and require the first character to be alphanumeric.
const ENVIRONMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENVIRONMENT_NAME_MAX = 63;

export function validateEnvironmentName(name: string): string {
  const value = name.trim();
  if (value === "") return "Please enter an environment name.";
  if (value.length > ENVIRONMENT_NAME_MAX)
    return `Environment names must be ${ENVIRONMENT_NAME_MAX} characters or fewer.`;
  if (!ENVIRONMENT_NAME.test(value))
    return "Environment names can use only letters, numbers, dots, hyphens, and underscores, and must start with a letter or number.";
  return "";
}
