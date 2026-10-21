import { describe, expect, it } from "vitest";
import {
  automaticBranchVerificationPolicyMessage,
  buildVerifyWorkflowDispatchArgs,
  describeMergeRequiredTerminal,
  describePullRequestNextStep,
  describeVerificationDispatch,
  hasWorkflowRunTrigger,
  parseVerifyWorkflowRunUrl,
  type PullRequestNextStep
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

  describe("automatic setup-branch verification safety", () => {
    it.each([
      ["enabled", { state: "enabled" } as const, ""],
      [
        "an existing verify workflow",
        { state: "disabled", reason: "verify-present" } as const,
        ""
      ],
      [
        "an unreadable verify workflow",
        { state: "disabled", reason: "verify-unreadable" } as const,
        "could not safely read"
      ],
      [
        "a chained dispatcher",
        { state: "disabled", reason: "dispatcher-legacy-chain" } as const,
        "can still auto-run"
      ],
      [
        "an unreadable dispatcher",
        { state: "disabled", reason: "dispatcher-unreadable" } as const,
        "could not safely inspect"
      ],
      [
        "a legacy deploy workflow",
        { state: "disabled", reason: "legacy-deploy-present" } as const,
        "legacy deploy workflow"
      ],
      [
        "an unreadable legacy deploy workflow",
        { state: "disabled", reason: "legacy-deploy-unreadable" } as const,
        "could not safely confirm"
      ]
    ])(
      "describes %s without exposing internal reason codes",
      (_name, policy, text) => {
        expect(automaticBranchVerificationPolicyMessage(policy)).toContain(
          text
        );
      }
    );
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
          'workflow "radius-verify-credentials.yml", environment "dev", repository "octo/app", ref "trunk".'
      );
    }
  );
});

describe("pull request next step", () => {
  // Listed once so a new outcome cannot be added without the invariants below
  // covering it.
  const ALL_OUTCOMES = [
    "verification-running",
    "awaiting-merge",
    "awaiting-credentials",
    "awaiting-merge-and-credentials"
  ] as const satisfies readonly PullRequestNextStep[];

  it("reports verification as running when the dispatch already went out", () => {
    expect(
      describePullRequestNextStep({
        outcome: "verification-running",
        baseBranch: "main",
        ref: "radius/setup-dev-workflows-abc"
      })
    ).toBe(
      'Credential verification is running against branch "radius/setup-dev-workflows-abc", ' +
        'so it is not waiting for the merge. Merging the pull request above puts the workflows on "main".'
    );
  });

  it("tells the customer to retry verification after merging", () => {
    expect(
      describePullRequestNextStep({
        outcome: "awaiting-merge",
        baseBranch: "main",
        ref: "radius/setup-dev-workflows-abc"
      })
    ).toBe(
      'Merge the pull request above to put the workflows on "main", then retry credential verification.'
    );
  });

  // Merging is not what unblocks this customer, so the guidance must not spend
  // its one sentence telling them to merge "to finish setup".
  it("names the credentials, not the merge, as the blocker when they are incomplete", () => {
    const message = describePullRequestNextStep({
      outcome: "awaiting-credentials",
      baseBranch: "main",
      ref: "radius/setup-dev-workflows-abc"
    });
    expect(message).toBe(
      'Merging the pull request above puts the workflows on "main", but credential ' +
        "verification is waiting on the cloud credentials above, not on the merge."
    );
    expect(message).not.toContain("to finish setup");
  });

  // Merging is necessary here but not sufficient, so the guidance must name
  // both blockers rather than implying the merge is the last step.
  it("names both blockers when the merge and the credentials are outstanding", () => {
    const message = describePullRequestNextStep({
      outcome: "awaiting-merge-and-credentials",
      baseBranch: "main",
      ref: "radius/setup-dev-workflows-abc"
    });
    expect(message).toBe(
      'Merge the pull request above to put the workflows on "main", and finish the cloud ' +
        "credentials above. Credential verification is waiting on both, so merging alone " +
        "will not start it."
    );
    expect(message).not.toContain("run once it lands");
  });

  it("never promises that merging starts verification", () => {
    const promising = ALL_OUTCOMES.filter((outcome) =>
      /run once it lands/.test(
        describePullRequestNextStep({ outcome, baseBranch: "main", ref: "x" })
      )
    );
    expect(promising).toEqual([]);
  });

  // The two claims are opposites, so no single message may make both.
  it("never says verification waits for the merge while it is already running", () => {
    for (const baseBranch of ["main", "trunk"]) {
      for (const outcome of ALL_OUTCOMES) {
        const message = describePullRequestNextStep({
          outcome,
          baseBranch,
          ref: "setup"
        });
        expect(
          /is running against branch/.test(message) &&
            /run once it lands/.test(message)
        ).toBe(false);
      }
    }
  });

  it("names the branch verification runs against only when it is running", () => {
    for (const outcome of ALL_OUTCOMES.filter(
      (candidate) => candidate !== "verification-running"
    )) {
      expect(
        describePullRequestNextStep({
          outcome,
          baseBranch: "main",
          ref: "radius/setup-dev-workflows-abc"
        })
      ).not.toContain("radius/setup-dev-workflows-abc");
    }
  });
});

describe("merge-required terminal message", () => {
  // The headline is more prominent than the step, so it must not promise what
  // the step withdrew.
  it("does not promise the merge starts verification when credentials also block", () => {
    const message = describeMergeRequiredTerminal({
      outcome: "awaiting-merge-and-credentials",
      branch: "radius/setup-dev-workflows-abc",
      baseBranch: "main",
      hasPullRequest: true
    });
    expect(message).toBe(
      "Merge the pull request and finish the cloud credentials to complete setup. " +
        "Credential verification is waiting on both, so merging alone will not start it."
    );
    expect(message).not.toContain("run once it lands");
  });

  it("keeps the existing promise when the merge is the only blocker", () => {
    expect(
      describeMergeRequiredTerminal({
        outcome: "awaiting-merge",
        branch: "radius/setup-dev-workflows-abc",
        baseBranch: "main",
        hasPullRequest: true
      })
    ).toBe(
      "Merge the pull request, then retry credential verification to finish setup."
    );
  });

  it("names both blockers when the pull request must be opened by hand", () => {
    expect(
      describeMergeRequiredTerminal({
        outcome: "awaiting-merge-and-credentials",
        branch: "radius/setup-dev-workflows-abc",
        baseBranch: "main",
        hasPullRequest: false
      })
    ).toBe(
      'Open and merge a pull request from "radius/setup-dev-workflows-abc" into "main", ' +
        "and finish the cloud credentials, to complete setup. Credential verification is " +
        "waiting on both, so merging alone will not start it."
    );
  });

  it("keeps the existing manual instruction when the merge is the only blocker", () => {
    expect(
      describeMergeRequiredTerminal({
        outcome: "awaiting-merge",
        branch: "radius/setup-dev-workflows-abc",
        baseBranch: "main",
        hasPullRequest: false
      })
    ).toBe(
      'Open and merge a pull request from "radius/setup-dev-workflows-abc" into "main" to finish setup.'
    );
  });

  // The step and the headline are the same answer shown in two places, so the
  // pair is what matters, not either string alone.
  it("agrees with the step for every outcome that reaches it", () => {
    for (const outcome of [
      "awaiting-merge",
      "awaiting-merge-and-credentials"
    ] as const) {
      const step = describePullRequestNextStep({
        outcome,
        baseBranch: "main",
        ref: "setup"
      });
      const headline = describeMergeRequiredTerminal({
        outcome,
        branch: "setup",
        baseBranch: "main",
        hasPullRequest: true
      });
      expect(/run once it lands/.test(step)).toBe(
        /run once it lands/.test(headline)
      );
      expect(/will not start it/.test(step)).toBe(
        /will not start it/.test(headline)
      );
    }
  });
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
