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
    stderr: partial.stderr ?? ""
  };
}

function harness(options: {
  runAz: (args: string[]) => Promise<AzureAutoSetupCommandResult>;
  ensureServicePrincipal?: AzureAutoSetupCredentialInput["dependencies"]["ensureServicePrincipal"];
  checkpoint?: () => Promise<boolean>;
  sleep?: (milliseconds: number) => Promise<void>;
  tempWrite?: (path: string, contents: string) => void;
  tempRemove?: (path: string) => void;
}) {
  const failures: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const ficEntries: Array<Record<string, unknown>> = [];
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
        objectId: OBJECT_ID
      })),
    operations: {
      recordServicePrincipal: (_operation, patch) =>
        calls.push(`sp:${String(patch.state || patch.objectId)}`),
      recordCreatedFederatedCredential: (_operation, credential) => {
        calls.push(`fic:${credential.name}`);
        ficEntries.push(credential as Record<string, unknown>);
      },
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
  return { calls, failures, ficEntries, input, workflow };
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
    ).rejects.toThrow("spawn failed");
    expect(removed).toEqual(["C:\\temp\\fic.json"]);
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
          return result({ code: 1, stderr: "permission denied" });
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

  it("retries replication lag, records created roles, and preserves the non-fatal AKS warning", async () => {
    let objectLookup = 0;
    let contributor = 0;
    const test = harness({
      ensureServicePrincipal: async () => ({
        ok: true,
        state: "created",
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

  it("treats a malformed advisory credential list as empty and creates the credential", async () => {
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({ stdout: "{oops" });
        }
        if (line.includes("federated-credential create")) return result();
        if (line.startsWith("role assignment create ")) return result();
        throw new Error(`unexpected az call: ${line}`);
      }
    });

    expect(await configureAzureAutoSetupCredentials(test.input)).toBe(true);
    expect(test.calls).toContain("fic:dev");
    // The recorded entry carries the identity fields durable provenance needs
    // (issue #331): the app registration id, issuer, audience and repo id.
    expect(test.ficEntries[0]).toMatchObject({
      name: "dev",
      clientId: APP_ID,
      issuer: "https://token.actions.githubusercontent.com",
      audiences: ["api://AzureADTokenExchange"],
      repoId: 5
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

  it("accepts already-existing role assignments without recording new artifacts", async () => {
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("federated-credential list")) {
          return result({
            stdout: JSON.stringify([{ name: "dev", subject: SUBJECT }])
          });
        }
        if (line.startsWith("role assignment create ")) {
          return result({ code: 1, stderr: "already exists" });
        }
        throw new Error(`unexpected az call: ${line}`);
      }
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
