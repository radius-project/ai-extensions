import {
  buildAppCreateArgs,
  buildAppOwnerAddArgs,
  buildAppOwnerListArgs,
  buildAppTagPatchArgs,
  buildAppTagShowArgs,
  buildRadiusAppProvenanceTags,
  buildServicePrincipalObjectIdArgs,
  buildSignedInUserObjectIdArgs,
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
} from "./platforms/setup-azure-identity.js";
import type { RadiusAppProvenanceInput } from "./platforms/setup-azure-identity.js";
import type {
  AzureApplicationInput,
  AzureApplicationPorts,
  AzureApplication
} from "./setup-azure-contracts.js";
import type { ProviderMutationCommandResult } from "./setup-azure-recovery.js";
import {
  azureRetryDelayMs,
  isReplicationLagError,
  isRetryableAzureReadFailure
} from "./setup-azure-reads.js";
const CALLER_IDENTITY_LOOKUP_ATTEMPTS = 6;
const APP_PROPAGATION_ATTEMPTS = 6;
const APP_OWNERSHIP_READ_CONCURRENCY = 4;

interface AppRegistrationMatch {
  appId: string;
  displayName?: string;
  createdDateTime?: string;
  tags?: unknown;
}

async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await map(items[index]);
      }
    }
  );
  const settled = await Promise.allSettled(workers);
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (rejected) throw rejected.reason;
  return results;
}

async function persistReusedApplication(
  ports: AzureApplicationPorts
): Promise<boolean> {
  try {
    await ports.persist();
    return true;
  } catch (error) {
    ports.persistenceFailure(error);
    return false;
  }
}

export async function resolveAzureAutoSetupApplication({
  ports,
  oidc,
  environment,
  explicitAppId,
  createNewApp,
  appNameProvided,
  requestedAppName,
  requestedClientId,
  serviceManagementReference,
  callerIdentity,
  resumeAtCreate
}: AzureApplicationInput): Promise<AzureApplication | null> {
  const { runAz, runGitHubJson, stopBoundary, checkpoint } = ports;

  let appName =
    resumeAtCreate?.appName ??
    `radius-deploy-${oidc.fullName.replace("/", "-")}`;
  let applicationState: AzureApplication["state"] = "reused";
  if (!explicitAppId && !resumeAtCreate) {
    if (appNameProvided) {
      const nameCheck = validateAppRegistrationName(requestedAppName);
      if (!nameCheck.ok) {
        await ports.finalizeFailure({
          kind: "invalid-app-name",
          reason: String(nameCheck.reason),
          evidence: {}
        });
        return null;
      }
      appName = nameCheck.name;
    } else {
      const nameCheck = validateAppRegistrationName(appName);
      if (!nameCheck.ok) {
        await ports.finalizeFailure({
          kind: "invalid-derived-app-name",
          reason: String(nameCheck.reason),
          evidence: {}
        });
        return null;
      }
      appName = nameCheck.name;
    }
  }

  const applicationMutationKind = "azure_application.create";
  const applicationMutationTarget = `${oidc.fullName}:${environment}:${appName}`;
  const pendingApplicationCreate = ports.recovery.find(
    applicationMutationKind,
    applicationMutationTarget
  );
  const recoveringApplicationCreate =
    pendingApplicationCreate?.status === "prepared" ||
    pendingApplicationCreate?.status === "outcome_unknown" ||
    pendingApplicationCreate?.status === "confirmed";

  const skipApplicationReads =
    recoveringApplicationCreate || resumeAtCreate !== undefined;
  let existingClientId = skipApplicationReads ? "" : requestedClientId;
  if (!skipApplicationReads && !existingClientId) {
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

  type CallerObjectIdResult =
    { ok: true; id: string } | { ok: false; stderr: string };
  let callerObjectId: string | null = resumeAtCreate?.callerObjectId ?? null;
  let callerObjectIdLookup: Promise<CallerObjectIdResult> | null = null;
  // Resolves the object id for the principal classified by the account
  // preflight, so this service does not repeat `az account show`.
  const getCallerObjectId = async (): Promise<CallerObjectIdResult> => {
    if (callerObjectId !== null) return { ok: true, id: callerObjectId };
    callerObjectIdLookup ??= (async () => {
      if (callerIdentity.kind === "unsupported") {
        return { ok: false as const, stderr: callerIdentity.reason };
      }
      const lookupArgs =
        callerIdentity.kind === "servicePrincipal" ?
          buildServicePrincipalObjectIdArgs({ appId: callerIdentity.appId })
        : buildSignedInUserObjectIdArgs();
      let lookup = await runAz(lookupArgs);
      for (
        let attempt = 1;
        lookup.code !== 0 &&
        lookup.code !== "0" &&
        attempt < CALLER_IDENTITY_LOOKUP_ATTEMPTS;
        attempt++
      ) {
        const detail = lookup.stderr || lookup.stdout;
        if (!isRetryableAzureReadFailure(detail)) break;
        const delay = azureRetryDelayMs(detail, 2000 * attempt);
        if (delay === null) break;
        await ports.sleep(delay);
        lookup = await runAz(lookupArgs);
      }
      if (lookup.code !== 0 && lookup.code !== "0") {
        return {
          ok: false as const,
          stderr: lookup.stderr || lookup.stdout
        };
      }
      const id = lookup.stdout.trim().toLowerCase();
      // An empty id compares unequal to every owner, which would turn a failed
      // read into a silent "not owned". Ownership gates destructive setup here.
      if (!id) {
        return {
          ok: false as const,
          stderr:
            "Microsoft Entra returned no object id for the current Azure CLI identity."
        };
      }
      if (!isUuid(id)) {
        return {
          ok: false as const,
          stderr:
            "Microsoft Entra returned an invalid object id for the current Azure CLI identity."
        };
      }
      return { ok: true as const, id };
    })();
    const result = await callerObjectIdLookup;
    if (result.ok) callerObjectId = result.id;
    return result;
  };
  const isOwnedByCaller = async (appId: string) => {
    const caller = await getCallerObjectId();
    if (!caller.ok) return { ok: false as const, stderr: caller.stderr };
    const result = await runAz(buildAppOwnerListArgs({ appId }));
    if (result.code !== 0 && result.code !== "0") {
      return { ok: false as const, stderr: result.stderr };
    }
    return {
      ok: true as const,
      owned: parseDirectoryObjectIds(result.stdout).includes(caller.id)
    };
  };
  const readCreatedAppOwners = async (
    appId: string,
    ownerObjectId: string
  ): Promise<ProviderMutationCommandResult> => {
    let result: ProviderMutationCommandResult = {
      code: 1,
      stdout: "",
      stderr: "App Registration owners were not read."
    };
    for (let attempt = 1; attempt <= APP_PROPAGATION_ATTEMPTS; attempt++) {
      result = await runAz(buildAppOwnerListArgs({ appId }));
      const succeeded = result.code === 0 || result.code === "0";
      if (
        succeeded &&
        parseDirectoryObjectIds(result.stdout).includes(
          ownerObjectId.toLowerCase()
        )
      ) {
        return result;
      }
      const detail = result.stderr || result.stdout;
      if (
        !(
          succeeded ||
          isReplicationLagError(detail) ||
          isRetryableAzureReadFailure(detail)
        ) ||
        attempt >= APP_PROPAGATION_ATTEMPTS
      ) {
        break;
      }
      const delay = azureRetryDelayMs(detail, 2000 * attempt);
      if (delay === null) break;
      await ports.sleep(delay);
    }
    return result;
  };
  const readCreatedAppTags = async (
    appId: string,
    requiredTags: readonly string[]
  ): Promise<ProviderMutationCommandResult> => {
    let result: ProviderMutationCommandResult = {
      code: 1,
      stdout: "",
      stderr: "App Registration tags were not read."
    };
    for (let attempt = 1; attempt <= APP_PROPAGATION_ATTEMPTS; attempt++) {
      result = await runAz(buildAppTagShowArgs({ appId }));
      const succeeded = result.code === 0 || result.code === "0";
      const tags = succeeded ? parseAppTags(result.stdout) : null;
      if (tags && missingRequiredAppTags(tags, requiredTags).length === 0) {
        return result;
      }
      const detail = result.stderr || result.stdout;
      if (
        !(
          (succeeded && tags !== null) ||
          isReplicationLagError(detail) ||
          isRetryableAzureReadFailure(detail)
        ) ||
        attempt >= APP_PROPAGATION_ATTEMPTS
      ) {
        break;
      }
      const delay = azureRetryDelayMs(detail, 2000 * attempt);
      if (delay === null) break;
      await ports.sleep(delay);
    }
    return result;
  };
  const readRadiusProvenance = async (
    appId: string
  ): Promise<RadiusAppProvenanceInput | undefined> => {
    const result = await runAz(buildAppTagShowArgs({ appId }));
    if (result.code !== 0 && result.code !== "0") return undefined;
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

  if (!skipApplicationReads && existingClientId) {
    ports.progress({
      kind: "verify-existing-client",
      values: [String(existingClientId)]
    });
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
      const ownership = await isOwnedByCaller(existingClientId);
      if (!ownership.ok) {
        await ports.finalizeFailure({
          kind: "existing-client-owner-lookup",
          clientId: String(existingClientId),
          detail: String(ownership.stderr),
          evidence: { azError: ownership.stderr }
        });
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
      await ports.finalizeFailure({
        kind: "existing-client-verification",
        clientId: String(existingClientId),
        detail: String(showResult.stderr),
        code: decision.code,
        evidence: { azError: showResult.stderr }
      });
      return null;
    }
    if (decision.action === "error") {
      await ports.finalizeFailure({
        kind: "existing-client-ownership",
        message: decision.reason,
        clientId: String(existingClientId),
        code: decision.code,
        evidence: {}
      });
      return null;
    }
    if (decision.action === "reuse") {
      clientId = existingClientId;
      ports.progress({
        kind: "reuse-existing-client",
        values: [String(clientId)]
      });
      ports.recordAzureApp({
        state: "reused",
        origin: await classifyReuseOrigin(clientId),
        appId: clientId,
        displayName: null
      });
      if (!(await persistReusedApplication(ports))) {
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

    if (!skipApplicationReads && explicitAppId) {
      if (!isUuid(explicitAppId)) {
        await ports.finalizeFailure({
          kind: "invalid-app-id",
          evidence: {}
        });
        return null;
      }
      const ownership = await isOwnedByCaller(explicitAppId);
      if (!ownership.ok) {
        await ports.finalizeFailure({
          kind: "selected-application-owner-lookup",
          appId: String(explicitAppId),
          detail: String(ownership.stderr),
          evidence: { azError: ownership.stderr }
        });
        return null;
      }
      if (!ownership.owned) {
        const decision = decideRadiusAppOwnership({
          ownedByCaller: false,
          radiusProvenance: await readRadiusProvenance(explicitAppId)
        });
        await ports.finalizeFailure({
          kind: "selected-application-ownership",
          message: decision.reason,
          code: decision.code,
          evidence: { appName }
        });
        return null;
      }
      clientId = explicitAppId;
      ports.progress({
        kind: "select-application",
        values: [String(clientId)]
      });
      ports.recordAzureApp({
        state: "reused",
        origin: await classifyReuseOrigin(clientId),
        appId: clientId,
        displayName: null
      });
    }

    if (!clientId) {
      let matches: unknown[] = [];
      if (!resumeAtCreate) {
        ports.progress({
          kind: "list-applications",
          values: [String(appName)]
        });
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
          await ports.finalizeFailure({
            kind: "app-lookup-failed",
            detail: String(listResult.stderr),
            evidence: { azError: listResult.stderr }
          });
          return null;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(listResult.stdout);
        } catch {
          await ports.finalizeFailure({
            kind: "app-lookup-invalid-json",
            evidence: {}
          });
          return null;
        }
        if (!Array.isArray(parsed)) {
          await ports.finalizeFailure({
            kind: "app-lookup-parse",
            evidence: {}
          });
          return null;
        }
        matches = parsed;
      }

      const ownedMatches: AppRegistrationMatch[] = [];
      let unownedRadiusProvenance: RadiusAppProvenanceInput | undefined;
      if (!recoveringApplicationCreate) {
        const candidates = matches.filter(
          (match): match is AppRegistrationMatch =>
            Boolean(
              match &&
              typeof match === "object" &&
              "appId" in match &&
              typeof match.appId === "string" &&
              match.appId
            )
        );
        const ownershipResults = await mapWithLimit(
          candidates,
          APP_OWNERSHIP_READ_CONCURRENCY,
          async (match) => ({
            match,
            ownership: await isOwnedByCaller(String(match.appId))
          })
        );
        for (const { match, ownership } of ownershipResults) {
          if (!ownership.ok) {
            await ports.finalizeFailure({
              kind: "candidate-owner-lookup",
              appId: String(match.appId),
              detail: String(ownership.stderr),
              evidence: { azError: ownership.stderr }
            });
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
      }

      const selection = decideAppSelection({
        ownedMatches,
        hasUnownedMatch:
          !recoveringApplicationCreate && matches.length > ownedMatches.length,
        radiusProvenance: unownedRadiusProvenance,
        existingClientId,
        createNew:
          createNewApp || recoveringApplicationCreate || Boolean(resumeAtCreate)
      });
      if (selection.action === "error") {
        await ports.finalizeFailure({
          kind: "application-selection",
          message: selection.reason,
          code: selection.code,
          evidence: { appName }
        });
        return null;
      }
      if (selection.action === "needs-selection") {
        const candidates = [];
        for (const candidate of selection.candidates) {
          const servesRepos = await listServesRepos(candidate.appId);
          candidates.push({
            appId: candidate.appId,
            displayName: candidate.displayName,
            createdDateTime: candidate.createdDateTime,
            ...(servesRepos ? { servesRepos } : {})
          });
        }
        await ports.finalizeFailure({
          kind: "app-selection-required",
          evidence: {
            appName,
            candidates,
            defaultAppId: selection.defaultAppId
          }
        });
        return null;
      }
      if (selection.action === "reuse") {
        clientId = selection.appId;
        // The list query already projected this application's tags, so its
        // Radius provenance is decided without a second `az` round trip. An
        // application with no tags returns none, which is the empty array
        // rather than "unknown".
        const reusedMatch = ownedMatches[0];
        ports.progress({
          kind: "reuse-application",
          values: [String(clientId)]
        });
        ports.recordAzureApp({
          state: "reused",
          origin: await classifyReuseOrigin(
            clientId,
            Array.isArray(reusedMatch.tags) ? reusedMatch.tags : []
          ),
          appId: clientId,
          displayName: appName
        });
        if (!(await persistReusedApplication(ports))) {
          return null;
        }
      } else {
        const forwardCreate = ports.recovery.willWrite(
          applicationMutationKind,
          applicationMutationTarget
        );
        let callerBeforeCreate: { ok: true; id: string } | null = null;
        if (forwardCreate) {
          const caller = await getCallerObjectId();
          if (!caller.ok) {
            await ports.finalizeFailure({
              kind: "caller-before-application-create",
              detail: String(caller.stderr),
              evidence: { azError: caller.stderr }
            });
            return null;
          }
          callerBeforeCreate = caller;
        }
        ports.progress({
          kind: "create-application",
          values: [String(appName)]
        });
        // Only a forward create is stoppable. A journaled attempt that reaches
        // here to be reconciled is a read, and stopping before it would strand
        // the provenance of a request nobody saw answered.
        if (
          forwardCreate &&
          !(await stopBoundary("before-app-registration-create"))
        )
          return null;
        const createResult = await ports.recovery.execute({
          kind: applicationMutationKind,
          target: applicationMutationTarget,
          beforeMutation: () => stopBoundary("before-app-registration-create"),
          mutate: async () => {
            const result = await runAz(
              buildAppCreateArgs({
                appName,
                serviceManagementReference
              }).filter((arg): arg is string => typeof arg === "string")
            );
            if (
              (result.code === 0 || result.code === "0") &&
              !isUuid(result.stdout.trim())
            ) {
              return {
                ...result,
                code: 1,
                stderr:
                  "Microsoft Entra acknowledged the App Registration create without a valid application id."
              };
            }
            return result;
          },
          accept: (result) => result.stdout.trim(),
          providerIdOf: (_result, appId) => appId,
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
            const applicationArtifact = ports.getApplicationArtifact();
            const recordedAppId =
              (
                applicationArtifact?.origin === "this_operation" &&
                typeof applicationArtifact.appId === "string"
              ) ?
                applicationArtifact.appId
              : "";
            // The id the acknowledgement itself carried, settled with the
            // status rather than by the later ledger write. It is the only
            // identity that exists when the process died between the two.
            const journaledAppId =
              ports.recovery.find(
                applicationMutationKind,
                applicationMutationTarget
              )?.providerId || "";
            const operationTag = buildRadiusAppProvenanceTags({
              operationId: ports.operationId
            }).find((tag) => tag.includes(ports.operationId));
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
        if (createResult.state === "cancelled") return null;
        if (createResult.state === "not_applied") {
          const rejected = createResult.result;
          if (!(await stopBoundary("after-app-registration-create-attempt")))
            return null;
          if (
            !serviceManagementReference &&
            isServiceManagementReferenceError(rejected?.stderr)
          ) {
            await ports.finalizeFailure({
              kind: "service-management-reference-required",
              evidence: {
                azError: rejected?.stderr,
                appCreateContinuationAppName: appName,
                appCreateContinuationCallerObjectId:
                  callerBeforeCreate?.id || ""
              }
            });
            return null;
          }
          await ports.finalizeFailure({
            kind: "app-create-failed",
            stderr: rejected?.stderr || "",
            stdout: rejected?.stdout || "",
            evidence: { azError: rejected?.stderr || "" }
          });
          return null;
        }
        clientId = createResult.value;
        applicationState = "created";
        ports.progress({
          kind: "application-created",
          values: [String(clientId)]
        });
        ports.recordAzureApp({
          state: "created",
          origin: "this_operation",
          appId: clientId,
          displayName: appName,
          serviceManagementReference: serviceManagementReference || null
        });
        if (!(await checkpoint("after-app-registration-create"))) return null;

        const caller = callerBeforeCreate ?? (await getCallerObjectId());
        if (!caller.ok) {
          await ports.finalizeFailure({
            kind: "caller-after-application-create",
            detail: String(caller.stderr),
            evidence: { azError: caller.stderr, clientId, appName }
          });
          return null;
        }
        ports.progress({ kind: "add-application-owner", values: [] });
        const ownerMutationTarget = `${clientId}:${caller.id}`;
        if (
          ports.recovery.willWrite(
            "azure_app_owner.add",
            ownerMutationTarget
          ) &&
          !(await stopBoundary("before-app-registration-owner-add"))
        )
          return null;
        const ownerMutation =
          await ports.recovery.execute<ProviderMutationCommandResult>({
            kind: "azure_app_owner.add",
            target: ownerMutationTarget,
            providerIdempotencyKey: ownerMutationTarget,
            beforeMutation: () =>
              stopBoundary("before-app-registration-owner-add"),
            mutate: async () => {
              let result: ProviderMutationCommandResult = {
                code: 1,
                stdout: "",
                stderr: "App Registration owner assignment was not attempted."
              };
              for (
                let attempt = 1;
                attempt <= APP_PROPAGATION_ATTEMPTS;
                attempt++
              ) {
                result = await runAz(
                  buildAppOwnerAddArgs({
                    appId: clientId,
                    ownerObjectId: caller.id
                  })
                );
                if (
                  result.code === 0 ||
                  result.code === "0" ||
                  isAppOwnerAlreadyAssignedError(result.stderr)
                ) {
                  break;
                }
                if (
                  !isReplicationLagError(result.stderr || result.stdout) ||
                  attempt >= APP_PROPAGATION_ATTEMPTS
                ) {
                  break;
                }
                const delay = azureRetryDelayMs(
                  result.stderr || result.stdout,
                  2000 * attempt
                );
                if (delay === null) break;
                await ports.sleep(delay);
              }
              return isAppOwnerAlreadyAssignedError(result.stderr) ?
                  { ...result, code: 0, alreadyAssigned: true }
                : result;
            },
            accept: (result) => result,
            acceptedEvidence: (result) =>
              (result as { alreadyAssigned?: boolean }).alreadyAssigned ?
                "Entra reported the Azure CLI identity was already an owner, so this operation added nothing."
              : null,
            reconcile: async () => {
              const owners = await readCreatedAppOwners(clientId, caller.id);
              if (owners.code !== 0 && owners.code !== "0") {
                throw new Error(
                  owners.stderr ||
                    owners.stdout ||
                    "App Registration owners could not be read."
                );
              }
              const ownerIds = parseDirectoryObjectIds(owners.stdout);
              return ownerIds.includes(caller.id.toLowerCase()) ?
                  {
                    state: "applied" as const,
                    value: { code: 0, stdout: owners.stdout, stderr: "" },
                    evidence:
                      "The exact App Registration and Azure CLI owner identity matched."
                  }
                : {
                    state: "not_applied" as const,
                    evidence:
                      "Microsoft Entra confirmed the Azure CLI identity is not an owner."
                  };
            }
          });
        if (ownerMutation.state === "cancelled") return null;
        const ownerAdd =
          ownerMutation.state === "applied" ?
            ownerMutation.value
          : ownerMutation.result || {
              code: 1,
              stdout: "",
              stderr:
                "Microsoft Entra confirmed the owner assignment was not applied."
            };
        if (!(await checkpoint("after-app-registration-owner-add")))
          return null;
        if (
          ownerAdd.code !== 0 &&
          ownerAdd.code !== "0" &&
          !isAppOwnerAlreadyAssignedError(ownerAdd.stderr)
        ) {
          await ports.finalizeFailure({
            kind: "app-owner-add-failed",
            detail: String(ownerAdd.stderr),
            evidence: { azError: ownerAdd.stderr, clientId, appName }
          });
          return null;
        }

        ports.progress({ kind: "verify-application-owner", values: [] });
        const ownerList = await readCreatedAppOwners(clientId, caller.id);
        if (ownerList.code !== 0 && ownerList.code !== "0") {
          await ports.finalizeFailure({
            kind: "created-application-owner-lookup",
            detail: String(ownerList.stderr),
            evidence: { azError: ownerList.stderr, clientId, appName }
          });
          return null;
        }
        const ownerIds = parseDirectoryObjectIds(ownerList.stdout);
        if (!ownerIds.includes(caller.id.toLowerCase())) {
          await ports.finalizeFailure({
            kind: "app-owner-verify-failed",
            evidence: { azError: ownerList.stdout, clientId, appName }
          });
          return null;
        }
        ports.progress({ kind: "application-owner-verified", values: [] });
        if (!(await checkpoint("after-app-registration-owner-verify")))
          return null;

        const provenanceTags = buildRadiusAppProvenanceTags({
          repo: oidc.fullName,
          environment,
          operationId: ports.operationId
        });
        ports.progress({ kind: "patch-application-tags", values: [] });
        const tagMutationTarget = `${clientId}:${ports.operationId}`;
        if (
          ports.recovery.willWrite("azure_app_tags.patch", tagMutationTarget) &&
          !(await stopBoundary("before-app-registration-tag-update"))
        )
          return null;
        const tagMutation =
          await ports.recovery.execute<ProviderMutationCommandResult>({
            kind: "azure_app_tags.patch",
            target: tagMutationTarget,
            providerIdempotencyKey: clientId,
            beforeMutation: () =>
              stopBoundary("before-app-registration-tag-update"),
            mutate: async () => {
              let result: ProviderMutationCommandResult = {
                code: 1,
                stdout: "",
                stderr: "App Registration tag update was not attempted."
              };
              for (
                let attempt = 1;
                attempt <= APP_PROPAGATION_ATTEMPTS;
                attempt++
              ) {
                result = await runAz(
                  buildAppTagPatchArgs({
                    appId: clientId,
                    tags: provenanceTags
                  })
                );
                if (result.code === 0 || result.code === "0") break;
                if (
                  !isReplicationLagError(result.stderr || result.stdout) ||
                  attempt >= APP_PROPAGATION_ATTEMPTS
                ) {
                  break;
                }
                const delay = azureRetryDelayMs(
                  result.stderr || result.stdout,
                  2000 * attempt
                );
                if (delay === null) break;
                await ports.sleep(delay);
              }
              return result;
            },
            accept: (result) => result,
            reconcile: async () => {
              const shown = await readCreatedAppTags(clientId, provenanceTags);
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
        if (tagMutation.state === "cancelled") return null;
        const tagPatch =
          tagMutation.state === "applied" ?
            tagMutation.value
          : tagMutation.result || {
              code: 1,
              stdout: "",
              stderr:
                "Microsoft Entra confirmed the provenance tag update was not applied."
            };
        if (!(await checkpoint("after-app-registration-tag-update")))
          return null;
        if (tagPatch.code !== 0 && tagPatch.code !== "0") {
          await ports.finalizeFailure({
            kind: "app-tag-update-failed",
            detail: String(tagPatch.stderr),
            evidence: { azError: tagPatch.stderr, clientId, appName }
          });
          return null;
        }
        ports.progress({ kind: "verify-application-tags", values: [] });
        const tagShow = await readCreatedAppTags(clientId, provenanceTags);
        if (tagShow.code !== 0 && tagShow.code !== "0") {
          await ports.finalizeFailure({
            kind: "app-tag-read-failed",
            detail: String(tagShow.stderr),
            evidence: { azError: tagShow.stderr, clientId, appName }
          });
          return null;
        }
        const actualTags = parseAppTags(tagShow.stdout);
        if (!actualTags) {
          await ports.finalizeFailure({
            kind: "app-tag-parse-failed",
            evidence: { azError: tagShow.stdout, clientId, appName }
          });
          return null;
        }
        const missingTags = missingRequiredAppTags(actualTags, provenanceTags);
        if (missingTags.length > 0) {
          await ports.finalizeFailure({
            kind: "app-tag-verify-failed",
            missingTags: String(missingTags.join(", ")),
            evidence: { azError: JSON.stringify(actualTags), clientId, appName }
          });
          return null;
        }
        ports.progress({ kind: "application-tags-verified", values: [] });
        if (!(await checkpoint("after-app-registration-tag-verify")))
          return null;
      }
    }
  }

  return { clientId, appName, state: applicationState };
}
