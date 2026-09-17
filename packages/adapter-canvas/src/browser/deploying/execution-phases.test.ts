import { expect, it } from "vitest";
import { executionPhaseSummary } from "./execution-phases.js";

it("renders only fixed phase labels and distinguishes skipped from inapplicable", () => {
  expect(
    executionPhaseSummary([
      {
        phase: "command",
        status: "failed",
        reason: "<script>untrusted</script>"
      },
      { phase: "state-save", status: "skipped" },
      { phase: "cleanup", status: "not_applicable" }
    ])
  ).toBe(
    "Execution phases: Command: failed; State save: required but skipped; Cleanup: not applicable."
  );
  expect(executionPhaseSummary(undefined)).toBe("");
});
it.each([
  null,
  [],
  "unavailable",
  Array(7).fill({ phase: "restore", status: "succeeded" }),
  [null],
  ["restore"],
  [{ status: "failed" }],
  [{ phase: "restore" }],
  [{ phase: "<script>", status: "failed" }],
  [{ phase: "restore", status: "secret-text" }],
  [
    { phase: "restore", status: "unknown" },
    { phase: "restore", status: "failed" }
  ]
])("does not invent phase detail for malformed evidence %j", (value) => {
  expect(executionPhaseSummary(value)).toBe("Phase details unavailable.");
});
