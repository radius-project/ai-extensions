import { describe, expect, it } from "vitest";
import { setSetupEnvironmentVariable } from "./setup-environment-variable.js";
import { setupEnvironmentHarness } from "../test/support/setup-environment.js";
import type { SetupWorkflowCommandResult } from "./setup-workflow-contracts.js";

const target = {
  targetRepo: "octo/app",
  envName: "dev",
  environmentProviderId: "7"
};

function harness(responses: Partial<SetupWorkflowCommandResult>[]) {
  const h = setupEnvironmentHarness();
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const response = responses.shift();
    if (!response) throw new Error("Unexpected command");
    return { code: 0, stderr: "", stdout: "", ...response };
  };
  return {
    ...h,
    calls,
    ports: {
      recovery: h.ports.recovery,
      run,
      runOrThrow: run,
      digest: (value: string) => `digest:${value}`,
      recordVariable: () => {}
    }
  };
}

describe("setup variable identity and recovery", () => {
  it.each([
    ["array", "[]"],
    ["null", "null"],
    ["scalar", '"7"'],
    ["invalid JSON", "{"],
    ["no id", "{}"],
    ["empty ids", '{"id":"","node_id":""}'],
    ["non-finite serialized id", '{"id":null}']
  ])(
    "refuses %s environment identity before sending the variable",
    async (_, stdout) => {
      const h = harness([{ stdout }]);
      await expect(
        setSetupEnvironmentVariable(target, "NAME", "value", h.ports)
      ).rejects.toThrow(/unreadable|did not report/);
      expect(h.calls).toHaveLength(1);
      expect(h.mutations).toEqual([]);
    }
  );

  it.each([[{ id: 7 }], [{ id: " 7 " }], [{ id: "", node_id: " 7 " }]])(
    "accepts immutable provider identity %j",
    async (identity) => {
      const state = { stdout: JSON.stringify(identity) };
      const absent = { code: 1, stderr: "HTTP 404" };
      const h = harness([
        state,
        absent,
        state,
        state,
        absent,
        state,
        { code: 0 }
      ]);
      expect(
        await setSetupEnvironmentVariable(target, "NAME", "value", h.ports)
      ).toBe(true);
      expect(h.calls.at(-1)?.slice(0, 3)).toEqual(["variable", "set", "NAME"]);
    }
  );

  it.each([
    ["no diagnostic", "", "GitHub environment identity could not be read."],
    ["stdout diagnostic", "denied", "denied"]
  ])("surfaces failed identity read with %s", async (_, stdout, detail) => {
    const h = harness([{ code: 1, stdout }]);
    await expect(
      setSetupEnvironmentVariable(target, "NAME", "value", h.ports)
    ).rejects.toThrow(detail);
  });

  it("does not turn a variable 404 into absence after environment replacement", async () => {
    const h = harness([
      { stdout: '{"id":7}' },
      { code: 1, stderr: "HTTP 404" },
      { stdout: '{"id":8}' }
    ]);
    await expect(
      setSetupEnvironmentVariable(target, "NAME", "value", h.ports)
    ).rejects.toMatchObject({ code: "provider-mutation-manual-required" });
    expect(h.calls).toHaveLength(3);
  });

  it.each([
    ["malformed variable", [{ stdout: '{"id":7}' }, { stdout: "{" }], "old"],
    ["replacement environment", [{ stdout: '{"id":8}' }], 4]
  ] as const)(
    "quarantines %s during readback rather than replaying the write",
    async (_, responses, previousValue) => {
      const h = harness([...responses]);
      h.mutations.push({
        mutationId: "variable",
        kind: "github_environment_variable.put",
        target: "octo/app:dev:NAME",
        status: "prepared",
        evidence: null,
        intent: { previousKnown: true, previousValue }
      });
      await expect(
        setSetupEnvironmentVariable(target, "NAME", "value", h.ports)
      ).rejects.toMatchObject({ code: "provider-mutation-manual-required" });
      expect(h.calls.every((args) => args[0] === "api")).toBe(true);
    }
  );
});
