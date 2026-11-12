import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(
    new URL("../../../../.github/workflows/codeql.yml", import.meta.url),
    "utf8"
  )
);
const analysis = workflow.jobs.analyze;
const gate = workflow.jobs["codeql-gate"];
const bash =
  process.platform === "win32" ?
    join(process.env.ProgramFiles, "Git", "bin", "bash.exe")
  : "bash";

function runGate(needs) {
  return spawnSync(bash, ["--noprofile", "--norc", "-s"], {
    input: gate.steps[0].run,
    env: { ...process.env, NEEDS: JSON.stringify(needs) },
    encoding: "utf8",
    timeout: 5_000
  });
}

describe("CodeQL workflow", () => {
  it("analyzes every pull request, including stacks, and refreshes main", () => {
    expect(workflow.on).toEqual({
      pull_request: null,
      push: { branches: ["main"] },
      schedule: [{ cron: "23 7 * * 2" }],
      workflow_dispatch: null
    });
    expect(workflow.permissions).toEqual({});
    expect(Object.keys(workflow.jobs).sort()).toEqual([
      "analyze",
      "codeql-gate"
    ]);
  });

  it("runs each language independently with only checkout and upload privileges", () => {
    expect(analysis["runs-on"]).toBe("ubuntu-latest");
    expect(analysis.permissions).toEqual({
      contents: "read",
      "security-events": "write"
    });
    expect(analysis.strategy).toEqual({
      "fail-fast": false,
      matrix: { language: ["javascript-typescript", "actions"] }
    });
    expect(analysis).not.toHaveProperty("if");
    expect(analysis).not.toHaveProperty("continue-on-error");
    expect(analysis).not.toHaveProperty("env");
    expect(workflow).not.toHaveProperty("env");
  });

  it("uses pinned actions without executing application install or build scripts", () => {
    expect(analysis.steps).toEqual([
      {
        name: "Checkout",
        uses: expect.stringMatching(/^actions\/checkout@[a-f0-9]{40}$/),
        with: { "persist-credentials": false }
      },
      {
        name: "Initialize CodeQL",
        uses: expect.stringMatching(
          /^github\/codeql-action\/init@[a-f0-9]{40}$/
        ),
        with: {
          languages: "${{ matrix.language }}",
          "build-mode": "none",
          queries: "security-extended",
          tools: "linked"
        }
      },
      {
        name: "Analyze and upload",
        uses: expect.stringMatching(
          /^github\/codeql-action\/analyze@[a-f0-9]{40}$/
        ),
        with: { category: "/language:${{ matrix.language }}" }
      }
    ]);
    expect(analysis.steps[1].uses.split("@")[1]).toBe(
      analysis.steps[2].uses.split("@")[1]
    );
    const categories = analysis.strategy.matrix.language.map((language) =>
      analysis.steps[2].with.category.replace(
        "${{ matrix.language }}",
        language
      )
    );
    expect(categories).toEqual([
      "/language:javascript-typescript",
      "/language:actions"
    ]);
  });

  it("keeps the completion check unconditional, unprivileged and source-bound", () => {
    expect(gate.name).toBe("CodeQL analysis gate");
    expect(gate.if).toBe("${{ always() }}");
    expect(gate.needs).toEqual(["analyze"]);
    expect(gate["runs-on"]).toBe("ubuntu-latest");
    expect(gate).not.toHaveProperty("permissions");
    expect(gate).not.toHaveProperty("continue-on-error");
    expect(gate.steps).toHaveLength(1);
    expect(gate.steps[0].env).toEqual({ NEEDS: "${{ toJSON(needs) }}" });
    expect(gate.steps[0].shell).toBe("bash");
    expect(gate.steps[0]).not.toHaveProperty("if");
    expect(gate.steps[0]).not.toHaveProperty("continue-on-error");
  });

  it("passes when the complete analysis matrix succeeds", () => {
    const result = runGate({ analyze: { result: "success" } });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("::error::");
  });

  it.each(["failure", "cancelled", "skipped", "unknown", ""])(
    "rejects the matrix result %j with a diagnostic",
    (outcome) => {
      const result = runGate({ analyze: { result: outcome } });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain("::error::");
      expect(result.stdout).toContain("analyze");
      expect(result.stdout).toContain(JSON.stringify(outcome));
    }
  );

  it.each([
    {},
    { analyze: {} },
    { analyze: { result: null } },
    { analyze: null },
    { other: { result: "success" } },
    { analyze: { result: "success" }, other: { result: "success" } },
    [],
    null
  ])("fails closed for missing or unexpected results: %j", (needs) => {
    const result = runGate(needs);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("::error::");
    expect(result.stdout).toContain(
      "Both CodeQL language analyses must succeed"
    );
  });
});
