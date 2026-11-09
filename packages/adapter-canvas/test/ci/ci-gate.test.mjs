import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(
    new URL("../../../../.github/workflows/build.yml", import.meta.url),
    "utf8"
  )
);
const gate = workflow.jobs["ci-gate"];
const bash =
  process.platform === "win32" ?
    join(process.env.ProgramFiles, "Git", "bin", "bash.exe")
  : "bash";
const jobs = Object.keys(workflow.jobs).filter((job) => job !== "ci-gate");

function runGate(needs) {
  return spawnSync(bash, ["--noprofile", "--norc", "-s"], {
    input: gate.steps[0].run,
    env: { ...process.env, NEEDS: JSON.stringify(needs) },
    encoding: "utf8",
    timeout: 5_000
  });
}

function successfulJobs() {
  return Object.fromEntries(jobs.map((job) => [job, { result: "success" }]));
}

describe("required CI gate", () => {
  it("reports on every pull request and runs even when a dependency fails", () => {
    expect(workflow.on).toHaveProperty("pull_request", null);
    expect(gate.name).toBe("CI gate");
    expect(gate.if).toBe("${{ always() }}");
    expect([...gate.needs].sort()).toEqual([...jobs].sort());
    expect(gate).not.toHaveProperty("continue-on-error");
    expect(gate.steps[0].env.NEEDS).toBe("${{ toJSON(needs) }}");
    expect(gate.steps[0].shell).toBe("bash");
    expect(gate.steps[0]).not.toHaveProperty("if");
    expect(gate.steps[0]).not.toHaveProperty("continue-on-error");
  });

  it("passes only when every build job and matrix succeeds", () => {
    const result = runGate(successfulJobs());
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("::error::");
  });

  describe.each(jobs)("%s", (job) => {
    it.each(["failure", "cancelled", "skipped"])(
      "blocks merge when its result is %s",
      (outcome) => {
        const result = runGate({
          ...successfulJobs(),
          [job]: { result: outcome }
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout).toContain("::error::");
        expect(result.stdout).toContain(job);
        expect(result.stdout).toContain(outcome);
      }
    );
  });

  it.each([{}, { job: {} }, { job: { result: "unknown" } }])(
    "fails closed for missing or unknown results: %j",
    (needs) => {
      const result = runGate(needs);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain("::error::");
    }
  );
});
