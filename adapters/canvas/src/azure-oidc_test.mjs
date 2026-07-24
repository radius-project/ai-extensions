import { describe, expect, it, vi } from "vitest";
import {
  isUuid,
  isValidRepoSlug,
  isAksClusterName,
  isResourceGroupName,
  buildAppCreateArgs,
  isServiceManagementReferenceError,
  fetchGitHubJson,
  resolveOidcSubject,
  selectAppRegistration,
  selectMissingFederatedCredentials,
} from "./azure-oidc.mjs";

const UUID = "11111111-2222-3333-4444-555555555555";

// A runner that maps apiPath -> a canned { ok, status, json, stderr } response.
function makeRunner(map) {
  return vi.fn(async (apiPath) => {
    if (typeof map[apiPath] === "function") return map[apiPath]();
    if (map[apiPath]) return map[apiPath];
    return { ok: false, status: 404, json: null, stderr: "Not Found (HTTP 404)" };
  });
}

const REPO_OK = {
  ok: true,
  status: 200,
  json: { full_name: "octo-org/octo-repo", id: 222, owner: { id: 111 } },
  stderr: "",
};

describe("validators", () => {
  it("isUuid accepts a canonical UUID and rejects junk", () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
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
      "ad", "app", "create",
      "--display-name", "radius-deploy-o-r",
      "--query", "appId", "-o", "tsv",
    ]);
    expect(args).not.toContain("--service-management-reference");
  });

  it("appends the SMR flag when provided", () => {
    const args = buildAppCreateArgs({ appName: "x", serviceManagementReference: UUID });
    const i = args.indexOf("--service-management-reference");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe(UUID);
  });
});

describe("isServiceManagementReferenceError", () => {
  it("detects the known error identifiers case-insensitively", () => {
    expect(isServiceManagementReferenceError("ServiceManagementReference field is required")).toBe(true);
    expect(isServiceManagementReferenceError("error: SERVICETREENULLVALUEPROVIDED")).toBe(true);
    expect(isServiceManagementReferenceError("ServiceTreeInvalid: bad guid")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isServiceManagementReferenceError("Insufficient privileges to complete the operation")).toBe(false);
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
    expect(res.ok).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("retries on 429 up to the cap then returns the last failure", async () => {
    const runner = vi.fn().mockResolvedValue({ ok: false, status: 429, stderr: "rate" });
    const res = await fetchGitHubJson(runner, "/x", { retries: 3, ...noSleep });
    expect(res.ok).toBe(false);
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 404", async () => {
    const runner = vi.fn().mockResolvedValue({ ok: false, status: 404, stderr: "nf" });
    const res = await fetchGitHubJson(runner, "/x", noSleep);
    expect(res.status).toBe(404);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("retries on a transport error (null status)", async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: null, stderr: "ECONNRESET" })
      .mockResolvedValueOnce({ ok: true, status: 200, json: {} });
    const res = await fetchGitHubJson(runner, "/x", noSleep);
    expect(res.ok).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
  });
});

describe("resolveOidcSubject", () => {
  const opts = { sleepFn: async () => {} };

  it("creates BOTH mutable and immutable default FICs when the endpoint 404s", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: false, status: 404, json: null, stderr: "Not Found (HTTP 404)",
      },
    });
    const res = await resolveOidcSubject(
      { targetRepo: "octo-org/octo-repo", envName: "dev", suffix: "environment:dev" },
      runner, opts,
    );
    expect(res.federatedCredentials).toHaveLength(2);
    const bySubject = Object.fromEntries(res.federatedCredentials.map((f) => [f.name, f.subject]));
    expect(bySubject["github-octo-org-octo-repo-dev-mutable"]).toBe("repo:octo-org/octo-repo:environment:dev");
    expect(bySubject["github-octo-org-octo-repo-dev-immutable"]).toBe("repo:octo-org@111/octo-repo@222:environment:dev");
  });

  it("still creates both default forms even when the API says use_immutable_subject=false", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: true, status: 200, json: { use_default: true, use_immutable_subject: false },
      },
    });
    const res = await resolveOidcSubject(
      { targetRepo: "octo-org/octo-repo", envName: "prod", suffix: "environment:prod" }, runner, opts,
    );
    const subjects = res.federatedCredentials.map((f) => f.subject).sort();
    expect(subjects).toEqual([
      "repo:octo-org/octo-repo:environment:prod",
      "repo:octo-org@111/octo-repo@222:environment:prod",
    ]);
  });

  it("builds a single custom subject from include_claim_keys", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: true, status: 200,
        json: { use_default: false, use_immutable_subject: false, include_claim_keys: ["repository", "repository_id", "context"] },
      },
    });
    const res = await resolveOidcSubject(
      { targetRepo: "octo-org/octo-repo", envName: "dev", suffix: "environment:dev" }, runner, opts,
    );
    expect(res.federatedCredentials).toHaveLength(1);
    expect(res.federatedCredentials[0].subject).toBe("repository:octo-org/octo-repo:repository_id:222:environment:dev");
    expect(res.federatedCredentials[0].name).toBe("github-octo-org-octo-repo-dev");
  });

  it("builds the immutable form for a custom repository key when immutable", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: true, status: 200,
        json: {
          use_default: false,
          use_immutable_subject: true,
          include_claim_keys: ["repository", "context"],
        },
      },
    });
    const res = await resolveOidcSubject(
      { targetRepo: "octo-org/octo-repo", envName: "dev", suffix: "environment:dev" }, runner, opts,
    );
    expect(res.federatedCredentials[0].subject).toBe("repository:octo-org@111/octo-repo@222:environment:dev");
  });

  it("prefers sub_claim_prefix for a custom immutable repository key", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: true, status: 200,
        json: {
          use_default: false,
          include_claim_keys: ["repository"],
          sub_claim_prefix: "repo:octo-org@9/octo-repo@8",
        },
      },
    });
    const res = await resolveOidcSubject(
      { targetRepo: "octo-org/octo-repo", envName: "dev", suffix: "environment:dev" }, runner, opts,
    );
    expect(res.federatedCredentials[0].subject).toBe("repository:octo-org@9/octo-repo@8");
  });

  it("uses the canonical full_name from the API, not the user casing", async () => {
    const runner = makeRunner({
      "/repos/Octo-Org/Octo-Repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: false, status: 404, json: null, stderr: "Not Found (HTTP 404)",
      },
    });
    const res = await resolveOidcSubject(
      { targetRepo: "Octo-Org/Octo-Repo", envName: "dev", suffix: "environment:dev" }, runner, opts,
    );
    expect(res.fullName).toBe("octo-org/octo-repo");
    expect(res.federatedCredentials.every((f) => f.subject.includes("octo-org/octo-repo") || f.subject.includes("octo-org@111"))).toBe(true);
  });

  it("throws on an invalid repo slug before any network call", async () => {
    const runner = vi.fn();
    await expect(
      resolveOidcSubject({ targetRepo: "bad", envName: "dev", suffix: "environment:dev" }, runner, opts),
    ).rejects.toThrow(/owner\/repo/);
    expect(runner).not.toHaveBeenCalled();
  });

  it("fails when the repo itself cannot be read (no silent default)", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": { ok: false, status: 403, json: null, stderr: "Forbidden (HTTP 403)" },
    });
    await expect(
      resolveOidcSubject({ targetRepo: "octo-org/octo-repo", envName: "dev", suffix: "environment:dev" }, runner, opts),
    ).rejects.toThrow(/Could not read repository/);
  });

  it("fails on a non-404 customization error rather than defaulting", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: false, status: 403, json: null, stderr: "Forbidden (HTTP 403)",
      },
    });
    await expect(
      resolveOidcSubject({ targetRepo: "octo-org/octo-repo", envName: "dev", suffix: "environment:dev" }, runner, opts),
    ).rejects.toThrow(/customization/i);
  });

  it("fails closed on a malformed customization 200 body (no boolean use_default)", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: true, status: 200, json: { include_claim_keys: ["repository"] },
      },
    });
    await expect(
      resolveOidcSubject({ targetRepo: "octo-org/octo-repo", envName: "dev", suffix: "environment:dev" }, runner, opts),
    ).rejects.toThrow(/use_default/);
  });

  it("fails closed when the repo returns non-positive numeric ids", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": {
        ok: true, status: 200, json: { full_name: "octo-org/octo-repo", id: 0, owner: { id: 111 } },
      },
    });
    await expect(
      resolveOidcSubject({ targetRepo: "octo-org/octo-repo", envName: "dev", suffix: "environment:dev" }, runner, opts),
    ).rejects.toThrow(/reliable OIDC subject/);
  });

  it("propagates an unknown-claim-key error from the pure builder", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: true, status: 200,
        json: { use_default: false, include_claim_keys: ["job_workflow_ref"] },
      },
    });
    await expect(
      resolveOidcSubject({ targetRepo: "octo-org/octo-repo", envName: "dev", suffix: "environment:dev" }, runner, opts),
    ).rejects.toThrow(/job_workflow_ref/);
  });

  it("reads /repos before the customization endpoint", async () => {
    const calls = [];
    const runner = vi.fn(async (p) => {
      calls.push(p);
      if (p === "/repos/octo-org/octo-repo") return REPO_OK;
      return { ok: false, status: 404, json: null, stderr: "Not Found (HTTP 404)" };
    });
    await resolveOidcSubject(
      { targetRepo: "octo-org/octo-repo", envName: "dev", suffix: "environment:dev" }, runner, opts,
    );
    expect(calls[0]).toBe("/repos/octo-org/octo-repo");
    expect(calls[1]).toBe("/repos/octo-org/octo-repo/actions/oidc/customization/sub");
  });
});

describe("selectAppRegistration", () => {
  it("creates when there are no matches at all", () => {
    expect(selectAppRegistration({ ownedMatches: [], hasUnownedMatch: false })).toEqual({ action: "create" });
  });

  it("errors app-registration-not-owned when the only match is unowned", () => {
    const r = selectAppRegistration({ ownedMatches: [], hasUnownedMatch: true });
    expect(r.action).toBe("error");
    expect(r.code).toBe("app-registration-not-owned");
    expect(r.reason).toMatch(/owned by another user/i);
  });

  it("reuses the single owned match", () => {
    const r = selectAppRegistration({ ownedMatches: [{ appId: "aaa" }], hasUnownedMatch: false });
    expect(r).toMatchObject({ action: "reuse", appId: "aaa", duplicates: false });
  });

  it("prefers the owned match equal to the existing AZURE_CLIENT_ID", () => {
    const owned = [
      { appId: "old", createdDateTime: "2020-01-01T00:00:00Z" },
      { appId: "wired", createdDateTime: "2023-01-01T00:00:00Z" },
    ];
    const r = selectAppRegistration({ ownedMatches: owned, existingClientId: "WIRED" });
    expect(r).toMatchObject({ action: "reuse", appId: "wired", duplicates: true });
    expect(r.reason).toMatch(/AZURE_CLIENT_ID/);
  });

  it("falls back to the oldest owned match when no existingClientId matches", () => {
    const owned = [
      { appId: "newer", createdDateTime: "2023-05-01T00:00:00Z" },
      { appId: "oldest", createdDateTime: "2019-02-01T00:00:00Z" },
      { appId: "mid", createdDateTime: "2021-01-01T00:00:00Z" },
    ];
    const r = selectAppRegistration({ ownedMatches: owned, existingClientId: "not-present" });
    expect(r).toMatchObject({ action: "reuse", appId: "oldest", duplicates: true });
    expect(r.reason).toMatch(/oldest/i);
  });

  it("treats missing createdDateTime as newest (never chosen over a dated one)", () => {
    const owned = [
      { appId: "undated" },
      { appId: "dated", createdDateTime: "2020-01-01T00:00:00Z" },
    ];
    const r = selectAppRegistration({ ownedMatches: owned });
    expect(r.appId).toBe("dated");
  });
});

describe("selectMissingFederatedCredentials", () => {
  const desired = [
    { name: "a-mutable", subject: "repo:o/r:environment:dev" },
    { name: "a-immutable", subject: "repo:o@1/r@2:environment:dev" },
  ];

  it("returns all when none exist", () => {
    expect(selectMissingFederatedCredentials(desired, [])).toEqual(desired);
  });

  it("skips subjects that already exist (match by subject, not name)", () => {
    const out = selectMissingFederatedCredentials(desired, ["repo:o/r:environment:dev"]);
    expect(out).toEqual([desired[1]]);
  });

  it("returns empty when all subjects exist", () => {
    const out = selectMissingFederatedCredentials(desired, [
      "  repo:o/r:environment:dev  ",
      "repo:o@1/r@2:environment:dev",
    ]);
    expect(out).toEqual([]);
  });

  it("ignores non-string existing entries", () => {
    const out = selectMissingFederatedCredentials(desired, [null, 42, "repo:o/r:environment:dev"]);
    expect(out).toEqual([desired[1]]);
  });
});
