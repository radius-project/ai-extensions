import { describe, expect, it } from "vitest";
import { resolveAzureAutoSetupApplication } from "./setup-azure-application.js";
import {
  azurePorts,
  callerId,
  clientId,
  command,
  existingIdentityAz,
  request,
  resolved
} from "../test/support/azure-setup.js";
import type { AzureApplicationInput } from "./setup-azure-contracts.js";
import { buildRadiusAppProvenanceTags } from "./platforms/setup-azure-identity.js";

function input(ports: AzureApplicationInput["ports"]): AzureApplicationInput {
  return {
    ports,
    oidc: resolved.oidc,
    environment: "dev",
    explicitAppId: "",
    createNewApp: false,
    appNameProvided: false,
    requestedAppName: "",
    requestedClientId: clientId,
    serviceManagementReference: "",
    callerIdentity: { kind: "user" }
  };
}

describe("Azure application policy ports", () => {
  it.each([
    ["HTTP 429", "caller-before-application-create", 6],
    ["AuthorizationFailed", "caller-before-application-create", 1]
  ] as const)(
    "uses stdout-only caller lookup diagnostics for %s",
    async (detail, kind, attempts) => {
      const { test, facts } = creating();
      const run = test.application.runAz;
      let reads = 0;
      test.application.runAz = async (args) => {
        if (args[1] === "signed-in-user") {
          reads++;
          return command(detail, 1);
        }
        return run(args);
      };
      expect(await resolveAzureAutoSetupApplication(facts)).toBeNull();
      expect(reads).toBe(attempts);
      expect(test.events.at(-1)).toMatchObject({
        kind,
        evidence: { azError: detail }
      });
    }
  );

  it.each(["owner", "tags"] as const)(
    "refuses excessive Retry-After during created %s verification without sleeping",
    async (kind) => {
      const { test, facts } = creating({
        kind,
        value: command("", 1, "HTTP 429\nRetry-After: 11")
      });
      const mutations: string[] = [];
      test.application.recovery.execute = async (mutation) => {
        mutations.push(mutation.kind);
        return {
          state: "applied",
          value: mutation.accept(await mutation.mutate()),
          recovered: false
        };
      };
      expect(await resolveAzureAutoSetupApplication(facts)).toBeNull();
      expect(test.events.at(-1)).toMatchObject({
        kind:
          kind === "owner" ?
            "created-application-owner-lookup"
          : "app-tag-read-failed",
        evidence: { azError: "HTTP 429\nRetry-After: 11" }
      });
      expect(test.events).not.toContainEqual(["sleep", expect.any(Number)]);
      expect(mutations).toHaveLength(kind === "owner" ? 2 : 3);
    }
  );

  it.each([
    ["Directory_ObjectNotFound", 6],
    ["Directory_ObjectNotFound\nRetry-After: 11", 1]
  ] as const)(
    "retains stdout-only tag mutation propagation failure %s",
    async (detail, attempts) => {
      const { test, facts } = creating();
      const run = test.application.runAz;
      let writes = 0;
      test.application.runAz = async (args) => {
        if (args[0] === "rest" && args.includes("PATCH")) {
          writes++;
          return command(detail, 1);
        }
        return run(args);
      };
      test.application.recovery.execute = async (mutation) => {
        const result = await mutation.mutate();
        return result.code === 0 ?
            {
              state: "applied",
              value: mutation.accept(result),
              recovered: false
            }
          : { state: "not_applied", result };
      };
      expect(await resolveAzureAutoSetupApplication(facts)).toBeNull();
      expect(writes).toBe(attempts);
      expect(test.events.at(-1)).toMatchObject({
        kind: "app-tag-update-failed",
        evidence: { azError: "", clientId }
      });
    }
  );

  it("keeps the first unowned candidate's provenance when later candidates omit tags", async () => {
    const test = azurePorts(async (args) => {
      if (args[2] === "list")
        return command(
          JSON.stringify([{ appId: clientId }, { appId: callerId }])
        );
      if (args[2] === "owner") return command("");
      return existingIdentityAz(args);
    });
    expect(
      await resolveAzureAutoSetupApplication({
        ...input(test.application),
        requestedClientId: ""
      })
    ).toBeNull();
    expect(test.events.at(-1)).toMatchObject({
      kind: "application-selection",
      values: [expect.any(String), "app-registration-not-owned"]
    });
  });

  it.each([
    [command("", 1), "The App Registration state could not be read."],
    [command(""), "No operation-provenanced App Registration is visible yet."],
    [command("{}"), "No operation-provenanced App Registration is visible yet."]
  ])("fails closed on empty recovery reads", async (response, message) => {
    const test = azurePorts(async () => response);
    test.application.recovery.find = () => ({
      kind: "azure_application.create",
      status: "prepared",
      evidence: null
    });
    test.application.recovery.willWrite = () => false;
    test.application.recovery.execute = async (mutation) => {
      await mutation.reconcile();
      throw new Error("must reject");
    };
    await expect(
      resolveAzureAutoSetupApplication({
        ...input(test.application),
        resumeAtCreate: {
          appName: "radius-deploy-owner-repo",
          callerObjectId: callerId
        }
      })
    ).rejects.toThrow(message);
  });

  it.each([
    ["azure_application.create", "app-create-failed"],
    ["azure_app_owner.add", "app-owner-add-failed"],
    ["azure_app_tags.patch", "app-tag-update-failed"]
  ])(
    "finalizes a %s reconciliation refusal with no command response",
    async (kind, failure) => {
      const { test, facts } = creating();
      test.application.recovery.execute = async (mutation) =>
        mutation.kind === kind ?
          { state: "not_applied" }
        : {
            state: "applied",
            value: mutation.accept(await mutation.mutate()),
            recovered: false
          };
      expect(await resolveAzureAutoSetupApplication(facts)).toBeNull();
      expect(test.events.at(-1)).toMatchObject({ kind: failure });
    }
  );

  it("retains an empty caller hint when reconciliation requests SMR without a forward create", async () => {
    const { test, facts } = creating();
    test.application.recovery.find = () => ({
      kind: "azure_application.create",
      status: "prepared",
      evidence: null
    });
    test.application.recovery.willWrite = () => false;
    test.application.recovery.execute = async () => ({
      state: "not_applied",
      result: command("", 1, "ServiceManagementReference required")
    });
    expect(await resolveAzureAutoSetupApplication(facts)).toBeNull();
    expect(test.events.at(-1)).toMatchObject({
      kind: "service-management-reference-required",
      evidence: { appCreateContinuationCallerObjectId: "" }
    });
  });

  it("resolves the caller after recovering a create instead of issuing another application write", async () => {
    const { test, facts } = creating();
    const calls: string[][] = [];
    const run = test.application.runAz;
    test.application.runAz = async (args) => {
      calls.push(args);
      return run(args);
    };
    test.application.recovery.find = (kind) =>
      kind === "azure_application.create" ?
        {
          kind,
          status: "prepared",
          evidence: null,
          providerId: clientId
        }
      : null;
    test.application.recovery.willWrite = (kind) =>
      kind !== "azure_application.create";
    test.application.recovery.execute = async (mutation) => ({
      state: "applied",
      value: mutation.accept(
        mutation.kind === "azure_application.create" ?
          command(clientId)
        : await mutation.mutate()
      ),
      recovered: mutation.kind === "azure_application.create"
    });
    expect(await resolveAzureAutoSetupApplication(facts)).toMatchObject({
      clientId,
      state: "created"
    });
    expect(calls.filter((args) => args[1] === "signed-in-user")).toHaveLength(
      1
    );
    expect(
      calls.some((args) => args[1] === "app" && args[2] === "create")
    ).toBe(false);
  });

  it("retries an owner mutation whose replication diagnostic arrives on stdout", async () => {
    const { test, facts } = creating();
    const run = test.application.runAz;
    let attempts = 0;
    test.application.runAz = async (args) => {
      if (args[2] === "owner" && args[3] === "add" && ++attempts === 1)
        return command("Directory_ObjectNotFound", 1);
      return run(args);
    };
    test.application.recovery.execute = async (mutation) => ({
      state: "applied",
      value: mutation.accept(await mutation.mutate()),
      recovered: false
    });
    expect(await resolveAzureAutoSetupApplication(facts)).toMatchObject({
      clientId,
      state: "created"
    });
    expect(attempts).toBe(2);
    expect(test.events).toContainEqual(["sleep", 2000]);
  });
  it("rejects unreadable application recovery state without reissuing a create", async () => {
    let reads = 0;
    const test = azurePorts(async () => command(++reads === 1 ? "[]" : "{"));
    test.application.recovery.find = () => ({
      kind: "azure_application.create",
      status: "prepared",
      evidence: null
    });
    test.application.recovery.willWrite = () => false;
    test.application.recovery.execute = async (mutation) => {
      await mutation.reconcile();
      throw new Error("must reject");
    };
    await expect(
      resolveAzureAutoSetupApplication({
        ...input(test.application),
        requestedClientId: ""
      })
    ).rejects.toThrow("The App Registration recovery lookup was unreadable.");
    expect(reads).toBe(2);
  });
  it.each([
    [[], "No operation-provenanced App Registration is visible yet."],
    [
      [
        { appId: clientId, displayName: "radius-deploy-owner-repo" },
        { appId: clientId, displayName: "radius-deploy-owner-repo" }
      ],
      null
    ]
  ])(
    "fails closed on absent or ambiguous operation-provenanced applications",
    async (matches, message) => {
      const test = azurePorts(async () => command(JSON.stringify(matches)));
      test.application.recovery.find = () => ({
        kind: "azure_application.create",
        status: "confirmed",
        providerId: clientId,
        evidence: null
      });
      test.application.recovery.willWrite = () => false;
      test.application.recovery.execute = async (mutation) => {
        if (message)
          await expect(mutation.reconcile()).rejects.toThrow(message);
        else
          expect(await mutation.reconcile()).toEqual({
            state: "manual_required",
            guidance:
              'Multiple App Registrations named "radius-deploy-owner-repo" appeared during the interrupted request. Radius will not guess which application belongs to this operation or create another one.'
          });
        return { state: "cancelled" };
      };
      expect(
        await resolveAzureAutoSetupApplication({
          ...input(test.application),
          requestedClientId: ""
        })
      ).toBeNull();
    }
  );
  function creating(response?: {
    kind: "owner" | "tags";
    value: ReturnType<typeof command>;
  }) {
    const tags = buildRadiusAppProvenanceTags({
      repo: "owner/repo",
      environment: "dev",
      operationId: "setup-1"
    });
    const test = azurePorts(async (args) => {
      if (args.slice(0, 3).join(" ") === "ad app list") return command("[]");
      if (args.slice(0, 3).join(" ") === "ad app create")
        return command(clientId);
      if (args.slice(0, 4).join(" ") === "ad app owner add") return command();
      if (
        args.slice(0, 4).join(" ") === "ad app owner list" &&
        response?.kind === "owner"
      )
        return response.value;
      if (args[0] === "rest" && args.includes("PATCH")) return command();
      if (args.slice(0, 3).join(" ") === "ad app show" && args.includes("tags"))
        return response?.kind === "tags" ?
            response.value
          : command(JSON.stringify(tags));
      return existingIdentityAz(args);
    });
    return {
      test,
      facts: {
        ...input(test.application),
        requestedClientId: "",
        createNewApp: true
      }
    };
  }

  it("runs each persisted-write boundary through narrow recovery callbacks", async () => {
    const { test, facts } = creating();
    const kinds: string[] = [];
    test.application.recovery.execute = async (mutation) => {
      kinds.push(mutation.kind);
      expect(await mutation.beforeMutation?.()).toBe(true);
      const result = await mutation.mutate();
      const value = mutation.accept(result);
      mutation.providerIdOf?.(result, value);
      mutation.acceptedEvidence?.(result);
      return { state: "applied", value, recovered: false };
    };
    expect(await resolveAzureAutoSetupApplication(facts)).toEqual({
      clientId,
      appName: "radius-deploy-owner-repo",
      state: "created"
    });
    expect(kinds).toEqual([
      "azure_application.create",
      "azure_app_owner.add",
      "azure_app_tags.patch"
    ]);
  });

  it.each([
    ["owner", command("", 1, "AuthorizationFailed"), "AuthorizationFailed"],
    ["owner", command("stdout failure", 1), "stdout failure"],
    ["owner", command("", 1), "App Registration owners could not be read."],
    ["tags", command("", 1, "AuthorizationFailed"), "AuthorizationFailed"],
    ["tags", command("stdout failure", 1), "stdout failure"],
    ["tags", command("", 1), "App Registration tags could not be read."],
    [
      "tags",
      command("{"),
      "Microsoft Entra returned unreadable App Registration tags."
    ]
  ] as const)(
    "preserves %s reconciliation diagnostics",
    async (kind, value, message) => {
      const { test, facts } = creating({ kind, value });
      test.application.recovery.execute = async (mutation) => {
        if (
          mutation.kind ===
          (kind === "owner" ? "azure_app_owner.add" : "azure_app_tags.patch")
        ) {
          await mutation.reconcile();
          throw new Error("must reject");
        }
        return {
          state: "applied",
          value: mutation.accept(await mutation.mutate()),
          recovered: false
        };
      };
      await expect(resolveAzureAutoSetupApplication(facts)).rejects.toThrow(
        message
      );
    }
  );

  it.each(["azure_app_owner.add", "azure_app_tags.patch"])(
    "halts when %s recovery is cancelled",
    async (target) => {
      const { test, facts } = creating();
      test.application.recovery.execute = async (mutation) =>
        mutation.kind === target ?
          { state: "cancelled" }
        : {
            state: "applied",
            value: mutation.accept(await mutation.mutate()),
            recovered: false
          };
      expect(await resolveAzureAutoSetupApplication(facts)).toBeNull();
    }
  );

  it("preserves tag mismatch guidance without overwriting unrelated tags", async () => {
    const { test, facts } = creating({ kind: "tags", value: command("[]") });
    test.application.recovery.execute = async (mutation) => {
      if (mutation.kind === "azure_app_tags.patch") {
        expect(await mutation.reconcile()).toEqual({
          state: "manual_required",
          guidance: `App Registration "${clientId}" does not carry the exact Radius operation provenance tags. Radius will not overwrite or delete it based on display name.`
        });
        return { state: "cancelled" };
      }
      return {
        state: "applied",
        value: mutation.accept(await mutation.mutate()),
        recovered: false
      };
    };
    expect(await resolveAzureAutoSetupApplication(facts)).toBeNull();
  });
  it("waits for every concurrent owner read before propagating its original rejection", async () => {
    const original = new Error("owner read failed");
    const reads: string[] = [];
    const test = azurePorts(async (args) => {
      if (args.slice(0, 3).join(" ") === "ad app list")
        return command(
          JSON.stringify([{ appId: clientId }, { appId: callerId }])
        );
      if (args.slice(0, 4).join(" ") === "ad app owner list") {
        reads.push(args[5]);
        if (args[5] === clientId) throw original;
        return command(callerId);
      }
      return existingIdentityAz(args);
    });
    await expect(
      resolveAzureAutoSetupApplication({
        ...input(test.application),
        requestedClientId: ""
      })
    ).rejects.toBe(original);
    expect(reads).toEqual([clientId, callerId]);
  });
  it("persists reuse before returning the identity", async () => {
    const test = azurePorts(existingIdentityAz);
    expect(
      await resolveAzureAutoSetupApplication(input(test.application))
    ).toEqual({
      clientId,
      appName: "radius-deploy-owner-repo",
      state: "reused"
    });
    expect(test.events.slice(-2)).toEqual([
      [
        "application",
        {
          state: "reused",
          origin: "pre_existing",
          appId: clientId,
          displayName: null
        }
      ],
      "persist"
    ]);
  });

  it("reports persistence failure at the original position without finalizing cleanup", async () => {
    const test = azurePorts(existingIdentityAz);
    const original = new Error("store unavailable");
    test.application.persist = async () => {
      throw original;
    };
    expect(
      await resolveAzureAutoSetupApplication(input(test.application))
    ).toBeNull();
    expect(test.events.at(-1)).toEqual(["persistence-failure", original]);
    expect(test.events).not.toContainEqual(
      expect.objectContaining({ kind: "invalid-app-name" })
    );
  });

  it("reads live artifact identity within recovery, after the initial application lookup", async () => {
    let artifact: { origin: string; appId: string } | undefined;
    const test = azurePorts(async (args) => {
      if (args.slice(0, 3).join(" ") === "ad app list") {
        artifact = { origin: "this_operation", appId: clientId };
        return command(
          JSON.stringify([
            { appId: clientId, displayName: "radius-deploy-owner-repo" }
          ])
        );
      }
      return existingIdentityAz(args);
    });
    test.application.getApplicationArtifact = () => artifact;
    test.application.recovery.find = () => ({
      kind: "azure_application.create",
      status: "prepared",
      evidence: null
    });
    test.application.recovery.willWrite = () => false;
    test.application.recovery.execute = async (mutation) => {
      const reconciliation = await mutation.reconcile();
      expect(reconciliation).toEqual({
        state: "applied",
        value: clientId,
        evidence:
          "The exact App Registration provider identity or immutable Radius operation provenance matched the interrupted operation."
      });
      return { state: "cancelled" };
    };
    expect(
      await resolveAzureAutoSetupApplication({
        ...input(test.application),
        requestedClientId: ""
      })
    ).toBeNull();
  });

  it("does not wrap a recovery port error or continue after it", async () => {
    const test = azurePorts(async (args) =>
      args[2] === "list" ? command("[]")
      : args[1] === "signed-in-user" ? command(callerId)
      : existingIdentityAz(args)
    );
    const original = new Error("mutation outcome unknown");
    test.application.recovery.execute = async () => {
      throw original;
    };
    await expect(
      resolveAzureAutoSetupApplication({
        ...input(test.application),
        requestedClientId: "",
        createNewApp: true
      })
    ).rejects.toBe(original);
    expect(test.events).not.toContainEqual(
      expect.arrayContaining(["application"])
    );
  });

  it("requires selection instead of making a new identity when candidates are ambiguous", async () => {
    const test = azurePorts(async (args) =>
      args.slice(0, 3).join(" ") === "ad app list" ?
        command(
          JSON.stringify([
            { appId: clientId },
            { appId: request.requestedSubscriptionId }
          ])
        )
      : existingIdentityAz(args)
    );
    expect(
      await resolveAzureAutoSetupApplication({
        ...input(test.application),
        requestedClientId: ""
      })
    ).toBeNull();
    expect(test.events.at(-1)).toMatchObject({
      kind: "app-selection-required",
      evidence: { candidates: expect.any(Array) }
    });
  });
});
