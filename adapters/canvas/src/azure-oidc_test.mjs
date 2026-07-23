import { describe, expect, it, vi } from "vitest";
import {
  isUuid,
  isValidRepoSlug,
  isAzureName,
  buildAppCreateArgs,
  isServiceTreeError,
  fetchGitHubJson,
  resolveOidcSubject,
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

  it("isValidRepoSlug requires exactly owner/repo", () => {
    expect(isValidRepoSlug("octo-org/octo-repo")).toBe(true);
    expect(isValidRepoSlug("octo-org")).toBe(false);
    expect(isValidRepoSlug("a/b/c")).toBe(false);
    expect(isValidRepoSlug("/b")).toBe(false);
  });

  it("isAzureName rejects a leading dash and empty values", () => {
    expect(isAzureName("radius-rg")).toBe(true);
    expect(isAzureName("rg_1.name(2)")).toBe(true);
    expect(isAzureName("-flag")).toBe(false);
    expect(isAzureName("")).toBe(false);
    expect(isAzureName("has space")).toBe(false);
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

describe("isServiceTreeError", () => {
  it("detects the known Service-Tree identifiers case-insensitively", () => {
    expect(isServiceTreeError("ServiceManagementReference field is required")).toBe(true);
    expect(isServiceTreeError("error: SERVICETREENULLVALUEPROVIDED")).toBe(true);
    expect(isServiceTreeError("ServiceTreeInvalid: bad guid")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isServiceTreeError("Insufficient privileges to complete the operation")).toBe(false);
    expect(isServiceTreeError("")).toBe(false);
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

  it("uses the mutable default when the customization endpoint 404s", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: false, status: 404, json: null, stderr: "Not Found (HTTP 404)",
      },
    });
    // 404 => not opted into a custom subject, but immutability is unknown =>
    // fail closed unless we know the format. Assert that behavior explicitly.
    await expect(
      resolveOidcSubject({ targetRepo: "octo-org/octo-repo", suffix: "environment:dev" }, runner, opts),
    ).rejects.toThrow(/immutable/i);
  });

  it("respects an immutable override on the default (404) path", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: false, status: 404, json: null, stderr: "Not Found (HTTP 404)",
      },
    });
    const mutable = await resolveOidcSubject(
      { targetRepo: "octo-org/octo-repo", suffix: "environment:dev", immutableOverride: false },
      runner, opts,
    );
    expect(mutable.subject).toBe("repo:octo-org/octo-repo:environment:dev");

    const immutable = await resolveOidcSubject(
      { targetRepo: "octo-org/octo-repo", suffix: "environment:dev", immutableOverride: true },
      runner, opts,
    );
    expect(immutable.subject).toBe("repo:octo-org@111/octo-repo@222:environment:dev");
  });

  it("uses use_immutable_subject=false from the API for a mutable default", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: true, status: 200, json: { use_default: true, use_immutable_subject: false },
      },
    });
    const res = await resolveOidcSubject(
      { targetRepo: "octo-org/octo-repo", suffix: "environment:prod" }, runner, opts,
    );
    expect(res.subject).toBe("repo:octo-org/octo-repo:environment:prod");
  });

  it("infers immutability from a sub_claim_prefix containing @id", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: true, status: 200,
        json: { use_default: true, sub_claim_prefix: "repo:octo-org@111/octo-repo@222" },
      },
    });
    const res = await resolveOidcSubject(
      { targetRepo: "octo-org/octo-repo", suffix: "environment:prod" }, runner, opts,
    );
    expect(res.subject).toBe("repo:octo-org@111/octo-repo@222:environment:prod");
  });

  it("builds a custom subject from include_claim_keys", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: true, status: 200,
        json: { use_default: false, include_claim_keys: ["repository", "repository_id", "context"] },
      },
    });
    const res = await resolveOidcSubject(
      { targetRepo: "octo-org/octo-repo", suffix: "environment:dev" }, runner, opts,
    );
    expect(res.subject).toBe("repository:octo-org/octo-repo:repository_id:222:environment:dev");
  });

  it("uses the canonical full_name from the API, not the user casing", async () => {
    const runner = makeRunner({
      "/repos/Octo-Org/Octo-Repo": REPO_OK,
      "/repos/octo-org/octo-repo/actions/oidc/customization/sub": {
        ok: true, status: 200, json: { use_default: true, use_immutable_subject: false },
      },
    });
    const res = await resolveOidcSubject(
      { targetRepo: "Octo-Org/Octo-Repo", suffix: "environment:dev" }, runner, opts,
    );
    expect(res.subject).toBe("repo:octo-org/octo-repo:environment:dev");
  });

  it("throws on an invalid repo slug before any network call", async () => {
    const runner = vi.fn();
    await expect(
      resolveOidcSubject({ targetRepo: "bad", suffix: "environment:dev" }, runner, opts),
    ).rejects.toThrow(/owner\/repo/);
    expect(runner).not.toHaveBeenCalled();
  });

  it("fails when the repo itself cannot be read (no silent default)", async () => {
    const runner = makeRunner({
      "/repos/octo-org/octo-repo": { ok: false, status: 403, json: null, stderr: "Forbidden (HTTP 403)" },
    });
    await expect(
      resolveOidcSubject({ targetRepo: "octo-org/octo-repo", suffix: "environment:dev" }, runner, opts),
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
      resolveOidcSubject({ targetRepo: "octo-org/octo-repo", suffix: "environment:dev" }, runner, opts),
    ).rejects.toThrow(/customization/i);
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
      resolveOidcSubject({ targetRepo: "octo-org/octo-repo", suffix: "environment:dev" }, runner, opts),
    ).rejects.toThrow(/job_workflow_ref/);
  });

  it("reads /repos before the customization endpoint", async () => {
    const calls = [];
    const runner = vi.fn(async (p) => {
      calls.push(p);
      if (p === "/repos/octo-org/octo-repo") return REPO_OK;
      return { ok: true, status: 200, json: { use_default: true, use_immutable_subject: false } };
    });
    await resolveOidcSubject(
      { targetRepo: "octo-org/octo-repo", suffix: "environment:dev" }, runner, opts,
    );
    expect(calls[0]).toBe("/repos/octo-org/octo-repo");
    expect(calls[1]).toBe("/repos/octo-org/octo-repo/actions/oidc/customization/sub");
  });
});
