import { describe, expect, it } from "vitest";
import {
  planCredentialVerification,
  hasVerificationOperationMarker,
  hasWorkflowRunTrigger
} from "./setup-verification-plan.js";

const dispatcher = (env: string, chain = true) => `name: Radius
on:
  workflow_dispatch:
    inputs:
      environment:
        default: '${env}'
${
  chain ?
    `  workflow_run:\n    workflows: ["Radius - Verify Credentials"]\n`
  : ""
}jobs:
  detect:
    environment: \${{ inputs.environment || '${env}' }}
`;

describe("verification workflow feature detection", () => {
  it.each([
    [null, false],
    ["radius_operation:", false],
    ["inputs.radius_operation", false],
    ["radius_operation: inputs.radius_operation", true]
  ] as const)(
    "requires both operation input declaration and usage in %j",
    (workflow, expected) => {
      expect(hasVerificationOperationMarker(workflow)).toBe(expected);
    }
  );
  it.each([
    [null, false],
    ["on:\n  workflow_run:\n", true],
    ["jobs:\n  workflow_run:\n", false]
  ] as const)(
    "limits workflow_run detection to the trigger section in %j",
    (workflow, expected) => {
      expect(hasWorkflowRunTrigger(workflow)).toBe(expected);
    }
  );
});

describe("credential verification planning", () => {
  const base = {
    targetRepo: "octo/app",
    defaultBranch: "main"
  };

  it.each(["", "main"])(
    "does not fetch the same dispatch workflow twice for legacy branch %j",
    async (branch) => {
      const reads: string[] = [];
      const result = await planCredentialVerification({
        ...base,
        prState: { branch },
        fetchFile: async (_repo, path, ref) => {
          reads.push(`${path}@${ref}`);
          return undefined;
        }
      });
      expect(reads).toHaveLength(2);
      expect(result).toMatchObject({
        trigger: "none",
        supportsOperationMarker: false
      });
    }
  );

  it("dispatches directly when there is no PR fallback", async () => {
    const plan = await planCredentialVerification({
      ...base,
      prState: null,
      fetchFile: async () =>
        "on:\n  workflow_dispatch:\n    inputs:\n      radius_operation:\n        required: false\nrun-name: ${{ inputs.radius_operation }}\n"
    });

    expect(plan.shouldDispatch).toBe(true);
    expect(plan.trigger).toBe("workflow_dispatch");
    expect(plan.ref).toBe("main");
    expect(plan.defaultBranch).toBe("main");
    expect(plan.supportsOperationMarker).toBe(true);
  });

  it("uses the confirmed non-main branch when the direct workflow cannot be read", async () => {
    // Assuming support would send `-f radius_operation` to a workflow that may
    // not declare it, and GitHub answers that with a 422 the journal reads as a
    // conclusive refusal, failing setup for the wrong stated reason.
    const plan = await planCredentialVerification({
      ...base,
      defaultBranch: "trunk",
      prState: null,
      fetchFile: async () => null
    });
    expect(plan.shouldDispatch).toBe(true);
    expect(plan.ref).toBe("trunk");
    expect(plan.defaultBranch).toBe("trunk");
    expect(plan.supportsOperationMarker).toBe(false);
  });

  it("reads marker support from the ref the dispatch runs at", async () => {
    // The default branch still carries a pre-marker workflow on every
    // customer's first upgrade; the branch this request just committed to is
    // the one GitHub validates the dispatch inputs against.
    const marked =
      "on:\n  workflow_dispatch:\n    inputs:\n      radius_operation:\n        required: false\nrun-name: ${{ inputs.radius_operation }}\n";
    const plan = await planCredentialVerification({
      ...base,
      prState: { branch: "radius/setup-dev", base: "main" },
      fetchFile: async (_repo, path, ref) =>
        path.includes("verify") ?
          ref === "radius/setup-dev" ?
            marked
          : "on:\n  workflow_dispatch:\n    inputs:\n      environment:\n        required: true\njobs:\n"
        : null
    });
    expect(plan.supportsOperationMarker).toBe(true);
  });

  it("discovers rather than dispatching when the setup push was enabled", async () => {
    const plan = await planCredentialVerification({
      ...base,
      prState: { branch: "radius/setup-dev", base: "main" },
      automaticPushEnabled: true,
      fetchFile: async () => {
        throw new Error("automatic verification must not re-plan from files");
      }
    });

    expect(plan).toMatchObject({
      shouldDispatch: false,
      trigger: "push",
      ref: "radius/setup-dev",
      pullRequestUrl: ""
    });
  });

  it("defers when the default branch still chains verification to deployment", async () => {
    const plan = await planCredentialVerification({
      ...base,
      prState: { branch: "radius/setup-dev", base: "main" },
      pullRequestUrl: "https://github.com/octo/app/pull/9",
      fetchFile: async (_repo, path) =>
        path.includes("verify") ?
          "on:\n  workflow_dispatch:\n"
        : dispatcher("dev")
    });
    expect(plan.shouldDispatch).toBe(false);
    expect(plan.ref).toBe("radius/setup-dev");
    expect(plan.pullRequestUrl).toBe("https://github.com/octo/app/pull/9");
    expect(plan.skipReason).toContain("still auto-runs after verification");
  });

  it("defers when verify is absent, with or without an automatic PR URL", async () => {
    for (const pullRequestUrl of ["https://github.com/octo/app/pull/9", ""]) {
      const plan = await planCredentialVerification({
        ...base,
        prState: { branch: "radius/setup-dev", base: "main" },
        pullRequestUrl,
        fetchFile: async () => null
      });
      expect(plan.shouldDispatch).toBe(false);
      expect(plan.pullRequestUrl).toBe(pullRequestUrl);
    }
  });

  it("blocks every auto-running dispatcher but not a chain-free one", async () => {
    const stale = await planCredentialVerification({
      ...base,
      prState: { branch: "radius/setup-dev", base: "main" },
      fetchFile: async (_repo, path) =>
        path.includes("verify") ? "workflow" : dispatcher("prod")
    });
    expect(stale.shouldDispatch).toBe(false);
    expect(stale.skipReason).toContain("merge the pull request");

    const safe = await planCredentialVerification({
      ...base,
      prState: { branch: "radius/setup-dev", base: "main" },
      fetchFile: async (_repo, path) =>
        path.includes("verify") ? "workflow" : dispatcher("prod", false)
    });
    expect(safe.shouldDispatch).toBe(true);
    expect(safe.supportsOperationMarker).toBe(false);
  });

  it("blocks branch dispatch when status-aware workflow safety failed", async () => {
    const plan = await planCredentialVerification({
      ...base,
      prState: { branch: "radius/setup-dev", base: "main" },
      pullRequestUrl: "https://github.com/octo/app/pull/7",
      branchVerificationAllowed: false,
      fetchFile: async () =>
        "on:\n  workflow_dispatch:\n    inputs:\n      radius_operation:\n"
    });

    expect(plan).toMatchObject({
      shouldDispatch: false,
      trigger: "none",
      pullRequestUrl: "https://github.com/octo/app/pull/7"
    });
    expect(plan.skipReason).toContain("safety could not be established");
  });
});
