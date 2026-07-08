import { fillTemplate } from "./template.js";
import dispatcherTemplate from "./templates/run-rad-commands.yml";
import azureTemplate from "./templates/run-rad-commands-azure.yml";
import awsTemplate from "./templates/run-rad-commands-aws.yml";

// The pinned ref of radius-project/radius that hosts the shared composite
// actions (setup-control-plane, restore-state,
// run-rad-commands, teardown) referenced by the provider workflows. Points at
// `main` now that the deploy-workflow actions have merged there.
const RADIUS_REF = "main";

// Committed workflow file names. All three are always committed to the target
// repo's .github/workflows/: the dispatcher references both provider workflows
// by path, and the provider is selected at runtime by the dispatcher's `detect`
// job — so both provider files must exist regardless of the environment's cloud.
export const DEPLOY_DISPATCHER_FILE = "run-rad-commands.yml";
export const DEPLOY_AZURE_FILE = "run-rad-commands-azure.yml";
export const DEPLOY_AWS_FILE = "run-rad-commands-aws.yml";

export type DeployWorkflowFiles = Record<string, string>;

/**
 * Build the application-deploy GitHub Actions workflows, mirroring the
 * composite-action structure of radius-project/radius#12250.
 *
 * Returns the three files that get committed to the target repo's
 * `.github/workflows/`: the unified `run-rad-commands.yml` dispatcher plus the
 * reusable `run-rad-commands-azure.yml` / `run-rad-commands-aws.yml` provider
 * workflows. The provider-agnostic phases live in composite actions referenced
 * from `radius-project/radius@{{RADIUS_REF}}` and are never copied here. Only
 * the `{{ENV}}`, `{{APP_FILE}}` and `{{RADIUS_REF}}` placeholders are filled.
 */
export function generateDeployWorkflow(env: string, appFile: string): DeployWorkflowFiles {
  return {
    [DEPLOY_DISPATCHER_FILE]: fillTemplate(dispatcherTemplate, { ENV: env }),
    [DEPLOY_AZURE_FILE]: fillTemplate(azureTemplate, {
      ENV: env,
      APP_FILE: appFile,
      RADIUS_REF,
    }),
    [DEPLOY_AWS_FILE]: fillTemplate(awsTemplate, {
      ENV: env,
      APP_FILE: appFile,
      RADIUS_REF,
    }),
  };
}
