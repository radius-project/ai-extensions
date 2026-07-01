import type { ComputePlatform } from "../platforms/index.js";
import { fillTemplate } from "./template.js";
import deployTemplate from "./templates/deploy.yml";

/**
 * Build the application-deploy GitHub Actions workflow YAML from the static
 * `templates/deploy.yml` template. The template is committed as-is; only the
 * placeholder tokens (`{{ENV}}`, `{{APP_FILE}}`, and the platform-specific
 * snippets) are filled in — the workflow is never generated inline.
 */
export function generateDeployWorkflow(
  env: string,
  platform: ComputePlatform,
  appFile: string,
): string {
  return fillTemplate(deployTemplate, {
    ENV: env,
    APP_FILE: appFile,
    CLUSTER_AUTH: platform.deployClusterAuthSteps,
    RAD_CRED_REGISTER: platform.radCredentialRegister,
    RECIPE_AUTH_ENV: platform.recipeAuthEnv,
    DB_RECIPE_REGISTER: platform.dbRecipeRegister,
  });
}
