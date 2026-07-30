import { fillTemplate } from "./template.js";
import { pinActionRefs } from "./pins.js";
import {
  REPO_RADIUS_PINSET,
  RADIUS_WORKFLOW_DIR,
  RADIUS_WORKFLOW_REPO,
} from "./pinset.js";

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
 * composite-action structure of radius-project/radius.
 *
 * Returns the three files that get committed to the target repo's
 * `.github/workflows/`: the unified `run-rad-commands.yml` dispatcher plus the
 * reusable `run-rad-commands-azure.yml` / `run-rad-commands-aws.yml` provider
 * workflows. The provider-agnostic phases live in composite actions referenced
 * from radius-project/radius and are never copied here.
 *
 * `{{ENV}}` and `{{APP_FILE}}` are filled, and every `uses:` the pinset governs
 * is rewritten to its pinned commit SHA — including a template that hardcodes a
 * ref instead of using the `{{RADIUS_REF}}` placeholder, so the committed
 * workflow is reproducible whatever shape upstream ships.
 *
 * `templates` maps the committed file name to the raw template body fetched
 * from radius-project/radius. The caller must supply all three files; there is
 * no bundled fallback, so a missing file is a hard error.
 */
export function generateDeployWorkflow(
  env: string,
  appFile: string,
  templates: DeployWorkflowFiles,
): DeployWorkflowFiles {
  const pick = (file: string): string => {
    const body = templates[file];
    if (!body) {
      throw new Error(
        `Missing deploy template "${file}". Templates must be fetched from ${RADIUS_WORKFLOW_REPO}/${RADIUS_WORKFLOW_DIR} at "${REPO_RADIUS_PINSET.templateSource.sha}".`,
      );
    }
    return body;
  };
  const radiusRef = REPO_RADIUS_PINSET.templateSource.sha;
  const provider = (file: string): string =>
    pinActionRefs(
      fillTemplate(pick(file), { ENV: env, APP_FILE: appFile, RADIUS_REF: radiusRef }),
      REPO_RADIUS_PINSET,
    );
  return {
    [DEPLOY_DISPATCHER_FILE]: pinActionRefs(
      fillTemplate(pick(DEPLOY_DISPATCHER_FILE), { ENV: env }),
      REPO_RADIUS_PINSET,
    ),
    [DEPLOY_AZURE_FILE]: provider(DEPLOY_AZURE_FILE),
    [DEPLOY_AWS_FILE]: provider(DEPLOY_AWS_FILE),
  };
}
