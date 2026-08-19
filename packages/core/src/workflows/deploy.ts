import { assertNoUnresolvedPlaceholders, fillTemplate } from "./template.js";

// The pinned ref of radius-project/ai-extensions that hosts BOTH the shared
// composite actions (setup-control-plane, restore-state, run-rad-commands,
// teardown) and the workflow templates the extension commits into user repos.
// Points at `main`, where the deploy-workflow actions and templates live.
export const RADIUS_REF = "main";

// The canonical home of the workflow templates in radius-project/ai-extensions.
// The extension fetches them from here at commit time so a user repo always
// gets the reviewed upstream version. radius-project/ai-extensions is the single
// source of truth: the extension bundles no template copies of its own.
export const RADIUS_WORKFLOW_REPO = "radius-project/ai-extensions";
export const RADIUS_WORKFLOW_DIR = ".github/extension";

// Committed workflow file names. All three are always committed to the target
// repo's .github/workflows/: the dispatcher references both provider workflows
// by path, and the provider is selected at runtime by the dispatcher's `detect`
// job — so both provider files must exist regardless of the environment's cloud.
export const DEPLOY_DISPATCHER_FILE = "run-rad-commands.yml";
export const DEPLOY_AZURE_FILE = "run-rad-commands-azure.yml";
export const DEPLOY_AWS_FILE = "run-rad-commands-aws.yml";

export const DEPLOY_TEMPLATE_VAR_TARGET_CLUSTER_ARCH_MODE =
  "TARGET_CLUSTER_ARCH_MODE";
export const DEPLOY_TEMPLATE_VAR_TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS =
  "TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS";
export const DEFAULT_TARGET_CLUSTER_ARCH_MODE = "detect";
export const DEFAULT_TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS =
  "linux/amd64,linux/arm64";

// GitHub Actions repository variables a repo can set to override the baked-in
// architecture defaults per-environment, without editing the committed workflow.
export const RADIUS_BUILD_ARCH_MODE_VAR = "RADIUS_BUILD_ARCH_MODE";
export const RADIUS_BUILD_PLATFORMS_VAR = "RADIUS_BUILD_PLATFORMS";

export type DeployWorkflowFiles = Record<string, string>;
export type DeployWorkflowTemplateVars = Record<string, string>;

export interface DeployWorkflowOptions {
  templateVars?: DeployWorkflowTemplateVars;
}

// Build a GitHub Actions expression that reads an override repository variable
// and falls back to a baked-in default: `${{ vars.<NAME> || '<default>' }}`.
function ghVarWithDefault(varName: string, fallback: string): string {
  return `\${{ vars.${varName} || '${fallback}' }}`;
}

export function defaultDeployTemplateVars(): DeployWorkflowTemplateVars {
  return {
    [DEPLOY_TEMPLATE_VAR_TARGET_CLUSTER_ARCH_MODE]: ghVarWithDefault(
      RADIUS_BUILD_ARCH_MODE_VAR,
      DEFAULT_TARGET_CLUSTER_ARCH_MODE
    ),
    [DEPLOY_TEMPLATE_VAR_TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS]:
      ghVarWithDefault(
        RADIUS_BUILD_PLATFORMS_VAR,
        DEFAULT_TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS
      )
  };
}

/**
 * Build the application-deploy GitHub Actions workflows, mirroring the
 * composite-action structure of radius-project/ai-extensions.
 *
 * Returns the three files that get committed to the target repo's
 * `.github/workflows/`: the unified `run-rad-commands.yml` dispatcher plus the
 * reusable `run-rad-commands-azure.yml` / `run-rad-commands-aws.yml` provider
 * workflows. The provider-agnostic phases live in composite actions referenced
 * from `radius-project/ai-extensions@{{RADIUS_REF}}` and are never copied here. Core
 * always fills the reserved `{{ENV}}`, `{{APP_FILE}}`, and `{{RADIUS_REF}}`
 * placeholders. It also fills the architecture-aware
 * `{{TARGET_CLUSTER_ARCH_MODE}}` and
 * `{{TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS}}` placeholders with runtime
 * GitHub-variable defaults. Callers may also supply additional
 * `{{UPPER_SNAKE}}` template vars for upstream workflow features that this repo
 * needs to thread through, and may override the architecture defaults.
 *
 * `templates` maps the committed file name to the raw template body fetched
 * from `radius-project/ai-extensions`. The caller must supply all three files;
 * there is no bundled fallback, so a missing file is a hard error.
 */
export function generateDeployWorkflow(
  env: string,
  appFile: string,
  templates: DeployWorkflowFiles,
  options: DeployWorkflowOptions = {}
): DeployWorkflowFiles {
  const pick = (file: string): string => {
    const body = templates[file];
    if (!body) {
      throw new Error(
        `Missing deploy template "${file}". Templates must be fetched from ${RADIUS_WORKFLOW_REPO}/${RADIUS_WORKFLOW_DIR} at "${RADIUS_REF}".`
      );
    }
    return body;
  };
  const templateVars: DeployWorkflowTemplateVars = {
    ...defaultDeployTemplateVars(),
    ...(options.templateVars || {}),
    ENV: env,
    APP_FILE: appFile,
    RADIUS_REF
  };
  const fill = (file: string): string => fillTemplate(pick(file), templateVars);
  const files: DeployWorkflowFiles = {
    [DEPLOY_DISPATCHER_FILE]: fill(DEPLOY_DISPATCHER_FILE),
    [DEPLOY_AZURE_FILE]: fill(DEPLOY_AZURE_FILE),
    [DEPLOY_AWS_FILE]: fill(DEPLOY_AWS_FILE)
  };
  for (const [file, body] of Object.entries(files)) {
    assertNoUnresolvedPlaceholders(body, `deploy workflow "${file}"`);
  }
  return files;
}
