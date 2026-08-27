import { describe, expect, it } from "vitest";
import type { ResolveOidcSubjectResult } from "../../azure-oidc.js";
import {
  buildEnvironmentSuffix,
  buildFederatedCredentialName
} from "@radius-project/core";
import {
  buildRoleAssignmentArgs,
  configureAzureAutoSetupCredentials,
  findFederatedCredentialNameCollision,
  isReplicationLagError,
  pickAksResourceGroup
} from "./azure-auto-setup-credentials.js";
import type {
  AzureAutoSetupCommandResult,
  AzureAutoSetupCredentialInput,
  AzureAutoSetupOperation,
  AzureAutoSetupWorkflow
} from "./azure-auto-setup-types.js";
import { createAzureAutoSetupTestDependencies } from "../../../test/support/server/azure-auto-setup.js";

const APP_ID = "33333333-3333-3333-3333-333333333333";
const OBJECT_ID = "44444444-4444-4444-4444-444444444444";
const SUBSCRIPTION = "22222222-2222-2222-2222-222222222222";
const SUBJECT = "repo:octo/app:environment:dev";

const OIDC: ResolveOidcSubjectResult = {
  federatedCredentials: [{ name: "dev", subject: SUBJECT }],
  fullName: "octo/app",
  ownerId: 7,
  repoId: 5,
  subjectConfig: { useDefault: false }
};

function result(
  partial: Partial<AzureAutoSetupCommandResult> = {}
): AzureAutoSetupCommandResult {
  return {
    code: partial.code ?? 0,
    stdout: partial.stdout ?? "",
    stderr: partial.stderr ?? "",
    ...(partial.timedOut === undefined ? {} : { timedOut: partial.timedOut })
  };
}

function harness(options: {
  runAz: (args: string[]) => Promise<AzureAutoSetupCommandResult>;
  ensureServicePrincipal?: AzureAutoSetupCredentialInput["dependencies"]["ensureServicePrincipal"];
  stopBoundary?: AzureAutoSetupWorkflow["stopBoundary"];
  checkpoint?: AzureAutoSetupWorkflow["checkpoint"];
  sleep?: (milliseconds: number) => Promise<void>;
  tempWrite?: (path: string, contents: string) => void;
  tempRemove?: (path: string) => void;
}) {
  const failures: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const recorded: Record<string, unknown>[] = [];
  const operation: AzureAutoSetupOperation = {
    operationId: "op-credentials",
    repo: "octo/app",
    environment: "dev",
    provider: "azure",
    currentStage: "authorize_identity"
  };
  const dependencies = createAzureAutoSetupTestDependencies({
    ensureServicePrincipal:
      options.ensureServicePrincipal ??
      (async () => ({
        ok: true,
        state: "reused",
        origin: "pre_existing",
        objectId: OBJECT_ID
      })),
    operations: {
      recordServicePrincipal: (_operation, patch) => {
        recorded.push(patch);
        calls.push(`sp:${String(patch.state || patch.objectId)}`);
      },
      recordCreatedFederatedCredential: (_operation, credential) =>
        calls.push(`fic:${credential.name}`),
      recordCreatedRoleAssignment: (_operation, assignment) =>
        calls.push(`role:${assignment.role}`)
    },
    sleep:
      options.sleep ??
      (async (milliseconds) => {
        calls.push(`sleep:${milliseconds}`);
      }),
    tempFile: {
      createPath: () => "C:\\temp\\fic.json",
      write:
        options.tempWrite ??
        ((path, contents) => {
          calls.push(`path:${path}`);
          calls.push(`write:${contents}`);
        }),
      remove:
        options.tempRemove ??
        ((path) => {
          calls.push(`remove:${path}`);
        })
    }
  });
  const workflow: AzureAutoSetupWorkflow = {
    operation,
    steps: [],
    respond: () => {},
    runAz: async (args) => {
      calls.push(`az:${args.join(" ")}`);
      return options.runAz(args);
    },
    runGitHubJson: async () => ({ ok: false, status: 404 }),
    fail: async (status, error, code, extra = {}) => {
      failures.push({ status, error, code, extra });
    },
    stopBoundary:
      options.stopBoundary ??
      (async (boundary) => {
        calls.push(`stop:${boundary}`);
        return true;
      }),
    checkpoint:
      options.checkpoint ??
      (async () => {
        calls.push("checkpoint");
        return true;
      })
  };
  const input: AzureAutoSetupCredentialInput = {
    workflow,
    dependencies,
    oidc: OIDC,
    oidcSuffix: "environment:dev",
    clientId: APP_ID,
    appName: "radius-deploy-octo-app",
    subscriptionId: SUBSCRIPTION,
    resourceGroup: "rg-radius",
    clusterResourceGroup: "rg-aks",
    clusterName: "aks-radius"
  };
  return { calls, failures, recorded, input, workflow };
}

describe("Azure auto-setup credentials and roles service (SU-08)", () => {
  it("reports a Service Principal failure before listing credentials", async () => {
    const test = harness({
      runAz: async (args) => {
        throw new Error(`unexpected az call: ${args.join(" ")}`);
      },
      ensureServicePrincipal: async () => ({
        ok: false,
        stderr: "Graph denied"
      })
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
    expect(test.failures[0]).toMatchObject({
      code: "sp-failed",
      extra: { azError: "Graph denied" }
    });
  });

  it("stops after the Service Principal lookup and before its create", async () => {
    const test = harness({
      stopBoundary: async (boundary) =>
        boundary !== "before-service-principal-create",
      ensureServicePrincipal: async (
        _clientId,
        _runAz,
        _mutationRecovery,
        beforeCreate
      ) => {
        if (!(await beforeCreate())) return { ok: false, stopped: true };
        throw new Error("Service Principal create must not start");
      },
      runAz: async (args) => {
        throw new Error(`unexpected az call: ${args.join(" ")}`);
      }
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
    expect(test.failures).toEqual([]);
  });

  it("stops immediately when the Service Principal checkpoint cancels", async () => {
    const test = harness({
      runAz: async (args) => {
        throw new Error(`unexpected az call: ${args.join(" ")}`);
      },
      checkpoint: async () => false
    });
    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
    expect(test.calls).toEqual(["sp:reused"]);
  });

  it("records where the Service Principal came from, not just that it exists", async () => {
    const test = harness({
      runAz: async (args) => {
        throw new Error(`unexpected az call: ${args.join(" ")}`);
      },
      checkpoint: async () => false
    });
    await configureAzureAutoSetupCredentials(test.input);
    expect(test.recorded).toEqual([
      {
        state: "reused",
        origin: "pre_existing",
        appId: APP_ID,
        objectId: OBJECT_ID
      }
    ]);
  });

  it("carries an unprovable Service Principal into the ledger and the narration", async () => {
    const test = harness({
      runAz: async (args) => {
        throw new Error(`unexpected az call: ${args.join(" ")}`);
      },
      ensureServicePrincipal: async () => ({
        ok: true,
        state: "created_candidate",
        origin: "unknown",
        objectId: OBJECT_ID
      }),
      checkpoint: async () => false
    });

    await configureAzureAutoSetupCredentials(test.input);

    expect(test.recorded).toEqual([
      {
        state: "created_candidate",
        origin: "unknown",
        appId: APP_ID,
        objectId: OBJECT_ID
      }
    ]);
    expect(test.workflow.steps).toContain(
      "\u2139\ufe0f The Service Principal was absent before this step and present after it, but the create command did not report success, so Radius cannot prove it created it and will not remove it during a rollback."
    );
  });

  it("says nothing about provenance when the Service Principal was simply created", async () => {
    const test = harness({
      runAz: async (args) => {
        throw new Error(`unexpected az call: ${args.join(" ")}`);
      },
      ensureServicePrincipal: async () => ({
        ok: true,
        state: "created",
        origin: "this_operation",
        objectId: null
      }),
      checkpoint: async () => false
    });

    await configureAzureAutoSetupCredentials(test.input);

    expect(test.recorded).toEqual([
      { state: "created", origin: "this_operation", appId: APP_ID }
    ]);
    expect(
      test.workflow.steps.filter((step) => step.startsWith("\u2139\ufe0f"))
    ).toEqual([]);
  });

  it("fails loud on a federated credential name collision", async () => {
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({
            stdout: JSON.stringify([
              { name: "dev", subject: "repo:octo/app:environment:other" }
            ])
          });
        }
        throw new Error(`unexpected az call: ${line}`);
      }
    });
    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
    expect(test.failures[0]).toMatchObject({
      code: "federated-credential-name-collision"
    });
  });

  it("removes the secure temp file when the credential command throws", async () => {
    const removed: string[] = [];
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({ stdout: "[]" });
        }
        if (line.includes("federated-credential create")) {
          throw new Error("spawn failed");
        }
        throw new Error(`unexpected az call: ${line}`);
      },
      tempRemove: (path) => removed.push(path)
    });
    await expect(
      configureAzureAutoSetupCredentials(test.input)
    ).rejects.toThrow(
      "Radius could not confirm the outcome of azure_federated_credential.create"
    );
    expect(removed).toEqual(["C:\\temp\\fic.json"]);
    expect(
      (
        test.workflow.operation as AzureAutoSetupOperation & {
          providerRecovery: { mutations: Array<{ status: string }> };
        }
      ).providerRecovery.mutations[0]?.status
    ).toBe("outcome_unknown");
  });

  it("removes the secure temp file when writing the credential file throws", async () => {
    const removed: string[] = [];
    const test = harness({
      runAz: async (args) => {
        if (args.join(" ").includes("federated-credential list")) {
          return result({ stdout: "[]" });
        }
        throw new Error(`unexpected az call: ${args.join(" ")}`);
      },
      tempWrite: () => {
        throw new Error("disk full");
      },
      tempRemove: (path) => removed.push(path)
    });

    await expect(
      configureAzureAutoSetupCredentials(test.input)
    ).rejects.toThrow("disk full");
    expect(removed).toEqual(["C:\\temp\\fic.json"]);
  });

  it("reports a federated credential creation failure after cleanup", async () => {
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({ stdout: "[]" });
        }
        if (line.includes("federated-credential create")) {
          return result({
            code: 1,
            stderr:
              "ERROR: (Authorization_RequestDenied) Insufficient privileges to complete the operation."
          });
        }
        throw new Error(`unexpected az call: ${line}`);
      }
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
    expect(test.failures[0]).toMatchObject({
      code: "federated-credential-failed"
    });
    expect(test.calls).toContain("remove:C:\\temp\\fic.json");
  });

  it("honors Stop after a failed federated credential write before rollback", async () => {
    const test = harness({
      checkpoint: async (boundary) =>
        !boundary.startsWith("after-federated-credential-create-attempt:"),
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({ stdout: "[]" });
        }
        if (line.includes("federated-credential create")) {
          // A rejection Entra composed, so the journal settles the attempt
          // without a reconciling read and the Stop lands on settled provenance.
          return result({
            code: 1,
            stderr: "ERROR: (Authorization_RequestDenied) permission denied"
          });
        }
        throw new Error(`unexpected az call: ${line}`);
      }
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
    expect(test.failures).toEqual([]);
  });

  it("stops after credential discovery and before federated credential create", async () => {
    const test = harness({
      stopBoundary: async (boundary) =>
        !boundary.startsWith("before-federated-credential-create:"),
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({ stdout: "[]" });
        }
        throw new Error(`unexpected az call: ${line}`);
      }
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
    expect(
      test.calls.some((call) => call.includes("federated-credential create"))
    ).toBe(false);
  });

  it("verifies an already-existing credential subject before continuing", async () => {
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({ stdout: "[]" });
        }
        if (line.includes("federated-credential create")) {
          return result({ code: 1, stderr: "already exists" });
        }
        if (line.includes("federated-credential show")) {
          return result({ stdout: SUBJECT });
        }
        if (line.startsWith("role assignment create ")) return result();
        throw new Error(`unexpected az call: ${line}`);
      }
    });
    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(true);
    expect(test.calls.some((call) => call.startsWith("fic:"))).toBe(false);
    expect(test.calls).toContain("role:Contributor");
  });

  it("starts no role assignment after Stop is observed", async () => {
    const test = harness({
      stopBoundary: async (boundary) =>
        boundary !== "before-role-assignment:Contributor:attempt-1",
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({ stdout: "[]" });
        }
        if (line.includes("federated-credential create")) return result();
        throw new Error(`unexpected az call: ${line}`);
      }
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
    expect(test.failures).toEqual([]);
    expect(
      test.calls.some((call) => call.startsWith("az:role assignment create "))
    ).toBe(false);
  });

  it("stops before the AKS cluster role instead of warning about it", async () => {
    const test = harness({
      stopBoundary: async (boundary) =>
        !boundary.startsWith(
          "before-role-assignment:Azure Kubernetes Service RBAC Cluster Admin"
        ),
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({ stdout: "[]" });
        }
        if (line.includes("federated-credential create")) return result();
        if (line.startsWith("role assignment create ")) return result();
        throw new Error(`unexpected az call: ${line}`);
      }
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
    expect(test.failures).toEqual([]);
    expect(test.calls).toContain("role:Contributor");
    expect(
      test.workflow.steps.some((step) =>
        step.includes("Could not assign the AKS RBAC Cluster Admin role")
      )
    ).toBe(false);
  });

  it("rejects an already-existing credential with a different subject", async () => {
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({ stdout: "[]" });
        }
        if (line.includes("federated-credential create")) {
          return result({ code: 1, stderr: "already exists" });
        }
        if (line.includes("federated-credential show")) {
          return result({ stdout: "different-subject" });
        }
        throw new Error(`unexpected az call: ${line}`);
      }
    });
    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
    expect(test.failures[0]).toMatchObject({
      code: "federated-credential-subject-mismatch"
    });
  });

  it("adopts a timed-out federated credential only when operation provenance matches", async () => {
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({ stdout: "[]" });
        }
        if (line.includes("federated-credential create")) {
          return result({ code: 1, timedOut: true });
        }
        if (line.includes("federated-credential show")) {
          return result({
            stdout: JSON.stringify({
              subject: SUBJECT,
              description: "Created by Radius operation op-credentials"
            })
          });
        }
        if (line.startsWith("role assignment create ")) return result();
        throw new Error(`unexpected az call: ${line}`);
      }
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(true);
    expect(test.calls).toContain("fic:dev");
    expect(
      (
        test.workflow.operation as AzureAutoSetupOperation & {
          providerRecovery: { mutations: Array<{ status: string }> };
        }
      ).providerRecovery.mutations[0]
    ).toMatchObject({ status: "confirmed" });
  });

  it("reconciles a pending credential before the existing-subject skip on restart", async () => {
    let listCalls = 0;
    let showCalls = 0;
    let roleCreates = 0;
    let test: ReturnType<typeof harness>;
    test = harness({
      checkpoint: async () =>
        (
          test.workflow.operation as AzureAutoSetupOperation & {
            providerRecovery?: { state?: string };
          }
        ).providerRecovery?.state !== "rollback_pending",
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          listCalls += 1;
          return result({
            stdout:
              listCalls === 1 ? "[]" : (
                JSON.stringify([{ name: "dev", subject: SUBJECT }])
              )
          });
        }
        if (line.includes("federated-credential create")) {
          return result({ code: 1, timedOut: true });
        }
        if (line.includes("federated-credential show")) {
          showCalls += 1;
          return showCalls === 1 ?
              result({ code: 1, stderr: "temporarily unavailable" })
            : result({
                stdout: JSON.stringify({
                  subject: SUBJECT,
                  description: "Created by Radius operation op-credentials"
                })
              });
        }
        if (line.startsWith("role assignment create ")) {
          roleCreates += 1;
          return result();
        }
        throw new Error(`unexpected az call: ${line}`);
      }
    });

    await expect(
      configureAzureAutoSetupCredentials(test.input)
    ).rejects.toMatchObject({ code: "provider-mutation-outcome-unknown" });
    (
      test.workflow.operation as AzureAutoSetupOperation & {
        recoveryState?: string;
      }
    ).recoveryState = "provider_reconciliation_pending";

    await expect(configureAzureAutoSetupCredentials(test.input)).resolves.toBe(
      false
    );
    expect(test.calls.filter((call) => call === "fic:dev")).toHaveLength(1);
    expect(roleCreates).toBe(0);
    expect(
      (
        test.workflow.operation as AzureAutoSetupOperation & {
          providerRecovery: { state: string };
        }
      ).providerRecovery.state
    ).toBe("rollback_pending");
  });

  it("adopts a timed-out deterministic role assignment after exact reconciliation", async () => {
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({
            stdout: JSON.stringify([{ name: "dev", subject: SUBJECT }])
          });
        }
        if (
          line.startsWith("role assignment create ") &&
          line.includes("--role Contributor ")
        ) {
          return result({ code: 1, timedOut: true });
        }
        if (line.startsWith("role assignment list ")) {
          const assignmentId = /name=='([^']+)'/.exec(
            args[args.indexOf("--query") + 1]
          )?.[1];
          const scope = `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-radius`;
          return result({
            stdout: JSON.stringify([
              {
                id: `${scope}/providers/Microsoft.Authorization/roleAssignments/${assignmentId}`,
                principalId: OBJECT_ID,
                roleDefinitionName: "Contributor",
                scope
              }
            ])
          });
        }
        if (line.startsWith("role assignment create ")) return result();
        throw new Error(`unexpected az call: ${line}`);
      }
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(true);
    expect(test.calls).toContain("role:Contributor");
    expect(
      test.calls.find(
        (call) =>
          call.startsWith("az:role assignment create ") &&
          call.includes("--role Contributor ")
      )
    ).toContain("--name");
  });

  it("lets the role stage reconcile its own unresolved mutation after restart", async () => {
    let contributorCreates = 0;
    let contributorReads = 0;
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({
            stdout: JSON.stringify([{ name: "dev", subject: SUBJECT }])
          });
        }
        if (
          line.startsWith("role assignment create ") &&
          line.includes("--role Contributor ")
        ) {
          contributorCreates += 1;
          return result({ code: 1, timedOut: true });
        }
        if (line.startsWith("role assignment list ")) {
          contributorReads += 1;
          if (contributorReads === 1) {
            return result({ code: 1, stderr: "temporarily unavailable" });
          }
          const assignmentId = /name=='([^']+)'/.exec(
            args[args.indexOf("--query") + 1]
          )?.[1];
          const scope = `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-radius`;
          return result({
            stdout: JSON.stringify([
              {
                id: `${scope}/providers/Microsoft.Authorization/roleAssignments/${assignmentId}`,
                principalId: OBJECT_ID,
                roleDefinitionName: "Contributor",
                scope
              }
            ])
          });
        }
        if (line.startsWith("role assignment create ")) return result();
        throw new Error(`unexpected az call: ${line}`);
      }
    });

    await expect(
      configureAzureAutoSetupCredentials(test.input)
    ).rejects.toMatchObject({ code: "provider-mutation-outcome-unknown" });
    (
      test.workflow.operation as AzureAutoSetupOperation & {
        recoveryState?: string;
      }
    ).recoveryState = "provider_reconciliation_pending";

    await expect(configureAzureAutoSetupCredentials(test.input)).resolves.toBe(
      false
    );
    expect(contributorCreates).toBe(1);
    expect(contributorReads).toBe(2);
    expect(test.failures).toContainEqual(
      expect.objectContaining({
        status: 409,
        code: "provider-rollback-pending"
      })
    );
    expect(
      (
        test.workflow.operation as AzureAutoSetupOperation & {
          providerRecovery: { state: string };
        }
      ).providerRecovery.state
    ).toBe("rollback_pending");
  });

  it("retries replication lag, records created roles, and preserves the non-fatal AKS warning", async () => {
    let objectLookup = 0;
    let contributor = 0;
    const test = harness({
      ensureServicePrincipal: async () => ({
        ok: true,
        state: "created",
        origin: "this_operation",
        objectId: null
      }),
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({
            stdout: JSON.stringify([{ name: "dev", subject: SUBJECT }])
          });
        }
        if (line.startsWith("ad sp show ")) {
          objectLookup += 1;
          return objectLookup < 2 ?
              result({ code: 1, stderr: "PrincipalNotFound" })
            : result({ stdout: OBJECT_ID });
        }
        if (
          line.startsWith("role assignment create ") &&
          line.includes("--role Contributor ")
        ) {
          contributor += 1;
          return contributor < 2 ?
              result({ code: 1, stderr: "PrincipalNotFound" })
            : result();
        }
        if (
          line.startsWith("role assignment create ") &&
          line.includes("Azure Kubernetes Service RBAC Cluster Admin")
        ) {
          return result({ code: 1, stderr: "AuthorizationFailed" });
        }
        throw new Error(`unexpected az call: ${line}`);
      }
    });
    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(true);
    expect(test.calls).toContain("sleep:2000");
    expect(test.calls).toContain("role:Contributor");
    expect(test.workflow.steps.at(-1)).toContain("AuthorizationFailed");
    expect(test.failures).toEqual([]);
  });

  it("stops on a genuine Contributor assignment failure without retrying", async () => {
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({
            stdout: JSON.stringify([{ name: "dev", subject: SUBJECT }])
          });
        }
        if (line.startsWith("role assignment create ")) {
          return result({ code: 1, stderr: "AuthorizationFailed" });
        }
        throw new Error(`unexpected az call: ${line}`);
      }
    });
    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
    expect(test.failures[0]).toMatchObject({
      code: "role-assignment-failed"
    });
    expect(
      test.calls.filter((call) => call.startsWith("az:role "))
    ).toHaveLength(1);
  });

  it("honors Stop after a failed role write before automatic rollback", async () => {
    const test = harness({
      stopBoundary: async (boundary) =>
        !boundary.startsWith("after-role-assignment-attempt:Contributor:"),
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({
            stdout: JSON.stringify([{ name: "dev", subject: SUBJECT }])
          });
        }
        if (line.startsWith("role assignment create ")) {
          return result({ code: 1, stderr: "AuthorizationFailed" });
        }
        throw new Error(`unexpected az call: ${line}`);
      }
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
    expect(test.failures).toEqual([]);
  });

  it("honors Stop during role replication backoff before another attempt", async () => {
    let assignments = 0;
    const test = harness({
      stopBoundary: async (boundary) =>
        !boundary.startsWith("before-role-assignment-backoff:Contributor:"),
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({
            stdout: JSON.stringify([{ name: "dev", subject: SUBJECT }])
          });
        }
        if (line.startsWith("role assignment create ")) {
          assignments += 1;
          return result({ code: 1, stderr: "PrincipalNotFound" });
        }
        throw new Error(`unexpected az call: ${line}`);
      }
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
    expect(assignments).toBe(1);
    expect(test.calls.some((call) => call.startsWith("sleep:"))).toBe(false);
    expect(test.failures).toEqual([]);
  });

  it("fails closed when the federated credential list is malformed", async () => {
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({ stdout: "{oops" });
        }
        throw new Error(`unexpected az call: ${line}`);
      }
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
    expect(test.failures[0]).toMatchObject({
      code: "federated-credential-list-malformed"
    });
    expect(test.calls).not.toContain("fic:dev");
  });

  it.each([
    ["empty output", ""],
    ["a non-object entry", JSON.stringify([null])],
    ["an entry without a subject", JSON.stringify([{ name: "dev" }])]
  ])("fails closed on %s in the credential list", async (_label, stdout) => {
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({ stdout });
        }
        throw new Error(`unexpected az call: ${line}`);
      }
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
    expect(test.failures[0]).toMatchObject({
      code: "federated-credential-list-malformed"
    });
  });

  it("accepts an unrelated flexible federated credential without a subject", async () => {
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({
            stdout: JSON.stringify([
              { name: "dev", subject: SUBJECT },
              {
                name: "flexible",
                subject: null,
                claimsMatchingExpression: {
                  languageVersion: 1,
                  value: "claims['sub'] matches 'repo:octo/*'"
                }
              }
            ])
          });
        }
        if (line.startsWith("role assignment create ")) return result();
        throw new Error(`unexpected az call: ${line}`);
      }
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(true);
    expect(test.failures).toEqual([]);
  });

  it("honors a short Retry-After for a rate-limited credential inventory read", async () => {
    let reads = 0;
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          reads += 1;
          return reads === 1 ?
              result({
                code: 1,
                stderr: "TooManyRequests (HTTP 429)\nRetry-After: 2"
              })
            : result({
                stdout: JSON.stringify([{ name: "dev", subject: SUBJECT }])
              });
        }
        if (line.startsWith("role assignment create ")) return result();
        throw new Error(`unexpected az call: ${line}`);
      }
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(true);
    expect(reads).toBe(2);
    expect(test.calls).toContain("sleep:2000");
  });

  it("does not retry before Retry-After when it exceeds the read budget", async () => {
    let reads = 0;
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          reads += 1;
          return result({
            code: 1,
            stderr: "TooManyRequests (HTTP 429)\nRetry-After: 60"
          });
        }
        throw new Error(`unexpected az call: ${line}`);
      }
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
    expect(reads).toBe(1);
    expect(test.calls.some((call) => call.startsWith("sleep:"))).toBe(false);
  });

  it("honors Retry-After when Azure emits throttling on stdout", async () => {
    let reads = 0;
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          reads += 1;
          return result({
            code: 1,
            stdout: "TooManyRequests (HTTP 429)\nRetry-After: 60"
          });
        }
        throw new Error(`unexpected az call: ${line}`);
      }
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
    expect(reads).toBe(1);
    expect(test.calls.some((call) => call.startsWith("sleep:"))).toBe(false);
  });

  it("does not retry an authorization failure from credential inventory", async () => {
    let reads = 0;
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          reads += 1;
          return result({
            code: 1,
            stderr: "AuthorizationFailed (HTTP 403)\nRetry-After: 60"
          });
        }
        throw new Error(`unexpected az call: ${line}`);
      }
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
    expect(reads).toBe(1);
    expect(test.failures[0]).toMatchObject({
      code: "federated-credential-list-failed"
    });
  });

  it("warns when the immutable identity still has a legacy mutable credential", async () => {
    const immutableSubject = "repo_id:5:environment:dev";
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({
            stdout: JSON.stringify([
              { name: "legacy-dev", subject: SUBJECT },
              { name: "dev", subject: immutableSubject }
            ])
          });
        }
        if (line.startsWith("role assignment create ")) return result();
        throw new Error(`unexpected az call: ${line}`);
      }
    });
    test.input.oidc = {
      ...OIDC,
      federatedCredentials: [{ name: "dev", subject: immutableSubject }],
      subjectConfig: { useDefault: true, useImmutableSubject: true }
    };

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(true);
    expect(test.workflow.steps.join("\n")).toContain("legacy-dev");
  });

  it("stops when persistence cancels after creating a federated credential", async () => {
    let checkpoint = 0;
    const test = harness({
      checkpoint: async () => {
        checkpoint += 1;
        return checkpoint === 1;
      },
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({ stdout: "[]" });
        }
        if (line.includes("federated-credential create")) return result();
        throw new Error(`unexpected az call: ${line}`);
      }
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
    expect(test.calls).toContain("fic:dev");
    expect(
      test.calls.some((call) => call.startsWith("az:role assignment"))
    ).toBe(false);
  });

  it("fails after bounded retries when the Service Principal object id never replicates", async () => {
    const test = harness({
      ensureServicePrincipal: async () => ({
        ok: true,
        state: "created",
        origin: "this_operation",
        objectId: null
      }),
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({
            stdout: JSON.stringify([{ name: "dev", subject: SUBJECT }])
          });
        }
        if (line.startsWith("ad sp show ")) {
          return result({ code: 1, stderr: "PrincipalNotFound" });
        }
        throw new Error(`unexpected az call: ${line}`);
      }
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
    expect(test.failures[0]).toMatchObject({ code: "sp-objectid-failed" });
    expect(
      test.calls.filter((call) => call.startsWith("az:ad sp show"))
    ).toHaveLength(6);
    expect(test.calls.filter((call) => call.startsWith("sleep:"))).toHaveLength(
      5
    );
  });

  it("does not retry an authorization failure while resolving the Service Principal id", async () => {
    let reads = 0;
    const test = harness({
      ensureServicePrincipal: async () => ({
        ok: true,
        state: "created",
        origin: "this_operation",
        objectId: null
      }),
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({
            stdout: JSON.stringify([{ name: "dev", subject: SUBJECT }])
          });
        }
        if (line.startsWith("ad sp show ")) {
          reads += 1;
          return result({ code: 1, stderr: "AuthorizationFailed" });
        }
        throw new Error(`unexpected az call: ${line}`);
      }
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
    expect(reads).toBe(1);
    expect(test.failures[0]).toMatchObject({
      code: "sp-objectid-failed"
    });
  });

  it("stops when persistence cancels after resolving the Service Principal object id", async () => {
    let checkpoint = 0;
    const test = harness({
      checkpoint: async () => {
        checkpoint += 1;
        return checkpoint === 1;
      },
      ensureServicePrincipal: async () => ({
        ok: true,
        state: "created",
        origin: "this_operation",
        objectId: null
      }),
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({
            stdout: JSON.stringify([{ name: "dev", subject: SUBJECT }])
          });
        }
        if (line.startsWith("ad sp show ")) {
          return result({ stdout: OBJECT_ID });
        }
        throw new Error(`unexpected az call: ${line}`);
      }
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
    expect(test.calls).toContain(`sp:${OBJECT_ID}`);
  });

  it.each([
    ["Contributor", 3],
    ["Azure Kubernetes Service RBAC Cluster Admin", 4]
  ])(
    "stops when persistence cancels after recording %s",
    async (role, stopAt) => {
      let checkpoint = 0;
      const test = harness({
        checkpoint: async () => {
          checkpoint += 1;
          return checkpoint < stopAt;
        },
        runAz: async (args) => {
          const line = args.join(" ");
          if (line.includes("federated-credential list")) {
            return result({
              stdout: JSON.stringify([{ name: "dev", subject: SUBJECT }])
            });
          }
          if (line.startsWith("role assignment create ")) return result();
          throw new Error(`unexpected az call: ${line}`);
        }
      });

      expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
      expect(test.calls).toContain(`role:${role}`);
    }
  );

  it.each([0, 1])(
    "accepts code %i already-existing role assignments without recording new artifacts",
    async (code) => {
      const test = harness({
        runAz: async (args) => {
          const line = args.join(" ");
          if (line.includes("federated-credential list")) {
            return result({
              stdout: JSON.stringify([{ name: "dev", subject: SUBJECT }])
            });
          }
          if (line.startsWith("role assignment create ")) {
            return result({ code, stderr: "already exists" });
          }
          throw new Error(`unexpected az call: ${line}`);
        }
      });

      expect(await configureAzureAutoSetupCredentials(test.input)).toBe(true);
      expect(test.calls.some((call) => call.startsWith("role:"))).toBe(false);
    }
  );

  it("preserves non-ownership through a transient reconciliation failure", async () => {
    const assignments = new Map<
      string,
      { objectId: string; role: string; scope: string }
    >();
    let failNextRead = false;
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({
            stdout: JSON.stringify([{ name: "dev", subject: SUBJECT }])
          });
        }
        if (line.startsWith("role assignment create ")) {
          const assignmentId = args[args.indexOf("--name") + 1];
          assignments.set(assignmentId, {
            objectId: args[args.indexOf("--assignee-object-id") + 1],
            role: args[args.indexOf("--role") + 1],
            scope: args[args.indexOf("--scope") + 1]
          });
          return result({ code: 0, stderr: "already exists" });
        }
        if (line.startsWith("role assignment list ")) {
          if (failNextRead) {
            failNextRead = false;
            return result({ code: 1, stderr: "temporarily unavailable" });
          }
          const assignmentId = /name=='([^']+)'/.exec(
            args[args.indexOf("--query") + 1]
          )?.[1];
          const assignment =
            assignmentId ? assignments.get(assignmentId) : undefined;
          return result({
            stdout: JSON.stringify(
              assignment ?
                [
                  {
                    id: `${assignment.scope}/providers/Microsoft.Authorization/roleAssignments/${assignmentId}`,
                    principalId: assignment.objectId,
                    roleDefinitionName: assignment.role,
                    scope: assignment.scope
                  }
                ]
              : []
            )
          });
        }
        throw new Error(`unexpected az call: ${line}`);
      }
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(true);
    failNextRead = true;
    await expect(
      configureAzureAutoSetupCredentials(test.input)
    ).rejects.toMatchObject({
      code: "provider-mutation-outcome-unknown"
    });
    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(true);
    expect(test.calls.some((call) => call.startsWith("role:"))).toBe(false);
  });
});

describe("isReplicationLagError", () => {
  it("treats Graph-replication 'principal not yet visible' errors as retryable", () => {
    for (const stderr of [
      "Principal <id> does not exist in the directory <tenant>.",
      "No matching principal found.",
      "PrincipalNotFound: Principal does not exist.",
      "Cannot find user or service principal in graph database for the given assignee.",
      "Cannot find principal in the directory.",
      "The assignee was not found in the directory."
    ]) {
      expect(isReplicationLagError(stderr), stderr).toBe(true);
    }
  });

  it("does not retry authorization failures or empty errors", () => {
    expect(
      isReplicationLagError(
        "AuthorizationFailed: The client does not have authorization to perform action 'Microsoft.Authorization/roleAssignments/write'."
      )
    ).toBe(false);
    expect(isReplicationLagError("RoleAssignmentUpdateNotPermitted")).toBe(
      false
    );
    expect(isReplicationLagError("")).toBe(false);
    expect(isReplicationLagError()).toBe(false);
  });
});

describe("buildRoleAssignmentArgs", () => {
  it("assigns by SP object id with an explicit ServicePrincipal principal type", () => {
    const args = buildRoleAssignmentArgs({
      objectId: "00000000-obj-id",
      role: "Contributor",
      scope: "/subscriptions/sub/resourceGroups/rg",
      subscriptionId: "sub"
    });

    expect(args).toContain("--assignee-object-id");
    expect(args[args.indexOf("--assignee-object-id") + 1]).toBe(
      "00000000-obj-id"
    );
    expect(args).toContain("--assignee-principal-type");
    expect(args[args.indexOf("--assignee-principal-type") + 1]).toBe(
      "ServicePrincipal"
    );
    expect(args).not.toContain("--assignee");
    expect(
      args.slice(args.indexOf("--role"), args.indexOf("--role") + 2)
    ).toEqual(["--role", "Contributor"]);
    expect(
      args.slice(args.indexOf("--scope"), args.indexOf("--scope") + 2)
    ).toEqual(["--scope", "/subscriptions/sub/resourceGroups/rg"]);
  });
});

describe("findFederatedCredentialNameCollision", () => {
  const repoFullName = "octo/app";
  const colonName = buildFederatedCredentialName({
    repoFullName,
    envName: "prod:west"
  });
  const hyphenName = buildFederatedCredentialName({
    repoFullName,
    envName: "prod-west"
  });
  const colonSubject = `repo:${repoFullName}:${buildEnvironmentSuffix(
    "prod:west"
  )}`;
  const hyphenSubject = `repo:${repoFullName}:${buildEnvironmentSuffix(
    "prod-west"
  )}`;

  it("proves normalized names can collapse while subjects differ", () => {
    expect(hyphenName).toBe(colonName);
    expect(hyphenSubject).not.toBe(colonSubject);
  });

  it("flags a name that already exists with a different subject", () => {
    const hit = findFederatedCredentialNameCollision(
      [{ name: hyphenName, subject: hyphenSubject }],
      new Map([[colonName, colonSubject]])
    );

    expect(hit).toEqual({
      name: hyphenName,
      existingSubject: colonSubject,
      desiredSubject: hyphenSubject
    });
  });

  it("returns null for idempotent, absent, or incomplete credentials", () => {
    expect(
      findFederatedCredentialNameCollision(
        [{ name: colonName, subject: colonSubject }],
        new Map([[colonName, colonSubject]])
      )
    ).toBeNull();
    expect(
      findFederatedCredentialNameCollision(
        [{ name: hyphenName, subject: hyphenSubject }],
        new Map()
      )
    ).toBeNull();
    expect(findFederatedCredentialNameCollision(null, new Map())).toBeNull();
    expect(findFederatedCredentialNameCollision([], null)).toBeNull();
    expect(
      findFederatedCredentialNameCollision(
        [{ subject: "s" }],
        new Map([["n", "x"]])
      )
    ).toBeNull();
  });

  it("accepts a plain object map", () => {
    const hit = findFederatedCredentialNameCollision(
      [{ name: hyphenName, subject: hyphenSubject }],
      { [colonName]: colonSubject }
    );

    expect(hit?.name).toBe(hyphenName);
  });
});

describe("pickAksResourceGroup", () => {
  it("prefers and trims the cluster resource group", () => {
    expect(pickAksResourceGroup("rg-cluster", "rg-deploy")).toBe("rg-cluster");
    expect(pickAksResourceGroup("  rg-cluster  ", "rg-deploy")).toBe(
      "rg-cluster"
    );
  });

  it("falls back when the cluster resource group is absent or invalid", () => {
    expect(pickAksResourceGroup("", "rg-deploy")).toBe("rg-deploy");
    expect(pickAksResourceGroup("   ", "rg-deploy")).toBe("rg-deploy");
    expect(pickAksResourceGroup(undefined, "rg-deploy")).toBe("rg-deploy");
    expect(pickAksResourceGroup(null, "rg-deploy")).toBe("rg-deploy");
    expect(pickAksResourceGroup(123, "rg-deploy")).toBe("rg-deploy");
  });
});

describe("halting Azure work once a rollback has been decided", () => {
  function pending(test: ReturnType<typeof harness>) {
    (
      test.workflow.operation as AzureAutoSetupOperation & {
        providerRecovery: { state: string; guidance: null; mutations: [] };
      }
    ).providerRecovery = {
      state: "rollback_pending",
      guidance: null,
      mutations: []
    };
    return test;
  }

  it("creates no Service Principal at all", async () => {
    const test = pending(
      harness({
        runAz: async (args) => {
          throw new Error(`no az call may run: ${args.join(" ")}`);
        },
        ensureServicePrincipal: async () => {
          throw new Error("no Service Principal may be created");
        }
      })
    );

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
    expect(test.failures[0]).toMatchObject({
      status: 409,
      code: "provider-rollback-pending",
      error: expect.stringContaining("before creating a Service Principal")
    });
    expect(test.calls).toEqual([]);
  });

  it("adds no federated credential after the Service Principal step reconciled", async () => {
    const test = harness({
      runAz: async (args) => {
        throw new Error(`no az call may run: ${args.join(" ")}`);
      },
      ensureServicePrincipal: async (_clientId, _runAz) => {
        pending(test);
        return {
          ok: true,
          state: "created_candidate",
          origin: "unknown",
          objectId: OBJECT_ID
        };
      }
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
    expect(test.failures[0]).toMatchObject({
      status: 409,
      code: "provider-rollback-pending",
      error: expect.stringContaining("before adding federated credentials")
    });
    expect(test.calls).not.toContain("fic:radius-octo-app-dev");
  });

  it("assigns no Azure role after the federated credentials reconciled", async () => {
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({ stdout: "[]" });
        }
        if (line.includes("federated-credential create")) {
          pending(test);
          return result();
        }
        throw new Error(`no further az call may run: ${line}`);
      }
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(false);
    expect(test.failures[0]).toMatchObject({
      status: 409,
      code: "provider-rollback-pending",
      error: expect.stringContaining("before assigning Azure roles")
    });
    expect(test.calls.some((call) => call.startsWith("role:"))).toBe(false);
  });
});
