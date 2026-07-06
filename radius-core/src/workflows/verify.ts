import type { ComputePlatform } from "../platforms/index.js";
import { fillTemplate } from "./template.js";
import verifyAzureTemplate from "./templates/verify-azure.yml";
import verifyAwsTemplate from "./templates/verify-aws.yml";

// Provider-specific static verify templates. Each bundles its cloud provider's
// OIDC login and cluster-access checks with the provider baked in. The committed
// workflow is never generated inline; only the `{{ENV}}` placeholder is filled.
const VERIFY_TEMPLATES: Record<string, string> = {
  azure: verifyAzureTemplate,
  aws: verifyAwsTemplate,
};

/**
 * Build the credential-verification GitHub Actions workflow YAML by selecting
 * the provider-specific static template for `platform` and filling its `{{ENV}}`
 * (dispatch default) placeholder. The provider-specific verify steps live in the
 * static templates, not inline.
 */
export function generateVerifyWorkflow(env: string, platform: ComputePlatform): string {
  const template = VERIFY_TEMPLATES[platform.id];
  if (!template) {
    throw new Error(
      `No verify template for platform "${platform.id}". Supported platforms: ${Object.keys(VERIFY_TEMPLATES).join(", ")}.`,
    );
  }
  return fillTemplate(template, {
    ENV: env,
  });
}
