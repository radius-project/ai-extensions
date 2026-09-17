import { TOOL_BASELINE } from "./compatibility-baseline.js";

// US3 changes guidance, not the seven historical tool names or input contracts.
const descriptions: Readonly<Record<string, string>> = {
  radius_generate_app:
    "Checks the trusted workspace for modelability, then invokes canonical definition.author once and returns its JSON operation result or explicit error. Requires trusted approval and authenticated agent assignment; current SDK hosts return CAPABILITY_UNAVAILABLE, with no independent skill handoff. Source discovery failures are explicit failures. A source subdirectory or external path cannot currently be represented and is unavailable, not widened to the workspace. For repositories without a Dockerfile, returns a Markdown refusal without starting authoring.",
  radius_report_modeling_failure:
    "Records a permanent modeling failure as a legacy Canvas diagnostic for the exact instance, repository, branch, and attempt token supplied by that Canvas handoff. This is not an authenticated agent outcome: it cannot complete a lifecycle action, approve changes, or promote outputs. Never report transient failures, cancellations, or a run that wrote app.bicep. Lifecycle agent outcomes require authenticated operation.respond instead."
};

export const AUTHORING_TOOL_CONTRACTS = TOOL_BASELINE.map((tool) => ({
  ...tool,
  description: descriptions[tool.name] ?? tool.description
}));
