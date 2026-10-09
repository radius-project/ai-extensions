import { describe, expect, it } from "vitest";
import {
  describeWorkflowProtection,
  parseWorkflowProtection
} from "./workflow-protection.js";
import { observeWorkflowRun } from "./workflow-observation.js";

const pending = {
  environment: { id: 1, name: "production" },
  wait_timer: 0,
  wait_timer_started_at: null,
  current_user_can_approve: false,
  reviewers: []
};

describe("workflow protection evidence", () => {
  it("retains only normalized facts and sorts environments for stable narration", () => {
    const result = parseWorkflowProtection([
      {
        ...pending,
        environment: { id: 2, name: "<production>", url: "untrusted" },
        wait_timer: 43200,
        wait_timer_started_at: "2026-01-01T00:00:00.123Z",
        current_user_can_approve: true,
        reviewers: [
          { type: "User", reviewer: { id: 1, login: "private-name" } },
          { type: "Team", reviewer: { id: 2 } }
        ]
      },
      pending
    ]);
    expect(result).toEqual({
      state: "observed",
      environments: [
        {
          id: 1,
          name: "production",
          waitTimerMinutes: 0,
          reviewersConfigured: false,
          currentAccountCanApprove: false
        },
        {
          id: 2,
          name: "<production>",
          waitTimerMinutes: 43200,
          reviewersConfigured: true,
          currentAccountCanApprove: true
        }
      ]
    });
    expect(describeWorkflowProtection(result)).toBe(
      'Observation: environment "production" is waiting on protection rules.\n' +
        'Observation: environment "<production>" is waiting on protection rules. Required reviewers are configured. A 43200-minute wait timer is configured. The GitHub account used for this read can approve.'
    );
    expect(JSON.stringify(result)).not.toMatch(/private-name|untrusted/);
  });

  it.each([
    null,
    {},
    [null],
    [[]],
    [{ ...pending, environment: null }],
    [{ ...pending, environment: { id: 0, name: "dev" } }],
    [{ ...pending, environment: { id: -1, name: "dev" } }],
    [{ ...pending, environment: { id: 1.5, name: "dev" } }],
    [
      {
        ...pending,
        environment: { id: Number.MAX_SAFE_INTEGER + 1, name: "dev" }
      }
    ],
    [{ ...pending, environment: { id: "1", name: "dev" } }],
    [{ ...pending, environment: { id: 1, name: "" } }],
    [{ ...pending, environment: { id: 1, name: " " } }],
    [{ ...pending, environment: { id: 1, name: 2 } }],
    [pending, pending],
    [{ ...pending, wait_timer: -1 }],
    [{ ...pending, wait_timer: 43201 }],
    [{ ...pending, wait_timer: 1.5 }],
    [{ ...pending, wait_timer: "0" }],
    [{ ...pending, wait_timer_started_at: undefined }],
    [{ ...pending, wait_timer_started_at: "yesterday" }],
    [{ ...pending, wait_timer_started_at: "2026-99-99T00:00:00Z" }],
    [{ ...pending, wait_timer_started_at: "2026-02-30T00:00:00Z" }],
    [{ ...pending, current_user_can_approve: "true" }],
    [{ ...pending, reviewers: null }],
    [{ ...pending, reviewers: [null] }],
    [{ ...pending, reviewers: [{ type: "Unknown", reviewer: { id: 1 } }] }],
    [{ ...pending, reviewers: [{ type: "User", reviewer: null }] }],
    [{ ...pending, reviewers: [{ type: "Team", reviewer: { id: 0 } }] }]
  ])("keeps malformed evidence unknown: %j", (value) => {
    expect(parseWorkflowProtection(value)).toEqual({
      state: "unavailable",
      reason: "invalid-data"
    });
  });

  it("does not interpret absence or unreadability as approval", () => {
    expect(describeWorkflowProtection(parseWorkflowProtection([]))).toBe(
      "Observation: GitHub returned no pending environments; this does not establish approval or deployment success."
    );
    expect(describeWorkflowProtection(parseWorkflowProtection(null))).toBe(
      "Observation: environment protection details are unavailable (invalid-data); approval status is unknown."
    );
  });

  it("carries protection evidence through normalization without changing opt-out results", async () => {
    const protection = parseWorkflowProtection([pending]);
    const data = { status: "waiting", conclusion: null };
    const plain = await observeWorkflowRun(
      { repo: "org/app", runId: 41 },
      { readRun: async () => ({ data, includeJobs: true }) }
    );
    const enriched = await observeWorkflowRun(
      { repo: "org/app", runId: 41 },
      { readRun: async () => ({ data, includeJobs: true, protection }) }
    );
    expect(plain).not.toHaveProperty("protection");
    expect(enriched).toEqual({ ...plain, protection });
  });
});
