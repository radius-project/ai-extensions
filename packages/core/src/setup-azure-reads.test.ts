import {
  buildRoleAssignmentArgs,
  findFederatedCredentialNameCollision,
  isReplicationLagError,
  pickAksResourceGroup
} from "./setup-azure-reads.js";
import { describe, expect, it } from "vitest";
import {
  buildEnvironmentSuffix,
  buildFederatedCredentialName
} from "./platforms/oidc-subject.js";
import {
  azureRetryDelayMs,
  federatedCredentialIdFrom,
  isRetryableAzureReadFailure,
  parseFederatedCredentialInventory,
  parseFederatedCredentialObject,
  readAzureWithPropagationRetry,
  readFederatedCredentialId
} from "./setup-azure-reads.js";
import { command } from "../test/support/azure-setup.js";

describe("Azure read and identity mechanics", () => {
  it.each([
    ["Retry-After: Wed, 14 Oct 2026 10:00:05 GMT", 5000],
    ["Retry-After: invalid", 2000],
    ["Retry-After: -1", 0],
    ["Retry-After: 11", null],
    ["Retry-After: 0", 0],
    [undefined, 2000]
  ])("preserves Retry-After parsing for %j", (detail, expected) => {
    expect(
      azureRetryDelayMs(detail, 2000, Date.parse("2026-10-14T10:00:00Z"))
    ).toBe(expected);
  });
  it.each([
    "HTTP 401",
    "HTTP 403",
    "Authorization_RequestDenied",
    "Insufficient privileges"
  ])("never retries authorization error %s", (detail) => {
    expect(isRetryableAzureReadFailure(detail)).toBe(false);
  });
  it("retries transient reads but not an unsuccessful acceptance of a successful response by default", async () => {
    const reads = [command("", 1, "HTTP 503"), command("not accepted")];
    const delays: number[] = [];
    const last = await readAzureWithPropagationRetry(
      async () => reads.shift() ?? command("unexpected"),
      async (delay) => {
        delays.push(delay);
      },
      () => false
    );
    expect(last.stdout).toBe("not accepted");
    expect(delays).toEqual([2000]);
  });
  it.each([
    "null",
    "{}",
    "[null]",
    "[[]]",
    '[{"name":"dev","subject":"","claimsMatchingExpression":""}]'
  ])("rejects incomplete credential inventory %s", (payload) => {
    expect(parseFederatedCredentialInventory(payload)).toBeNull();
  });
  it("accepts expression credentials without claiming a mutable subject", () => {
    expect(
      parseFederatedCredentialInventory(
        '[{"name":"dev","claimsMatchingExpression":{"languageVersion":1,"value":"claims"}}]'
      )
    ).toEqual({ subjects: [""], nameToSubject: new Map([["dev", ""]]) });
    expect(parseFederatedCredentialObject("{}")).toBeNull();
  });
  it.each([undefined, "{", "null", "{}", '{"id":42}', '{"id":" "}'])(
    "does not invent an object id from %j",
    (stdout) => {
      expect(federatedCredentialIdFrom(stdout)).toBeNull();
    }
  );
  it.each([command(""), command("", 1), command("  ")])(
    "returns no credential identity after an inconclusive lookup",
    async (result) => {
      expect(
        await readFederatedCredentialId(
          async () => result,
          "application",
          "dev"
        )
      ).toBeNull();
    }
  );
  it("contains a provider lookup exception without claiming identity", async () => {
    expect(
      await readFederatedCredentialId(
        async () => {
          throw new Error("lookup unavailable");
        },
        "application",
        "dev"
      )
    ).toBeNull();
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
