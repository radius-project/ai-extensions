import { describe, expect, it } from "vitest";
import {
  buildVerifyWorkflowDispatchArgs,
  describeVerificationDispatch,
  hasWorkflowRunTrigger,
  parseVerifyWorkflowRunUrl,
  planCredentialVerification
} from "./verification-plan.js";

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

describe("workflow parsing", () => {
  it("detects only a top-level workflow_run trigger", () => {
    expect(hasWorkflowRunTrigger(dispatcher("dev"))).toBe(true);
    expect(hasWorkflowRunTrigger(dispatcher("dev", false))).toBe(false);
    expect(
      hasWorkflowRunTrigger(
        "jobs:\n  a:\n    steps:\n      - run: echo workflow_run:\n"
      )
    ).toBe(false);
  });
});

describe("credential verification planning", () => {
  const base = {
    targetRepo: "octo/app",
    defaultBranch: "main"
  };

  it("dispatches directly when there is no PR fallback", async () => {
    const plan = await planCredentialVerification({
      ...base,
      prState: null,
      fetchFile: async () =>
        "on:\n  workflow_dispatch:\n    inputs:\n      radius_operation:\n        required: false\nrun-name: ${{ inputs.radius_operation }}\n"
    });
    expect(plan.shouldDispatch).toBe(true);
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
});

describe("dispatch arguments", () => {
  it("adds --ref only when provided", () => {
    const base = {
      workflowFile: "radius-verify-credentials.yml",
      targetRepo: "octo/app",
      envName: "dev"
    };
    expect(buildVerifyWorkflowDispatchArgs(base)).not.toContain("--ref");
    expect(
      buildVerifyWorkflowDispatchArgs({
        ...base,
        ref: "radius/setup-dev"
      }).slice(-2)
    ).toEqual(["--ref", "radius/setup-dev"]);
  });

  it("passes the operation marker as a workflow input", () => {
    expect(
      buildVerifyWorkflowDispatchArgs({
        workflowFile: "radius-verify-credentials.yml",
        targetRepo: "octo/app",
        envName: "dev",
        operationMarker: "op_verify"
      })
    ).toContain("radius_operation=op_verify");
  });
});

describe("dispatch narration", () => {
  it.each([
    ["injected", "the Copilot session token"],
    ["keyring", "the stored GitHub CLI credential"]
  ] as const)(
    "names the %s credential without exposing it",
    (source, label) => {
      expect(
        describeVerificationDispatch({
          login: "octocat",
          credentialSource: source,
          workflowFile: "radius-verify-credentials.yml",
          targetRepo: "octo/app",
          envName: "dev",
          ref: "trunk"
        })
      ).toBe(
        `Credential verification dispatch is configured for @octocat using ${label}: ` +
          'workflow "radius-verify-credentials.yml", environment "dev", repository "octo/app", ref "trunk". ' +
          "Radius passes this resolved ref explicitly so GitHub CLI does not perform another default-branch lookup."
      );
    }
  );
});

describe("workflow run URL parsing", () => {
  it("extracts the immutable run identity from gh workflow run output", () => {
    expect(
      parseVerifyWorkflowRunUrl(
        "  https://github.com/octo/app/actions/runs/12345\n",
        { targetRepo: "octo/app" }
      )
    ).toEqual({
      runId: "12345",
      runUrl: "https://github.com/octo/app/actions/runs/12345"
    });
  });

  it.each([
    "",
    "created\nhttps://github.com/octo/app/actions/runs/1",
    "not a URL",
    "http://github.com/octo/app/actions/runs/1",
    "https://example.test/octo/app/actions/runs/1",
    "https://github.com/other/app/actions/runs/1",
    "https://github.com/octo/app/actions/runs/0",
    "https://github.com/octo/app/actions/runs/1?check=true"
  ])("rejects ambiguous or unexpected output %j", (stdout) => {
    expect(() =>
      parseVerifyWorkflowRunUrl(stdout, { targetRepo: "octo/app" })
    ).toThrow();
  });

  it("rejects an invalid repository identity", () => {
    expect(() =>
      parseVerifyWorkflowRunUrl("https://github.com/octo/app/actions/runs/1", {
        targetRepo: "octo/app/extra"
      })
    ).toThrow("target GitHub repository is invalid");
  });
});
