import { describe, expect, it } from "vitest";
import { configureAzureAutoSetupCredentials } from "./setup-azure-credentials.js";
import type { AzureCredentialInput } from "./setup-azure-contracts.js";
import {
  azurePorts,
  clientId,
  command,
  existingIdentityAz,
  liveCredential,
  request,
  resolved
} from "../test/support/azure-setup.js";

function input(ports: AzureCredentialInput["ports"]): AzureCredentialInput {
  return {
    ports,
    ...resolved,
    clientId,
    appName: "radius-deploy-owner-repo",
    resourceGroup: request.resourceGroup,
    clusterResourceGroup: "",
    clusterName: request.clusterName
  };
}

describe("Azure credential policy ports", () => {
  it.each([0, 1, 5, 6])(
    "bounds direct credential propagation retries after %i rejections",
    async (rejections) => {
      let creates = 0;
      const rejection =
        "Resource 'Application_fixture' does not exist or one of its queried reference-property objects are not present.";
      const test = azurePorts(async (args) => {
        if (args[2] === "federated-credential") {
          if (args[3] === "list") return command("[]");
          if (args[3] === "create") {
            creates++;
            return creates <= rejections ?
                command(`${rejection} Attempt ${creates}`, 1)
              : command(JSON.stringify(liveCredential), "0");
          }
          if (args[3] === "show")
            return command(JSON.stringify(liveCredential));
        }
        return existingIdentityAz(args);
      });
      test.credentials.recovery.execute = async (mutation) => {
        const result = await mutation.mutate();
        return result.code === 0 || result.code === "0" ?
            {
              state: "applied",
              value: mutation.accept(result),
              recovered: false
            }
          : { state: "not_applied", result };
      };

      expect(
        await configureAzureAutoSetupCredentials(input(test.credentials))
      ).toBe(rejections < 6);
      expect(creates).toBe(Math.min(rejections + 1, 6));
      expect(
        test.events.filter(
          (event) => Array.isArray(event) && event[0] === "sleep"
        )
      ).toEqual(
        [2000, 4000, 6000, 8000, 10000]
          .slice(0, rejections)
          .map((delay) => ["sleep", delay])
      );
      for (let attempt = 2; attempt <= creates; attempt++) {
        expect(test.events).toContainEqual({
          kind: "retry-federated-credential",
          values: ["dev", attempt, 6]
        });
      }
      expect(
        test.events.filter(
          (event) => Array.isArray(event) && event[0] === "remove"
        )
      ).toEqual([["remove", "credential.json"]]);
      if (rejections === 6) {
        expect(test.events).toContainEqual({
          kind: "federated-credential-failed",
          credentialName: "dev",
          detail: `${rejection} Attempt 6`,
          evidence: {
            clientId,
            appName: "radius-deploy-owner-repo",
            azError: ""
          }
        });
        expect(test.events).not.toContainEqual([
          "credential",
          expect.anything()
        ]);
      } else {
        expect(test.events).toContainEqual([
          "provenance",
          expect.objectContaining({ origin: "created" })
        ]);
      }
    }
  );

  it("records the legacy empty environment when the adapter has no environment context", async () => {
    const test = azurePorts(existingIdentityAz);
    test.credentials.environment = "";
    test.credentials.checkpoint = async (boundary) =>
      !boundary.startsWith("after-record-credential-provenance:");
    expect(
      await configureAzureAutoSetupCredentials(input(test.credentials))
    ).toBe(false);
    expect(test.events).toContainEqual([
      "provenance",
      expect.objectContaining({ environment: "", origin: "reused" })
    ]);
    expect(test.events.at(-1)).toBe("unlock");
  });

  it("finalizes an absent credential after reconciliation without a command response", async () => {
    const test = azurePorts(async (args) =>
      args[2] === "federated-credential" ?
        command("[]")
      : existingIdentityAz(args)
    );
    test.credentials.recovery.execute = async () => ({ state: "not_applied" });
    expect(
      await configureAzureAutoSetupCredentials(input(test.credentials))
    ).toBe(false);
    expect(test.events.slice(-3)).toEqual([
      ["checkpoint", "after-federated-credential-create-attempt:dev"],
      expect.objectContaining({
        kind: "federated-credential-failed",
        evidence: expect.objectContaining({
          azError:
            "Microsoft Entra confirmed the federated credential was not created."
        })
      }),
      "unlock"
    ]);
  });

  it("does not invent role rollback authority after reconciliation confirms absence", async () => {
    const test = azurePorts(existingIdentityAz);
    test.credentials.recovery.execute = async () => ({ state: "not_applied" });
    expect(
      await configureAzureAutoSetupCredentials(input(test.credentials))
    ).toBe(false);
    expect(test.events.at(-1)).toMatchObject({
      kind: "role-assignment-failed",
      evidence: {
        azError: "Azure confirmed the role assignment was not created."
      }
    });
    expect(test.events).not.toContainEqual(["role", expect.anything()]);
  });

  it.each([false, true])(
    "preserves stdout-only role propagation and exhaustion (stop during backoff: %s)",
    async (stop) => {
      const test = azurePorts(existingIdentityAz);
      let attempts = 0;
      test.credentials.recovery.execute = async () => {
        attempts++;
        return {
          state: "not_applied",
          result: command("PrincipalNotFound", 1)
        };
      };
      test.credentials.stopBoundary = async (boundary) =>
        !(stop && boundary.startsWith("before-role-assignment-backoff:"));
      expect(
        await configureAzureAutoSetupCredentials(input(test.credentials))
      ).toBe(false);
      expect(attempts).toBe(stop ? 1 : 6);
      expect(
        test.events.filter(
          (event) => Array.isArray(event) && event[0] === "sleep"
        )
      ).toHaveLength(stop ? 0 : 5);
      if (!stop)
        expect(test.events.at(-1)).toMatchObject({
          kind: "role-assignment-failed",
          evidence: { azError: "" }
        });
      else
        expect(test.events).not.toContainEqual(
          expect.objectContaining({
            kind: "role-assignment-failed"
          })
        );
    }
  );

  it.each(["", "principal read failed"])(
    "retains empty or stdout-only service-principal diagnostics %j",
    async (stdout) => {
      const test = azurePorts(async (args) =>
        args[1] === "sp" ? command(stdout, 1) : existingIdentityAz(args)
      );
      test.credentials.ensureServicePrincipal = async () => ({
        ok: true,
        state: "created",
        origin: "this_operation",
        objectId: null
      });
      expect(
        await configureAzureAutoSetupCredentials(input(test.credentials))
      ).toBe(false);
      expect(test.events.at(-1)).toMatchObject({
        kind: "sp-objectid-failed",
        evidence: { azError: stdout }
      });
    }
  );

  it("accepts string-zero principal reads without changing role command status semantics", async () => {
    const test = azurePorts(async (args) =>
      args[1] === "sp" ? command("principal-id", "0") : existingIdentityAz(args)
    );
    test.credentials.ensureServicePrincipal = async () => ({
      ok: true,
      state: "created",
      origin: "this_operation",
      objectId: null
    });
    test.credentials.recovery.execute = async (mutation) => ({
      state: "applied",
      value: mutation.accept(command()),
      recovered: false
    });
    expect(
      await configureAzureAutoSetupCredentials(input(test.credentials))
    ).toBe(true);
    expect(test.events).toContainEqual([
      "principal",
      { objectId: "principal-id" }
    ]);
  });

  it("verifies a new credential after an empty live subject propagates", async () => {
    let reads = 0;
    const test = azurePorts(async (args) => {
      if (args[2] === "federated-credential") {
        if (args[3] === "list") return command("[]");
        if (args[3] === "show") {
          reads++;
          return command(
            JSON.stringify({
              ...liveCredential,
              subject: reads === 1 ? "" : liveCredential.subject
            })
          );
        }
      }
      return existingIdentityAz(args);
    });
    test.credentials.recovery.find = (kind) =>
      kind === "azure_federated_credential.create" ?
        {
          kind,
          status: "confirmed",
          providerId: liveCredential.id,
          evidence: null
        }
      : null;
    test.credentials.recovery.execute = async (mutation) => ({
      state: "applied",
      value: mutation.accept(command()),
      recovered: false
    });
    expect(
      await configureAzureAutoSetupCredentials(input(test.credentials))
    ).toBe(true);
    expect(reads).toBe(2);
    expect(test.events).toContainEqual(["sleep", 2000]);
    expect(test.events).toContainEqual([
      "provenance",
      expect.objectContaining({
        credentialId: liveCredential.id,
        subject: liveCredential.subject,
        origin: "created"
      })
    ]);
  });
  it("does not complete while any federated credential mutation remains unresolved", async () => {
    const test = azurePorts(existingIdentityAz);
    test.credentials.recovery.unresolved = () => [
      {
        kind: "azure_federated_credential.create",
        status: "outcome_unknown",
        evidence: null
      }
    ];
    expect(
      await configureAzureAutoSetupCredentials(input(test.credentials))
    ).toBe(false);
    expect(test.events.at(-2)).toMatchObject({
      kind: "provider-reconciliation-pending"
    });
  });

  it("refuses a created credential whose live identity stays incomplete through six reads", async () => {
    const test = azurePorts(async (args) => {
      if (args[2] === "federated-credential") {
        if (args[3] === "list") return command("[]");
        return command(
          JSON.stringify({
            name: "dev",
            subject: resolved.oidc.federatedCredentials[0].subject
          })
        );
      }
      return existingIdentityAz(args);
    });
    test.credentials.recovery.execute = async (mutation) => ({
      state: "applied",
      value: mutation.accept(command('{"id":"created-object"}')),
      recovered: false
    });
    expect(
      await configureAzureAutoSetupCredentials(input(test.credentials))
    ).toBe(false);
    expect(test.events.at(-2)).toMatchObject({
      kind: "created-federated-credential-identity-incomplete"
    });
    expect(
      test.events.filter(
        (event) => Array.isArray(event) && event[0] === "sleep"
      )
    ).toHaveLength(5);
  });

  it("retries an empty principal object id before assigning roles", async () => {
    let reads = 0;
    const test = azurePorts(async (args) =>
      args[1] === "sp" ?
        command(++reads === 1 ? "" : "principal-id")
      : existingIdentityAz(args)
    );
    test.credentials.ensureServicePrincipal = async () => ({
      ok: true,
      state: "created",
      origin: "this_operation",
      objectId: null
    });
    test.credentials.recovery.execute = async (mutation) => ({
      state: "applied",
      value: mutation.accept(await mutation.mutate()),
      recovered: false
    });
    expect(
      await configureAzureAutoSetupCredentials(input(test.credentials))
    ).toBe(true);
    expect(reads).toBe(2);
    expect(test.events).toContainEqual(["sleep", 2000]);
  });

  it("observes rollback selected by Contributor recovery before assigning optional roles", async () => {
    let rollback = false;
    const test = azurePorts(existingIdentityAz);
    test.credentials.isRollbackPending = () => rollback;
    test.credentials.recovery.execute = async (mutation) => {
      rollback = true;
      return {
        state: "applied",
        value: mutation.accept(await mutation.mutate()),
        recovered: false
      };
    };
    expect(
      await configureAzureAutoSetupCredentials(input(test.credentials))
    ).toBe(false);
    expect(test.events.at(-1)).toMatchObject({
      kind: "rollback-after-contributor"
    });
  });

  it("does not wait beyond Azure's Retry-After cap for a required role", async () => {
    const test = azurePorts(existingIdentityAz);
    test.credentials.recovery.execute = async () => ({
      state: "not_applied",
      result: command("", 1, "HTTP 429\nRetry-After: 11")
    });
    expect(
      await configureAzureAutoSetupCredentials(input(test.credentials))
    ).toBe(false);
    expect(test.events.at(-1)).toMatchObject({
      kind: "role-assignment-failed"
    });
    expect(
      test.events.filter(
        (event) => Array.isArray(event) && event[0] === "sleep"
      )
    ).toEqual([]);
  });
  it.each([
    [command("", 1, "AuthorizationFailed"), "app-object-id-failed"],
    [command(""), "app-object-id-failed"]
  ])(
    "refuses credentials when the application object cannot be read",
    async (response, kind) => {
      const test = azurePorts(async () => response);
      expect(
        await configureAzureAutoSetupCredentials(input(test.credentials))
      ).toBe(false);
      expect(test.events.at(-2)).toMatchObject({ kind });
    }
  );

  it("refuses an existing credential whose complete provider identity is missing", async () => {
    const test = azurePorts(async (args) =>
      args[2] === "federated-credential" ?
        command(
          JSON.stringify([
            {
              name: "dev",
              subject: resolved.oidc.federatedCredentials[0].subject
            }
          ])
        )
      : existingIdentityAz(args)
    );
    expect(
      await configureAzureAutoSetupCredentials(input(test.credentials))
    ).toBe(false);
    expect(test.events.at(-2)).toMatchObject({
      kind: "federated-credential-identity-incomplete"
    });
  });

  it("awaits a reused credential provenance failure inside the lock", async () => {
    const test = azurePorts(existingIdentityAz);
    test.credentials.recordFederatedCredentialProvenance = async () => {
      throw new Error("store unavailable");
    };
    expect(
      await configureAzureAutoSetupCredentials(input(test.credentials))
    ).toBe(false);
    expect(test.events.at(-2)).toMatchObject({
      kind: "credential-provenance-write-failed",
      credentialName: "dev",
      created: false
    });
  });

  it.each([
    [command("", 1, "not found"), "not_applied"],
    [
      command(
        JSON.stringify({
          id: "credential-object",
          subject: "another",
          description: "Created by Radius operation setup-1"
        })
      ),
      "manual_required"
    ],
    [
      command(
        JSON.stringify({
          id: "credential-object",
          subject: resolved.oidc.federatedCredentials[0].subject,
          description: "Created by Radius operation setup-1"
        })
      ),
      "applied"
    ]
  ])(
    "preserves federated credential reconciliation verdict %s",
    async (response, state) => {
      const test = azurePorts(async (args) => {
        if (args[2] === "federated-credential")
          return args[3] === "list" ? command("[]") : response;
        return existingIdentityAz(args);
      });
      test.credentials.recovery.execute = async (mutation) => {
        expect(await mutation.reconcile()).toMatchObject({ state });
        expect(await mutation.beforeMutation?.()).toBe(true);
        return { state: "cancelled" };
      };
      expect(
        await configureAzureAutoSetupCredentials(input(test.credentials))
      ).toBe(false);
      expect(test.events.slice(-2)).toEqual([
        ["remove", "credential.json"],
        "unlock"
      ]);
    }
  );

  it.each([
    [command("", 1), "The federated credential could not be read."],
    [command("stdout denial", 1), "stdout denial"],
    [
      command("{"),
      "Microsoft Entra returned unreadable federated credential state."
    ]
  ])("preserves federated reconciliation errors", async (response, message) => {
    const test = azurePorts(async (args) =>
      args[2] === "federated-credential" ?
        args[3] === "list" ?
          command("[]")
        : response
      : existingIdentityAz(args)
    );
    test.credentials.recovery.execute = async (mutation) => {
      await mutation.reconcile();
      throw new Error("must reject");
    };
    await expect(
      configureAzureAutoSetupCredentials(input(test.credentials))
    ).rejects.toThrow(message);
  });

  it.each([
    [command("[]"), "not_applied"],
    [command("", 1, "not found"), "not_applied"],
    [
      command(
        '[{"id":"other","principalId":"principal-id","roleDefinitionName":"Contributor","scope":"wrong"}]'
      ),
      "manual_required"
    ],
    [command("[{},{}]"), "manual_required"]
  ])("preserves role reconciliation verdict %s", async (response, state) => {
    const test = azurePorts(async (args) =>
      args[0] === "role" ? response : existingIdentityAz(args)
    );
    test.credentials.recovery.execute = async (mutation) => {
      expect(await mutation.beforeMutation?.()).toBe(true);
      expect(await mutation.reconcile()).toMatchObject({ state });
      return { state: "cancelled" };
    };
    expect(
      await configureAzureAutoSetupCredentials(input(test.credentials))
    ).toBe(false);
  });

  it.each([
    [command("{}"), "Azure returned unreadable role assignment state."],
    [command("{"), "Azure returned unreadable role assignment state."],
    [command("", 1), "The Azure role assignment could not be read."],
    [command("stdout denial", 1), "stdout denial"]
  ])(
    "rejects unreadable role reconciliation state",
    async (response, message) => {
      const test = azurePorts(async (args) =>
        args[0] === "role" ? response : existingIdentityAz(args)
      );
      test.credentials.recovery.execute = async (mutation) => {
        await mutation.reconcile();
        throw new Error("must reject");
      };
      await expect(
        configureAzureAutoSetupCredentials(input(test.credentials))
      ).rejects.toThrow(message);
    }
  );

  it.each([
    ["Locks Contributor", "rollback-after-locks-contributor"],
    [
      "Azure Kubernetes Service RBAC Cluster Admin",
      "rollback-after-cluster-admin"
    ]
  ])(
    "observes rollback selected by %s recovery before completing",
    async (role, kind) => {
      let rollback = false;
      const test = azurePorts(existingIdentityAz);
      test.credentials.isRollbackPending = () => rollback;
      test.credentials.recovery.execute = async (mutation) => {
        const value = mutation.accept(await mutation.mutate());
        if (mutation.target.includes(role)) rollback = true;
        return { state: "applied", value, recovered: false };
      };
      expect(
        await configureAzureAutoSetupCredentials(input(test.credentials))
      ).toBe(false);
      expect(test.events.at(-1)).toMatchObject({
        kind
      });
    }
  );
  it("awaits finalization while the provenance lock is held", async () => {
    const events: string[] = [];
    let held = false;
    const test = azurePorts(async (args) =>
      args[2] === "federated-credential" ?
        command("malformed")
      : existingIdentityAz(args)
    );
    test.credentials.withCredentialProvenanceLock = async (work) => {
      held = true;
      events.push("lock");
      try {
        return await work();
      } finally {
        held = false;
        events.push("unlock");
      }
    };
    test.credentials.finalizeFailure = async (event) => {
      expect(event.kind).toBe("federated-credential-list-malformed");
      expect(held).toBe(true);
      events.push("finalize:start");
      await Promise.resolve();
      expect(held).toBe(true);
      events.push("finalize:end");
    };
    expect(
      await configureAzureAutoSetupCredentials(input(test.credentials))
    ).toBe(false);
    expect(events).toEqual([
      "lock",
      "finalize:start",
      "finalize:end",
      "unlock"
    ]);
  });

  it("re-reads rollback state after provenance before assigning roles", async () => {
    let rollback = false;
    const test = azurePorts(existingIdentityAz);
    test.credentials.isRollbackPending = () => rollback;
    test.credentials.recordFederatedCredentialProvenance = async () => {
      rollback = true;
    };
    expect(
      await configureAzureAutoSetupCredentials(input(test.credentials))
    ).toBe(false);
    expect(test.events.at(-1)).toMatchObject({
      kind: "rollback-after-federated-credential"
    });
    expect(test.events).not.toContainEqual(expect.arrayContaining(["role"]));
  });

  it("preserves a recovery failure identity and removes its parameter file before unlocking", async () => {
    const test = azurePorts(async (args) =>
      args[2] === "federated-credential" ?
        command("[]")
      : existingIdentityAz(args)
    );
    const original = new Error("ambiguous provider mutation");
    test.credentials.recovery.execute = async () => {
      throw original;
    };
    await expect(
      configureAzureAutoSetupCredentials(input(test.credentials))
    ).rejects.toBe(original);
    expect(test.events.slice(-2)).toEqual([
      ["remove", "credential.json"],
      "unlock"
    ]);
  });

  it("stops when the required Contributor assignment fails", async () => {
    const test = azurePorts(existingIdentityAz);
    test.credentials.recovery.execute = async (mutation) => ({
      state: "not_applied",
      result: command(
        "",
        1,
        mutation.target.includes("Contributor") ?
          "AuthorizationFailed"
        : "denied"
      )
    });
    expect(
      await configureAzureAutoSetupCredentials(input(test.credentials))
    ).toBe(false);
    expect(test.events.at(-1)).toMatchObject({
      kind: "role-assignment-failed",
      evidence: { azError: "AuthorizationFailed" }
    });
  });

  it.each([
    ["Azure Kubernetes Service RBAC Cluster Admin", "cluster-admin-warning"],
    ["Locks Contributor", "locks-contributor-warning"]
  ])("completes with a warning when optional %s fails", async (role, kind) => {
    const assignments: string[] = [];
    const test = azurePorts(existingIdentityAz);
    test.credentials.recovery.execute = async (mutation) => {
      assignments.push(mutation.target);
      return {
        state: "not_applied",
        result:
          mutation.target.split("\0")[2] === role ?
            command("", 1, "AuthorizationFailed")
          : command()
      };
    };
    expect(
      await configureAzureAutoSetupCredentials(input(test.credentials))
    ).toBe(true);
    expect(assignments.map((target) => target.split("\0")[2])).toEqual([
      "Contributor",
      "Azure Kubernetes Service RBAC Cluster Admin",
      "Locks Contributor"
    ]);
    expect(test.events).toContainEqual(expect.objectContaining({ kind }));
    expect(test.events).not.toContainEqual(
      expect.objectContaining({ kind: "role-assignment-failed" })
    );
  });
});
