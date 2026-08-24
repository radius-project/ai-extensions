// Single source of truth for deciding which cloud provider an environment was
// created for, given its GitHub Actions variables. Environment listing and
// environment deletion both need this answer and previously computed it two
// different ways: listing joined every variable name and ran a `/AZURE_/`
// substring regex, while deletion keyed off the exact `AZURE_CLIENT_ID` name.
// The regex misclassifies a user-defined `MY_AZURE_THING`, so the two paths
// could disagree about the same environment. Keying off the exact canonical
// name each provider always writes keeps them in lockstep.
//
// Note: AWS is not a supported provider yet — a user cannot create an AWS
// environment, so the AWS branch is barebones framework kept only so the two
// call sites classify identically. `AWS_ROLE_ARN` is used as the AWS marker
// because it is the OIDC role the workflow assumes and is written before the
// cluster name, so it is the safest single variable to key off.
export type ClassifiedProvider = "azure" | "aws" | "";

const AZURE_MARKER = "AZURE_CLIENT_ID";
const AWS_MARKER = "AWS_ROLE_ARN";

export function classifyProvider(
  vars: Record<string, string>
): ClassifiedProvider {
  if (Object.prototype.hasOwnProperty.call(vars, AZURE_MARKER)) return "azure";
  if (Object.prototype.hasOwnProperty.call(vars, AWS_MARKER)) return "aws";
  return "";
}
