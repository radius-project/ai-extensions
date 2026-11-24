import { describe, expect, it } from "vitest";
import {
  createOperation,
  finish,
  requireInput,
  requestStop
} from "../operations.js";
import {
  projectEnvironmentApplicationChoices,
  projectEnvironmentOperation,
  projectEnvironmentVerification
} from "./environment-tool-result.js";

const redact = (value: string) =>
  value.replaceAll("opaque-private-value", "[redacted]");
const operation = () =>
  createOperation({
    operationId: "op-1",
    repo: "fixture/app",
    environment: "dev",
    provider: "azure"
  });

describe("allowlisted environment results", () => {
  const appId = (n: number) =>
    `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
  it("projects selectable IDs and dates without leaking arbitrary application metadata", () => {
    const candidate = {
      displayName: "opaque-private-value",
      createdDateTime: "2026-10-01T12:30:00Z",
      credentials: "never-return-this"
    };
    expect(
      projectEnvironmentApplicationChoices(
        {
          candidates: [
            { ...candidate, appId: appId(1) },
            { ...candidate, appId: appId(2) }
          ],
          defaultAppId: appId(2),
          secret: "never-return-this"
        },
        redact
      )
    ).toEqual({
      candidates: [
        {
          appId: appId(1),
          displayName: "[redacted]",
          createdDateTime: candidate.createdDateTime
        },
        {
          appId: appId(2),
          displayName: "[redacted]",
          createdDateTime: candidate.createdDateTime
        }
      ],
      defaultAppId: appId(2),
      truncated: false
    });
  });
  it.each([
    undefined,
    null,
    [],
    {},
    { candidates: "invalid" },
    { candidates: [] }
  ])(
    "safely handles absent or malformed application metadata: %j",
    (metadata) => {
      expect(projectEnvironmentApplicationChoices(metadata, redact)).toEqual({
        candidates: [],
        truncated: false
      });
    }
  );
  it("filters invalid IDs, deduplicates by ID rather than name and rejects invalid dates/defaults", () => {
    const result = projectEnvironmentApplicationChoices(
      {
        candidates: [
          null,
          1,
          { appId: "bad" },
          {
            appId: appId(1),
            displayName: 42,
            createdDateTime: "2026-02-30T12:00:00Z"
          },
          { appId: appId(1), displayName: "duplicate" },
          { appId: appId(2), createdDateTime: "yesterday" },
          { appId: appId(3), createdDateTime: "9999-99-99T99:99:99Z" }
        ],
        defaultAppId: appId(4)
      },
      redact
    );
    expect(result).toEqual({
      candidates: [1, 2, 3].map((n) => ({ appId: appId(n), displayName: "" })),
      truncated: false
    });
  });
  it.each([19, 20, 21])(
    "bounds %s choices and retains a default beyond the visible prefix",
    (count) => {
      const result = projectEnvironmentApplicationChoices(
        {
          candidates: Array.from({ length: count }, (_, n) => ({
            appId: appId(n),
            displayName: "same"
          })),
          defaultAppId: appId(count - 1)
        },
        redact
      );
      expect(result.candidates).toHaveLength(Math.min(count, 20));
      expect(result.candidates.at(-1)?.appId).toBe(appId(count - 1));
      expect(result.defaultAppId).toBe(appId(count - 1));
      expect(result.truncated).toBe(count > 20);
    }
  );
  it.each([199, 200, 201])(
    "bounds a %s-character name and signals truncation",
    (length) => {
      const result = projectEnvironmentApplicationChoices(
        {
          candidates: [{ appId: appId(1), displayName: "x".repeat(length) }],
          defaultAppId: "invalid"
        },
        redact
      );
      expect(result.candidates[0].displayName).toHaveLength(
        Math.min(length, 200)
      );
      expect(result.truncated).toBe(length > 200);
      expect(result.defaultAppId).toBeUndefined();
    }
  );
  it("omits pending Stop so clients cannot treat it as a new command", () => {
    const op = operation();
    requestStop(op);
    expect(projectEnvironmentOperation(op, redact).actions).not.toContain(
      "stop"
    );
  });
  it("exposes only operation identity, state and eligible actions", () => {
    const op = operation();
    op.request = { private: "opaque-private-value" };
    op.context = { githubLogin: "octocat", private: "opaque-private-value" };
    op.currentStage = "configure-environment";
    const value = projectEnvironmentOperation(op, redact);
    expect(value).toEqual({
      operationId: "op-1",
      repo: "fixture/app",
      environment: "dev",
      provider: "azure",
      state: "running",
      terminal: false,
      stage: "configure-environment",
      actions: ["stop"]
    });
    expect(JSON.stringify(value)).not.toContain("opaque-private-value");
  });
  it("bounds redacted diagnostics and never exposes legacy failure evidence", () => {
    const op = operation();
    finish(op, "failed", {
      failure: {
        code: "test",
        message: `opaque-private-value ${"x".repeat(5000)}`,
        evidence: "never-return-this"
      }
    });
    const result = projectEnvironmentOperation(op, redact);
    expect(result.message).toHaveLength(4000);
    expect(result.message).toMatch(/^\[redacted\]/);
    expect(JSON.stringify(result)).not.toContain("never-return-this");
    expect(result.terminal).toBe(true);
  });
  it.each(["provider", "repo", "environment", "state"])(
    "rejects malformed saved %s",
    (key) => {
      const op = operation();
      op[key] = "";
      expect(() => projectEnvironmentOperation(op, redact)).toThrow(
        "valid environment"
      );
    }
  );
  it("refuses deletion operations and only offers supported live Azure prompts", () => {
    const op = operation();
    op.kind = "delete";
    expect(() => projectEnvironmentOperation(op, redact)).toThrow();
    op.kind = "create";
    requireInput(op, {
      code: "app-selection-required",
      checkpoint: "selection"
    });
    expect(projectEnvironmentOperation(op, redact).actions).toContain("resume");
    op.provider = "aws";
    expect(projectEnvironmentOperation(op, redact).actions).not.toContain(
      "resume"
    );
  });
  it.each([
    "pending",
    "in_progress",
    "success",
    "failed",
    "unknown",
    "expired"
  ])("preserves %s evidence without inventing run data", (state) => {
    expect(
      projectEnvironmentVerification({ state, logs: ["hidden"] }, redact)
    ).toEqual({ state });
  });
  it("allowlists run URLs and redacts before truncating observation errors", () => {
    expect(
      projectEnvironmentVerification(
        {
          state: "failed",
          runId: 42,
          runUrl: "https://github.com/fixture/app/actions/runs/42",
          error: "opaque-private-value",
          rawLogs: "private"
        },
        redact
      )
    ).toEqual({
      state: "failed",
      runId: "42",
      runUrl: "https://github.com/fixture/app/actions/runs/42",
      message: "[redacted]"
    });
    expect(
      projectEnvironmentVerification(
        {
          state: "unknown",
          runId: "not-a-run",
          runUrl: "https://other.example/private"
        },
        redact
      )
    ).toEqual({ state: "unknown" });
    expect(() =>
      projectEnvironmentVerification({ state: "complete" }, redact)
    ).toThrow("unsupported");
  });
});
