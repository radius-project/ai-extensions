import { assertNoUnresolvedPlaceholders, fillTemplate } from "./template.js";
import { RADIUS_REF } from "./deploy.js";

// The ref of radius-project/ai-extensions that hosts the delete workflow
// templates and the `delete-resource` composite action. These live on `main`,
// so both the template fetch and the `{{RADIUS_REF}}` the provider workflows
// pin their composite actions to default to RADIUS_REF ("main"). It can be
// overridden via the RADIUS_DELETE_REF env var (e.g. pin to a commit SHA or a
// PR branch) so the delete templates can be re-pinned without releasing a new
// core package.
export const DELETE_RADIUS_REF = process.env.RADIUS_DELETE_REF || RADIUS_REF;

// Committed delete-workflow file names. The application-delete dispatcher plus
// its reusable provider workflows are committed to the target repo's
// `.github/workflows/`. The dispatcher references both provider files by path
// and the provider is chosen at runtime by its `detect` job, so both must exist.
export const DELETE_APP_DISPATCHER_FILE = "delete-application.yml";
export const DELETE_AZURE_FILE = "delete-azure.yml";
export const DELETE_AWS_FILE = "delete-aws.yml";
// The environment-delete dispatcher. Unlike the application-delete dispatcher
// (which reuses the upstream `delete-azure.yml` provider), the environment-delete
// flow uses its own provider workflow — `delete-environment-azure.yml`, below —
// so it can carry the ai-extensions-owned "no deployed applications" guard step
// (issue #303). Both files are static assets in radius-project/ai-extensions
// (`.github/extension/`), not fetched from radius-project/radius.
export const DELETE_ENV_DISPATCHER_FILE = "delete-environment.yml";
// The environment-delete Azure provider workflow. Static, ai-extensions-owned,
// and committed alongside the environment dispatcher.
export const DELETE_ENV_AZURE_FILE = "delete-environment-azure.yml";

// The exact name of the guard step inside `delete-environment-azure.yml` that
// fails when applications are still deployed to the environment. The canvas
// extension matches on this step name (via the Actions run's jobs/steps) to tell
// an apps-still-deployed failure apart from any other delete failure, so it must
// stay byte-identical to the `- name:` in the static workflow file.
export const DELETE_ENV_GUARD_STEP_NAME =
  "Guard - environment has no deployed applications";

export type DeleteWorkflowFiles = Record<string, string>;

/**
 * Build the delete GitHub Actions workflows, mirroring the composite-action
 * structure of radius-project/ai-extensions.
 *
 * Returns the files committed to the target repo's `.github/workflows/`: the
 * `delete-application.yml` and `delete-environment.yml` dispatchers plus the
 * reusable provider workflows — `delete-azure.yml` / `delete-aws.yml` for the
 * application-delete path and `delete-environment-azure.yml` for the
 * environment-delete path. The dispatchers only fill `{{ENV}}` (the dispatch
 * default); the provider workflows also pin their composite actions to
 * `{{RADIUS_REF}}`.
 *
 * `templates` maps the committed file name to the raw template body fetched
 * from `radius-project/ai-extensions`. The caller must supply every file;
 * there is no fallback, so a missing file is a hard error.
 */
export function generateDeleteWorkflow(
  env: string,
  templates: DeleteWorkflowFiles
): DeleteWorkflowFiles {
  const pick = (file: string): string => {
    const body = templates[file];
    if (!body) {
      throw new Error(
        `Missing delete template "${file}". Templates must be fetched from radius-project/ai-extensions/.github/extension at "${DELETE_RADIUS_REF}".`
      );
    }
    return body;
  };
  const files: DeleteWorkflowFiles = {
    [DELETE_APP_DISPATCHER_FILE]: fillTemplate(
      pick(DELETE_APP_DISPATCHER_FILE),
      { ENV: env }
    ),
    [DELETE_ENV_DISPATCHER_FILE]: fillTemplate(
      pick(DELETE_ENV_DISPATCHER_FILE),
      { ENV: env }
    ),
    [DELETE_ENV_AZURE_FILE]: fillTemplate(pick(DELETE_ENV_AZURE_FILE), {
      ENV: env,
      RADIUS_REF: DELETE_RADIUS_REF
    }),
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
