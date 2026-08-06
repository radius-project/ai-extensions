import { assertNoUnresolvedPlaceholders, fillTemplate } from "./template.js";

// The pinned ref of radius-project/radius that hosts BOTH the shared composite
// actions (setup-control-plane, restore-state, run-rad-commands, teardown) and
// the workflow templates the extension commits into user repos. Points at
// `main` now that the deploy-workflow actions and templates have merged there.
export const RADIUS_REF = "main";

// The canonical home of the workflow templates in radius-project/radius. The
// extension fetches them from here at commit time so a user repo always gets
// the reviewed upstream version. radius-project/radius is the single source of
// truth: the extension bundles no template copies of its own.
export const RADIUS_WORKFLOW_REPO = "radius-project/radius";
export const RADIUS_WORKFLOW_DIR = ".github/extension";

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
 * from `radius-project/radius@{{RADIUS_REF}}` and are never copied here. Only
 * the `{{ENV}}`, `{{APP_FILE}}` and `{{RADIUS_REF}}` placeholders are filled.
 *
 * `templates` maps the committed file name to the raw template body fetched
 * from `radius-project/radius`. The caller must supply all three files; there
 * is no bundled fallback, so a missing file is a hard error.
 */
export function generateDeployWorkflow(
  env: string,
  appFile: string,
  templates: DeployWorkflowFiles
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
  const files: DeployWorkflowFiles = {
    [DEPLOY_DISPATCHER_FILE]: fillTemplate(pick(DEPLOY_DISPATCHER_FILE), {
      ENV: env
    }),
    [DEPLOY_AZURE_FILE]: fillTemplate(pick(DEPLOY_AZURE_FILE), {
      ENV: env,
      APP_FILE: appFile,
      RADIUS_REF
    }),
    [DEPLOY_AWS_FILE]: fillTemplate(pick(DEPLOY_AWS_FILE), {
      ENV: env,
      APP_FILE: appFile,
      RADIUS_REF
    })
  };
  for (const [file, body] of Object.entries(files)) {
    assertNoUnresolvedPlaceholders(body, `deploy workflow "${file}"`);
  }
  return files;
}
