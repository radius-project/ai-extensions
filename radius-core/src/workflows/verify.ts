import type { ComputePlatform } from "../platforms/index.js";
import { fillTemplate } from "./template.js";
import verifyTemplate from "./templates/verify.yml";

/**
 * Build the credential-verification GitHub Actions workflow YAML from the static
 * `templates/verify.yml` template. The template is committed as-is; only the
 * `{{ENV}}`, `{{VERIFY_STEPS}}`, and `{{PROVIDER_ID}}` placeholders are filled
 * in — the workflow is never generated inline.
 */
export function generateVerifyWorkflow(env: string, platform: ComputePlatform): string {
  return fillTemplate(verifyTemplate, {
    ENV: env,
    VERIFY_STEPS: platform.verifyWorkflowSteps,
    PROVIDER_ID: platform.id,
  });
}
