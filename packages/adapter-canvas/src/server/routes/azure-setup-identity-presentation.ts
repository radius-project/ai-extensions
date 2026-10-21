import type {
  AzureIdentityFailure,
  AzureIdentityProgress
} from "@radius-project/core";
import type { AzureAutoSetupWorkflow } from "./azure-auto-setup-types.js";
import { ENTRA_APP_RETENTION_NOTICE } from "./azure-setup-presentation.js";

export function createAzureIdentityPresentation({
  steps,
  fail
}: Pick<AzureAutoSetupWorkflow, "steps" | "fail">) {
  return {
    identityProgress(event: AzureIdentityProgress): void {
      switch (event.kind) {
        case "select-subscription":
          steps.push(`Selecting subscription ${event.subscriptionId}...`);
          return;
        case "check-login":
          steps.push("Checking Azure CLI login...");
          return;
        case "account-ready":
          steps.push(
            `✅ Using subscription=${event.subscriptionId}, tenant=${event.tenantId}`
          );
          return;
        case "resolve-oidc":
          steps.push("Resolving GitHub OIDC subject...");
          return;
        case "oidc-ready":
          steps.push(`✅ OIDC subject(s): ${event.subjects.join(", ")}`);
          return;
        case "application-retained":
          steps.push(
            `ℹ️ Created Entra app registration "${event.appName}". ${ENTRA_APP_RETENTION_NOTICE}`
          );
          return;
      }
    },
    finalizeIdentityFailure(event: AzureIdentityFailure): Promise<void> {
      switch (event.kind) {
        case "subscription-selection":
          return fail(
            400,
            `Could not select subscription ${event.subscriptionId}. Ensure you are logged in ("az login") to an account with access, then try again.${event.detail ? " Azure CLI: " + event.detail : ""}`,
            "az-subscription-set-failed",
            { steps }
          );
        case "not-logged-in":
          return fail(
            400,
            'Azure CLI not logged in. Run "az login" first.',
            "az-not-logged-in",
            { steps }
          );
        case "account-parse":
          return fail(
            400,
            'Azure CLI returned an invalid account identity from "az account show".',
            "az-account-parse",
            { steps }
          );
        case "tenant-mismatch":
          return fail(
            400,
            `Azure CLI is signed in to tenant ${event.activeTenantId}, but tenant ${event.tenantId} was requested. ` +
              `Run "az login --tenant ${event.tenantId}" and retry.`,
            "az-tenant-mismatch",
            { steps }
          );
        case "invalid-subscription":
          return fail(
            400,
            `Resolved subscription id "${event.subscriptionId}" is not a valid GUID.`,
            "invalid-subscription",
            { steps }
          );
        case "account-incomplete":
          return fail(
            400,
            'Could not determine a valid active Azure tenant. Run "az login" and "az account set --subscription <id>", then try again.',
            "az-account-incomplete",
            { steps }
          );
        case "oidc":
          return fail(400, event.message, event.code, { steps });
      }
    }
  };
}
