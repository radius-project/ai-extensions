import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import {
  continuationMatchesLiveContext,
  parseAzureAccountIdentity
} from "./setup-azure-account.js";
import {
  callerId,
  command,
  continuation,
  subscriptionId,
  tenantId
} from "../test/support/azure-setup.js";

describe("Azure account identity", () => {
  it.each([
    "{",
    "[]",
    "null",
    '{"id":42}',
    '{"id":"subscription","tenantId":42}'
  ])("rejects malformed account %s", (value) => {
    expect(parseAzureAccountIdentity(value)).toBeNull();
  });
  it("preserves normalized account facts without requiring tenant presence", () => {
    expect(
      parseAzureAccountIdentity(
        '{"id":" subscription ","user":{"type":"user"}}'
      )
    ).toEqual({
      subscriptionId: "subscription",
      tenantId: "",
      callerIdentity: { kind: "user" }
    });
  });
  it("classifies service-principal callers from the same account payload", () => {
    expect(
      parseAzureAccountIdentity(
        JSON.stringify({
          id: subscriptionId,
          tenantId,
          user: { type: "servicePrincipal", name: callerId }
        })
      )
    ).toEqual({
      subscriptionId,
      tenantId,
      callerIdentity: { kind: "servicePrincipal", appId: callerId }
    });
  });
});

describe("live continuation fingerprint", () => {
  function ports() {
    const reads: string[] = [];
    return {
      reads,
      runAz: async (args: string[]) => {
        reads.push(args.join(" "));
        return args[0] === "account" ?
            command(
              JSON.stringify({
                id: subscriptionId,
                tenantId,
                user: { type: "user" }
              })
            )
          : command(callerId);
      },
      runGitHubJson: async (path: string) => {
        reads.push(path);
        return path === "/repos/owner/repo" ?
            {
              ok: true,
              json: { full_name: "owner/repo", id: 2, owner: { id: 1 } }
            }
          : {
              ok: true,
              json: {
                use_default: false,
                include_claim_keys: ["repo", "context"],
                use_immutable_subject: false
              }
            };
      },
      deepEqual: isDeepStrictEqual
    };
  }
  it("reads account, caller and OIDC in order before accepting normalized facts", async () => {
    const test = ports();
    const expected = {
      ...continuation,
      resolved: {
        ...continuation.resolved,
        oidc: {
          ...continuation.resolved.oidc,
          subjectConfig: {
            useDefault: false,
            includeClaimKeys: ["repo", "context"],
            useImmutableSubject: false
          },
          federatedCredentials: [
            {
              name: "github-owner-repo-dev",
              subject: "repo:owner/repo:environment:dev"
            }
          ]
        }
      }
    };
    const matched = await continuationMatchesLiveContext(
      expected,
      "owner/repo",
      "dev",
      test
    );
    expect(test.reads).toEqual([
      "account show --output json",
      "ad signed-in-user show --query id -o tsv",
      "/repos/owner/repo",
      "/repos/owner/repo/actions/oidc/customization/sub"
    ]);
    expect(matched).toBe(true);
  });
  it.each(["account", "caller"])(
    "rejects a changed %s before OIDC reads",
    async (boundary) => {
      const test = ports();
      const original = test.runAz;
      test.runAz = async (args) =>
        (args[0] === "account") === (boundary === "account") ?
          command("", 1, "denied")
        : original(args);
      expect(
        await continuationMatchesLiveContext(
          continuation,
          "owner/repo",
          "dev",
          test
        )
      ).toBe(false);
      expect(test.reads.some((read) => read.startsWith("/repos/"))).toBe(false);
    }
  );
  it("treats an OIDC read failure as an invalid continuation", async () => {
    const test = ports();
    test.runGitHubJson = async () => {
      throw new Error("provider unavailable");
    };
    expect(
      await continuationMatchesLiveContext(
        continuation,
        "owner/repo",
        "dev",
        test
      )
    ).toBe(false);
  });
});
