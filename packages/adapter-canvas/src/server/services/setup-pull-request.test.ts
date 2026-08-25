import { describe, expect, it } from "vitest";
import { isSetupPullRequestMerged } from "./setup-pull-request.js";

// A fetch that throws on any path the scenario did not model, so "no network
// call" is an assertable outcome rather than an assumption.
function fetchFor(
  responses: Record<string, { ok: boolean; json: unknown }>,
  calls: string[] = []
) {
  return async (apiPath: string) => {
    calls.push(apiPath);
    const response = responses[apiPath];
    if (!response) throw new Error(`unscripted GitHub read: ${apiPath}`);
    return response;
  };
}

describe("isSetupPullRequestMerged", () => {
  it("reports a merged pull request from the merged flag", async () => {
    const calls: string[] = [];
    const merged = await isSetupPullRequestMerged(
      "contoso/store",
      "https://github.com/contoso/store/pull/7",
      fetchFor(
        { "repos/contoso/store/pulls/7": { ok: true, json: { merged: true } } },
        calls
      )
    );

    expect(merged).toBe(true);
    expect(calls).toEqual(["repos/contoso/store/pulls/7"]);
  });

  it("accepts a merge timestamp from a response with no merged flag", async () => {
    const merged = await isSetupPullRequestMerged(
      "contoso/store",
      "https://github.com/contoso/store/pull/7",
      fetchFor({
        "repos/contoso/store/pulls/7": {
          ok: true,
          json: { merged_at: "2026-08-14T00:00:00Z" }
        }
      })
    );

    expect(merged).toBe(true);
  });

  it("reports an open pull request as not merged", async () => {
    const merged = await isSetupPullRequestMerged(
      "contoso/store",
      "https://github.com/contoso/store/pull/7",
      fetchFor({
        "repos/contoso/store/pulls/7": {
          ok: true,
          json: { merged: false, merged_at: null }
        }
      })
    );

    expect(merged).toBe(false);
  });

  it("treats an empty merge timestamp as not merged", async () => {
    const merged = await isSetupPullRequestMerged(
      "contoso/store",
      "https://github.com/contoso/store/pull/7",
      fetchFor({
        "repos/contoso/store/pulls/7": {
          ok: true,
          json: { merged_at: "" }
        }
      })
    );

    expect(merged).toBe(false);
  });

  it("fails closed when GitHub refuses the read", async () => {
    const merged = await isSetupPullRequestMerged(
      "contoso/store",
      "https://github.com/contoso/store/pull/7",
      fetchFor({
        "repos/contoso/store/pulls/7": { ok: false, json: null }
      })
    );

    expect(merged).toBe(false);
  });

  it("fails closed for a response body that is not an object", async () => {
    const merged = await isSetupPullRequestMerged(
      "contoso/store",
      "https://github.com/contoso/store/pull/7",
      fetchFor({
        "repos/contoso/store/pulls/7": { ok: true, json: "merged" }
      })
    );

    expect(merged).toBe(false);
  });

  it.each([
    ["a missing url", null],
    ["an empty url", "   "],
    ["a non-GitHub host", "https://example.com/contoso/store/pull/7"],
    ["an issue url", "https://github.com/contoso/store/issues/7"],
    ["a non-numeric number", "https://github.com/contoso/store/pull/seven"]
  ])("refuses to call GitHub for %s", async (_label, url) => {
    const calls: string[] = [];
    const merged = await isSetupPullRequestMerged(
      "contoso/store",
      url,
      fetchFor({}, calls)
    );

    expect(merged).toBe(false);
    expect(calls).toEqual([]);
  });

  it("refuses a pull request in a different repository than the operation", async () => {
    const calls: string[] = [];
    const merged = await isSetupPullRequestMerged(
      "contoso/store",
      "https://github.com/attacker/store/pull/7",
      fetchFor({}, calls)
    );

    expect(merged).toBe(false);
    expect(calls).toEqual([]);
  });

  it("reads the pull request when the operation names no repository", async () => {
    const calls: string[] = [];
    const merged = await isSetupPullRequestMerged(
      "",
      "https://github.com/contoso/store/pull/7",
      fetchFor(
        { "repos/contoso/store/pulls/7": { ok: true, json: { merged: true } } },
        calls
      )
    );

    expect(merged).toBe(true);
    expect(calls).toEqual(["repos/contoso/store/pulls/7"]);
  });
});
