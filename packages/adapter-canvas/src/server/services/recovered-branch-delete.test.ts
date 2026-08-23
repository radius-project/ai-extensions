import { describe, expect, it } from "vitest";
import {
  createOperation,
  prepareProviderMutation,
  settleProviderMutation
} from "../../operations.js";
import {
  parseBranchDeleteTarget,
  pendingBranchDelete,
  reconcileRecoveredBranchDelete,
  REF_PAGE_SIZE,
  type BranchRefReadResult,
  type RecoveredBranchDeleteOutcome
} from "./recovered-branch-delete.js";

const REPO = "octo/app";
const BRANCH = "radius/setup-dev-workflows-abc";
const BASE = "base-sha-1";
const TARGET = `${REPO}\0${BRANCH}\0${BASE}`;

function operationWithPendingDelete(target = TARGET) {
  const operation = createOperation({ operationId: "op_branch" });
  prepareProviderMutation(operation, {
    kind: "github_branch.delete",
    target,
    providerIdempotencyKey: BRANCH
  });
  settleProviderMutation(
    operation,
    operation.providerRecovery.mutations[0].mutationId,
    "outcome_unknown",
    "The delete response was lost."
  );
  return operation;
}

function refRead(
  overrides: Partial<BranchRefReadResult> = {}
): BranchRefReadResult {
  return { code: 0, stdout: "", stderr: "", ...overrides };
}

// A removal carries no guidance by design, so asking for one is only valid once
// the outcome has been shown not to be a removal.
function guidanceOf(outcome: RecoveredBranchDeleteOutcome): string {
  if (outcome.state === "removed") {
    throw new Error(`expected a refusal, got a removal: ${outcome.evidence}`);
  }
  return outcome.guidance;
}

describe("parsing a recovered delete's target", () => {
  it("splits the exact repository, branch, and base commit", () => {
    expect(parseBranchDeleteTarget(TARGET)).toEqual({
      repo: REPO,
      branch: BRANCH,
      baseSha: BASE
    });
  });

  it.each([
    ["a target with too few fields", `${REPO}\0${BRANCH}`],
    ["a target with too many fields", `${REPO}\0${BRANCH}\0${BASE}\0extra`],
    ["an empty repository", `\0${BRANCH}\0${BASE}`],
    ["an empty branch", `${REPO}\0\0${BASE}`],
    ["an empty commit", `${REPO}\0${BRANCH}\0`],
    ["a colon-separated target", `${REPO}:${BRANCH}:${BASE}`]
  ])("reads nothing from %s", (_label, target) => {
    expect(parseBranchDeleteTarget(target)).toBeNull();
  });

  it("reads nothing from a non-string target", () => {
    expect(parseBranchDeleteTarget(undefined)).toBeNull();
  });
});

describe("finding the delete a record still owes an answer for", () => {
  it("returns only an unresolved setup-branch delete", () => {
    const operation = operationWithPendingDelete();
    expect(pendingBranchDelete(operation)?.kind).toBe("github_branch.delete");

    settleProviderMutation(
      operation,
      operation.providerRecovery.mutations[0].mutationId,
      "confirmed",
      "gone"
    );
    expect(pendingBranchDelete(operation)).toBeNull();
  });

  it("ignores an unresolved mutation of another kind", () => {
    const operation = createOperation({ operationId: "op_branch" });
    prepareProviderMutation(operation, {
      kind: "github_environment.put",
      target: "octo/app:dev"
    });
    expect(pendingBranchDelete(operation)).toBeNull();
  });
});

type ReconcileInput = Parameters<typeof reconcileRecoveredBranchDelete>[0];

// Every case needs the ref listing that a 404 is corroborated against. Only the
// masked-access and pagination cases care what it answers, so the default is a
// listing the selected account can complete which does not hold the branch, and
// each other case supplies its own.
function reconcile(
  input: Omit<ReconcileInput, "listBranchRefs"> &
    Partial<Pick<ReconcileInput, "listBranchRefs">>
): Promise<RecoveredBranchDeleteOutcome> {
  return reconcileRecoveredBranchDelete({
    listBranchRefs: async () => refRead({ stdout: "[]" }),
    ...input
  });
}

describe("settling a recovered setup-branch delete", () => {
  it("confirms removal only when GitHub reports the branch gone", async () => {
    const operation = operationWithPendingDelete();
    const reads: Array<[string, string]> = [];

    const outcome = await reconcile({
      operation,
      mutation: operation.providerRecovery.mutations[0],
      readBranchRef: async (repo, branch) => {
        reads.push([repo, branch]);
        return refRead({ code: 1, stderr: "HTTP 404: Not Found" });
      }
    });

    // The endpoint read that started the proof, then the confirming reread the
    // listing is checked against before absence is reported.
    expect(reads).toEqual([
      [REPO, BRANCH],
      [REPO, BRANCH]
    ]);
    expect(outcome).toMatchObject({ state: "removed", branch: BRANCH });
    expect(operation.providerRecovery.mutations[0].status).toBe("confirmed");
  });

  it("refuses to repeat the delete when the branch is still at the base commit", async () => {
    const operation = operationWithPendingDelete();

    const outcome = await reconcile({
      operation,
      mutation: operation.providerRecovery.mutations[0],
      readBranchRef: async () =>
        refRead({ stdout: JSON.stringify({ object: { sha: BASE } }) })
    });

    expect(outcome.state).toBe("manual_required");
    expect(guidanceOf(outcome)).toContain("will not repeat that delete");
    expect(operation.providerRecovery.mutations[0].status).toBe(
      "manual_required"
    );
    expect(operation.providerRecovery.state).toBe("manual_required");
  });

  it("refuses to delete a branch that has moved on", async () => {
    const operation = operationWithPendingDelete();

    const outcome = await reconcile({
      operation,
      mutation: operation.providerRecovery.mutations[0],
      readBranchRef: async () =>
        refRead({ stdout: JSON.stringify({ object: { sha: "someone-else" } }) })
    });

    expect(outcome.state).toBe("manual_required");
    expect(guidanceOf(outcome)).toContain("may hold work Radius did not write");
    expect(operation.providerRecovery.mutations[0].status).toBe(
      "manual_required"
    );
  });

  it.each([
    ["an error GitHub composed", refRead({ code: 1, stderr: "HTTP 500" })],
    ["unreadable branch state", refRead({ stdout: "<html>" })],
    ["a response with no commit", refRead({ stdout: JSON.stringify({}) })]
  ])("leaves the delete unresolved on %s", async (_label, response) => {
    const operation = operationWithPendingDelete();

    const outcome = await reconcile({
      operation,
      mutation: operation.providerRecovery.mutations[0],
      readBranchRef: async () => response
    });

    expect(outcome.state).toBe("unreadable");
    expect(guidanceOf(outcome)).toContain("changed nothing further");
    // Still unresolved, so the repository stays reserved and the read is retried.
    expect(operation.providerRecovery.mutations[0].status).toBe(
      "outcome_unknown"
    );
    expect(pendingBranchDelete(operation)).not.toBeNull();
  });

  it("leaves the delete unresolved when the branch cannot be reached at all", async () => {
    const operation = operationWithPendingDelete();

    const outcome = await reconcile({
      operation,
      mutation: operation.providerRecovery.mutations[0],
      readBranchRef: async () => {
        throw new Error("gh is not installed");
      }
    });

    expect(outcome).toMatchObject({ state: "unreadable", branch: BRANCH });
    expect(guidanceOf(outcome)).toContain("gh is not installed");
    expect(pendingBranchDelete(operation)).not.toBeNull();
  });

  it("names a non-Error read failure rather than dropping it", async () => {
    const operation = operationWithPendingDelete();

    const outcome = await reconcile({
      operation,
      mutation: operation.providerRecovery.mutations[0],
      readBranchRef: async () => {
        throw "spawn failed";
      }
    });

    expect(guidanceOf(outcome)).toContain("spawn failed");
  });

  it("confirms removal from a 404 reported on stdout with a string status", async () => {
    const operation = operationWithPendingDelete();

    const outcome = await reconcile({
      operation,
      mutation: operation.providerRecovery.mutations[0],
      readBranchRef: async () =>
        refRead({ code: "1", stdout: "gh: Not Found (HTTP 404)", stderr: "" })
    });

    expect(outcome.state).toBe("removed");
  });

  it("reads a branch head from a string-zero exit status", async () => {
    const operation = operationWithPendingDelete();

    const outcome = await reconcile({
      operation,
      mutation: operation.providerRecovery.mutations[0],
      readBranchRef: async () =>
        refRead({
          code: "0",
          stdout: JSON.stringify({ object: { sha: BASE } })
        })
    });

    expect(outcome.state).toBe("manual_required");
  });

  it("quarantines a delete whose target cannot be read", async () => {
    const operation = operationWithPendingDelete("malformed-target");

    const outcome = await reconcile({
      operation,
      mutation: operation.providerRecovery.mutations[0],
      readBranchRef: async () => {
        throw new Error("the branch must not be read from a broken target");
      }
    });

    expect(outcome).toMatchObject({ state: "manual_required", branch: null });
    expect(guidanceOf(outcome)).toContain("radius/setup-*");
    expect(operation.providerRecovery.mutations[0].status).toBe(
      "manual_required"
    );
  });

  describe("a 404 that may be masked access rather than a completed delete", () => {
    const NOT_FOUND = { code: 1, stderr: "HTTP 404: Not Found" };
    const refPage = (...refs: string[]) =>
      refRead({ stdout: JSON.stringify(refs.map((ref) => ({ ref }))) });

    it("proves absence only from a ref listing the same account can complete", async () => {
      const operation = operationWithPendingDelete();
      const listed: Array<[string, string, number]> = [];

      const outcome = await reconcile({
        operation,
        mutation: operation.providerRecovery.mutations[0],
        readBranchRef: async () => refRead(NOT_FOUND),
        listBranchRefs: async (repo, branch, page) => {
          listed.push([repo, branch, page]);
          return refPage("refs/heads/radius/setup-dev-workflows-other");
        }
      });

      expect(listed).toEqual([[REPO, BRANCH, 1]]);
      expect(outcome).toMatchObject({ state: "removed", branch: BRANCH });
      expect(operation.providerRecovery.mutations[0]).toMatchObject({
        status: "confirmed",
        evidence: expect.stringContaining("read every branch")
      });
    });

    it("refuses absence when the account may read the repository but not its refs", async () => {
      const operation = operationWithPendingDelete();

      const outcome = await reconcile({
        operation,
        mutation: operation.providerRecovery.mutations[0],
        readBranchRef: async () => refRead(NOT_FOUND),
        // Repository metadata is readable; the refs API is not. GitHub answers
        // 404 per resource, so the endpoint 404 proves nothing on its own.
        listBranchRefs: async () =>
          refRead({ code: 1, stderr: "HTTP 403: Resource not accessible" })
      });

      expect(outcome).toMatchObject({ state: "unreadable", branch: BRANCH });
      expect(guidanceOf(outcome)).toContain("masked access");
      expect(guidanceOf(outcome)).toContain("HTTP 403");
      // Still unresolved, so nothing downstream may report the branch removed.
      expect(pendingBranchDelete(operation)).not.toBeNull();
    });

    it("refuses absence when the listing itself is a 404", async () => {
      const operation = operationWithPendingDelete();

      const outcome = await reconcile({
        operation,
        mutation: operation.providerRecovery.mutations[0],
        readBranchRef: async () => refRead(NOT_FOUND),
        listBranchRefs: async () => refRead(NOT_FOUND)
      });

      expect(outcome.state).toBe("unreadable");
      expect(pendingBranchDelete(operation)).not.toBeNull();
    });

    it("refuses absence when the listing still holds the branch", async () => {
      const operation = operationWithPendingDelete();

      const outcome = await reconcile({
        operation,
        mutation: operation.providerRecovery.mutations[0],
        readBranchRef: async () => refRead(NOT_FOUND),
        listBranchRefs: async () =>
          refPage(`refs/heads/${BRANCH}`, "refs/heads/main")
      });

      expect(outcome).toMatchObject({
        state: "manual_required",
        branch: BRANCH
      });
      expect(guidanceOf(outcome)).toContain("still lists it");
      expect(operation.providerRecovery.mutations[0].status).toBe(
        "manual_required"
      );
    });

    it("reads every page before calling the branch gone", async () => {
      const operation = operationWithPendingDelete();
      const pages: number[] = [];
      const full = Array.from(
        { length: REF_PAGE_SIZE },
        (_unused, index) => `refs/heads/radius/setup-dev-workflows-${index}`
      );

      const outcome = await reconcile({
        operation,
        mutation: operation.providerRecovery.mutations[0],
        readBranchRef: async () => refRead(NOT_FOUND),
        listBranchRefs: async (_repo, _branch, page) => {
          pages.push(page);
          return page === 1 ? refPage(...full) : refPage("refs/heads/tail");
        }
      });

      expect(pages).toEqual([1, 2]);
      expect(outcome.state).toBe("removed");
    });

    it("never calls a branch gone from a page that may have been cut short", async () => {
      const operation = operationWithPendingDelete();
      const full = Array.from(
        { length: REF_PAGE_SIZE },
        (_unused, index) => `refs/heads/radius/setup-dev-workflows-${index}`
      );

      const outcome = await reconcile({
        operation,
        mutation: operation.providerRecovery.mutations[0],
        readBranchRef: async () => refRead(NOT_FOUND),
        // Every page comes back full, so the listing never ends and the branch
        // could be on the page after the one Radius stopped at.
        listBranchRefs: async () => refPage(...full)
      });

      expect(outcome.state).toBe("unreadable");
      expect(guidanceOf(outcome)).toContain("did not end within");
      expect(pendingBranchDelete(operation)).not.toBeNull();
    });

    it("finds the branch on a later page rather than reporting it gone", async () => {
      const operation = operationWithPendingDelete();
      const full = Array.from(
        { length: REF_PAGE_SIZE },
        (_unused, index) => `refs/heads/radius/setup-dev-workflows-${index}`
      );

      const outcome = await reconcile({
        operation,
        mutation: operation.providerRecovery.mutations[0],
        readBranchRef: async () => refRead(NOT_FOUND),
        listBranchRefs: async (_repo, _branch, page) =>
          page === 1 ? refPage(...full) : refPage(`refs/heads/${BRANCH}`)
      });

      expect(outcome.state).toBe("manual_required");
      expect(guidanceOf(outcome)).toContain("still lists it");
    });

    it.each([
      ["an unreadable body", refRead({ stdout: "<html>" })],
      ["a listing that is not an array", refRead({ stdout: "{}" })],
      ["an entry with no ref", refRead({ stdout: JSON.stringify([{}]) })],
      [
        "an entry whose ref is not a string",
        refRead({ stdout: JSON.stringify([{ ref: 7 }]) })
      ]
    ])("refuses absence for %s", async (_label, response) => {
      const operation = operationWithPendingDelete();

      const outcome = await reconcile({
        operation,
        mutation: operation.providerRecovery.mutations[0],
        readBranchRef: async () => refRead(NOT_FOUND),
        listBranchRefs: async () => response
      });

      expect(outcome.state).toBe("unreadable");
      expect(guidanceOf(outcome)).toContain("could not read");
      expect(pendingBranchDelete(operation)).not.toBeNull();
    });

    it("refuses absence when the listing cannot be reached at all", async () => {
      const operation = operationWithPendingDelete();

      const outcome = await reconcile({
        operation,
        mutation: operation.providerRecovery.mutations[0],
        readBranchRef: async () => refRead(NOT_FOUND),
        listBranchRefs: async () => {
          throw new Error("the token was revoked");
        }
      });

      expect(outcome.state).toBe("unreadable");
      expect(guidanceOf(outcome)).toContain("the token was revoked");
      expect(pendingBranchDelete(operation)).not.toBeNull();
    });

    it("names a non-Error listing failure rather than dropping it", async () => {
      const operation = operationWithPendingDelete();

      const outcome = await reconcile({
        operation,
        mutation: operation.providerRecovery.mutations[0],
        readBranchRef: async () => refRead(NOT_FOUND),
        listBranchRefs: async () => {
          throw "spawn failed";
        }
      });

      expect(guidanceOf(outcome)).toContain("spawn failed");
    });

    it("accepts a string-zero listing status", async () => {
      const operation = operationWithPendingDelete();

      const outcome = await reconcile({
        operation,
        mutation: operation.providerRecovery.mutations[0],
        readBranchRef: async () =>
          refRead({
            code: "1",
            stdout: "gh: Not Found (HTTP 404)",
            stderr: ""
          }),
        listBranchRefs: async () => refRead({ code: "0", stdout: "[]" })
      });

      expect(outcome.state).toBe("removed");
    });

    it("does not list refs at all when the branch is still present", async () => {
      const operation = operationWithPendingDelete();

      const outcome = await reconcile({
        operation,
        mutation: operation.providerRecovery.mutations[0],
        readBranchRef: async () =>
          refRead({ stdout: JSON.stringify({ object: { sha: BASE } }) }),
        listBranchRefs: async () => {
          throw new Error("a present branch needs no corroboration");
        }
      });

      expect(outcome.state).toBe("manual_required");
    });
  });
});
