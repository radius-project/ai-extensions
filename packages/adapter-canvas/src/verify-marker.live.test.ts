// The operation marker, rendered from the REAL upstream verify template.
//
// `configureVerifyOperationMarker` inserts a `radius_operation` dispatch input
// and a `run-name` into the template it is handed, and `verification-plan`
// decides whether to send `-f radius_operation` by asking
// `hasVerificationOperationMarker` about the installed file. Those two must
// agree: if the marker is ever absent, the dispatch sends an input GitHub
// rejects with 422, which the mutation journal reads as a conclusive refusal,
// and every environment creation fails with a message about the dispatch
// rather than about the template.
//
// The hermetic test in `infra.test.ts` pins that round trip against a fixture.
// Only a live render catches the case the fixture cannot: the upstream template
// changing shape so the insertion no longer finds its anchor. The generator
// throws in that case, so this test fails loudly on the real file.
//
// This hits the network and depends on an external repo's moving ref, so it is
// NOT part of the default hermetic suite. The live CI workflow sets
// RUN_LIVE_WORKFLOW_TESTS on pull requests, pushes to main, and nightly.
import { describe, it, expect } from "vitest";
import { generateVerifyWorkflow } from "./infra.js";
import { hasVerificationOperationMarker } from "./verification-run-identity.js";

const LIVE = !!process.env.RUN_LIVE_WORKFLOW_TESTS;

// The ported template tree only exists on this PR's branch until it merges, so
// fetch at the branch head sha the live CI workflow passes rather than `main`.
const LIVE_REF = process.env.RADIUS_LIVE_REF?.trim() || undefined;

describe.skipIf(!LIVE)(
  "live verify marker round trip (opt-in: set RUN_LIVE_WORKFLOW_TESTS)",
  () => {
    it.each([["azure"], ["aws"]])(
      "renders a %s verify workflow the planner recognises as marked",
      async (provider) => {
        const workflow = await generateVerifyWorkflow(
          "prod",
          provider,
          LIVE_REF
        );

        // The exact predicate `planCredentialVerification` calls, so this
        // asserts the contract those two modules actually share rather than
        // the substrings that happen to implement it today.
        expect(hasVerificationOperationMarker(workflow)).toBe(true);
      },
      30_000
    );
  }
);
