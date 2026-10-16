import {
  findLegacyMutableCredentialName,
  parseFederatedCredentials,
  selectMissingFederatedCredentials,
  type AzureFederatedCredential
} from "./platforms/setup-azure-identity.js";
import type {
  AzureCredentialInput,
  AzureCredentialPorts
} from "./setup-azure-contracts.js";
import type { ProviderMutationCommandResult } from "./setup-azure-recovery.js";
import {
  AZURE_PROPAGATION_ATTEMPTS,
  readAzureWithPropagationRetry,
  parseFederatedCredentialInventory,
  hasCompleteFederatedCredentialIdentity,
  parseFederatedCredentialObject,
  azureRetryDelayMs,
  isReplicationLagError,
  isRetryableAzureReadFailure,
  buildRoleAssignmentArgs,
  findFederatedCredentialNameCollision,
  pickAksResourceGroup,
  federatedCredentialIdFrom,
  readFederatedCredentialId,
  type RoleAssignmentInput
} from "./setup-azure-reads.js";
const GITHUB_ACTIONS_OIDC_ISSUER =
  "https://token.actions.githubusercontent.com";
const AZURE_AD_TOKEN_EXCHANGE_AUDIENCE = "api://AzureADTokenExchange";
async function createFederatedCredentials({
  ports,
  oidc,
  oidcSuffix,
  clientId,
  tenantId,
  appName
}: Pick<
  AzureCredentialInput,
  "ports" | "oidc" | "oidcSuffix" | "clientId" | "tenantId" | "appName"
>): Promise<boolean> {
  const { runAz, stopBoundary, checkpoint } = ports;
  const appResult = await readAzureWithPropagationRetry(
    () =>
      runAz([
        "ad",
        "app",
        "show",
        "--id",
        clientId,
        "--query",
        "id",
        "-o",
        "tsv"
      ]),
    ports.sleep,
    (result) =>
      (result.code === 0 || result.code === "0") && result.stdout.trim() !== "",
    (result) => result.stdout.trim() === ""
  );
  const applicationObjectId = appResult.stdout.trim();
  if (
    (appResult.code !== 0 && appResult.code !== "0") ||
    !applicationObjectId
  ) {
    await ports.finalizeFailure({
      kind: "app-object-id-failed",
      clientId: String(clientId),
      evidence: { clientId, appName, azError: appResult.stderr }
    });
    return false;
  }
  const listArgs = [
    "ad",
    "app",
    "federated-credential",
    "list",
    "--id",
    clientId,
    "--query",
    "[].{id:id,name:name,subject:subject,issuer:issuer,audiences:audiences,claimsMatchingExpression:claimsMatchingExpression}",
    "-o",
    "json"
  ];
  const listResult = await readAzureWithPropagationRetry(
    () => runAz(listArgs),
    ports.sleep,
    (result) => result.code === 0 || result.code === "0"
  );
  if (listResult.code !== 0 && listResult.code !== "0") {
    await ports.finalizeFailure({
      kind: "federated-credential-list-failed",
      stderr: String(listResult?.stderr),
      stdout: String(listResult?.stdout),
      evidence: { clientId, appName, azError: listResult?.stderr || "" }
    });
    return false;
  }
  const inventory = parseFederatedCredentialInventory(listResult.stdout);
  if (!inventory) {
    await ports.finalizeFailure({
      kind: "federated-credential-list-malformed",
      evidence: { clientId, appName }
    });
    return false;
  }
  const existingSubjects = inventory.subjects;
  const existingNameToSubject = inventory.nameToSubject;
  const existingCredentials = parseFederatedCredentials(
    JSON.parse(listResult.stdout)
  );

  const mutableCredentialName = findLegacyMutableCredentialName(
    oidc,
    oidcSuffix,
    existingNameToSubject
  );
  if (mutableCredentialName) {
    ports.progress({
      kind: "legacy-mutable-credential",
      values: [
        String(mutableCredentialName),
        String(clientId),
        String(mutableCredentialName)
      ]
    });
  }
  const ordinarilyMissing = selectMissingFederatedCredentials(
    oidc.federatedCredentials,
    existingSubjects
  );
  const credentials = oidc.federatedCredentials.filter((credential) => {
    const pending = ports.recovery.find(
      "azure_federated_credential.create",
      `${clientId}:${credential.name}`
    );
    return (
      pending?.status === "prepared" ||
      pending?.status === "outcome_unknown" ||
      pending?.status === "confirmed" ||
      ordinarilyMissing.some(
        (missing) =>
          missing.name === credential.name &&
          missing.subject === credential.subject
      )
    );
  });
  const skippedCount = oidc.federatedCredentials.length - credentials.length;
  if (skippedCount > 0) {
    ports.progress({
      kind: "credentials-already-present",
      values: [String(skippedCount)]
    });
  }
  const collision = findFederatedCredentialNameCollision(
    credentials,
    existingNameToSubject
  );
  if (collision) {
    await ports.finalizeFailure({
      kind: "federated-credential-name-collision",
      credentialName: String(collision.name),
      existingSubject: String(collision.existingSubject),
      requiredSubject: String(collision.desiredSubject),
      evidence: { clientId, appName }
    });
    return false;
  }

  const recordProvenance = async (
    credential: AzureFederatedCredential,
    origin: "created" | "reused"
  ): Promise<boolean> => {
    if (!hasCompleteFederatedCredentialIdentity(credential)) {
      await ports.finalizeFailure({
        kind: "federated-credential-identity-incomplete",
        credentialName: String(credential.name),
        evidence: { clientId, appName }
      });
      return false;
    }
    try {
      await ports.recordFederatedCredentialProvenance({
        repo: oidc.fullName,
        repoId: oidc.repoId,
        environment: String(ports.environment || ""),
        tenantId,
        clientId,
        applicationObjectId,
        credentialId: credential.id,
        name: credential.name,
        subject: credential.subject,
        issuer: credential.issuer,
        audiences: credential.audiences,
        subjectConfig: oidc.subjectConfig,
        origin
      });
    } catch (error) {
      await ports.finalizeFailure({
        kind: "credential-provenance-write-failed",
        credentialName: credential.name,
        created: origin === "created",
        evidence: { clientId, appName, error: String(error) }
      });
      return false;
    }
    return checkpoint(
      `after-record-credential-provenance:${origin}:${credential.name}`
    );
  };

  for (const desired of oidc.federatedCredentials) {
    const existing = existingCredentials.find(
      (credential) => credential.subject === desired.subject
    );
    if (existing && !(await recordProvenance(existing, "reused"))) return false;
  }

  for (const credential of credentials) {
    ports.progress({
      kind: "create-federated-credential",
      values: [String(credential.name)]
    });
    const credentialTarget = `${clientId}:${credential.name}`;
    // Only a forward create is stoppable. A credential listed here because its
    // journal entry is still open needs the reconciling read to settle it.
    if (
      ports.recovery.willWrite(
        "azure_federated_credential.create",
        credentialTarget
      ) &&
      !(await stopBoundary(
        `before-federated-credential-create:${credential.name}`
      ))
    )
      return false;
    const contents = JSON.stringify({
      name: credential.name,
      issuer: GITHUB_ACTIONS_OIDC_ISSUER,
      subject: credential.subject,
      audiences: [AZURE_AD_TOKEN_EXCHANGE_AUDIENCE],
      description: `Created by Radius operation ${ports.operationId}`
    });
    const path = ports.tempFile.createPath();
    let result: ProviderMutationCommandResult = {
      code: 1,
      stdout: "",
      stderr:
        "Microsoft Entra confirmed the federated credential was not created."
    };
    try {
      ports.tempFile.write(path, contents);
      for (let attempt = 0; attempt < AZURE_PROPAGATION_ATTEMPTS; attempt++) {
        if (
          ports.recovery.willWrite(
            "azure_federated_credential.create",
            credentialTarget
          ) &&
          !(await stopBoundary(
            `before-federated-credential-create:${credential.name}`
          ))
        )
          return false;
        const mutation =
          await ports.recovery.execute<ProviderMutationCommandResult>({
            kind: "azure_federated_credential.create",
            target: credentialTarget,
            beforeMutation: () =>
              stopBoundary(
                `before-federated-credential-create:${credential.name}`
              ),
            mutate: () =>
              runAz([
                "ad",
                "app",
                "federated-credential",
                "create",
                "--id",
                clientId,
                "--parameters",
                "@" + path,
                "--query",
                "{id:id,name:name,subject:subject,issuer:issuer,audiences:audiences,description:description}",
                "-o",
                "json"
              ]),
            accept: (value) => value,
            providerIdOf: (result) => federatedCredentialIdFrom(result.stdout),
            reconcile: async () => {
              const shown = await runAz([
                "ad",
                "app",
                "federated-credential",
                "show",
                "--id",
                clientId,
                "--federated-credential-id",
                credential.name,
                "--query",
                "{id:id,subject:subject,description:description}",
                "-o",
                "json"
              ]);
              if (shown.code !== 0 && shown.code !== "0") {
                if (
                  /not found|does not exist/i.test(shown.stderr || shown.stdout)
                ) {
                  return {
                    state: "not_applied" as const,
                    evidence:
                      "Microsoft Entra confirmed the federated credential is absent."
                  };
                }
                throw new Error(
                  shown.stderr ||
                    shown.stdout ||
                    "The federated credential could not be read."
                );
              }
              let actual: {
                id?: unknown;
                subject?: unknown;
                description?: unknown;
              };
              try {
                actual = JSON.parse(shown.stdout) as {
                  id?: unknown;
                  subject?: unknown;
                  description?: unknown;
                };
              } catch {
                throw new Error(
                  "Microsoft Entra returned unreadable federated credential state."
                );
              }
              if (
                actual.subject !== credential.subject ||
                actual.description !==
                  `Created by Radius operation ${ports.operationId}`
              ) {
                return {
                  state: "manual_required" as const,
                  guidance:
                    `Federated credential "${credential.name}" exists, but its subject or Radius operation provenance does not match. ` +
                    "Radius will not overwrite or delete it."
                };
              }
              return {
                state: "applied" as const,
                value: { code: 0, stdout: shown.stdout, stderr: "" },
                evidence:
                  "The credential name, subject, and Radius operation provenance matched."
              };
            }
          });
        if (mutation.state === "cancelled") return false;
        result =
          mutation.state === "applied" ?
            mutation.value
          : mutation.result || {
              code: 1,
              stdout: "",
              stderr:
                "Microsoft Entra confirmed the federated credential was not created."
            };
        const detail = result.stderr || result.stdout;
        const permissionFailure =
          /HTTP\s*(?:401|403)|Authorization|Authentication|Insufficient privileges/i.test(
            detail
          );
        // A reconciled absence alone cannot authorize replay of a lost write.
        if (
          mutation.state !== "not_applied" ||
          !mutation.result ||
          permissionFailure ||
          (!isReplicationLagError(detail) &&
            !isRetryableAzureReadFailure(detail)) ||
          attempt + 1 >= AZURE_PROPAGATION_ATTEMPTS
        )
          break;
        if (
          !(await checkpoint(
            `after-federated-credential-create-attempt:${credential.name}`
          )) ||
          !(await stopBoundary(
            `before-federated-credential-backoff:${credential.name}`
          ))
        )
          return false;
        const delay = azureRetryDelayMs(detail, 2000 * (attempt + 1));
        if (delay === null) break;
        ports.progress({
          kind: "retry-federated-credential",
          values: [credential.name, attempt + 2, AZURE_PROPAGATION_ATTEMPTS]
        });
        await ports.sleep(delay);
      }
    } finally {
      ports.tempFile.remove(path);
    }
    const created = result.code === 0 || result.code === "0";
    if (created) {
      // Record rollback authority before live verification. If verification
      // fails, the operation must still remember the object it just created.
      ports.recordCreatedFederatedCredential({
        name: credential.name,
        subject: credential.subject,
        providerId:
          ports.recovery.find(
            "azure_federated_credential.create",
            `${clientId}:${credential.name}`
          )?.providerId ||
          (await readFederatedCredentialId(runAz, clientId, credential.name))
      });
      if (
        !(await checkpoint(
          `after-federated-credential-create:${credential.name}`
        ))
      )
        return false;
    }
    if (!created) {
      if (
        !(await checkpoint(
          `after-federated-credential-create-attempt:${credential.name}`
        ))
      )
        return false;
      if (!result.stderr.includes("already exists")) {
        await ports.finalizeFailure({
          kind: "federated-credential-failed",
          credentialName: String(credential.name),
          detail: String(result.stderr || result.stdout),
          evidence: { clientId, appName, azError: result.stderr }
        });
        return false;
      }
    }
    const showCredential = () =>
      runAz([
        "ad",
        "app",
        "federated-credential",
        "show",
        "--id",
        clientId,
        "--federated-credential-id",
        credential.name,
        "--query",
        "{id:id,name:name,subject:subject,issuer:issuer,audiences:audiences}",
        "-o",
        "json"
      ]);
    const showResult = await readAzureWithPropagationRetry(
      showCredential,
      ports.sleep,
      (candidate) => {
        const live = parseFederatedCredentialObject(candidate.stdout);
        return (
          (candidate.code === 0 || candidate.code === "0") &&
          live?.subject === credential.subject &&
          hasCompleteFederatedCredentialIdentity(live)
        );
      },
      (candidate) => {
        const live = parseFederatedCredentialObject(candidate.stdout);
        return (
          created &&
          (!live ||
            live.subject === "" ||
            !hasCompleteFederatedCredentialIdentity(live))
        );
      }
    );
    const liveCredential = parseFederatedCredentialObject(showResult.stdout);
    if (
      (showResult.code !== 0 && showResult.code !== "0") ||
      liveCredential?.subject !== credential.subject
    ) {
      await ports.finalizeFailure({
        kind: "federated-credential-subject-mismatch",
        credentialName: credential.name,
        created: created,
        actualSubject: liveCredential?.subject || "",
        requiredSubject: credential.subject,
        evidence: { clientId, appName }
      });
      return false;
    }
    if (
      !liveCredential ||
      !hasCompleteFederatedCredentialIdentity(liveCredential)
    ) {
      await ports.finalizeFailure({
        kind: "created-federated-credential-identity-incomplete",
        credentialName: String(credential.name),
        evidence: { clientId, appName }
      });
      return false;
    }
    ports.progress({
      kind: "federated-credential-ready",
      values: [credential.name, created]
    });
    if (
      !(await recordProvenance(liveCredential, created ? "created" : "reused"))
    )
      return false;
  }
  const unresolvedCredentials = ports.recovery
    .unresolved()
    .filter(
      (mutation) => mutation.kind === "azure_federated_credential.create"
    );
  if (unresolvedCredentials.length > 0) {
    await ports.finalizeFailure({
      kind: "provider-reconciliation-pending",
      evidence: { clientId, appName }
    });
    return false;
  }
  return true;
}

async function resolveServicePrincipalObjectId(
  clientId: string,
  runAz: AzureCredentialInput["ports"]["runAz"],
  sleep: AzureCredentialInput["ports"]["sleep"]
): Promise<{ objectId: string; error: string }> {
  const result = await readAzureWithPropagationRetry(
    () =>
      runAz([
        "ad",
        "sp",
        "show",
        "--id",
        clientId,
        "--query",
        "id",
        "-o",
        "tsv"
      ]),
    sleep,
    (candidate) =>
      (candidate.code === 0 || candidate.code === "0") &&
      candidate.stdout.trim() !== "",
    (candidate) => candidate.stdout.trim() === ""
  );
  const objectId = result.stdout.trim();
  return {
    objectId:
      (result.code === 0 || result.code === "0") && objectId ? objectId : "",
    error: result.stderr || result.stdout
  };
}

async function assignRole(
  input: RoleAssignmentInput & { assignmentId: string },
  ports: AzureCredentialPorts,
  runAz: AzureCredentialInput["ports"]["runAz"],
  sleep: AzureCredentialInput["ports"]["sleep"],
  stopBoundary: AzureCredentialInput["ports"]["stopBoundary"]
): Promise<
  | { ok: true; created: boolean; stderr: "" }
  | { ok: false; stopped: true; created: false; stderr: "" }
  | { ok: false; stopped?: false; created: false; stderr: string }
> {
  let last: ProviderMutationCommandResult = {
    code: 1,
    stdout: "",
    stderr: ""
  };
  const mutationKind = "azure_role_assignment.create";
  const mutationTarget = input.assignmentId;
  for (let attempt = 0; attempt < AZURE_PROPAGATION_ATTEMPTS; attempt++) {
    const attemptNumber = attempt + 1;
    // Only a forward attempt is stoppable. A journaled attempt that reaches here
    // to be reconciled is a read, and stopping before it would strand the
    // provenance of a request nobody saw answered.
    if (
      ports.recovery.willWrite(mutationKind, mutationTarget) &&
      !(await stopBoundary(
        `before-role-assignment:${input.role}:attempt-${attemptNumber}`
      ))
    ) {
      return { ok: false, stopped: true, created: false, stderr: "" };
    }
    const mutation =
      await ports.recovery.execute<ProviderMutationCommandResult>({
        kind: mutationKind,
        target: mutationTarget,
        providerIdempotencyKey: input.assignmentId,
        beforeMutation: () =>
          stopBoundary(
            `before-role-assignment:${input.role}:attempt-${attemptNumber}`
          ),
        mutate: () => runAz(buildRoleAssignmentArgs(input)),
        accept: (value) => value,
        createdByOperation: (value) => !value.stderr.includes("already exists"),
        reconcile: async () => {
          const listed = await runAz([
            "role",
            "assignment",
            "list",
            "--scope",
            input.scope,
            "--query",
            `[?name=='${input.assignmentId}'].{id:id,principalId:principalId,roleDefinitionName:roleDefinitionName,scope:scope}`,
            "-o",
            "json"
          ]);
          if (listed.code !== 0 && listed.code !== "0") {
            if (
              /not found|does not exist/i.test(listed.stderr || listed.stdout)
            ) {
              return {
                state: "not_applied" as const,
                evidence:
                  "Azure confirmed the deterministic assignment ID is absent."
              };
            }
            throw new Error(
              listed.stderr ||
                listed.stdout ||
                "The Azure role assignment could not be read."
            );
          }
          let matches: Array<{
            id?: unknown;
            principalId?: unknown;
            roleDefinitionName?: unknown;
            scope?: unknown;
          }>;
          try {
            matches = JSON.parse(listed.stdout) as typeof matches;
          } catch {
            throw new Error("Azure returned unreadable role assignment state.");
          }
          if (!Array.isArray(matches)) {
            throw new Error("Azure returned unreadable role assignment state.");
          }
          if (matches.length === 0) {
            return {
              state: "not_applied" as const,
              evidence:
                "Azure confirmed the deterministic assignment ID is absent."
            };
          }
          const actual = matches.length === 1 ? matches[0] : undefined;
          if (
            !actual ||
            typeof actual.id !== "string" ||
            !actual.id
              .toLowerCase()
              .endsWith(`/${input.assignmentId.toLowerCase()}`) ||
            actual.principalId !== input.objectId ||
            actual.roleDefinitionName !== input.role ||
            typeof actual.scope !== "string" ||
            actual.scope.toLowerCase() !== input.scope.toLowerCase()
          ) {
            return {
              state: "manual_required" as const,
              guidance:
                `Azure role assignment "${input.assignmentId}" exists, but its principal, role, or scope does not match this operation. ` +
                "Radius will not modify or delete it."
            };
          }
          return {
            state: "applied" as const,
            value: {
              code: 0,
              stdout: listed.stdout,
              stderr:
                (
                  ports.recovery.find(mutationKind, mutationTarget)
                    ?.createdByOperation === false
                ) ?
                  "already exists"
                : ""
            },
            evidence:
              "The deterministic assignment ID, principal, role, and scope matched."
          };
        }
      });
    if (mutation.state === "cancelled") {
      return { ok: false, stopped: true, created: false, stderr: "" };
    }
    last =
      mutation.state === "applied" ?
        mutation.value
      : mutation.result || {
          code: 1,
          stdout: "",
          stderr: "Azure confirmed the role assignment was not created."
        };
    if (last.code === 0) {
      return {
        ok: true,
        created: !last.stderr.includes("already exists"),
        stderr: ""
      };
    }
    if (
      !(await stopBoundary(
        `after-role-assignment-attempt:${input.role}:attempt-${attemptNumber}`
      ))
    ) {
      return { ok: false, stopped: true, created: false, stderr: "" };
    }
    if (last.stderr.includes("already exists")) {
      return { ok: true, created: false, stderr: "" };
    }
    const failureDetail = last.stderr || last.stdout;
    if (
      !isReplicationLagError(failureDetail) &&
      !isRetryableAzureReadFailure(failureDetail)
    ) {
      break;
    }
    if (attempt + 1 < AZURE_PROPAGATION_ATTEMPTS) {
      if (
        !(await stopBoundary(
          `before-role-assignment-backoff:${input.role}:attempt-${attemptNumber}`
        ))
      ) {
        return { ok: false, stopped: true, created: false, stderr: "" };
      }
      const delay = azureRetryDelayMs(failureDetail, 2000 * attemptNumber);
      if (delay === null) break;
      await sleep(delay);
    }
  }
  return { ok: false, created: false, stderr: last.stderr };
}

export async function configureAzureAutoSetupCredentials({
  ports,
  oidc,
  oidcSuffix,
  clientId,
  tenantId,
  appName,
  subscriptionId,
  resourceGroup,
  clusterResourceGroup,
  clusterName
}: AzureCredentialInput): Promise<boolean> {
  const { runAz, stopBoundary, checkpoint } = ports;

  // Reconciliation may have decided this attempt must be undone while the
  // request that reached here was still in flight. Every mutation below adds a
  // resource to a set the rollback has already been selected for, so the halt
  // comes before the first one rather than after it.
  if (ports.isRollbackPending()) {
    await ports.finalizeFailure({
      kind: "rollback-before-service-principal",
      evidence: { clientId, appName }
    });
    return false;
  }
  ports.progress({ kind: "create-service-principal", values: [] });
  const servicePrincipal = await ports.ensureServicePrincipal(clientId, () =>
    stopBoundary("before-service-principal-create")
  );
  if (!servicePrincipal.ok) {
    if (servicePrincipal.stopped) return false;
    await ports.finalizeFailure({
      kind: "sp-failed",
      detail: String(servicePrincipal.stderr),
      evidence: { clientId, appName, azError: servicePrincipal.stderr }
    });
    return false;
  }
  ports.progress({ kind: "service-principal-ready", values: [] });
  if (servicePrincipal.state === "created_candidate") {
    ports.progress({ kind: "service-principal-ownership-unknown", values: [] });
  }
  ports.recordServicePrincipal({
    state: servicePrincipal.state,
    origin: servicePrincipal.origin,
    appId: clientId,
    ...(servicePrincipal.objectId ?
      { objectId: servicePrincipal.objectId }
    : {})
  });
  if (!(await checkpoint("after-service-principal"))) return false;

  if (ports.isRollbackPending()) {
    await ports.finalizeFailure({
      kind: "rollback-after-service-principal",
      evidence: { clientId, appName }
    });
    return false;
  }
  const credentialsReady = await ports.withCredentialProvenanceLock(() =>
    createFederatedCredentials({
      ports,
      oidc,
      oidcSuffix,
      clientId,
      tenantId,
      appName
    })
  );
  if (!credentialsReady) {
    return false;
  }
  if (ports.isRollbackPending()) {
    await ports.finalizeFailure({
      kind: "rollback-after-federated-credential",
      evidence: { clientId, appName }
    });
    return false;
  }

  let servicePrincipalObjectId = servicePrincipal.objectId;
  if (!servicePrincipalObjectId) {
    ports.progress({ kind: "resolve-service-principal-id", values: [] });
    const lookup = await resolveServicePrincipalObjectId(
      clientId,
      runAz,
      ports.sleep
    );
    if (!lookup.objectId) {
      await ports.finalizeFailure({
        kind: "sp-objectid-failed",
        detail: String(lookup.error),
        evidence: { clientId, appName, azError: lookup.error }
      });
      return false;
    }
    servicePrincipalObjectId = lookup.objectId;
  }
  ports.recordServicePrincipal({
    objectId: servicePrincipalObjectId
  });
  if (!(await checkpoint("after-service-principal-object-id"))) return false;

  const contributorScope = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;
  const contributorAssignmentId = ports.deterministicUuid(
    `${ports.operationId}\0${servicePrincipalObjectId}\0Contributor\0${contributorScope}`
  );
  ports.progress({
    kind: "assign-contributor",
    values: [String(resourceGroup)]
  });
  const contributor = await assignRole(
    {
      objectId: servicePrincipalObjectId,
      assignmentId: contributorAssignmentId,
      role: "Contributor",
      scope: contributorScope,
      subscriptionId
    },
    ports,
    runAz,
    ports.sleep,
    stopBoundary
  );
  if (!contributor.ok) {
    if (contributor.stopped) return false;
    await ports.finalizeFailure({
      kind: "role-assignment-failed",
      detail: String(contributor.stderr),
      evidence: { clientId, appName, azError: contributor.stderr }
    });
    return false;
  }
  ports.progress({ kind: "contributor-assigned", values: [] });
  if (contributor.created) {
    ports.recordCreatedRoleAssignment({
      assignmentId: contributorAssignmentId,
      role: "Contributor",
      scope: contributorScope,
      principalObjectId: servicePrincipalObjectId
    });
    if (!(await checkpoint("after-role-assignment:Contributor"))) return false;
  }
  if (ports.isRollbackPending()) {
    await ports.finalizeFailure({
      kind: "rollback-after-contributor",
      evidence: { clientId, appName }
    });
    return false;
  }

  const aksResourceGroup = pickAksResourceGroup(
    clusterResourceGroup,
    resourceGroup
  );
  const clusterScope = `/subscriptions/${subscriptionId}/resourceGroups/${aksResourceGroup}/providers/Microsoft.ContainerService/managedClusters/${clusterName}`;
  const clusterAssignmentId = ports.deterministicUuid(
    `${ports.operationId}\0${servicePrincipalObjectId}\0Azure Kubernetes Service RBAC Cluster Admin\0${clusterScope}`
  );
  ports.progress({
    kind: "assign-cluster-admin",
    values: [String(clusterName)]
  });
  const clusterRole = await assignRole(
    {
      objectId: servicePrincipalObjectId,
      assignmentId: clusterAssignmentId,
      role: "Azure Kubernetes Service RBAC Cluster Admin",
      scope: clusterScope,
      subscriptionId
    },
    ports,
    runAz,
    ports.sleep,
    stopBoundary
  );
  if (clusterRole.ok) {
    ports.progress({ kind: "cluster-admin-assigned", values: [] });
    if (clusterRole.created) {
      ports.recordCreatedRoleAssignment({
        assignmentId: clusterAssignmentId,
        role: "Azure Kubernetes Service RBAC Cluster Admin",
        scope: clusterScope,
        principalObjectId: servicePrincipalObjectId
      });
      if (
        !(await checkpoint(
          "after-role-assignment:Azure Kubernetes Service RBAC Cluster Admin"
        ))
      )
        return false;
    }
  } else if (clusterRole.stopped) {
    return false;
  } else {
    ports.progress({
      kind: "cluster-admin-warning",
      values: [
        String(servicePrincipalObjectId),
        String(clusterScope),
        String(clusterRole.stderr)
      ]
    });
  }
  if (ports.isRollbackPending()) {
    await ports.finalizeFailure({
      kind: "rollback-after-cluster-admin",
      evidence: { clientId, appName }
    });
    return false;
  }

  // Contributor cannot manage Microsoft.Authorization/locks. Locks Contributor
  // (28bf596f-4eb7-45ce-b5bc-6cf482fec137) grants only the lock read, write, and
  // delete actions needed by recipes that create CanNotDelete locks.
  //
  // Best-effort and non-fatal, like the AKS cluster role: the operator may not
  // be allowed to create role assignments, and applications that never request
  // a lock work without this role.
  const locksContributorAssignmentId = ports.deterministicUuid(
    `${ports.operationId}\0${servicePrincipalObjectId}\0Locks Contributor\0${contributorScope}`
  );
  ports.progress({
    kind: "assign-locks-contributor",
    values: [String(resourceGroup)]
  });
  const locksContributor = await assignRole(
    {
      objectId: servicePrincipalObjectId,
      assignmentId: locksContributorAssignmentId,
      role: "Locks Contributor",
      scope: contributorScope,
      subscriptionId
    },
    ports,
    runAz,
    ports.sleep,
    stopBoundary
  );
  if (locksContributor.ok) {
    ports.progress({ kind: "locks-contributor-assigned", values: [] });
    if (locksContributor.created) {
      ports.recordCreatedRoleAssignment({
        assignmentId: locksContributorAssignmentId,
        role: "Locks Contributor",
        scope: contributorScope,
        principalObjectId: servicePrincipalObjectId
      });
      if (!(await checkpoint("after-role-assignment:Locks Contributor")))
        return false;
    }
  } else if (locksContributor.stopped) {
    return false;
  } else {
    ports.progress({
      kind: "locks-contributor-warning",
      values: [
        String(servicePrincipalObjectId),
        String(contributorScope),
        String(locksContributor.stderr)
      ]
    });
  }
  if (ports.isRollbackPending()) {
    await ports.finalizeFailure({
      kind: "rollback-after-locks-contributor",
      evidence: { clientId, appName }
    });
    return false;
  }
  return true;
}
