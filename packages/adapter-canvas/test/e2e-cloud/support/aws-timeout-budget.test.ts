import { describe, expect, it } from "vitest";
import {
  AWS_NODE_GROUP_START_TIMEOUT_MS,
  AWS_PROBE_CONNECT_TIMEOUT_SECONDS,
  AWS_PROBE_RUN_TIMEOUT_MS,
  AWS_PROBE_START_TIMEOUT_MS,
  AWS_SERIAL_TEST_TIMEOUT_BUDGET_MS,
  AWS_SETTLE_MS,
  AWS_STAGE_TIMEOUTS_MS,
  AWS_SUITE_TIMEOUT_MS
} from "./aws-timeout-budget.js";
import { CLOUD_INSTALLATION_TOKEN_LIFETIME_MS } from "./cloud-timeout-budget.js";

describe("AWS Cloud E2E time budget", () => {
  it("has a limit for each of the ten stages, and they fit the AWS suite", () => {
    expect(Object.keys(AWS_STAGE_TIMEOUTS_MS)).toHaveLength(10);
    expect(AWS_SERIAL_TEST_TIMEOUT_BUDGET_MS).toBe(
      Object.values(AWS_STAGE_TIMEOUTS_MS).reduce((sum, item) => sum + item, 0)
    );
    expect(AWS_SERIAL_TEST_TIMEOUT_BUDGET_MS).toBeLessThanOrEqual(
      AWS_SUITE_TIMEOUT_MS
    );
  });

  it("keeps each stage inside one GitHub App token's lifetime", () => {
    for (const limit of Object.values(AWS_STAGE_TIMEOUTS_MS))
      expect(limit).toBeLessThanOrEqual(CLOUD_INSTALLATION_TOKEN_LIFETIME_MS);
  });

  it("fits the node group start and the preflight's settle wait in the preflight stage", () => {
    expect(AWS_NODE_GROUP_START_TIMEOUT_MS + AWS_SETTLE_MS).toBeLessThan(
      AWS_STAGE_TIMEOUTS_MS.preflight
    );
  });

  it("fits a default and an isolated probe in the connection check", () => {
    expect(AWS_PROBE_CONNECT_TIMEOUT_SECONDS * 1000).toBeLessThan(
      AWS_PROBE_RUN_TIMEOUT_MS
    );
    expect(
      2 * (AWS_PROBE_START_TIMEOUT_MS + AWS_PROBE_RUN_TIMEOUT_MS)
    ).toBeLessThanOrEqual(AWS_STAGE_TIMEOUTS_MS.connectionCheck);
  });
});
