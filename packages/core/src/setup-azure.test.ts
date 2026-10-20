import { describe, expect, it } from "vitest";
import {
  runAzureSetup,
  type AzureSetupPorts,
  type AzureIdentityFailure
} from "./setup-azure.js";
import {
  azurePorts,
  command,
  existingIdentityAz,
  request,
  subscriptionId,
  tenantId
} from "../test/support/azure-setup.js";

function harness(runAz = existingIdentityAz) {
  const fake = azurePorts(runAz);
  const identity: unknown[] = [];
  const failures: AzureIdentityFailure[] = [];
  const ports: AzureSetupPorts = {
    ...fake,
    identityProgress: (event) => {
      identity.push(event);
    },
    finalizeIdentityFailure: async (event) => {
      failures.push(event);
    },
    prepareContinuation: (resolved) => {
      identity.push(["continuation", resolved]);
    }
  };
  return { ...fake, ports, identity, failures };
}

describe("runAzureSetup", () => {
  it("returns input-required only after saving the continuation seed and awaiting the prompt", async () => {
    const test = harness(async (args) =>
      args.slice(0, 3).join(" ") === "ad app list" ?
        command("[]")
      : existingIdentityAz(args)
    );
    test.application.recovery.execute = async () => ({
      state: "not_applied",
      result: command("", 1, "serviceTreeNullValueProvided")
    });
    expect(
      await runAzureSetup(
        {
          request: { ...request, requestedClientId: "", createNewApp: true },
          serviceManagementReference: "",
          continuation: null
        },
        test.ports
      )
    ).toEqual({ kind: "input-required" });
    expect(test.identity.at(-1)).toEqual(["continuation", expect.any(Object)]);
    expect(test.events.at(-1)).toMatchObject({
      kind: "service-management-reference-required"
    });
  });

  it.each(["failed", "stopped"] as const)(
    "preserves the live %s result after a refused checkpoint",
    async (kind) => {
      const test = harness();
      test.credentials.checkpoint = async () => false;
      test.credentials.haltKind = () => kind;
      expect(
        await runAzureSetup(
          { request, serviceManagementReference: "", continuation: null },
          test.ports
        )
      ).toEqual({ kind });
    }
  );

  it("honors an application stop after subscription and OIDC validation", async () => {
    const test = harness(async (args) =>
      args.slice(0, 3).join(" ") === "ad app list" ?
        command("[]")
      : existingIdentityAz(args)
    );
    test.application.stopBoundary = async (boundary) =>
      boundary === "before-azure-subscription-selection";
    expect(
      await runAzureSetup(
        {
          request: { ...request, requestedClientId: "", createNewApp: true },
          serviceManagementReference: "",
          continuation: null
        },
        test.ports
      )
    ).toEqual({ kind: "stopped" });
  });

  it.each([
    new Error("lookup rejected"),
    "lookup rejected",
    { code: "", message: "unknown" }
  ])("keeps the original OIDC catch mapping", async (thrown) => {
    const test = harness();
    test.application.runGitHubJson = async () => {
      throw thrown;
    };
    expect(
      await runAzureSetup(
        { request, serviceManagementReference: "", continuation: null },
        test.ports
      )
    ).toEqual({ kind: "failed" });
    expect(test.failures[0]).toMatchObject({
      kind: "oidc",
      code: "oidc-subject-failed"
    });
  });
  it("composes account, OIDC, application and credentials without HTTP or Canvas", async () => {
    const test = harness();
    test.credentials.recovery.execute = async (input) => ({
      state: "applied",
      value: input.accept(await input.mutate()),
      recovered: false
    });
    const result = await runAzureSetup(
      { request, serviceManagementReference: "", continuation: null },
      test.ports
    );
    expect(result).toMatchObject({
      kind: "completed",
      subscriptionId,
      tenantId,
      application: { state: "reused" },
      subjects: ["repo:owner/repo:environment:dev"]
    });
    expect(
      test.identity.map((event) =>
        Array.isArray(event) ? event[0] : (event as { kind: string }).kind
      )
    ).toEqual([
      "select-subscription",
      "check-login",
      "account-ready",
      "resolve-oidc",
      "oidc-ready",
      "continuation"
    ]);
    expect(
      test.events.filter((event) => Array.isArray(event) && event[0] === "role")
    ).toHaveLength(3);
    expect(test.failures).toEqual([]);
  });

  it.each([
    ["string zero", "set", command("", "0"), "subscription-selection"],
    [
      "selection refused",
      "set",
      command("", 1, "denied"),
      "subscription-selection"
    ],
    ["login refused", "show", command("", 1), "not-logged-in"],
    ["malformed account", "show", command("{"), "account-parse"],
    [
      "tenant mismatch",
      "show",
      command(JSON.stringify({ id: subscriptionId, tenantId: subscriptionId })),
      "tenant-mismatch"
    ],
    [
      "invalid subscription",
      "show",
      command(JSON.stringify({ id: "invalid", tenantId })),
      "invalid-subscription"
    ],
    [
      "missing tenant",
      "show",
      command(JSON.stringify({ id: subscriptionId })),
      "account-incomplete"
    ]
  ])("preserves the %s boundary", async (_name, verb, response, kind) => {
    const test = harness(async (args) =>
      args[0] === "account" && args[1] === verb ?
        response
      : existingIdentityAz(args)
    );
    expect(
      await runAzureSetup(
        { request, serviceManagementReference: "", continuation: null },
        test.ports
      )
    ).toEqual({ kind: "failed" });
    expect(test.failures[0].kind).toBe(kind);
    expect(test.events).not.toContainEqual(
      expect.arrayContaining(["application"])
    );
  });

  it("stops before selecting a subscription", async () => {
    const test = harness(async () => {
      throw new Error("must not run");
    });
    test.application.stopBoundary = async () => false;
    expect(
      await runAzureSetup(
        { request, serviceManagementReference: "", continuation: null },
        test.ports
      )
    ).toEqual({ kind: "stopped" });
    expect(test.failures).toEqual([]);
  });

  it("awaits identity failure finalization and preserves thrown object identity", async () => {
    const test = harness(async () => command("", 1));
    const original = new Error("finalization refused");
    test.ports.finalizeIdentityFailure = async () => {
      throw original;
    };
    await expect(
      runAzureSetup(
        { request, serviceManagementReference: "", continuation: null },
        test.ports
      )
    ).rejects.toBe(original);
  });

  it("reports OIDC failure without proceeding to application mutation", async () => {
    const test = harness();
    test.application.runGitHubJson = async () => ({ ok: false, status: 403 });
    expect(
      await runAzureSetup(
        { request, serviceManagementReference: "", continuation: null },
        test.ports
      )
    ).toEqual({ kind: "failed" });
    expect(test.failures[0]).toMatchObject({ kind: "oidc" });
  });
});
