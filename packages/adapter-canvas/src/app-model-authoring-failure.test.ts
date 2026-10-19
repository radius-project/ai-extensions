import { describe, expect, it, vi } from "vitest";
import {
  appModelAuthoringFailure,
  appModelTargetKey,
  clearAppModelAuthoringFailure,
  readSelectedSourceRevision,
  reconcileAppModelAuthoringFailure
} from "./app-model-authoring-failure.js";

describe("app model authoring failures", () => {
  it("keys and reads failures by exact repository and branch", () => {
    const state = {
      appModelFailures: {
        "acme/widgets::main": {
          attemptToken: "attempt-1",
          error: "Recipe conflict"
        }
      },
      appModelAttemptTokens: {
        "acme/widgets::main": "attempt-1"
      }
    };

    expect(appModelTargetKey("acme/widgets", "main")).toBe(
      "acme/widgets::main"
    );
    expect(appModelAuthoringFailure(state, "acme/widgets", "main")).toEqual({
      attemptToken: "attempt-1",
      error: "Recipe conflict"
    });
    expect(
      appModelAuthoringFailure(state, "acme/widgets", "release")
    ).toBeNull();
    state.appModelAttemptTokens["acme/widgets::main"] = "attempt-2";
    expect(appModelAuthoringFailure(state, "acme/widgets", "main")).toBeNull();
  });

  it("clears both the failure and attempt token without requiring either map", () => {
    const state = {
      appModelFailures: {
        "acme/widgets::main": {
          attemptToken: "attempt-1",
          error: "Recipe conflict"
        }
      },
      appModelAttemptTokens: {
        "acme/widgets::main": "attempt-1"
      },
      appModelAttemptEnvironments: {
        "acme/widgets::main": '["azure","dev"]',
        "acme/widgets::other": '["azure","production"]'
      },
      appModelAttemptSourceRevisions: {
        "acme/widgets::main": "remote:sha-1",
        "acme/widgets::other": "remote:sha-2"
      }
    };

    clearAppModelAuthoringFailure(state, "acme/widgets", "main");
    clearAppModelAuthoringFailure({}, "acme/widgets", "main");

    expect(state.appModelFailures).toEqual({});
    expect(state.appModelAttemptTokens).toEqual({});
    expect(state.appModelAttemptEnvironments).toEqual({
      "acme/widgets::other": '["azure","production"]'
    });
    expect(state.appModelAttemptSourceRevisions).toEqual({
      "acme/widgets::other": "remote:sha-2"
    });
  });

  describe("readSelectedSourceRevision", () => {
    function readers(commit: string) {
      return {
        isWorkspaceSelection: (
          _state: unknown,
          _repo: string,
          branch: string
        ) => branch === "main",
        workspaceSourceRevision: vi.fn(
          async (path: string | undefined) => `workspace:${path}`
        ),
        branchHeadCommit: vi.fn(async () => commit)
      };
    }

    it("reads the saved workspace fingerprint for the open checkout", async () => {
      const read = readers("sha-1");
      expect(
        await readSelectedSourceRevision(
          { workspacePath: "/ws" },
          "acme/widgets",
          "main",
          read
        )
      ).toBe("workspace:/ws");
      expect(read.branchHeadCommit).not.toHaveBeenCalled();
    });

    it.each([
      ["sha-1", "remote:sha-1"],
      ["", ""]
    ])("reads commit %j of another branch as %j", async (commit, expected) => {
      const read = readers(commit);
      expect(
        await readSelectedSourceRevision({}, "acme/widgets", "release", read)
      ).toBe(expected);
      expect(read.branchHeadCommit).toHaveBeenCalledWith(
        "acme/widgets",
        "release"
      );
      expect(read.workspaceSourceRevision).not.toHaveBeenCalled();
    });

    it("lets a read error reach the caller", async () => {
      const read = readers("sha-1");
      read.branchHeadCommit.mockRejectedValue(new Error("offline"));
      await expect(
        readSelectedSourceRevision({}, "acme/widgets", "release", read)
      ).rejects.toThrow("offline");
    });
  });

  describe("reconcileAppModelAuthoringFailure", () => {
    function failed(sourceRevision?: string) {
      return {
        appModelFailures: {
          "acme/widgets::main": {
            attemptToken: "attempt-1",
            error: "Recipe conflict",
            ...(sourceRevision === undefined ? {} : { sourceRevision })
          }
        } as Record<
          string,
          {
            attemptToken: string;
            error: string;
            sourceRevision?: string;
            environmentKey?: string;
          }
        >,
        appModelAttemptTokens: {
          "acme/widgets::main": "attempt-1"
        } as Record<string, string>
      };
    }
    const reconcile = (
      state: ReturnType<typeof failed>,
      read: () => Promise<string>
    ) => reconcileAppModelAuthoringFailure(state, "acme/widgets", "main", read);

    it("clears the failure when the branch is at a different commit", async () => {
      const state = failed("sha-0");
      await reconcile(state, async () => "sha-1");
      expect(state.appModelFailures).toEqual({});
      expect(state.appModelAttemptTokens).toEqual({});
    });

    it.each([
      ["workspace:source-1", "remote:sha-1"],
      ["remote:sha-1", "workspace:source-1"]
    ])(
      "keeps a failure when its source changes kind from %s to %s",
      async (before, after) => {
        const state = failed(before);
        await reconcile(state, async () => after);
        expect(
          state.appModelFailures["acme/widgets::main"]?.sourceRevision
        ).toBe(after);
        await reconcile(state, async () => after);
        expect(state.appModelAttemptTokens["acme/widgets::main"]).toBe(
          "attempt-1"
        );
        await reconcile(state, async () => `${after}-changed`);
        expect(state.appModelFailures).toEqual({});
      }
    );

    it.each([
      [{ userRequested: true }, true],
      [{ userRequested: false }, false],
      [{ environmentKey: '["azure","production"]' }, true],
      [{ environmentKey: '["aws","dev"]' }, true],
      [{ environmentKey: '["azure","dev"]' }, false]
    ])(
      "only clears a current failure for an explicit retry or a changed environment: %j",
      async (retry, clears) => {
        const state = failed("remote:sha-1");
        const failure = state.appModelFailures["acme/widgets::main"];
        if (!failure) throw new Error("Missing fixture failure");
        failure.environmentKey = '["azure","dev"]';
        await reconcileAppModelAuthoringFailure(
          state,
          "acme/widgets",
          "main",
          async () => "",
          () => true,
          retry
        );
        expect(Boolean(state.appModelFailures["acme/widgets::main"])).toBe(
          !clears
        );
      }
    );

    it("keeps a graph or diff failure when the planned view opens", async () => {
      const state = failed("workspace:source-1");
      const failure = state.appModelFailures["acme/widgets::main"];
      if (!failure) throw new Error("Missing fixture failure");
      failure.environmentKey = "";
      await reconcileAppModelAuthoringFailure(
        state,
        "acme/widgets",
        "main",
        async () => "workspace:source-1",
        () => true,
        { environmentKey: '["azure",""]' }
      );
      expect(state.appModelFailures["acme/widgets::main"]).toBeDefined();
      expect(state.appModelAttemptTokens["acme/widgets::main"]).toBe(
        "attempt-1"
      );
    });

    it("does not release a failure for a stale explicit retry", async () => {
      const state = failed("remote:sha-1");
      await reconcileAppModelAuthoringFailure(
        state,
        "acme/widgets",
        "main",
        async () => {
          throw new Error("A stale request must not read source");
        },
        () => false,
        { userRequested: true }
      );
      expect(state.appModelAttemptTokens["acme/widgets::main"]).toBe(
        "attempt-1"
      );
    });

    it("reports an unavailable source read even when a baseline exists", async () => {
      const state = failed("remote:sha-1");
      expect(await reconcile(state, async () => "")).toBe("unavailable");
      expect(
        await reconcile(state, async () => {
          throw new Error("offline");
        })
      ).toBe("unavailable");
      expect(state.appModelFailures["acme/widgets::main"]?.sourceRevision).toBe(
        "remote:sha-1"
      );
    });

    it.each([
      ["the commit is unchanged", "sha-0", async () => "sha-0"],
      ["the commit is empty", "sha-0", async () => ""],
      [
        "the commit read throws",
        "sha-0",
        () => Promise.reject(new Error("offline"))
      ]
    ])("keeps the failure when %s", async (_name, recorded, read) => {
      const state = failed(recorded);
      await reconcile(state, read);
      expect(state.appModelFailures["acme/widgets::main"]).toBeDefined();
    });

    it("establishes a missing baseline, keeps reloads fenced, then allows a source edit", async () => {
      const state = failed();
      let reads = 0;
      await reconcile(state, async () => {
        reads += 1;
        return "sha-1";
      });
      expect(reads).toBe(1);
      expect(state.appModelFailures["acme/widgets::main"]?.sourceRevision).toBe(
        "sha-1"
      );
      await reconcile(state, async () => "sha-1");
      expect(state.appModelAttemptTokens["acme/widgets::main"]).toBe(
        "attempt-1"
      );
      await reconcile(state, async () => "sha-2");
      expect(state.appModelFailures).toEqual({});
      expect(state.appModelAttemptTokens).toEqual({});
    });

    it("does not read source when no current failure exists", async () => {
      const state = failed();
      state.appModelAttemptTokens["acme/widgets::main"] = "new-attempt";
      await reconcile(state, async () => {
        throw new Error("Unexpected source read");
      });
      expect(state.appModelFailures["acme/widgets::main"]).toBeDefined();
    });

    it("keeps a failure when its request becomes stale during the read", async () => {
      const state = failed("sha-0");
      let current = true;
      await reconcileAppModelAuthoringFailure(
        state,
        "acme/widgets",
        "main",
        async () => {
          current = false;
          return "sha-1";
        },
        () => current
      );
      expect(state.appModelFailures["acme/widgets::main"]?.sourceRevision).toBe(
        "sha-0"
      );
    });

    it("keeps an unknown baseline when source remains unreadable", async () => {
      const state = failed();
      await reconcile(state, async () => "");
      expect(
        state.appModelFailures["acme/widgets::main"]?.sourceRevision
      ).toBeUndefined();
    });

    it("keeps a failure that was replaced while the commit was read", async () => {
      const state = failed("sha-0");
      await reconcile(state, async () => {
        state.appModelFailures["acme/widgets::main"] = {
          attemptToken: "attempt-1",
          error: "Newer",
          sourceRevision: "sha-0"
        };
        return "sha-1";
      });
      expect(state.appModelFailures["acme/widgets::main"]?.error).toBe("Newer");
    });
  });
});
