import { describe, expect, it } from "vitest";
import {
  boundedDiagnostic,
  CommandFailure,
  type SubprocessFailure
} from "./command-failure.js";

describe("command failure diagnostics", () => {
  it.each([
    { code: 1, signal: null, killed: false, timedOut: false },
    { code: "ENOENT", signal: null, killed: false, timedOut: false },
    { code: null, signal: "SIGTERM", killed: true, timedOut: true },
    { code: null, signal: "SIGKILL", killed: true, timedOut: false },
    {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      signal: "SIGTERM",
      killed: true,
      timedOut: false
    }
  ] as const)(
    "preserves exit $code and signal $signal without guessing from output",
    ({ code, signal, killed, timedOut }) => {
      const cause: SubprocessFailure = Object.assign(
        new Error("spawn failed"),
        {
          code,
          signal,
          killed
        }
      );
      const failure = new CommandFailure(cause, "permission denied", 10000, []);
      expect(failure.cause).toMatchObject({
        message: "spawn failed",
        code,
        signal,
        killed
      });
      expect(failure).toMatchObject({
        message: "permission denied",
        code,
        signal,
        timedOut,
        stderr: "permission denied"
      });
    }
  );

  it("uses the spawn message when no stderr exists and no timeout was set", () => {
    const cause = Object.assign(
      new Error("fixture-opaque-credential missing"),
      {
        killed: true,
        signal: "SIGTERM" as const
      }
    );
    const failure = new CommandFailure(cause, "", undefined, [
      "fixture-opaque-credential"
    ]);
    expect(failure).toMatchObject({
      message: "[REDACTED] missing",
      stderr: "",
      code: null,
      signal: "SIGTERM",
      timedOut: false
    });
  });

  it.each([1999, 2000, 2001])(
    "bounds saved text at %i characters",
    (length) => {
      expect(boundedDiagnostic("x".repeat(length))).toBe(
        length > 2000 ? `${"x".repeat(2000)}[truncated]` : "x".repeat(length)
      );
    }
  );

  it("redacts credentials and authorization headers before truncation", () => {
    const text = boundedDiagnostic(
      "opaque-fixture-credential\nAuthorization: Bearer opaque-header\nclient_secret=fixture-value",
      ["opaque-fixture-credential"]
    );
    expect(text).toBe(
      "[REDACTED]\n[REDACTED HEADER]\nclient_secret=[REDACTED]"
    );
  });

  it("preserves safe subprocess cause details without retaining raw captured streams", () => {
    const cause = Object.assign(new Error("opaque-fixture-credential failed"), {
      code: 1,
      stdout: "raw kubeconfig must not be retained",
      stderr: "raw credential must not be retained"
    });
    const failure = new CommandFailure(cause, "permission denied", 10000, [
      "opaque-fixture-credential"
    ]);
    expect(failure.cause).toMatchObject({
      message: "[REDACTED] failed",
      code: 1,
      signal: null,
      killed: false
    });
    expect(JSON.stringify(failure.cause)).not.toContain("raw");
  });

  it.each([
    "apiVersion: v1\nclusters:\n- cluster: private",
    '{"clusters":[{"cluster":"private data"}]}',
    "kind: Config\nprivate data",
    "-----BEGIN PRIVATE KEY-----\nprivate data"
  ])("does not save raw configuration or private keys", (text) => {
    expect(boundedDiagnostic(text)).toBe("[REDACTED CONFIGURATION]");
  });
});
