import { describe, expect, it } from "vitest";
import {
  commandTimedOut,
  needsWorkflowScope,
  shouldRetryWithKeyringCredential
} from "./workflow-credential-fallback.js";

// Both functions are pure, so every branch is exercised directly against the
// diagnostics gh actually emits.

describe("needsWorkflowScope", () => {
  it.each([
    [
      "HTTP 403: refusing to allow an OAuth App to create or update workflow `.github/workflows/x.yml` without `workflow` scope"
    ],
    ["error: workflow scope is required for this operation"],
    ['refusing without "workflow" scope'],
    [
      "HTTP 403: refusing to allow a GitHub App to create or update workflow `.github/workflows/x.yml` without `workflows` permission"
    ]
  ])("recognises %s as a missing workflow scope", (stderr) => {
    expect(needsWorkflowScope(stderr)).toBe(true);
  });

  it.each<[stderr: string | undefined, label: string]>([
    ["HTTP 404: Not Found", "an unrelated HTTP failure"],
    ["protected branch update failed", "a protected-branch rejection"],
    [
      "HTTP 403: Resource not accessible by integration",
      "a generic permission refusal"
    ],
    ["", "an empty message"],
    [undefined, "an absent message"]
  ])("does not claim a missing workflow scope for %s", (stderr) => {
    expect(needsWorkflowScope(stderr)).toBe(false);
  });
});

describe("commandTimedOut", () => {
  it.each<[error: unknown, label: string]>([
    [{ killed: true, signal: "SIGTERM" }, "a child the timeout killed"],
    [{ killed: true }, "a killed child with no signal reported"],
    [{ signal: "SIGKILL" }, "a signalled child"]
  ])("reports %s as an unknown outcome", (error) => {
    expect(commandTimedOut(error as { killed?: boolean })).toBe(true);
  });

  it.each<[error: unknown, label: string]>([
    [{ code: 1, killed: false, signal: null }, "an ordinary non-zero exit"],
    [{}, "an error carrying no termination detail"],
    [null, "a command that succeeded"],
    [undefined, "a missing error"]
  ])("does not report %s as a timeout", (error) => {
    expect(commandTimedOut(error as { killed?: boolean } | null)).toBe(false);
  });
});

describe("shouldRetryWithKeyringCredential", () => {
  const scopeFailure =
    "HTTP 403: refusing to allow an OAuth App to create or update workflow `.github/workflows/deploy.yml` without `workflow` scope";

  it("retries a scope rejection when there is an injected token to strip", () => {
    expect(
      shouldRetryWithKeyringCredential({
        stderr: scopeFailure,
        hasInjectedToken: true
      })
    ).toBe(true);
  });

  it("does not retry when there is no injected token to strip", () => {
    expect(
      shouldRetryWithKeyringCredential({
        stderr: scopeFailure,
        hasInjectedToken: false
      })
    ).toBe(false);
  });

  it("does not retry a command that timed out, whose request may already have been accepted", () => {
    expect(
      shouldRetryWithKeyringCredential({
        stderr: scopeFailure,
        timedOut: true,
        hasInjectedToken: true
      })
    ).toBe(false);
  });

  it.each<[stderr: string | undefined, label: string]>([
    ["HTTP 404: Not Found", "a not-found dispatch"],
    ["protected branch update failed", "a protected branch"],
    [
      "HTTP 403: Resource not accessible by integration",
      "an unspecific permission refusal"
    ],
    ["", "a command that produced no diagnostic"],
    [undefined, "a command with no stderr at all"]
  ])("does not retry %s (%s)", (stderr) => {
    expect(
      shouldRetryWithKeyringCredential({
        stderr,
        hasInjectedToken: true
      })
    ).toBe(false);
  });
});
