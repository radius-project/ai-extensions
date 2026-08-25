import {
  buildAppCreateArgs,
  buildAppOwnerAddArgs,
  buildAppOwnerListArgs,
  buildAppTagPatchArgs,
  buildAppTagShowArgs,
  buildRadiusAppProvenanceTags,
  decideAppSelection,
  decideExistingClientId,
  decideRadiusAppOwnership,
  isAppOwnerAlreadyAssignedError,
  isAzResourceNotFound,
  isRadiusProvenanceMatch,
  isServiceManagementReferenceError,
  isUuid,
  missingRequiredAppTags,
  parseAppTags,
  parseDirectoryObjectIds,
  parseServedReposFromSubjects,
  validateAppRegistrationName
} from "../../azure-oidc.js";
import type {
  AzureAutoSetupApplicationInput,
  AzureAutoSetupApplicationResult,
  AzureAutoSetupCommandResult,
  AzureAutoSetupOperation,
  AzureAutoSetupWorkflow,
  RadiusAppProvenanceInput
} from "./azure-auto-setup-types.js";
import { providerMutationRecord } from "../../operations.js";
import { executeRecoverableMutation } from "../services/provider-mutation-recovery.js";

export const ENTRA_APP_RETENTION_NOTICE =
  "Radius retains this app registration if you later delete the environment; environment deletion removes only that environment's federated identity credential.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function persistReusedApplication(
  operation: AzureAutoSetupOperation,
  workflow: AzureAutoSetupWorkflow,
  operations: AzureAutoSetupApplicationInput["dependencies"]["operations"]
): Promise<boolean> {
  try {
    await operations.persist();
    return true;
  } catch (error) {
    operations.report({
      code: "operation-store-write-failed",
      message: `Could not persist setup operation ${operation.operationId}: ${errorMessage(error)}`
    });
    operations.finish(operation, "failed", {
      failure: {
        code: "operation-persistence-failed",
        stage: operation.currentStage,
        stepSeq: null,
        message:
          "Radius changed no cloud resources because it could not save the setup recovery record.",
        classification: "unknown"
      }
    });
    workflow.respond(500, {
      error:
        "Radius changed no cloud resources because it could not save the setup recovery record.",
      code: "operation-persistence-failed",
      operationId: operation.operationId
    });
    return false;
  }
}

export async function resolveAzureAutoSetupApplication({
  workflow,
  dependencies,
  oidc,
  environment,
  explicitAppId,
  createNewApp,
  appNameProvided,
  requestedAppName,
  requestedClientId,
  serviceManagementReference
}: AzureAutoSetupApplicationInput): Promise<AzureAutoSetupApplicationResult | null> {
  const { operation, steps, runAz, runGitHubJson, fail, checkpoint } = workflow;
  const { operations } = dependencies;

  let appName = `radius-deploy-${oidc.fullName.replace("/", "-")}`;
  let applicationState: AzureAutoSetupApplicationResult["state"] = "reused";
  if (!explicitAppId) {
    if (appNameProvided) {
      const nameCheck = validateAppRegistrationName(requestedAppName);
      if (!nameCheck.ok) {
        await fail(400, nameCheck.reason, "invalid-app-name", { steps });
        return null;
      }
      appName = nameCheck.name;
    } else {
      const nameCheck = validateAppRegistrationName(appName);
      if (!nameCheck.ok) {
        await fail(
          400,
          "The derived App Registration name is invalid: " +
            nameCheck.reason +
            " Supply a shorter appName.",
          "invalid-app-name",
          { steps }
        );
        return null;
      }
      appName = nameCheck.name;
    }
  }

  const applicationMutationKind = "azure_application.create";
  const applicationMutationTarget = `${oidc.fullName}:${environment}:${appName}`;
  const pendingApplicationCreate = providerMutationRecord(
    operation,
    applicationMutationKind,
    applicationMutationTarget
  );
  const recoveringApplicationCreate =
    pendingApplicationCreate?.status === "prepared" ||
    pendingApplicationCreate?.status === "outcome_unknown" ||
    pendingApplicationCreate?.status === "confirmed";

  let existingClientId = recoveringApplicationCreate ? "" : requestedClientId;
  if (!recoveringApplicationCreate && !existingClientId) {
    const variable = await runGitHubJson(
      `/repos/${oidc.fullName}/environments/${encodeURIComponent(
        environment
      )}/variables/AZURE_CLIENT_ID`
    );
    if (
      variable?.ok &&
      variable.json &&
      typeof variable.json.value === "string"
    ) {
      existingClientId = variable.json.value.trim();
    }
  }

  let signedInUserId: string | null = null;
  const getSignedInUserId = async (): Promise<
    { ok: true; id: string } | { ok: false; stderr: string }
  > => {
    if (signedInUserId !== null) return { ok: true, id: signedInUserId };
    const result = await runAz([
      "ad",
      "signed-in-user",
      "show",
      "--query",
      "id",
      "-o",
      "tsv"
    ]);
    if (result.code !== 0) return { ok: false, stderr: result.stderr };
    signedInUserId = result.stdout.trim().toLowerCase();
    return { ok: true, id: signedInUserId };
  };
  const isOwnedBySignedInUser = async (appId: string) => {
    const signedIn = await getSignedInUserId();
    if (!signedIn.ok) return { ok: false as const, stderr: signedIn.stderr };
    const result = await runAz(buildAppOwnerListArgs({ appId }));
    if (result.code !== 0) {
      return { ok: false as const, stderr: result.stderr };
    }
    return {
      ok: true as const,
      owned: parseDirectoryObjectIds(result.stdout).includes(signedIn.id)
    };
  };
  const readRadiusProvenance = async (
    appId: string
  ): Promise<RadiusAppProvenanceInput | undefined> => {
    const result = await runAz(buildAppTagShowArgs({ appId }));
    if (result.code !== 0) return undefined;
    return {
      tags: parseAppTags(result.stdout) || [],
      repo: oidc.fullName,
      environment
    };
  };

  // Which "reused" the customer is looking at. An App Registration Radius
  // tagged for this repository and environment was created by an earlier Radius
  // setup, and saying so is the difference between "Radius will keep this
  // because it was reused" reading as an explanation and reading as a bug to
  // someone who watched Create Environment make it.
  const classifyReuseOrigin = async (
    appId: string,
    knownTags?: unknown[]
  ): Promise<"pre_existing" | "radius_earlier_setup"> => {
    const provenance =
      knownTags ?
        { tags: knownTags, repo: oidc.fullName, environment }
      : await readRadiusProvenance(appId);
    if (!provenance) return "pre_existing";
    return isRadiusProvenanceMatch(provenance) ?
        "radius_earlier_setup"
      : "pre_existing";
  };

  let clientId = "";
  const rollbackCreatedAppAndFail = (
    error: string,
    code: string,
    azError: string
  ) =>
    fail(400, error, code, {
      steps,
      azError,
      clientId,
      appName
    });

  if (!recoveringApplicationCreate && existingClientId) {
    steps.push(
      `Verifying the repository's existing AZURE_CLIENT_ID: ${existingClientId}...`
    );
    const showResult = await runAz([
      "ad",
      "app",
      "show",
      "--id",
      existingClientId,
      "--query",
      "id",
      "-o",
      "tsv"
    ]);
    const showStatus =
      showResult.code === 0 && showResult.stdout.trim() ? "found"
      : isAzResourceNotFound(showResult.stderr) ? "not-found"
      : "lookup-failed";
    let owned = false;
    let radiusProvenance: RadiusAppProvenanceInput | undefined;
    if (showStatus === "found") {
      const ownership = await isOwnedBySignedInUser(existingClientId);
      if (!ownership.ok) {
        await fail(
          400,
          `Could not read owners of the existing AZURE_CLIENT_ID app ${existingClientId}: ` +
            ownership.stderr,
          "app-owner-lookup-failed",
          { steps, azError: ownership.stderr }
        );
        return null;
      }
      owned = ownership.owned;
      if (!owned) {
        radiusProvenance = await readRadiusProvenance(existingClientId);
      }
    }
    const decision = decideExistingClientId({
      clientId: existingClientId,
      showStatus,
      owned,
      radiusProvenance
    });
    if (decision.action === "fatal") {
      await fail(
        400,
        `Could not verify the repository's AZURE_CLIENT_ID (${existingClientId}): ` +
          showResult.stderr,
        decision.code || "existing-client-id-failed",
        { steps, azError: showResult.stderr }
      );
      return null;
    }
    if (decision.action === "error") {
      await fail(
        400,
        decision.reason ||
          `The repository's AZURE_CLIENT_ID (${existingClientId}) references an App Registration the current signed-in user does not own. Verify or clear the variable and retry.`,
        decision.code || "existing-client-id-not-owned",
        { steps }
      );
      return null;
    }
    if (decision.action === "reuse") {
      clientId = existingClientId;
      steps.push(
        `✅ Reusing the App Registration already wired into AZURE_CLIENT_ID: ${clientId}`
      );
      operations.recordAzureApp(operation, {
        state: "reused",
        origin: await classifyReuseOrigin(clientId),
        appId: clientId,
        displayName: null
      });
      if (!(await persistReusedApplication(operation, workflow, operations))) {
        return null;
      }
    }
  }

  if (!clientId) {
    const listServesRepos = async (appId: string) => {
      const result = await runAz([
        "ad",
        "app",
        "federated-credential",
        "list",
        "--id",
        appId,
        "--query",
        "[].subject",
        "-o",
        "json"
      ]);
      if (result.code !== 0) return undefined;
      try {
        return parseServedReposFromSubjects(JSON.parse(result.stdout));
      } catch {
        return undefined;
      }
    };

    if (!recoveringApplicationCreate && explicitAppId) {
      if (!isUuid(explicitAppId)) {
        await fail(
          400,
          "The selected App Registration id is not a valid GUID.",
          "invalid-app-id",
          { steps }
        );
        return null;
      }
      const ownership = await isOwnedBySignedInUser(explicitAppId);
      if (!ownership.ok) {
        await fail(
          400,
          `Could not read owners of App Registration ${explicitAppId}: ` +
            ownership.stderr,
          "app-owner-lookup-failed",
          { steps, azError: ownership.stderr }
        );
        return null;
      }
      if (!ownership.owned) {
        const decision = decideRadiusAppOwnership({
          ownedBySignedInUser: false,
          radiusProvenance: await readRadiusProvenance(explicitAppId)
        });
        await fail(
          400,
          decision.reason ||
            "The selected App Registration is not owned by the current signed-in user. Choose one you own or create a new application.",
          decision.code || "app-registration-not-owned",
          { steps, appName }
        );
        return null;
      }
      clientId = explicitAppId;
      steps.push(`✅ Using the selected App Registration: ${clientId}`);
      operations.recordAzureApp(operation, {
        state: "reused",
        origin: await classifyReuseOrigin(clientId),
        appId: clientId,
        displayName: null
      });
    }

    if (!clientId) {
      steps.push(`Looking up existing App Registration: ${appName}...`);
      const listResult = await runAz([
        "ad",
        "app",
        "list",
        "--filter",
        `displayName eq '${appName}'`,
        "--query",
        "[].{appId:appId,id:id,displayName:displayName,createdDateTime:createdDateTime,tags:tags}",
        "-o",
        "json"
      ]);
      if (listResult.code !== 0) {
        await fail(
          400,
          "Failed to look up existing App Registrations: " + listResult.stderr,
          "app-lookup-failed",
          { steps, azError: listResult.stderr }
        );
        return null;
      }
      let matches;
      try {
        const parsed = JSON.parse(listResult.stdout);
        if (!Array.isArray(parsed)) {
          await fail(
            400,
            "The App Registration lookup returned an unexpected (non-array) result.",
            "app-lookup-parse",
            { steps }
          );
          return null;
        }
        matches = parsed;
      } catch {
        await fail(
          400,
          "Could not parse the App Registration lookup result.",
          "app-lookup-parse",
          { steps }
        );
        return null;
      }

      const ownedMatches = [];
      let unownedRadiusProvenance: RadiusAppProvenanceInput | undefined;
      for (const match of matches) {
        if (!match || !match.appId) continue;
        const ownership = await isOwnedBySignedInUser(match.appId);
        if (!ownership.ok) {
          await fail(
            400,
            `Could not read owners of App Registration ${match.appId}: ` +
              ownership.stderr,
            "app-owner-lookup-failed",
            { steps, azError: ownership.stderr }
          );
          return null;
        }
        if (ownership.owned) ownedMatches.push(match);
        else if (!unownedRadiusProvenance) {
          unownedRadiusProvenance = {
            tags: Array.isArray(match.tags) ? match.tags : [],
            repo: oidc.fullName,
            environment
          };
        }
      }

      const selection = decideAppSelection({
        ownedMatches,
        hasUnownedMatch: matches.length > ownedMatches.length,
        radiusProvenance: unownedRadiusProvenance,
        existingClientId,
        createNew: createNewApp || recoveringApplicationCreate
      });
      if (selection.action === "error") {
        await fail(
          400,
          selection.reason || "Could not select an App Registration.",
          selection.code || "app-selection-failed",
          { steps, appName }
        );
        return null;
      }
      if (selection.action === "needs-selection") {
        const candidates = [];
        for (const candidate of selection.candidates || []) {
          const servesRepos = await listServesRepos(candidate.appId);
          candidates.push({
            appId: candidate.appId,
            displayName: candidate.displayName,
            createdDateTime: candidate.createdDateTime,
            ...(servesRepos ? { servesRepos } : {})
          });
        }
        await fail(
          400,
          "Multiple owned App Registrations found — choose which identity to use.",
          "app-selection-required",
          {
            steps,
            appName,
            candidates,
            defaultAppId: selection.defaultAppId
          }
        );
        return null;
      }
      if (selection.action === "reuse") {
        clientId = selection.appId || "";
        // The list query already projected this application's tags, so its
        // Radius provenance is decided without a second `az` round trip. An
        // application with no tags returns none, which is the empty array
        // rather than "unknown".
        const reusedMatch = ownedMatches.find(
          (candidate: { appId?: string; tags?: unknown }) =>
            candidate && candidate.appId === clientId
        );
        steps.push(`✅ Reusing existing App Registration: ${clientId}`);
        operations.recordAzureApp(operation, {
          state: "reused",
          origin: await classifyReuseOrigin(
            clientId,
            reusedMatch ?
              Array.isArray(reusedMatch.tags) ?
                reusedMatch.tags
              : []
            : undefined
          ),
          appId: clientId,
          displayName: appName
        });
        if (
          !(await persistReusedApplication(operation, workflow, operations))
        ) {
          return null;
        }
      } else {
        steps.push(`Creating Entra app registration: ${appName}...`);
        const createResult = await executeRecoverableMutation<string>({
          operation: operation as AzureAutoSetupOperation & {
            providerRecovery?: unknown;
          },
          kind: applicationMutationKind,
          target: applicationMutationTarget,
          persist: () => operations.persist(),
          mutate: () =>
            runAz(
              buildAppCreateArgs({
                appName,
                serviceManagementReference
              }).filter((arg): arg is string => typeof arg === "string")
            ),
          accept: (result) => result.stdout.trim(),
          // `az ad app create --query appId` answers with the id itself, so the
          // acknowledgement carries the identity. Settling it here writes it in
          // the same durable record as `confirmed`, which closes the window
          // where a crash before `recordAzureApp` would leave a created
          // application with no identity for a later pass to match.
          providerIdOf: (_result, appId) =>
            typeof appId === "string" && appId.trim() ? appId.trim() : null,
          reconcile: async () => {
            const lookup = await runAz([
              "ad",
              "app",
              "list",
              "--filter",
              `displayName eq '${appName}'`,
              "--query",
              "[].{appId:appId,displayName:displayName,tags:tags}",
              "-o",
              "json"
            ]);
            if (lookup.code !== 0 && lookup.code !== "0") {
              throw new Error(
                lookup.stderr || "The App Registration state could not be read."
              );
            }
            let candidates: Array<{
              appId?: unknown;
              displayName?: unknown;
              tags?: unknown;
            }>;
            try {
              const parsed: unknown = JSON.parse(lookup.stdout || "[]");
              candidates = Array.isArray(parsed) ? parsed : [];
            } catch {
              throw new Error(
                "The App Registration recovery lookup was unreadable."
              );
            }
            const recordedAppId =
              (
                operation.setupArtifacts?.azureApp?.origin ===
                  "this_operation" &&
                typeof operation.setupArtifacts.azureApp.appId === "string"
              ) ?
                operation.setupArtifacts.azureApp.appId
              : "";
            // The id the acknowledgement itself carried, settled with the
            // status rather than by the later ledger write. It is the only
            // identity that exists when the process died between the two.
            const journaledAppId =
              providerMutationRecord(
                operation,
                applicationMutationKind,
                applicationMutationTarget
              )?.providerId || "";
            const operationTag = buildRadiusAppProvenanceTags({
              operationId: operation.operationId
            }).find((tag) => tag.includes(operation.operationId));
            const exact = candidates.filter(
              (candidate) =>
                candidate.displayName === appName &&
                typeof candidate.appId === "string" &&
                candidate.appId &&
                ((journaledAppId && candidate.appId === journaledAppId) ||
                  (recordedAppId && candidate.appId === recordedAppId) ||
                  (operationTag &&
                    Array.isArray(candidate.tags) &&
                    candidate.tags.includes(operationTag)))
            );
            if (exact.length === 0) {
              if (candidates.length === 0) {
                throw new Error(
                  "No operation-provenanced App Registration is visible yet."
                );
              }
              return {
                state: "manual_required",
                guidance:
                  `One or more recent App Registrations named "${appName}" are visible, but none carries this operation's immutable provenance or a provider ID Radius saved before losing the response. ` +
                  "Radius will not adopt, modify, or delete any of them."
              };
            }
            if (exact.length > 1) {
              return {
                state: "manual_required",
                guidance:
                  `Multiple App Registrations named "${appName}" appeared during the interrupted request. ` +
                  "Radius will not guess which application belongs to this operation or create another one."
              };
            }
            const appId = String(exact[0].appId);
            return {
              state: "applied",
              value: appId,
              evidence:
                "The exact App Registration provider identity or immutable Radius operation provenance matched the interrupted operation."
            };
          }
        });
        if (createResult.state === "not_applied") {
          const rejected = createResult.result;
          if (
            !serviceManagementReference &&
            isServiceManagementReferenceError(rejected?.stderr)
          ) {
            await fail(
              400,
              "This Entra tenant requires a Service Management Reference on new App Registrations. " +
                "Enter your Service Management Reference (for Microsoft-internal tenants, your Service Tree ID GUID) and retry.",
              "service-management-reference-required",
              { steps, azError: rejected?.stderr || "" }
            );
            return null;
          }
          await fail(
            400,
            "Failed to create App Registration: " +
              (rejected?.stderr ||
                rejected?.stdout ||
                "The request was rejected."),
            "app-create-failed",
            { steps, azError: rejected?.stderr || "" }
          );
          return null;
        }
        clientId = createResult.value;
        applicationState = "created";
        steps.push(`✅ Entra app registration created: ${clientId}`);
        operations.recordAzureApp(operation, {
          state: "created",
          origin: "this_operation",
          appId: clientId,
          displayName: appName,
          serviceManagementReference: serviceManagementReference || null
        });
        if (!(await checkpoint())) return null;

        const signedIn = await getSignedInUserId();
        if (!signedIn.ok) {
          await rollbackCreatedAppAndFail(
            "Failed to read the signed-in Entra user after creating the App Registration: " +
              signedIn.stderr,
            "app-owner-lookup-failed",
            signedIn.stderr
          );
          return null;
        }
        steps.push(
          "Assigning the signed-in user as an owner of the new App Registration..."
        );
        const ownerMutation =
          await executeRecoverableMutation<AzureAutoSetupCommandResult>({
            operation,
            kind: "azure_app_owner.add",
            target: `${clientId}:${signedIn.id}`,
            providerIdempotencyKey: `${clientId}:${signedIn.id}`,
            persist: operations.persist,
            mutate: async () => {
              const result = await runAz(
                buildAppOwnerAddArgs({
                  appId: clientId,
                  ownerObjectId: signedIn.id
                })
              );
              return isAppOwnerAlreadyAssignedError(result.stderr) ?
                  { ...result, code: 0 }
                : result;
            },
            accept: (result) => result,
            reconcile: async () => {
              const owners = await runAz(
                buildAppOwnerListArgs({ appId: clientId })
              );
              if (owners.code !== 0 && owners.code !== "0") {
                throw new Error(
                  owners.stderr ||
                    owners.stdout ||
                    "App Registration owners could not be read."
                );
              }
              const ownerIds = parseDirectoryObjectIds(owners.stdout);
              return ownerIds.includes(signedIn.id.toLowerCase()) ?
                  {
                    state: "applied" as const,
                    value: { code: 0, stdout: owners.stdout, stderr: "" },
                    evidence:
                      "The exact App Registration and signed-in owner identity matched."
                  }
                : {
                    state: "not_applied" as const,
                    evidence:
                      "Microsoft Entra confirmed the signed-in user is not an owner."
                  };
            }
          });
        const ownerAdd =
          ownerMutation.state === "applied" ?
            ownerMutation.value
          : ownerMutation.result || {
              code: 1,
              stdout: "",
              stderr:
                "Microsoft Entra confirmed the owner assignment was not applied."
            };
        if (
          ownerAdd.code !== 0 &&
          !isAppOwnerAlreadyAssignedError(ownerAdd.stderr)
        ) {
          await rollbackCreatedAppAndFail(
            "Failed to assign the signed-in user as an owner of the new App Registration: " +
              ownerAdd.stderr,
            "app-owner-add-failed",
            ownerAdd.stderr
          );
          return null;
        }

        steps.push(
          "Verifying the signed-in user owns the new App Registration..."
        );
        const ownerList = await runAz(
          buildAppOwnerListArgs({ appId: clientId })
        );
        if (ownerList.code !== 0) {
          await rollbackCreatedAppAndFail(
            "Failed to verify owners of the new App Registration: " +
              ownerList.stderr,
            "app-owner-lookup-failed",
            ownerList.stderr
          );
          return null;
        }
        const ownerIds = parseDirectoryObjectIds(ownerList.stdout);
        if (!ownerIds.includes(signedIn.id.toLowerCase())) {
          await rollbackCreatedAppAndFail(
            "The signed-in user was not present in the App Registration owners after creation.",
            "app-owner-verify-failed",
            ownerList.stdout
          );
          return null;
        }
        steps.push("✅ Signed-in user verified as App Registration owner");
        if (!(await checkpoint())) return null;

        const provenanceTags = buildRadiusAppProvenanceTags({
          repo: oidc.fullName,
          environment,
          operationId: operation.operationId
        });
        steps.push(
          "Applying Radius provenance tags to the new App Registration..."
        );
        const tagMutation =
          await executeRecoverableMutation<AzureAutoSetupCommandResult>({
            operation,
            kind: "azure_app_tags.patch",
            target: `${clientId}:${operation.operationId}`,
            providerIdempotencyKey: clientId,
            persist: operations.persist,
            mutate: () =>
              runAz(
                buildAppTagPatchArgs({ appId: clientId, tags: provenanceTags })
              ),
            accept: (result) => result,
            reconcile: async () => {
              const shown = await runAz(
                buildAppTagShowArgs({ appId: clientId })
              );
              if (shown.code !== 0 && shown.code !== "0") {
                throw new Error(
                  shown.stderr ||
                    shown.stdout ||
                    "App Registration tags could not be read."
                );
              }
              const tags = parseAppTags(shown.stdout);
              if (!tags) {
                throw new Error(
                  "Microsoft Entra returned unreadable App Registration tags."
                );
              }
              const missing = missingRequiredAppTags(tags, provenanceTags);
              return missing.length === 0 ?
                  {
                    state: "applied" as const,
                    value: { code: 0, stdout: shown.stdout, stderr: "" },
                    evidence:
                      "The exact App Registration carries every Radius operation provenance tag."
                  }
                : {
                    state: "manual_required" as const,
                    guidance:
                      `App Registration "${clientId}" does not carry the exact Radius operation provenance tags. ` +
                      "Radius will not overwrite or delete it based on display name."
                  };
            }
          });
        const tagPatch =
          tagMutation.state === "applied" ?
            tagMutation.value
          : tagMutation.result || {
              code: 1,
              stdout: "",
              stderr:
                "Microsoft Entra confirmed the provenance tag update was not applied."
            };
        if (tagPatch.code !== 0) {
          await rollbackCreatedAppAndFail(
            "Failed to apply Radius provenance tags to the new App Registration: " +
              tagPatch.stderr,
            "app-tag-update-failed",
            tagPatch.stderr
          );
          return null;
        }
        steps.push("Verifying Radius provenance tags...");
        const tagShow = await runAz(buildAppTagShowArgs({ appId: clientId }));
        if (tagShow.code !== 0) {
          await rollbackCreatedAppAndFail(
            "Failed to read the App Registration tags after update: " +
              tagShow.stderr,
            "app-tag-read-failed",
            tagShow.stderr
          );
          return null;
        }
        const actualTags = parseAppTags(tagShow.stdout);
        if (!actualTags) {
          await rollbackCreatedAppAndFail(
            "Could not parse the App Registration tags after update.",
            "app-tag-parse-failed",
            tagShow.stdout
          );
          return null;
        }
        const missingTags = missingRequiredAppTags(actualTags, provenanceTags);
        if (missingTags.length > 0) {
          await rollbackCreatedAppAndFail(
            `The new App Registration is missing required Radius provenance tags: ${missingTags.join(
              ", "
            )}.`,
            "app-tag-verify-failed",
            JSON.stringify(actualTags)
          );
          return null;
        }
        steps.push("✅ Radius provenance tags verified");
        if (!(await checkpoint())) return null;
      }
    }
  }

  return { clientId, appName, state: applicationState };
}
