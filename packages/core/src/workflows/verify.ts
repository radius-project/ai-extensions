import type { ComputePlatform } from "../platforms/index.js";
import { RADIUS_REF } from "./deploy.js";
import { assertNoUnresolvedPlaceholders, fillTemplate } from "./template.js";

// Upstream verify-template file names in radius-project/radius/.github/extension.
// The extension fetches these from the radius repo at commit time so user repos
// get the reviewed upstream version; the extension bundles no copies of its own.
export const VERIFY_AZURE_FILE = "verify-azure.yml";
export const VERIFY_AWS_FILE = "verify-aws.yml";

const VERIFY_FILE_BY_PLATFORM: Record<string, string> = {
  azure: VERIFY_AZURE_FILE,
  aws: VERIFY_AWS_FILE
};

/** Upstream `.github/extension` file name for a platform's verify template. */
export function verifyTemplateFile(
  platform: ComputePlatform
): string | undefined {
  return VERIFY_FILE_BY_PLATFORM[platform.id];
}

/**
 * Build the credential-verification GitHub Actions workflow YAML by filling the
 * `{{ENV}}` (dispatch default) and `{{RADIUS_REF}}` (the `verify-ghcr-push`
 * composite-action ref) placeholders of the provider-specific verify template.
 * `RADIUS_REF` matches the ref the template itself is fetched at, so the pinned
 * action reference stays consistent with the fetched upstream template.
 *
 * `template` is the raw body fetched from `radius-project/radius`; there is no
 * bundled fallback, so the caller must supply it. Generation fails if any
 * `{{...}}` placeholder remains unresolved, so a broken workflow is never
 * committed.
 */
export function generateVerifyWorkflow(
  env: string,
  platform: ComputePlatform,
  template: string
): string {
  if (!template || !template.trim()) {
    throw new Error(
      `Missing verify template for platform "${platform.id}". It must be fetched from radius-project/radius/.github/extension.`
    );
  }
  const workflow = fillTemplate(template, {
    ENV: env,
    RADIUS_REF
  });
  assertNoUnresolvedPlaceholders(
    workflow,
    `verify workflow for platform "${platform.id}"`
  );
  return workflow;
}
