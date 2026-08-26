// Pre-flight validation for the Create Environment form (exception 4.1). These
// are pure, DOM-free checks run before the verify workflow is dispatched so a
// malformed value is caught with a field-specific message instead of surfacing
// as an opaque workflow failure minutes later. Each function returns an empty
// string when the value is acceptable, or a human-readable message naming what
// to fix. Presence of profile-derived values (tenant, subscription, region,
// account) is validated separately in the form controller; these cover the
// fields the user types directly.

// GitHub Environment names cannot contain spaces or the characters that GitHub
// rejects; Radius additionally requires a name it can use as a Kubernetes
// namespace-friendly identifier. Allow letters, digits, and the separators
// `-`, `_`, and `.`, and require the first character to be alphanumeric.
const ENVIRONMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENVIRONMENT_NAME_MAX = 63;

// Azure identifiers (client, tenant, subscription) are GUIDs.
const GUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// An AWS IAM role ARN, e.g. arn:aws:iam::123456789012:role/deployer.
const ROLE_ARN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/;

export function validateEnvironmentName(name: string): string {
  const value = name.trim();
  if (value === "") return "Please enter an environment name.";
  if (value.length > ENVIRONMENT_NAME_MAX)
    return `Environment names must be ${ENVIRONMENT_NAME_MAX} characters or fewer.`;
  if (!ENVIRONMENT_NAME.test(value))
    return "Environment names can use only letters, numbers, dots, hyphens, and underscores, and must start with a letter or number.";
  return "";
}

export function validateAzureClientId(clientId: string): string {
  const value = clientId.trim();
  if (value === "") return "";
  if (!GUID.test(value))
    return "The Azure client ID must be a GUID (for example 00000000-0000-0000-0000-000000000000).";
  return "";
}

export function validateAwsRoleArn(roleArn: string): string {
  const value = roleArn.trim();
  if (value === "") return "";
  if (!ROLE_ARN.test(value))
    return "The AWS role ARN must look like arn:aws:iam::123456789012:role/role-name.";
  return "";
}
