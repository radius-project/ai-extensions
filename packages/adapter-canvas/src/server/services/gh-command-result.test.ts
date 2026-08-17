import { describe, expect, it } from "vitest";
import { toGhCommandResult } from "./gh-command-result.js";

describe("toGhCommandResult", () => {
  it("reports a successful command with exit code 0 and no timeout flag", () => {
    expect(toGhCommandResult(null, "dispatched\n", "")).toEqual({
      code: 0,
      stdout: "dispatched\n",
      stderr: ""
    });
  });

  it("keeps the CLI's own exit code and diagnostic", () => {
    expect(toGhCommandResult({ code: 3 }, "", "HTTP 404: Not Found")).toEqual({
      code: 3,
      stdout: "",
      stderr: "HTTP 404: Not Found"
    });
  });

  it("keeps a string errno, which a spawn failure reports instead of a number", () => {
    expect(toGhCommandResult({ code: "ENOENT" }, "", "")).toMatchObject({
      code: "ENOENT"
    });
  });

  it.each<[code: number | string | null | undefined, label: string]>([
    [null, "a signalled child"],
    [undefined, "an error with no code at all"],
    [0, "an error that reports a zero code"]
  ])("never reads %s (%s) as success", (code) => {
    expect(toGhCommandResult({ code }, "", "boom").code).toBe(1);
  });

  it("flags a child the timeout killed so no fallback re-runs it", () => {
    expect(
      toGhCommandResult({ code: null, killed: true, signal: "SIGTERM" }, "", "")
    ).toEqual({ code: 1, stdout: "", stderr: "", timedOut: true });
  });

  it("trims stdout only when the caller asks for it", () => {
    expect(
      toGhCommandResult(null, "  value  \n", "", { trimStdout: true }).stdout
    ).toBe("value");
    expect(toGhCommandResult(null, "  value  \n", "").stdout).toBe(
      "  value  \n"
    );
  });

  it("normalizes absent stdout and stderr to strings", () => {
    expect(toGhCommandResult(null, undefined, undefined)).toEqual({
      code: 0,
      stdout: "",
      stderr: ""
    });
  });
});
