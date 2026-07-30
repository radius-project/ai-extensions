import { fillTemplate } from "./template.js";
import { pinActionRefs } from "./pins.js";
import { REPO_RADIUS_PINSET } from "./pinset.js";

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
 * `delete-azure.yml` / `delete-aws.yml` provider workflows. As with deploy,
 * `{{ENV}}` is filled and every `uses:` the pinset governs is rewritten to its
 * pinned commit SHA.
 *
 * `templates` maps the committed file name to the raw template body fetched
 * from radius-project/radius. The caller must supply all three files; there is
 * no bundled fallback, so a missing file is a hard error.
 */
export function generateDeleteWorkflow(
  env: string,
  templates: DeleteWorkflowFiles,
): DeleteWorkflowFiles {
  const pick = (file: string): string => {
    const body = templates[file];
    if (!body) {
      throw new Error(
        `Missing delete template "${file}". Templates must be fetched from radius-project/radius/.github/extension at "${REPO_RADIUS_PINSET.templateSource.sha}".`,
      );
    }
    return body;
  };
  const radiusRef = REPO_RADIUS_PINSET.templateSource.sha;
  const provider = (file: string): string =>
    pinActionRefs(
      fillTemplate(pick(file), { ENV: env, RADIUS_REF: radiusRef }),
      REPO_RADIUS_PINSET,
    );
  return {
    [DELETE_APP_DISPATCHER_FILE]: pinActionRefs(
      fillTemplate(pick(DELETE_APP_DISPATCHER_FILE), { ENV: env }),
      REPO_RADIUS_PINSET,
    ),
    [DELETE_AZURE_FILE]: provider(DELETE_AZURE_FILE),
    [DELETE_AWS_FILE]: provider(DELETE_AWS_FILE),
  };
}
