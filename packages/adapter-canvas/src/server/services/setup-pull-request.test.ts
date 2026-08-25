import { describe, expect, it, vi } from "vitest";
import {
  checkSetupPullRequestMerge,
  checkSetupPullRequestMergeForOperation,
  isSetupPullRequestMerged
} from "./setup-pull-request.js";
import { successfulSelectedGhExecutor } from "../../../test/support/server/selected-gh.js";

// A fetch that throws on any path the scenario did not model, so "no network
// call" is an assertable outcome rather than an assumption.
function fetchFor(
  responses: Record<string, { ok: boolean; json: unknown; error?: string }>,
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

  describe("checkSetupPullRequestMerge", () => {
    it("distinguishes an unreadable pull request from an open one", async () => {
      const check = await checkSetupPullRequestMerge(
        "contoso/store",
        "https://github.com/contoso/store/pull/7",
        fetchFor({
          "repos/contoso/store/pulls/7": {
            ok: false,
            json: null,
            error: "HTTP 403"
          }
        })
      );

      expect(check).toEqual({ state: "unavailable", detail: "HTTP 403" });
    });

    describe("checkSetupPullRequestMergeForOperation", () => {
      it("uses the operation selected executor for the merge read", async () => {
        const executor = successfulSelectedGhExecutor({ login: "alice" });
        const created: string[] = [];
        const reads: Array<{ executor: unknown; path: string }> = [];

        const check = await checkSetupPullRequestMergeForOperation(
          {
            repo: "contoso/store",
            context: { githubLogin: " alice " }
          },
          "https://github.com/contoso/store/pull/7",
          {
            createExecutor: async (login) => {
              created.push(login);
              return executor;
            },
            fetchJson: async (actingExecutor, path) => {
              reads.push({ executor: actingExecutor, path });
              return { ok: true, json: { merged: true } };
            },
            errorMessage: (error) => String(error)
          }
        );

        expect(check).toEqual({ state: "merged" });
        expect(created).toEqual(["alice"]);
        expect(reads).toEqual([
          {
            executor,
            path: "repos/contoso/store/pulls/7"
          }
        ]);
      });

      it("fails closed before GitHub when the operation has no selected login", async () => {
        const createExecutor = vi.fn();
        const fetchJson = vi.fn();

        const check = await checkSetupPullRequestMergeForOperation(
          { repo: "contoso/store", context: {} },
          "https://github.com/contoso/store/pull/7",
          {
            createExecutor,
            fetchJson,
            errorMessage: (error) => String(error)
          }
        );

        expect(check).toEqual({
          state: "unavailable",
          login: "",
          detail: "The operation has no saved GitHub account."
        });
        expect(createExecutor).not.toHaveBeenCalled();
        expect(fetchJson).not.toHaveBeenCalled();
      });

      it("returns selected-account guidance when executor acquisition fails", async () => {
        const check = await checkSetupPullRequestMergeForOperation(
          {
            repo: "contoso/store",
            context: { githubLogin: "alice" }
          },
          "https://github.com/contoso/store/pull/7",
          {
            createExecutor: () =>
              Promise.reject(new Error("credential unavailable")),
            fetchJson: vi.fn(),
            errorMessage: (error) =>
              error instanceof Error ? error.message : String(error)
          }
        );

        expect(check).toEqual({
          state: "unavailable",
          login: "alice",
          detail: "credential unavailable"
        });
      });

      it("retains the selected login when its pull request read fails", async () => {
        const executor = successfulSelectedGhExecutor({ login: "alice" });
        const check = await checkSetupPullRequestMergeForOperation(
          {
            repo: "contoso/store",
            context: { githubLogin: "alice" }
          },
          "https://github.com/contoso/store/pull/7",
          {
            createExecutor: () => Promise.resolve(executor),
            fetchJson: () =>
              Promise.resolve({ ok: false, json: null, error: "HTTP 403" }),
            errorMessage: (error) => String(error)
          }
        );

        expect(check).toEqual({
          state: "unavailable",
          login: "alice",
          detail: "HTTP 403"
        });
      });

      it("uses the saved pull request repository when a legacy operation has no repo", async () => {
        const executor = successfulSelectedGhExecutor({ login: "alice" });
        const paths: string[] = [];
        const check = await checkSetupPullRequestMergeForOperation(
          { context: { githubLogin: "alice" } },
          "https://github.com/contoso/store/pull/7",
          {
            createExecutor: () => Promise.resolve(executor),
            fetchJson: (_executor, path) => {
              paths.push(path);
              return Promise.resolve({ ok: true, json: { merged: false } });
            },
            errorMessage: (error) => String(error)
          }
        );

        expect(check).toEqual({ state: "open" });
        expect(paths).toEqual(["repos/contoso/store/pulls/7"]);
      });
    });

    it("explains why an invalid saved pull request cannot be checked", async () => {
      const check = await checkSetupPullRequestMerge(
        "contoso/store",
        "https://github.com/attacker/store/pull/7",
        fetchFor({})
      );

      expect(check).toEqual({
        state: "unavailable",
        detail:
          "The saved setup pull request URL is missing, invalid, or names another repository."
      });
    });
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
