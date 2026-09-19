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

// Parses the tab-delimited `name\tvalue` lines emitted by the environment
// variables `gh api --jq` query into a variable map for classifyProvider and
// the delete flow. Splits on `\r?\n` rather than `\n` because the `gh` process'
// stdout is consumed verbatim: a Windows host can terminate lines with CRLF, and
// a stray trailing carriage return would otherwise be captured as part of the
// final variable's value and corrupt an id (e.g. AZURE_TENANT_ID) passed on to
// downstream `az` commands.
export function parseGitHubEnvironmentVariables(
  out: string
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of (out || "").split(/\r?\n/)) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) {
      vars[line] = "";
      continue;
    }
    vars[line.slice(0, tab)] = line.slice(tab + 1);
  }
  return vars;
}
