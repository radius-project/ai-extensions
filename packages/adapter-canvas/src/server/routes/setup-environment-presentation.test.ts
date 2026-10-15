import { describe, expect, it } from "vitest";
import {
  describeSetupEnvironmentFailure,
  presentSetupVerificationSkip,
  reportSetupEnvironment
} from "./setup-environment-presentation.js";

describe("Canvas setup failure presentation", () => {
  it.each([false, true])(
    "distinguishes unavailable and unreadable verification baselines: %s",
    (unreadable) => {
      const steps = ["existing step"];
      expect(
        describeSetupEnvironmentFailure(
          {
            kind: "verification-baseline",
            unreadable,
            detail: "GitHub unavailable"
          },
          {
            steps,
            ociStateBackend: "oci",
            defaultStateArchive: "radius-state"
          }
        )
      ).toEqual({
        status: 502,
        code: "verify-baseline-read-failed",
        error:
          unreadable ?
            "GitHub returned an unreadable verification-run baseline, so Radius did not dispatch the workflow."
          : "Radius could not read the verification-run baseline, so it did not dispatch the workflow. Retry after GitHub Actions run history is readable.",
        extra: unreadable ? { steps } : { steps, ghError: "GitHub unavailable" }
      });
    }
  );

  it("preserves merge and manual PR fallback guidance without exposing domain tags", () => {
    const steps: string[] = [];
    const ports = {
      pushStep: (text: string) => {
        steps.push(text);
      },
      errorMessage: String,
      login: "selected",
      credentialSource: "injected" as const,
      verifyWorkflowFile: "verify.yml"
    };
    expect(presentSetupVerificationSkip({ kind: "merge", reason: "" })).toBe(
      "Credential verification will run automatically once the workflows are on the default branch."
    );
    reportSetupEnvironment(
      {
        kind: "pull-request-failed",
        branch: "setup",
        base: "trunk",
        detail: ""
      },
      ports
    );
    reportSetupEnvironment(
      { kind: "verification-merge-skip", reason: "" },
      ports
    );
    expect(steps).toEqual([
      '⚠️ Committed workflows to branch "setup" but could not open a pull request automatically: GitHub API request failed. Open one manually from that branch into "trunk".',
      "⏭️ Skipping credential verification until the pull request is merged — the workflows are not on the default branch yet."
    ]);
  });
});
