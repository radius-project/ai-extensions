import type { ComputePlatform } from "../platforms/index.js";
import { fillTemplate } from "./template.js";
import verifyAzureTemplate from "./templates/verify-azure.yml";
import verifyAwsTemplate from "./templates/verify-aws.yml";

// Upstream verify-template file names in radius-project/radius/.github/extension.
// The extension fetches these from the radius repo at commit time (falling back
// to the bundled copies below) so user repos get the reviewed upstream version.
export const VERIFY_AZURE_FILE = "verify-azure.yml";
export const VERIFY_AWS_FILE = "verify-aws.yml";

const VERIFY_FILE_BY_PLATFORM: Record<string, string> = {
  azure: VERIFY_AZURE_FILE,
  aws: VERIFY_AWS_FILE,
};

// Bundled copies of the upstream verify templates, used as an offline fallback
// (see BUNDLED_DEPLOY_TEMPLATES in deploy.ts).
export const BUNDLED_VERIFY_TEMPLATES: Record<string, string> = {
  azure: verifyAzureTemplate,
  aws: verifyAwsTemplate,
};

/** Upstream `.github/extension` file name for a platform's verify template. */
export function verifyTemplateFile(platform: ComputePlatform): string | undefined {
  return VERIFY_FILE_BY_PLATFORM[platform.id];
}

/**
 * Build the credential-verification GitHub Actions workflow YAML by filling the
 * `{{ENV}}` (dispatch default) placeholder of the provider-specific verify
 * template. `template` is the raw body fetched from `radius-project/radius`;
 * when omitted it falls back to the bundled copy for `platform`.
 */
export function generateVerifyWorkflow(
  env: string,
  platform: ComputePlatform,
  template?: string,
): string {
  const chosen = template ?? BUNDLED_VERIFY_TEMPLATES[platform.id];
  if (!chosen) {
    throw new Error(
      `No verify template for platform "${platform.id}". Supported platforms: ${Object.keys(BUNDLED_VERIFY_TEMPLATES).join(", ")}.`,
    );
  }
  return fillTemplate(chosen, {
    ENV: env,
  });
}
