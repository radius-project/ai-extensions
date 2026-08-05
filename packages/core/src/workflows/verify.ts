import type { ComputePlatform } from "../platforms/index.js";
import { fillTemplate } from "./template.js";

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
 * `{{ENV}}` (dispatch default) placeholder of the provider-specific verify
 * template. `template` is the raw body fetched from `radius-project/radius`;
 * there is no bundled fallback, so the caller must supply it.
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
  return fillTemplate(template, {
    ENV: env
  });
}
