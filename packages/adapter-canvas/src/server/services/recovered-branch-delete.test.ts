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

describe("settling a recovered setup-branch delete", () => {
  it("confirms removal only when GitHub reports the branch gone", async () => {
    const operation = operationWithPendingDelete();
    const reads: Array<[string, string]> = [];

    const outcome = await reconcileRecoveredBranchDelete({
      operation,
      mutation: operation.providerRecovery.mutations[0],
      readBranchRef: async (repo, branch) => {
        reads.push([repo, branch]);
        return refRead({ code: 1, stderr: "HTTP 404: Not Found" });
      }
    });

    expect(reads).toEqual([[REPO, BRANCH]]);
    expect(outcome).toMatchObject({ state: "removed", branch: BRANCH });
    expect(operation.providerRecovery.mutations[0].status).toBe("confirmed");
  });

  it("refuses to repeat the delete when the branch is still at the base commit", async () => {
    const operation = operationWithPendingDelete();

    const outcome = await reconcileRecoveredBranchDelete({
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

    const outcome = await reconcileRecoveredBranchDelete({
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

    const outcome = await reconcileRecoveredBranchDelete({
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

    const outcome = await reconcileRecoveredBranchDelete({
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

    const outcome = await reconcileRecoveredBranchDelete({
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

    const outcome = await reconcileRecoveredBranchDelete({
      operation,
      mutation: operation.providerRecovery.mutations[0],
      readBranchRef: async () =>
        refRead({ code: "1", stdout: "gh: Not Found (HTTP 404)", stderr: "" })
    });

    expect(outcome.state).toBe("removed");
  });

  it("reads a branch head from a string-zero exit status", async () => {
    const operation = operationWithPendingDelete();

    const outcome = await reconcileRecoveredBranchDelete({
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

    const outcome = await reconcileRecoveredBranchDelete({
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
});
