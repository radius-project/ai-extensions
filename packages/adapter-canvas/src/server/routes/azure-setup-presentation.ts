import {
  AZURE_SERVICE_MANAGEMENT_REFERENCE_PROMPT,
  type AzureSetupProgress,
  type AzureSetupFailure
} from "@radius-project/core";
import type { AzureAutoSetupWorkflow } from "./azure-auto-setup-types.js";
export const ENTRA_APP_RETENTION_NOTICE =
  "Radius retains this app registration if you later delete the environment; environment deletion removes only that environment's federated identity credential.";
export function createAzureSetupPresentation({
  steps,
  fail
}: Pick<AzureAutoSetupWorkflow, "steps" | "fail">) {
  return {
    progress(event: AzureSetupProgress): void {
      switch (event.kind) {
        case "verify-existing-client":
          steps.push(
            `Verifying the repository's existing AZURE_CLIENT_ID: ${event.values[0]}...`
          );
          return;
        case "reuse-existing-client":
          steps.push(
            `✅ Reusing the App Registration already wired into AZURE_CLIENT_ID: ${event.values[0]}`
          );
          return;
        case "select-application":
          steps.push(
            `✅ Using the selected App Registration: ${event.values[0]}`
          );
          return;
        case "list-applications":
          steps.push(
            `Looking up existing App Registration: ${event.values[0]}...`
          );
          return;
        case "reuse-application":
          steps.push(
            `✅ Reusing existing App Registration: ${event.values[0]}`
          );
          return;
        case "create-application":
          steps.push(`Creating Entra app registration: ${event.values[0]}...`);
          return;
        case "application-created":
          steps.push(`✅ Entra app registration created: ${event.values[0]}`);
          return;
        case "add-application-owner":
          steps.push(
            "Assigning the Azure CLI identity as an owner of the new App Registration..."
          );
          return;
        case "verify-application-owner":
          steps.push(
            "Verifying the Azure CLI identity owns the new App Registration..."
          );
          return;
        case "application-owner-verified":
          steps.push(
            "✅ Azure CLI identity verified as App Registration owner"
          );
          return;
        case "patch-application-tags":
          steps.push(
            "Applying Radius provenance tags to the new App Registration..."
          );
          return;
        case "verify-application-tags":
          steps.push("Verifying Radius provenance tags...");
          return;
        case "application-tags-verified":
          steps.push("✅ Radius provenance tags verified");
          return;
        case "legacy-mutable-credential":
          steps.push(
            `⚠️ Legacy mutable federated credential "${event.values[0]}" is still present. ` +
              `After immutable OIDC verification succeeds, remove it with: ` +
              `az ad app federated-credential delete --id ${event.values[1]} ` +
              `--federated-credential-id ${event.values[2]}`
          );
          return;
        case "credentials-already-present":
          steps.push(
            `✅ ${event.values[0]} federated credential(s) already present — skipping`
          );
          return;
        case "create-federated-credential":
          steps.push(`Creating federated credential "${event.values[0]}"...`);
          return;
        case "retry-federated-credential":
          steps.push(
            `Retrying federated credential "${event.values[0]}" after Azure propagation or throttling (attempt ${event.values[1]}/${event.values[2]})...`
          );
          return;
        case "federated-credential-ready":
          steps.push(
            `✅ Federated credential "${event.values[0]}" ${event.values[1] ? "created" : "reused"}`
          );
          return;
        case "create-service-principal":
          steps.push("Creating Service Principal...");
          return;
        case "service-principal-ready":
          steps.push("✅ Service Principal ready");
          return;
        case "service-principal-ownership-unknown":
          steps.push(
            "ℹ️ The Service Principal was absent before this step and present after it, but the create command did not report success, so Radius cannot prove it created it and will not remove it during setup deletion."
          );
          return;
        case "resolve-service-principal-id":
          steps.push("Resolving Service Principal object id...");
          return;
        case "assign-contributor":
          steps.push(`Assigning Contributor role on ${event.values[0]}...`);
          return;
        case "contributor-assigned":
          steps.push("✅ Contributor role assigned");
          return;
        case "assign-cluster-admin":
          steps.push(
            `Assigning Azure Kubernetes Service RBAC Cluster Admin on ${event.values[0]}...`
          );
          return;
        case "cluster-admin-assigned":
          steps.push("✅ AKS RBAC Cluster Admin role assigned");
          return;
        case "cluster-admin-warning":
          steps.push(
            "⚠️ Could not assign the AKS RBAC Cluster Admin role automatically. " +
              'If your cluster uses Azure RBAC for Kubernetes (the default for AKS Automatic) the deploy will fail at "Verify AKS Access". ' +
              `Grant it manually: az role assignment create --assignee-object-id ${event.values[0]} --assignee-principal-type ServicePrincipal --role "Azure Kubernetes Service RBAC Cluster Admin" --scope ${event.values[1]}` +
              "\nDetails: " +
              event.values[2]
          );
          return;
        case "assign-locks-contributor":
          steps.push(
            `Assigning Locks Contributor on ${event.values[0]} for applications that manage resource locks...`
          );
          return;
        case "locks-contributor-assigned":
          steps.push("✅ Locks Contributor role assigned");
          return;
        case "locks-contributor-warning":
          steps.push(
            "⚠️ Could not assign the Locks Contributor role automatically. " +
              "Applications whose recipes set a resource lock will fail to deploy, and " +
              'existing locked resources will fail to delete with "AuthorizationFailed". ' +
              `Grant the least-privilege role manually: az role assignment create --assignee-object-id ${event.values[0]} --assignee-principal-type ServicePrincipal --role "Locks Contributor" --scope ${event.values[1]}` +
              "\nDetails: " +
              event.values[2]
          );
          return;
      }
    },
    finalizeFailure(event: AzureSetupFailure): Promise<void> {
      switch (event.kind) {
        case "invalid-app-name":
          return fail(400, event.reason, "invalid-app-name", {
            steps,
            ...event.evidence
          });
        case "invalid-derived-app-name":
          return fail(
            400,
            "The derived App Registration name is invalid: " +
              event.reason +
              " Supply a shorter appName.",
            "invalid-app-name",
            { steps, ...event.evidence }
          );
        case "existing-client-owner-lookup":
          return fail(
            400,
            `Could not read owners of the existing AZURE_CLIENT_ID app ${event.clientId}: ` +
              event.detail,
            "app-owner-lookup-failed",
            { steps, ...event.evidence }
          );
        case "existing-client-verification":
          return fail(
            400,
            `Could not verify the repository's AZURE_CLIENT_ID (${event.clientId}): ` +
              event.detail,
            event.code || "existing-client-id-failed",
            { steps, ...event.evidence }
          );
        case "existing-client-ownership":
          return fail(
            400,
            event.message ||
              `The repository's AZURE_CLIENT_ID (${event.clientId}) references an App Registration the current Azure CLI identity does not own. Verify or clear the variable and retry.`,
            event.code || "existing-client-id-not-owned",
            { steps, ...event.evidence }
          );
        case "invalid-app-id":
          return fail(
            400,
            "The selected App Registration id is not a valid GUID.",
            "invalid-app-id",
            { steps, ...event.evidence }
          );
        case "selected-application-owner-lookup":
          return fail(
            400,
            `Could not read owners of App Registration ${event.appId}: ` +
              event.detail,
            "app-owner-lookup-failed",
            { steps, ...event.evidence }
          );
        case "selected-application-ownership":
          return fail(
            400,
            event.message ||
              "The selected App Registration is not owned by the current Azure CLI identity. Choose one you own or create a new application.",
            event.code || "app-registration-not-owned",
            { steps, ...event.evidence }
          );
        case "app-lookup-failed":
          return fail(
            400,
            "Failed to look up existing App Registrations: " + event.detail,
            "app-lookup-failed",
            { steps, ...event.evidence }
          );
        case "app-lookup-parse":
          return fail(
            400,
            "The App Registration lookup returned an unexpected (non-array) result.",
            "app-lookup-parse",
            { steps, ...event.evidence }
          );
        case "app-lookup-invalid-json":
          return fail(
            400,
            "Could not parse the App Registration lookup result.",
            "app-lookup-parse",
            { steps, ...event.evidence }
          );
        case "candidate-owner-lookup":
          return fail(
            400,
            `Could not read owners of App Registration ${event.appId}: ` +
              event.detail,
            "app-owner-lookup-failed",
            { steps, ...event.evidence }
          );
        case "application-selection":
          return fail(
            400,
            event.message || "Could not select an App Registration.",
            event.code || "app-selection-failed",
            { steps, ...event.evidence }
          );
        case "app-selection-required":
          return fail(
            400,
            "Multiple owned App Registrations found — choose which identity to use.",
            "app-selection-required",
            { steps, ...event.evidence }
          );
        case "caller-before-application-create":
          return fail(
            400,
            "Failed to resolve the current Azure CLI identity before creating the App Registration: " +
              event.detail,
            "app-owner-lookup-failed",
            { steps, ...event.evidence }
          );
        case "service-management-reference-required":
          return fail(
            400,
            AZURE_SERVICE_MANAGEMENT_REFERENCE_PROMPT.message,
            AZURE_SERVICE_MANAGEMENT_REFERENCE_PROMPT.code,
            { steps, ...event.evidence }
          );
        case "app-create-failed":
          return fail(
            400,
            "Failed to create App Registration: " +
              (event.stderr || event.stdout || "The request was rejected."),
            "app-create-failed",
            { steps, ...event.evidence }
          );
        case "caller-after-application-create":
          return fail(
            400,
            "Failed to resolve the current Azure CLI identity after creating the App Registration: " +
              event.detail,
            "app-owner-lookup-failed",
            { steps, ...event.evidence }
          );
        case "app-owner-add-failed":
          return fail(
            400,
            "Failed to assign the Azure CLI identity as an owner of the new App Registration: " +
              event.detail,
            "app-owner-add-failed",
            { steps, ...event.evidence }
          );
        case "created-application-owner-lookup":
          return fail(
            400,
            "Failed to verify owners of the new App Registration: " +
              event.detail,
            "app-owner-lookup-failed",
            { steps, ...event.evidence }
          );
        case "app-owner-verify-failed":
          return fail(
            400,
            "The Azure CLI identity was not present in the App Registration owners after creation.",
            "app-owner-verify-failed",
            { steps, ...event.evidence }
          );
        case "app-tag-update-failed":
          return fail(
            400,
            "Failed to apply Radius provenance tags to the new App Registration: " +
              event.detail,
            "app-tag-update-failed",
            { steps, ...event.evidence }
          );
        case "app-tag-read-failed":
          return fail(
            400,
            "Failed to read the App Registration tags after update: " +
              event.detail,
            "app-tag-read-failed",
            { steps, ...event.evidence }
          );
        case "app-tag-parse-failed":
          return fail(
            400,
            "Could not parse the App Registration tags after update.",
            "app-tag-parse-failed",
            { steps, ...event.evidence }
          );
        case "app-tag-verify-failed":
          return fail(
            400,
            `The new App Registration is missing required Radius provenance tags: ${event.missingTags}.`,
            "app-tag-verify-failed",
            { steps, ...event.evidence }
          );
        case "app-object-id-failed":
          return fail(
            400,
            `Could not resolve the Entra object id for App Registration ${event.clientId}.`,
            "app-object-id-failed",
            { steps, ...event.evidence }
          );
        case "federated-credential-list-failed":
          return fail(
            400,
            "Could not read the App Registration federated credentials: " +
              (event.stderr || event.stdout || "Azure CLI request failed."),
            "federated-credential-list-failed",
            { steps, ...event.evidence }
          );
        case "federated-credential-list-malformed":
          return fail(
            400,
            "Microsoft Entra returned an invalid federated credential list.",
            "federated-credential-list-malformed",
            { steps, ...event.evidence }
          );
        case "federated-credential-name-collision":
          return fail(
            400,
            `Federated credential name "${event.credentialName}" already exists with a different subject ` +
              `("${event.existingSubject}" vs required "${event.requiredSubject}"). Two environment ` +
              `names normalize to the same credential name — rename this environment to avoid characters ` +
              `that collapse together (for example ":" and "-").`,
            "federated-credential-name-collision",
            { steps, ...event.evidence }
          );
        case "federated-credential-identity-incomplete":
          return fail(
            400,
            `Could not verify the complete Entra identity for federated credential "${event.credentialName}".`,
            "federated-credential-identity-incomplete",
            { steps, ...event.evidence }
          );
        case "credential-provenance-write-failed":
          return fail(
            500,
            `Federated credential "${event.credentialName}" was ${event.created ? "created" : "found"}, but Radius could not save the ownership record needed for safe cleanup.`,
            "credential-provenance-write-failed",
            { steps, ...event.evidence }
          );
        case "federated-credential-failed":
          return fail(
            400,
            `Failed to create federated credential "${event.credentialName}": ` +
              event.detail,
            "federated-credential-failed",
            { steps, ...event.evidence }
          );
        case "federated-credential-subject-mismatch":
          return fail(
            400,
            `Federated credential "${event.credentialName}" ${event.created ? "could not be verified" : "already exists but its subject"} ` +
              `("${event.actualSubject || ""}") does not match the required subject ("${event.requiredSubject}").`,
            "federated-credential-subject-mismatch",
            { steps, ...event.evidence }
          );
        case "created-federated-credential-identity-incomplete":
          return fail(
            400,
            `Could not verify the complete Entra identity for federated credential "${event.credentialName}".`,
            "federated-credential-identity-incomplete",
            { steps, ...event.evidence }
          );
        case "provider-reconciliation-pending":
          return fail(
            409,
            "Provider reconciliation is still pending. Radius will not complete setup or start another provider mutation.",
            "provider-reconciliation-pending",
            { steps, ...event.evidence }
          );
        case "rollback-before-service-principal":
          return fail(
            409,
            "Radius reconciled an interrupted provider request and must delete the setup resources before creating a Service Principal.",
            "provider-rollback-pending",
            { steps, ...event.evidence }
          );
        case "sp-failed":
          return fail(
            400,
            "Could not create or find the Service Principal: " + event.detail,
            "sp-failed",
            { steps, ...event.evidence }
          );
        case "rollback-after-service-principal":
          return fail(
            409,
            "Radius reconciled the interrupted Service Principal request and must delete the setup resources before adding federated credentials.",
            "provider-rollback-pending",
            { steps, ...event.evidence }
          );
        case "rollback-after-federated-credential":
          return fail(
            409,
            "Radius reconciled an interrupted federated credential request and must delete the setup resources before assigning Azure roles.",
            "provider-rollback-pending",
            { steps, ...event.evidence }
          );
        case "sp-objectid-failed":
          return fail(
            400,
            "Could not resolve the Service Principal object id needed to assign Azure roles: " +
              event.detail,
            "sp-objectid-failed",
            { steps, ...event.evidence }
          );
        case "role-assignment-failed":
          return fail(
            400,
            "Failed to assign Contributor role: " + event.detail,
            "role-assignment-failed",
            { steps, ...event.evidence }
          );
        case "rollback-after-contributor":
          return fail(
            409,
            "Radius reconciled the interrupted Contributor assignment and must delete the setup resources before any further provider changes.",
            "provider-rollback-pending",
            { steps, ...event.evidence }
          );
        case "rollback-after-cluster-admin":
          return fail(
            409,
            "Radius reconciled the interrupted AKS role assignment and must delete the setup resources before setup can complete.",
            "provider-rollback-pending",
            { steps, ...event.evidence }
          );
        case "rollback-after-locks-contributor":
          return fail(
            409,
            "Radius reconciled the interrupted Locks Contributor role assignment and must delete the setup resources before setup can complete.",
            "provider-rollback-pending",
            { steps, ...event.evidence }
          );
      }
    }
  };
}
