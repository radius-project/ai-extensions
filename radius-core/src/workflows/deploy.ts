import type { ComputePlatform } from "../platforms/index.js";
import { fillTemplate } from "./template.js";
import deployAzureTemplate from "./templates/deploy-azure.yml";
import deployAwsTemplate from "./templates/deploy-aws.yml";

// Provider-specific static deploy templates. Each is a 1:1 port of the Radius
// "run rad commands" workflow (radius-project/radius#12250), stripped to a
// single cloud provider. The committed workflow is never generated inline; only
// the `{{ENV}}` and `{{APP_FILE}}` placeholder tokens are filled in.
const DEPLOY_TEMPLATES: Record<string, string> = {
  azure: deployAzureTemplate,
  aws: deployAwsTemplate,
};

/**
 * Build the application-deploy GitHub Actions workflow YAML by selecting the
 * provider-specific static template for `platform` and filling its `{{ENV}}`
 * (dispatch default) and `{{APP_FILE}}` placeholders.
 */
export function generateDeployWorkflow(
  env: string,
  platform: ComputePlatform,
  appFile: string,
): string {
  const template = DEPLOY_TEMPLATES[platform.id];
  if (!template) {
    throw new Error(
      `No deploy template for platform "${platform.id}". Supported platforms: ${Object.keys(DEPLOY_TEMPLATES).join(", ")}.`,
    );
  }
  return fillTemplate(template, {
    ENV: env,
    APP_FILE: appFile,
  });
}
