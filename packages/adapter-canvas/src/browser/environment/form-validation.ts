// Pre-flight validation for the Create Environment form (exception 4.1). These
// are pure, DOM-free checks run before the verify workflow is dispatched so a
// malformed value is caught with a field-specific message instead of surfacing
// as an opaque workflow failure minutes later. Each function returns an empty
// string when the value is acceptable, or a human-readable message naming what
// to fix.
//
// The form only asks the user to *type* the environment name, so that is the
// only free-text field validated here. Every other value the form submits comes
// from a saved credential profile (client ID, tenant, subscription, role ARN,
// account, region — validated where the profile is created) or from a
// constrained discovery selection (cluster, resource group, namespace), none of
// which the user types by hand. There is no free-text cloud identifier on this
// form to validate, so 4.1's pre-flight scope here is the environment name.

// GitHub Environment names follow GitHub's own contract — not a Kubernetes
// identifier contract. GitHub accepts names up to 255 characters and rejects
// only control characters; letters (any case), digits, spaces, dots, hyphens,
// underscores and ':' are all valid. ':' in particular is used by existing
// environments — the OIDC subject builder escapes it as %3A (see
// buildEnvironmentSuffix) — so validation here must not reject it. Imposing a
// stricter, Kubernetes-namespace shape would reject names GitHub and the rest of
// the extension already accept.
const ENVIRONMENT_NAME_MAX = 255;
const ENVIRONMENT_NAME_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function validateEnvironmentName(name: string): string {
  const value = name.trim();
  if (value === "") return "Please enter an environment name.";
  if (value.length > ENVIRONMENT_NAME_MAX)
    return `Environment names must be ${ENVIRONMENT_NAME_MAX} characters or fewer.`;
  if (ENVIRONMENT_NAME_CONTROL_CHARS.test(value))
    return "Environment names cannot contain control characters.";
  return "";
}
