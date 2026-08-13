import { assertNoUnresolvedPlaceholders, fillTemplate } from "./template.js";
import { RADIUS_REF } from "./deploy.js";

// The ref of radius-project/radius that hosts the delete workflow templates and
// the `delete-resource` composite action. These now live on `main`, so both the
// template fetch and the `{{RADIUS_REF}}` the provider workflows pin their
// composite actions to default to RADIUS_REF ("main"). It can be overridden via
// the RADIUS_DELETE_REF env var (e.g. pin to a commit SHA or a PR branch) so the
// delete templates can be re-pinned without releasing a new core package.
export const DELETE_RADIUS_REF = process.env.RADIUS_DELETE_REF || RADIUS_REF;

// Committed delete-workflow file names. The application-delete dispatcher plus
// its reusable provider workflows are committed to the target repo's
// `.github/workflows/`. The dispatcher references both provider files by path
// and the provider is chosen at runtime by its `detect` job, so both must exist.
export const DELETE_APP_DISPATCHER_FILE = "delete-application.yml";
export const DELETE_AZURE_FILE = "delete-azure.yml";
export const DELETE_AWS_FILE = "delete-aws.yml";

export type DeleteWorkflowFiles = Record<string, string>;

/**
 * Build the application-delete GitHub Actions workflows, mirroring the
 * composite-action structure of radius-project/radius.
 *
 * Returns the files committed to the target repo's `.github/workflows/`: the
 * `delete-application.yml` dispatcher plus the reusable
 * `delete-azure.yml` / `delete-aws.yml` provider workflows. The dispatcher only
 * fills `{{ENV}}` (the dispatch default); the provider workflows also pin their
 * composite actions to `{{RADIUS_REF}}`.
 *
 * `templates` maps the committed file name to the raw template body fetched
 * from `radius-project/radius`. The caller must supply all three files; there is
 * no bundled fallback, so a missing file is a hard error.
 */
export function generateDeleteWorkflow(
  env: string,
  templates: DeleteWorkflowFiles
): DeleteWorkflowFiles {
  const pick = (file: string): string => {
    const body = templates[file];
    if (!body) {
      throw new Error(
        `Missing delete template "${file}". Templates must be fetched from radius-project/radius/.github/extension at "${DELETE_RADIUS_REF}".`
      );
    }
    return body;
  };
  const files: DeleteWorkflowFiles = {
    [DELETE_APP_DISPATCHER_FILE]: fillTemplate(
      pick(DELETE_APP_DISPATCHER_FILE),
      { ENV: env }
    ),
    [DELETE_AZURE_FILE]: fillTemplate(pick(DELETE_AZURE_FILE), {
      ENV: env,
      RADIUS_REF: DELETE_RADIUS_REF
    }),
    [DELETE_AWS_FILE]: fillTemplate(pick(DELETE_AWS_FILE), {
      ENV: env,
      RADIUS_REF: DELETE_RADIUS_REF
    })
  };
  for (const [file, body] of Object.entries(files)) {
    assertNoUnresolvedPlaceholders(body, `delete workflow "${file}"`);
  }
  return files;
}

// Re-export so callers can pin template fetches to the same ref.
export { RADIUS_REF };
