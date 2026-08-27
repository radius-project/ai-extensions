import { describe, expect, it, vi } from "vitest";
import {
  isUuid,
  isValidRepoSlug,
  isAksClusterName,
  isResourceGroupName,
  buildAppCreateArgs,
  buildAppDeleteArgs,
  buildAppOwnerAddArgs,
  buildAppOwnerListArgs,
  buildAppTagPatchArgs,
  buildAppTagShowArgs,
  buildRadiusAppProvenanceTags,
  isServiceManagementReferenceError,
  isAppOwnerAlreadyAssignedError,
  fetchGitHubJson,
  resolveOidcSubject,
  findLegacyMutableCredentialName,
  selectMissingFederatedCredentials,
  decideExistingClientId,
  isAzResourceNotFound,
  missingRequiredAppTags,
  parseAppTags,
  parseRadiusAppProvenanceTags,
  decideRadiusAppOwnership,
  isRadiusProvenanceMatch,
  parseDirectoryObjectIds,
  discoverStatusText,
  decideAppSelection,
  parseServedReposFromSubjects,
  validateAppRegistrationName,
  formatServesReposLabel,
  RADIUS_MANAGED_APP_TAG,
  type GitHubJsonResponse
} from "./azure-oidc.js";

const UUID = "11111111-2222-3333-4444-555555555555";

// A runner that maps apiPath -> a canned { ok, status, json, stderr } response.
function makeRunner(
  map: Readonly<Record<string, GitHubJsonResponse | (() => GitHubJsonResponse)>>
) {
  return vi.fn(async (apiPath: string) => {
    if (typeof map[apiPath] === "function") return map[apiPath]();
    if (map[apiPath]) return map[apiPath];
    return {
      ok: false,
      status: 404,
      json: null,
      stderr: "Not Found (HTTP 404)"
    };
  });
}

const REPO_OK = {
  ok: true,
  status: 200,
  json: { full_name: "octo-org/octo-repo", id: 222, owner: { id: 111 } },
  stderr: ""
};

describe("validators", () => {
  it("isUuid accepts a canonical UUID and rejects junk", () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });

  it("isUuid rejects shell-metacharacter injection (subscriptionId → az on Windows cmd.exe)", () => {
    // /api/discover and /api/verify-azure-login pass subscriptionId into
    // `az account set --subscription`. cliExec quotes Windows argv values, but
    // the UUID guard remains the domain boundary and defense in depth.
    expect(isUuid("00000000-0000-0000-0000-000000000000&calc")).toBe(false);
    expect(isUuid("x&calc")).toBe(false);
    expect(isUuid(UUID + " & calc")).toBe(false);
    expect(isUuid(UUID + "|whoami")).toBe(false);
  });

  it("isValidRepoSlug accepts a real owner/repo", () => {
    expect(isValidRepoSlug("octo-org/octo-repo")).toBe(true);
    expect(isValidRepoSlug("a/b")).toBe(true);
    expect(isValidRepoSlug("octo-org/octo.repo_1-2")).toBe(true);
  });

  it("isValidRepoSlug rejects shape violations", () => {
    expect(isValidRepoSlug("octo-org")).toBe(false);
    expect(isValidRepoSlug("a/b/c")).toBe(false);
    expect(isValidRepoSlug("/b")).toBe(false);
  });

  it("isValidRepoSlug rejects shell-metacharacter injection (Windows cmd.exe)", () => {
    // These previously slipped through the loose /^[^/]+\/[^/]+$/ pattern.
    expect(isValidRepoSlug("owner/repo?x=1&calc")).toBe(false);
    expect(isValidRepoSlug("owner/re po")).toBe(false);
    expect(isValidRepoSlug("owner/re&po")).toBe(false);
    expect(isValidRepoSlug("owner/repo?x")).toBe(false);
    expect(isValidRepoSlug("ow ner/repo")).toBe(false);
    expect(isValidRepoSlug("-owner/repo")).toBe(false);
  });

  it("isAksClusterName enforces the AKS 63-char, alphanumeric-bookend rule", () => {
    expect(isAksClusterName("aks-cluster_1")).toBe(true);
    expect(isAksClusterName("a")).toBe(true);
    expect(isAksClusterName("-flag")).toBe(false);
    expect(isAksClusterName("bad.dot")).toBe(false);
    expect(isAksClusterName("has space")).toBe(false);
    expect(isAksClusterName("a".repeat(64))).toBe(false);
  });

  it("isResourceGroupName allows dots/parens but rejects a trailing dot", () => {
    expect(isResourceGroupName("radius-rg")).toBe(true);
    expect(isResourceGroupName("rg_1.name(2)")).toBe(true);
    expect(isResourceGroupName("-flag")).toBe(false);
    expect(isResourceGroupName("ends.with.dot.")).toBe(false);
    expect(isResourceGroupName("has space")).toBe(false);
    expect(isResourceGroupName("a".repeat(91))).toBe(false);
  });
});

describe("buildAppCreateArgs", () => {
  it("omits SMR when not provided", () => {
    const args = buildAppCreateArgs({ appName: "radius-deploy-o-r" });
    expect(args).toEqual([
      "ad",
      "app",
      "create",
      "--display-name",
      "radius-deploy-o-r",
      "--query",
      "appId",
      "-o",
      "tsv"
    ]);
    expect(args).not.toContain("--service-management-reference");
  });

  it("appends the SMR flag when provided", () => {
    const args = buildAppCreateArgs({
      appName: "x",
      serviceManagementReference: UUID
    });
    const i = args.indexOf("--service-management-reference");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe(UUID);
  });
});

describe("app owner/tag helpers", () => {
  it("builds argv for adding and listing app owners", () => {
    expect(
      buildAppOwnerAddArgs({ appId: "app-id", ownerObjectId: "user-id" })
    ).toEqual([
      "ad",
      "app",
      "owner",
      "add",
      "--id",
      "app-id",
      "--owner-object-id",
      "user-id"
    ]);
    expect(buildAppOwnerListArgs({ appId: "app-id" })).toEqual([
      "ad",
      "app",
      "owner",
      "list",
      "--id",
      "app-id",
      "--query",
      "[].id",
      "-o",
      "tsv"
    ]);
  });

  it("parses owner ids from TSV and normalizes case", () => {
    expect(parseDirectoryObjectIds("A\nb \t A \n")).toEqual(["a", "b"]);
  });

  it("treats duplicate-owner add errors as benign verification candidates", () => {
    expect(
      isAppOwnerAlreadyAssignedError(
        "One or more added object references already exist for the following modified properties: 'owners'."
      )
    ).toBe(true);
    expect(
      isAppOwnerAlreadyAssignedError(
        "Insufficient privileges to complete the operation"
      )
    ).toBe(false);
  });

  it("builds the Radius provenance tag set without blanks or duplicates", () => {
    expect(
      buildRadiusAppProvenanceTags({
        repo: "octo-org/octo-repo",
        environment: "dev",
        operationId: "op_123"
      })
    ).toEqual([
      RADIUS_MANAGED_APP_TAG,
      "radius-repo:octo-org/octo-repo",
      "radius-environment:dev",
      "radius-operation:op_123"
    ]);
  });

  it("builds the Graph PATCH argv for application tags", () => {
    expect(
      buildAppTagPatchArgs({
        appId: "11111111-2222-3333-4444-555555555555",
        tags: ["radius-managed", "radius-repo:octo/app"]
      })
    ).toEqual([
      "rest",
      "--method",
      "PATCH",
      "--url",
      "https://graph.microsoft.com/v1.0/applications(appId='11111111-2222-3333-4444-555555555555')",
      "--body",
      '{"tags":["radius-managed","radius-repo:octo/app"]}'
    ]);
    expect(buildAppTagShowArgs({ appId: "app-id" })).toEqual([
      "ad",
      "app",
      "show",
      "--id",
      "app-id",
      "--query",
      "tags",
      "-o",
      "json"
    ]);
    expect(buildAppDeleteArgs({ appId: "app-id" })).toEqual([
      "ad",
      "app",
      "delete",
      "--id",
      "app-id"
    ]);
  });

  it("parses tag JSON and reports missing required tags", () => {
    expect(parseAppTags('["radius-managed","radius-repo:octo/app"]')).toEqual([
      "radius-managed",
      "radius-repo:octo/app"
    ]);
    expect(parseAppTags("{")).toBeNull();
    expect(
      missingRequiredAppTags(
        ["radius-managed", "radius-repo:octo/app", "other"],
        ["radius-managed", "radius-environment:dev", "radius-repo:octo/app"]
      )
    ).toEqual(["radius-environment:dev"]);
  });
});

describe("isServiceManagementReferenceError", () => {
  it("detects the known error identifiers case-insensitively", () => {
    expect(
      isServiceManagementReferenceError(
        "ServiceManagementReference field is required"
      )
    ).toBe(true);
    expect(
      isServiceManagementReferenceError("error: SERVICETREENULLVALUEPROVIDED")
    ).toBe(true);
    expect(
      isServiceManagementReferenceError("ServiceTreeInvalid: bad guid")
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(
      isServiceManagementReferenceError(
        "Insufficient privileges to complete the operation"
      )
    ).toBe(false);
    expect(isServiceManagementReferenceError("")).toBe(false);
  });
});

describe("fetchGitHubJson retry", () => {
  const noSleep = { sleepFn: async () => {} };

  it("retries on 5xx then succeeds", async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, stderr: "boom" })
      .mockResolvedValueOnce({ ok: true, status: 200, json: { a: 1 } });
    const res = await fetchGitHubJson(runner, "/x", noSleep);
    expect(res?.ok).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("retries on 429 up to the cap then returns the last failure", async () => {
    const runner = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 429, stderr: "rate" });
    const res = await fetchGitHubJson(runner, "/x", { retries: 3, ...noSleep });
    expect(res?.ok).toBe(false);
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 404", async () => {
    const runner = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 404, stderr: "nf" });
    const res = await fetchGitHubJson(runner, "/x", noSleep);
    expect(res?.status).toBe(404);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("retries on a transport error (null status)", async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: null, stderr: "ECONNRESET" })
      .mockResolvedValueOnce({ ok: true, status: 200, json: {} });
    const res = await fetchGitHubJson(runner, "/x", noSleep);
    expect(res?.ok).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
  });
});

describe("findLegacyMutableCredentialName", () => {
  const immutable = {
    federatedCredentials: [],
    fullName: "octo-org/octo-repo",
    ownerId: 111,
    repoId: 222,
    subjectConfig: { useDefault: true, useImmutableSubject: true }
  };

  it("finds the legacy mutable credential for a proven immutable repository", () => {
    expect(
      findLegacyMutableCredentialName(
        immutable,
        "environment:prod",
        new Map([
          [
            "github-octo-org-octo-repo-prod-mutable",
            "repo:octo-org/octo-repo:environment:prod"
          ]
        ])
      )
    ).toBe("github-octo-org-octo-repo-prod-mutable");
  });

  it("does not warn for an inconclusive default state", () => {
    expect(
      findLegacyMutableCredentialName(
        {
          ...immutable,
          subjectConfig: { useDefault: true }
        },
        "environment:prod",
        new Map([
          [
            "github-octo-org-octo-repo-prod-mutable",
            "repo:octo-org/octo-repo:environment:prod"
          ]
        ])
      )
    ).toBeUndefined();
  });

  it.each([
    { useDefault: false, useImmutableSubject: true },
    { useDefault: true, useImmutableSubject: false }
  ])(
    "does not warn for subject config $useDefault/$useImmutableSubject",
    (subjectConfig) => {
      expect(
        findLegacyMutableCredentialName(
          { ...immutable, subjectConfig },
          "environment:prod",
          new Map([
            [
              "github-octo-org-octo-repo-prod-mutable",
              "repo:octo-org/octo-repo:environment:prod"
            ]
          ])
        )
      ).toBeUndefined();
    }
  );

  it("does not warn when no existing credential matches the mutable subject", () => {
    expect(
      findLegacyMutableCredentialName(
        immutable,
        "environment:prod",
        new Map([
          [
            "github-octo-org-octo-repo-prod-immutable",
            "repo:octo-org@111/octo-repo@222:environment:prod"
          ]
        ])
      )
    ).toBeUndefined();
  });
});

describe("resolveOidcSubject", () => {
  const opts = { sleepFn: async () => {} };

  it("creates BOTH mutable and immutable default FICs when the endpoint 404s", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: false,
        status: 404,
        json: null,
        stderr: "Not Found (HTTP 404)"
      }
    });

    const res = await resolveOidcSubject(
      {
        targetRepo: "octo-org/octo-repo",
        envName: "dev",
        suffix: "environment:dev"
      },
      runner,
      opts
    );
    expect(res.federatedCredentials).toHaveLength(2);
    const bySubject = Object.fromEntries(
      res.federatedCredentials.map((f) => [f.name, f.subject])
    );
    expect(bySubject["github-octo-org-octo-repo-dev-mutable"]).toBe(
      "repo:octo-org/octo-repo:environment:dev"
    );
    expect(bySubject["github-octo-org-octo-repo-dev-immutable"]).toBe(
      "repo:octo-org@111/octo-repo@222:environment:dev"
    );
  });

  it("still creates both default forms even when the API says use_immutable_subject=false", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: true,
        status: 200,
        json: { use_default: true, use_immutable_subject: false }
      }
    });
    const res = await resolveOidcSubject(
      {
        targetRepo: "octo-org/octo-repo",
        envName: "prod",
        suffix: "environment:prod"
      },
      runner,
      opts
    );
    const subjects = res.federatedCredentials.map((f) => f.subject).sort();
    expect(subjects).toEqual([
      "repo:octo-org/octo-repo:environment:prod",
      "repo:octo-org@111/octo-repo@222:environment:prod"
    ]);
  });

  it("creates only the immutable default FIC when GitHub explicitly enables immutable subjects", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: true,
        status: 200,
        json: {
          use_default: true,
          use_immutable_subject: true,
          sub_claim_prefix: "repo:octo-org@111/octo-repo@222"
        }
      }
    });
    const res = await resolveOidcSubject(
      {
        targetRepo: "octo-org/octo-repo",
        envName: "prod",
        suffix: "environment:prod"
      },
      runner,
      opts
    );
    expect(res.federatedCredentials).toEqual([
      {
        name: "github-octo-org-octo-repo-prod-immutable",
        subject: "repo:octo-org@111/octo-repo@222:environment:prod"
      }
    ]);
  });

  it("creates both default FICs when a successful response omits immutable fields", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: true,
        status: 200,
        json: { use_default: true }
      }
    });
    const res = await resolveOidcSubject(
      {
        targetRepo: "octo-org/octo-repo",
        envName: "prod",
        suffix: "environment:prod"
      },
      runner,
      opts
    );
    expect(res.federatedCredentials).toEqual([
      {
        name: "github-octo-org-octo-repo-prod-mutable",
        subject: "repo:octo-org/octo-repo:environment:prod"
      },
      {
        name: "github-octo-org-octo-repo-prod-immutable",
        subject: "repo:octo-org@111/octo-repo@222:environment:prod"
      }
    ]);
  });

  it("treats an exact immutable default prefix as proven immutable", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: true,
        status: 200,
        json: {
          use_default: true,
          sub_claim_prefix: "repo:octo-org@111/octo-repo@222"
        }
      }
    });

    const res = await resolveOidcSubject(
      {
        targetRepo: "octo-org/octo-repo",
        envName: "prod",
        suffix: "environment:prod"
      },
      runner,
      opts
    );
    expect(res.federatedCredentials).toEqual([
      {
        name: "github-octo-org-octo-repo-prod-immutable",
        subject: "repo:octo-org@111/octo-repo@222:environment:prod"
      }
    ]);
  });

  it("normalizes a canonical immutable prefix without repo:", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: true,
        status: 200,
        json: {
          use_default: true,
          sub_claim_prefix: "octo-org@111/octo-repo@222"
        }
      }
    });

    const res = await resolveOidcSubject(
      {
        targetRepo: "octo-org/octo-repo",
        envName: "prod",
        suffix: "environment:prod"
      },
      runner,
      opts
    );
    expect(res.federatedCredentials).toEqual([
      {
        name: "github-octo-org-octo-repo-prod-immutable",
        subject: "repo:octo-org@111/octo-repo@222:environment:prod"
      }
    ]);
  });

  it("matches a canonical immutable default prefix case-insensitively", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: true,
        status: 200,
        json: {
          use_default: true,
          sub_claim_prefix: "repo:OCTO-ORG@111/OCTO-REPO@222"
        }
      }
    });
    const res = await resolveOidcSubject(
      {
        targetRepo: "octo-org/octo-repo",
        envName: "prod",
        suffix: "environment:prod"
      },
      runner,
      opts
    );
    expect(res.federatedCredentials).toHaveLength(1);
    expect(res.subjectConfig.useImmutableSubject).toBe(true);
  });

  it.each(["repo:octo-org/octo-repo", "repo:team@corp/octo-repo"])(
    "keeps both default FICs for an unverified prefix %s",
    async (prefix) => {
      const runner = makeRunner({
        "/repos/octo-org/octo-repo": REPO_OK,
        "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
          ok: true,
          status: 200,
          json: { use_default: true, sub_claim_prefix: prefix }
        }
      });
      const res = await resolveOidcSubject(
        {
          targetRepo: "octo-org/octo-repo",
          envName: "prod",
          suffix: "environment:prod"
        },
        runner,
        opts
      );
      expect(res.federatedCredentials.map((fic) => fic.subject).sort()).toEqual(
        [
          "repo:octo-org/octo-repo:environment:prod",
          "repo:octo-org@111/octo-repo@222:environment:prod"
        ]
      );
      expect(res.subjectConfig.useImmutableSubject).toBe(
        prefix.includes("@") ? undefined : false
      );
    }
  );

  it("builds a single custom subject from include_claim_keys", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: true,
        status: 200,
        json: {
          use_default: false,
          use_immutable_subject: false,
          include_claim_keys: ["repository", "repository_id", "context"]
        }
      }
    });
    const res = await resolveOidcSubject(
      {
        targetRepo: "octo-org/octo-repo",
        envName: "dev",
        suffix: "environment:dev"
      },
      runner,
      opts
    );
    expect(res.federatedCredentials).toHaveLength(1);
    expect(res.federatedCredentials[0].subject).toBe(
      "repository:octo-org/octo-repo:repository_id:222:environment:dev"
    );
    expect(res.federatedCredentials[0].name).toBe(
      "github-octo-org-octo-repo-dev"
    );
  });

  it("builds the immutable form for a custom repository key when immutable", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: true,
        status: 200,
        json: {
          use_default: false,
          use_immutable_subject: true,
          include_claim_keys: ["repository", "context"]
        }
      }
    });

    const res = await resolveOidcSubject(
      {
        targetRepo: "octo-org/octo-repo",
        envName: "dev",
        suffix: "environment:dev"
      },
      runner,
      opts
    );
    expect(res.federatedCredentials[0].subject).toBe(
      "repository:octo-org@111/octo-repo@222:environment:dev"
    );
  });

  it("infers a custom repository subject is mutable from a name-only prefix", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: true,
        status: 200,
        json: {
          use_default: false,
          include_claim_keys: ["repository", "context"],
          sub_claim_prefix: "repo:octo-org/octo-repo"
        }
      }
    });
    const res = await resolveOidcSubject(
      {
        targetRepo: "octo-org/octo-repo",
        envName: "dev",
        suffix: "environment:dev"
      },
      runner,
      opts
    );
    expect(res.federatedCredentials[0].subject).toBe(
      "repository:octo-org/octo-repo:environment:dev"
    );
  });

  it("prefers sub_claim_prefix for a custom immutable repository key", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: true,
        status: 200,
        json: {
          use_default: false,
          include_claim_keys: ["repository"],
          sub_claim_prefix: "repository:octo-org@9/octo-repo@8"
        }
      }
    });
    const res = await resolveOidcSubject(
      {
        targetRepo: "octo-org/octo-repo",
        envName: "dev",
        suffix: "environment:dev"
      },
      runner,
      opts
    );
    expect(res.federatedCredentials[0].subject).toBe(
      "repository:octo-org@9/octo-repo@8"
    );
  });

  it("uses the canonical full_name from the API, not the user casing", async () => {
    const runner = makeRunner({
      "/repos/Octo-Org/Octo-Repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: false,
        status: 404,
        json: null,
        stderr: "Not Found (HTTP 404)"
      }
    });
    const res = await resolveOidcSubject(
      {
        targetRepo: "Octo-Org/Octo-Repo",
        envName: "dev",
        suffix: "environment:dev"
      },
      runner,
      opts
    );
    expect(res.fullName).toBe("octo-org/octo-repo");
    expect(
      res.federatedCredentials.every(
        (f) =>
          f.subject.includes("octo-org/octo-repo") ||
          f.subject.includes("octo-org@111")
      )
    ).toBe(true);
  });

  it("throws on an invalid repo slug before any network call", async () => {
    const runner = vi.fn();
    await expect(
      resolveOidcSubject(
        { targetRepo: "bad", envName: "dev", suffix: "environment:dev" },
        runner,
        opts
      )
    ).rejects.toThrow(/owner\/repo/);
    expect(runner).not.toHaveBeenCalled();
  });

  it("fails when the repo itself cannot be read (no silent default)", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": {
        ok: false,
        status: 403,
        json: null,
        stderr: "Forbidden (HTTP 403)"
      }
    });
    await expect(
      resolveOidcSubject(
        {
          targetRepo: "octo-org/octo-repo",
          envName: "dev",
          suffix: "environment:dev"
        },
        runner,
        opts
      )
    ).rejects.toThrow(/Could not read repository/);
  });

  it("fails on a non-404 customization error rather than defaulting", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: false,
        status: 403,
        json: null,
        stderr: "Forbidden (HTTP 403)"
      }
    });
    await expect(
      resolveOidcSubject(
        {
          targetRepo: "octo-org/octo-repo",
          envName: "dev",
          suffix: "environment:dev"
        },
        runner,
        opts
      )
    ).rejects.toThrow(/customization/i);
  });

  it("fails closed on a malformed customization 200 body (no boolean use_default)", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: true,
        status: 200,
        json: { include_claim_keys: ["repository"] }
      }
    });
    await expect(
      resolveOidcSubject(
        {
          targetRepo: "octo-org/octo-repo",
          envName: "dev",
          suffix: "environment:dev"
        },
        runner,
        opts
      )
    ).rejects.toThrow(/use_default/);
  });

  it("fails closed when the repo returns non-positive numeric ids", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": {
        ok: true,
        status: 200,
        json: { full_name: "octo-org/octo-repo", id: 0, owner: { id: 111 } }
      }
    });
    await expect(
      resolveOidcSubject(
        {
          targetRepo: "octo-org/octo-repo",
          envName: "dev",
          suffix: "environment:dev"
        },
        runner,
        opts
      )
    ).rejects.toThrow(/reliable OIDC subject/);
  });

  it("propagates an unknown-claim-key error from the pure builder", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: true,
        status: 200,
        json: { use_default: false, include_claim_keys: ["job_workflow_ref"] }
      }
    });
    await expect(
      resolveOidcSubject(
        {
          targetRepo: "octo-org/octo-repo",
          envName: "dev",
          suffix: "environment:dev"
        },
        runner,
        opts
      )
    ).rejects.toThrow(/job_workflow_ref/);
  });

  it("reads /repos before the customization endpoint", async () => {
    const calls: string[] = [];
    const runner = vi.fn(async (p: string) => {
      calls.push(p);
      if (p === "/repos/octo-org/octo-repo") return REPO_OK;
      return {
        ok: false,
        status: 404,
        json: null,
        stderr: "Not Found (HTTP 404)"
      };
    });
    await resolveOidcSubject(
      {
        targetRepo: "octo-org/octo-repo",
        envName: "dev",
        suffix: "environment:dev"
      },
      runner,
      opts
    );
    expect(calls[0]).toBe("/repos/octo-org/octo-repo");
    expect(calls[1]).toBe(
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub"
    );
  });
});

describe("selectMissingFederatedCredentials", () => {
  const desired = [
    { name: "a-mutable", subject: "repo:o/r:environment:dev" },
    { name: "a-immutable", subject: "repo:o@1/r@2:environment:dev" }
  ];

  it("returns all when none exist", () => {
    expect(selectMissingFederatedCredentials(desired, [])).toEqual(desired);
  });

  it("skips subjects that already exist (match by subject, not name)", () => {
    const out = selectMissingFederatedCredentials(desired, [
      "repo:o/r:environment:dev"
    ]);
    expect(out).toEqual([desired[1]]);
  });

  it("returns empty when all subjects exist", () => {
    const out = selectMissingFederatedCredentials(desired, [
      "  repo:o/r:environment:dev  ",
      "repo:o@1/r@2:environment:dev"
    ]);
    expect(out).toEqual([]);
  });

  it("ignores non-string existing entries", () => {
    const out = selectMissingFederatedCredentials(desired, [
      null,
      42,
      "repo:o/r:environment:dev"
    ]);
    expect(out).toEqual([desired[1]]);
  });
});

describe("decideExistingClientId", () => {
  it("falls through when clientId is empty", () => {
    expect(
      decideExistingClientId({ clientId: "", showStatus: "found", owned: true })
    ).toEqual({ action: "fallthrough" });
    expect(decideExistingClientId({})).toEqual({ action: "fallthrough" });
  });

  it("reuses when the wired app exists and is owned", () => {
    expect(
      decideExistingClientId({
        clientId: "abc",
        showStatus: "found",
        owned: true
      })
    ).toEqual({ action: "reuse" });
  });

  it("reports that the current signed-in user is not listed as an owner", () => {
    const result = decideExistingClientId({
      clientId: "abc",
      showStatus: "found",
      owned: false
    });
    expect(result).toMatchObject({
      action: "error",
      code: "app-registration-not-owned"
    });
    expect(result.reason).toContain(
      "The current signed-in user is not listed as one of this App Registration's owners."
    );
  });

  it("surfaces Radius-orphan guidance for an unowned AZURE_CLIENT_ID app whose tags match", () => {
    const result = decideExistingClientId({
      clientId: "abc",
      showStatus: "found",
      owned: false,
      radiusProvenance: {
        tags: [
          "radius-managed",
          "radius-repo:octo-org/octo-repo",
          "radius-environment:dev"
        ],
        repo: "octo-org/octo-repo",
        environment: "dev"
      }
    });
    expect(result).toMatchObject({
      action: "error",
      code: "app-registration-radius-orphaned",
      radiusOrphan: true
    });
    expect(result.reason).toContain("current signed-in user is not listed");
    expect(result.reason).toContain("clean it up manually");
  });

  it("falls through when the wired app is not found (stale variable)", () => {
    expect(
      decideExistingClientId({ clientId: "abc", showStatus: "not-found" })
    ).toEqual({ action: "fallthrough" });
  });

  it("is fatal client-id-lookup-failed on a real lookup failure", () => {
    expect(
      decideExistingClientId({ clientId: "abc", showStatus: "lookup-failed" })
    ).toEqual({
      action: "fatal",
      code: "client-id-lookup-failed"
    });
  });

  it("treats an unknown status conservatively as a fatal lookup failure", () => {
    expect(
      decideExistingClientId({ clientId: "abc", showStatus: "weird" })
    ).toEqual({
      action: "fatal",
      code: "client-id-lookup-failed"
    });
  });
});

describe("isAzResourceNotFound", () => {
  // TRUE → 'not-found' → Step 3a fallthrough to the name lookup.
  it("matches the canonical Graph resource-not-found phrase", () => {
    expect(
      isAzResourceNotFound(
        "Resource '00000000-0000-0000-0000-000000000000' does not exist or one of its queried reference-property objects are not present."
      )
    ).toBe(true);
  });

  it("matches the Request_ResourceNotFound error code", () => {
    expect(
      isAzResourceNotFound(
        "(Request_ResourceNotFound) The resource could not be located."
      )
    ).toBe(true);
  });

  // FALSE → 'lookup-failed' → decideExistingClientId → fatal client-id-lookup-failed.
  // A broad /not found/ would misclassify these as stale and let Step 3b create
  // a duplicate app — the tenant-sprawl bug this feature exists to prevent.
  it("does NOT match AADSTS auth failures (must fail closed)", () => {
    expect(
      isAzResourceNotFound(
        "AADSTS500011: The resource principal named api://foo was not found in the tenant named Contoso."
      )
    ).toBe(false);
  });

  it("does NOT match MSAL/token-cache 'not found' messages", () => {
    expect(
      isAzResourceNotFound(
        "No token found in cache. Interactive authentication is required."
      )
    ).toBe(false);
    expect(isAzResourceNotFound("Token was not found in the cache")).toBe(
      false
    );
  });

  it("does NOT match throttling / 429 messages", () => {
    expect(
      isAzResourceNotFound(
        "TooManyRequests: Request was throttled (HTTP 429). Retry after 30s."
      )
    ).toBe(false);
  });

  it("does NOT match Conditional Access / interactive-auth-required messages", () => {
    expect(
      isAzResourceNotFound(
        "AADSTS53003: Access has been blocked by Conditional Access policies. Interactive authentication is needed."
      )
    ).toBe(false);
  });

  it("does NOT match a malformed-guid error", () => {
    expect(
      isAzResourceNotFound("The value 'not-a-guid' is not a valid GUID.")
    ).toBe(false);
  });

  it("does NOT match bare 'not found' / 'was not found' / 'does not exist'", () => {
    expect(isAzResourceNotFound("Not Found (HTTP 404)")).toBe(false);
    expect(
      isAzResourceNotFound("The application was not found in the directory")
    ).toBe(false);
    expect(isAzResourceNotFound("Resource does not exist")).toBe(false);
  });

  it("does not match unrelated / empty input", () => {
    expect(isAzResourceNotFound("AADSTS500011: insufficient privileges")).toBe(
      false
    );
    expect(isAzResourceNotFound("")).toBe(false);
    expect(isAzResourceNotFound(undefined)).toBe(false);
  });
});

describe("discoverStatusText", () => {
  it("azure: summarizes counts on success", () => {
    expect(
      discoverStatusText({ clusters: [1, 2], resourceGroups: [1] }, "azure")
    ).toBe("Found 2 cluster(s), 1 resource group(s)");
  });

  it("azure: prefers the resourceGroups error over a clusters error", () => {
    expect(
      discoverStatusText(
        {
          clusters: [],
          resourceGroups: [],
          errors: { clusters: "aks boom", resourceGroups: "rg boom" }
        },
        "azure"
      )
    ).toBe("Discovery failed: rg boom");
  });

  it("azure: surfaces a clusters error when only that failed", () => {
    expect(
      discoverStatusText(
        {
          clusters: [],
          resourceGroups: [{}],
          errors: { clusters: "token not acquirable" }
        },
        "azure"
      )
    ).toBe("Discovery failed: token not acquirable");
  });

  it("azure: surfaces a namespace error when resource enumeration succeeded", () => {
    expect(
      discoverStatusText(
        {
          clusters: [{}],
          resourceGroups: [{}],
          errors: { namespaces: "selected cluster unavailable" }
        },
        "azure"
      )
    ).toBe("Discovery failed: selected cluster unavailable");
  });

  it("azure: top-level error wins", () => {
    expect(
      discoverStatusText(
        { error: "outer fail", errors: { resourceGroups: "inner" } },
        "azure"
      )
    ).toBe("Discovery failed: outer fail");
  });

  it("aws: summarizes counts on success", () => {
    expect(discoverStatusText({ clusters: [1], vpcs: [1, 2, 3] }, "aws")).toBe(
      "Found 1 cluster(s), 3 VPC(s)"
    );
  });

  it("aws: prefers the vpcs error", () => {
    expect(
      discoverStatusText(
        {
          clusters: [],
          vpcs: [],
          subnets: [],
          errors: {
            clusters: "eks boom",
            vpcs: "vpc boom",
            subnets: "subnet boom"
          }
        },
        "aws"
      )
    ).toBe("Discovery failed: vpc boom");
  });

  it("defaults to azure summary with empty input", () => {
    expect(discoverStatusText()).toBe(
      "Found 0 cluster(s), 0 resource group(s)"
    );
  });
});

describe("decideAppSelection", () => {
  const A = {
    appId: "aaa",
    displayName: "radius-deploy-o-r",
    createdDateTime: "2020-01-01T00:00:00Z"
  };
  const B = {
    appId: "bbb",
    displayName: "radius-deploy-o-r",
    createdDateTime: "2022-01-01T00:00:00Z"
  };

  it("creates when there are no matches at all", () => {
    expect(
      decideAppSelection({ ownedMatches: [], hasUnownedMatch: false })
    ).toEqual({ action: "create" });
  });

  it("errors app-registration-not-owned when the only match is unowned", () => {
    const r = decideAppSelection({ ownedMatches: [], hasUnownedMatch: true });
    expect(r.action).toBe("error");
    expect(r.code).toBe("app-registration-not-owned");
    expect(r.reason).toContain("current signed-in user is not listed");
  });

  it("reuses the single owned match", () => {
    expect(decideAppSelection({ ownedMatches: [A] })).toMatchObject({
      action: "reuse",
      appId: "aaa",
      duplicates: false
    });
  });

  it("returns needs-selection with the oldest as default when >1 owned and no choice", () => {
    const r = decideAppSelection({ ownedMatches: [B, A] });
    expect(r.action).toBe("needs-selection");
    expect(r.defaultAppId).toBe("aaa"); // A is older
    expect(r.candidates?.map((c) => c.appId)).toEqual(["bbb", "aaa"]);
    expect(r.candidates?.[0]).toHaveProperty("displayName");
  });

  it("needs-selection default prefers the wired existingClientId among owned", () => {
    const r = decideAppSelection({
      ownedMatches: [B, A],
      existingClientId: "BBB"
    });
    expect(r.action).toBe("needs-selection");
    expect(r.defaultAppId).toBe("bbb");
  });

  it("createNew short-circuits to create even with owned matches", () => {
    expect(
      decideAppSelection({ ownedMatches: [A, B], createNew: true })
    ).toEqual({ action: "create" });
  });

  it("reuses an explicitAppId that is among the owned candidates", () => {
    expect(
      decideAppSelection({ ownedMatches: [A, B], explicitAppId: "bbb" })
    ).toEqual({ action: "reuse", appId: "bbb" });
  });

  it("errors when explicitAppId is not among the owned candidates", () => {
    const r = decideAppSelection({ ownedMatches: [A], explicitAppId: "zzz" });
    expect(r.action).toBe("error");
    expect(r.code).toBe("app-registration-not-owned");
    expect(r.reason).toContain("current signed-in user is not listed");
  });

  it("surfaces Radius-orphan guidance when an explicit unowned app matches Radius provenance", () => {
    const r = decideAppSelection({
      ownedMatches: [A],
      explicitAppId: "zzz",
      radiusProvenance: {
        tags: [
          "radius-managed",
          "radius-repo:octo-org/octo-repo",
          "radius-environment:dev"
        ],
        repo: "octo-org/octo-repo",
        environment: "dev"
      }
    });
    expect(r.action).toBe("error");
    expect(r.code).toBe("app-registration-radius-orphaned");
    expect(r.radiusOrphan).toBe(true);
    expect(r.reason).toContain("clean it up manually");
  });

  it("explicitAppId takes precedence over createNew", () => {
    expect(
      decideAppSelection({
        ownedMatches: [A],
        explicitAppId: "aaa",
        createNew: true
      })
    ).toEqual({ action: "reuse", appId: "aaa" });
  });

  it("preserves reuse for an owned app even if Radius tags are present", () => {
    expect(
      decideAppSelection({
        ownedMatches: [A],
        radiusProvenance: {
          tags: [
            "radius-managed",
            "radius-repo:octo-org/octo-repo",
            "radius-environment:dev"
          ],
          repo: "octo-org/octo-repo",
          environment: "dev"
        }
      })
    ).toEqual({ action: "reuse", appId: "aaa", duplicates: false });
  });

  it("reuses the owned tagged app and only creates the missing subject on the retry path", () => {
    expect(
      decideAppSelection({
        ownedMatches: [A],
        radiusProvenance: {
          tags: [
            "radius-managed",
            "radius-repo:octo-org/octo-repo",
            "radius-environment:dev",
            "radius-operation:op_prior"
          ],
          repo: "octo-org/octo-repo",
          environment: "dev"
        }
      })
    ).toEqual({ action: "reuse", appId: "aaa", duplicates: false });

    expect(
      selectMissingFederatedCredentials(
        [
          {
            name: "radius-dev",
            subject: "repo:octo-org/octo-repo:environment:dev"
          },
          {
            name: "radius-dev-immutable",
            subject: "repo:octo-org@111/octo-repo@222:environment:dev"
          }
        ],
        ["repo:octo-org/octo-repo:environment:dev"]
      )
    ).toEqual([
      {
        name: "radius-dev-immutable",
        subject: "repo:octo-org@111/octo-repo@222:environment:dev"
      }
    ]);
  });

  it("reports a Radius-orphaned app with manual cleanup guidance when unowned", () => {
    const r = decideAppSelection({
      ownedMatches: [],
      hasUnownedMatch: true,
      radiusProvenance: {
        tags: [
          "radius-managed",
          "radius-repo:octo-org/octo-repo",
          "radius-environment:dev"
        ],
        repo: "octo-org/octo-repo",
        environment: "dev"
      }
    });
    expect(r.action).toBe("error");
    expect(r.code).toBe("app-registration-radius-orphaned");
    expect(r.radiusOrphan).toBe(true);
    expect(r.reason).toBeDefined();
    expect(r.reason!.toLowerCase()).toContain(
      "current signed-in user is not listed as one of its owners"
    );
    expect(r.reason).toContain("orphaned");
    expect(r.reason).toContain("manual");
  });

  it("uses the precise not-listed-as-owner language for ordinary unowned apps", () => {
    const r = decideAppSelection({ ownedMatches: [], hasUnownedMatch: true });
    expect(r.action).toBe("error");
    expect(r.code).toBe("app-registration-not-owned");
    expect(r.reason).toBeDefined();
    expect(r.reason!.toLowerCase()).toContain(
      "current signed-in user is not listed as one of this app registration's owners"
    );
    expect(r.reason).not.toContain("another user");
  });
});

describe("Radius provenance ownership decisions", () => {
  it("parses Radius provenance tags into repo/environment metadata", () => {
    expect(
      parseRadiusAppProvenanceTags([
        "radius-managed",
        "radius-repo:octo-org/octo-repo",
        "radius-environment:dev",
        "radius-operation:op_123",
        "radius-managed"
      ])
    ).toEqual({
      managed: true,
      repo: "octo-org/octo-repo",
      environment: "dev",
      operationId: "op_123"
    });
  });

  it("reuses any owned app regardless of Radius provenance", () => {
    expect(
      decideRadiusAppOwnership({
        ownedBySignedInUser: true,
        radiusProvenance: {
          tags: [
            "radius-managed",
            "radius-repo:octo-org/octo-repo",
            "radius-environment:dev"
          ],
          repo: "octo-org/octo-repo",
          environment: "dev"
        }
      })
    ).toEqual({ action: "reuse" });
  });

  it("returns the orphaned cleanup guidance for same-repo/environment Radius apps", () => {
    const r = decideRadiusAppOwnership({
      ownedBySignedInUser: false,
      radiusProvenance: {
        tags: [
          "radius-managed",
          "radius-repo:octo-org/octo-repo",
          "radius-environment:dev"
        ],
        repo: "octo-org/octo-repo",
        environment: "dev"
      }
    });
    expect(r.action).toBe("error");
    expect(r.code).toBe("app-registration-radius-orphaned");
    expect(r.radiusOrphan).toBe(true);
    expect(r.reason).toContain("current signed-in user is not listed");
    expect(r.reason).toContain("orphaned");
    expect(r.reason).toContain("manual");
  });

  // The same predicate also answers "why is this reused application being
  // kept", so it is pinned directly rather than only through the orphan path.
  it.each([
    [
      "the repository and environment both match",
      [
        "radius-managed",
        "radius-repo:octo-org/octo-repo",
        "radius-environment:dev"
      ],
      true
    ],
    [
      "the tags name a different environment",
      [
        "radius-managed",
        "radius-repo:octo-org/octo-repo",
        "radius-environment:prod"
      ],
      false
    ],
    [
      "the tags name a different repository",
      [
        "radius-managed",
        "radius-repo:octo-org/other",
        "radius-environment:dev"
      ],
      false
    ],
    [
      "the managed marker is missing",
      ["radius-repo:octo-org/octo-repo", "radius-environment:dev"],
      false
    ],
    ["there are no tags at all", [], false]
  ])("reports Radius provenance as %s -> %s", (_label, tags, expected) => {
    expect(
      isRadiusProvenanceMatch({
        tags,
        repo: "octo-org/octo-repo",
        environment: "dev"
      })
    ).toBe(expected);
  });

  it("claims no provenance without an expected repository and environment", () => {
    expect(
      isRadiusProvenanceMatch({
        tags: [
          "radius-managed",
          "radius-repo:octo-org/octo-repo",
          "radius-environment:dev"
        ]
      })
    ).toBe(false);
    expect(isRadiusProvenanceMatch()).toBe(false);
  });
});

describe("parseServedReposFromSubjects", () => {
  it("extracts sorted unique owner/repo from mixed subjects", () => {
    const out = parseServedReposFromSubjects([
      "repo:octo/api:ref:refs/heads/main",
      "repo:octo/api:environment:prod",
      "repo:octo/web:pull_request"
    ]);
    expect(out).toEqual(["octo/api", "octo/web"]);
  });

  it("strips the immutable @id suffixes", () => {
    const out = parseServedReposFromSubjects([
      "repo:octo@123/api@456:environment:prod"
    ]);
    expect(out).toEqual(["octo/api"]);
  });

  it("accepts the customized 'repository:' subject prefix (mutable and immutable)", () => {
    const out = parseServedReposFromSubjects([
      "repository:octo/api:environment:prod",
      "repository:octo@123/web@456:ref:refs/heads/main"
    ]);
    expect(out).toEqual(["octo/api", "octo/web"]);
  });

  it("does not treat repository_id/repository_owner claim keys as a repo slug", () => {
    const out = parseServedReposFromSubjects([
      "repository_id:456789:ref:refs/heads/main",
      "repository_owner:octo:environment:prod"
    ]);
    expect(out).toEqual([]);
  });

  it("ignores malformed / non-string entries", () => {
    const out = parseServedReposFromSubjects([
      null,
      42,
      "not-a-subject",
      "repo:onlyowner",
      "repo:a/b/c:x",
      "repo:good/repo:ref:x"
    ]);
    expect(out).toEqual(["good/repo"]);
  });

  it("returns [] for empty/undefined input", () => {
    expect(parseServedReposFromSubjects()).toEqual([]);
    expect(parseServedReposFromSubjects([])).toEqual([]);
  });
});

describe("formatServesReposLabel", () => {
  it("returns empty string for no repos", () => {
    expect(formatServesReposLabel([])).toBe("");
    expect(formatServesReposLabel(undefined)).toBe("");
    expect(formatServesReposLabel(null)).toBe("");
  });

  it("lists up to three repos inline", () => {
    expect(formatServesReposLabel(["a/b"])).toBe("Serves: a/b");
    expect(formatServesReposLabel(["a/b", "c/d", "e/f"])).toBe(
      "Serves: a/b, c/d, e/f"
    );
  });

  it("truncates with a +N more suffix past three", () => {
    expect(formatServesReposLabel(["a/b", "c/d", "e/f", "g/h", "i/j"])).toBe(
      "Serves: a/b, c/d, e/f +2 more"
    );
  });
});

describe("validateAppRegistrationName", () => {
  it("accepts a normal derived name and trims", () => {
    expect(validateAppRegistrationName("  radius-deploy-octo-api  ")).toEqual({
      ok: true,
      name: "radius-deploy-octo-api"
    });
  });

  it("accepts allowed punctuation and spaces", () => {
    expect(validateAppRegistrationName("My App (deploy) _v1.2-3")).toEqual({
      ok: true,
      name: "My App (deploy) _v1.2-3"
    });
  });

  it("rejects empty / whitespace-only", () => {
    expect(validateAppRegistrationName("   ").ok).toBe(false);
    expect(validateAppRegistrationName("").ok).toBe(false);
  });

  it("rejects >120 chars", () => {
    expect(validateAppRegistrationName("a".repeat(121)).ok).toBe(false);
    expect(validateAppRegistrationName("a".repeat(120)).ok).toBe(true);
  });

  it("rejects disallowed characters", () => {
    expect(validateAppRegistrationName("bad/name").ok).toBe(false);
    expect(validateAppRegistrationName("bad&name").ok).toBe(false);
    expect(validateAppRegistrationName("emoji😀").ok).toBe(false);
  });

  it("rejects control characters", () => {
    expect(validateAppRegistrationName("bad\u0000name").ok).toBe(false);
    expect(validateAppRegistrationName("bad\tname").ok).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(validateAppRegistrationName(undefined).ok).toBe(false);
    expect(validateAppRegistrationName(123).ok).toBe(false);
  });

  // The server validates the FINAL effective name — whether user-supplied or the
  // derived `radius-deploy-<owner>-<repo>` default — so a pathologically long
  // owner/repo that blows past Entra's 120-char limit is rejected up front
  // instead of failing opaquely inside `az ad app create`.
  it("rejects an over-long derived radius-deploy name", () => {
    const derived = "radius-deploy-" + "o".repeat(60) + "-" + "r".repeat(60);
    expect(derived.length).toBeGreaterThan(120);
    expect(validateAppRegistrationName(derived).ok).toBe(false);
  });

  it("accepts a normal derived radius-deploy name", () => {
    expect(validateAppRegistrationName("radius-deploy-octo-app")).toEqual({
      ok: true,
      name: "radius-deploy-octo-app"
    });
  });
});
