import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { LABELS } from "../../../../scripts/review-risk.mjs";

const workflow = parse(
  readFileSync(
    new URL("../../../../.github/workflows/review-risk.yml", import.meta.url),
    "utf8"
  )
);
const advisory = workflow.jobs.advisory;
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function resolveContext({
  number = 12,
  input = "12",
  name = "pull_request_target",
  ref = "refs/heads/main",
  sha = "a".repeat(40),
  workflowSha = sha
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "review-risk-workflow-"));
  roots.push(root);
  const payload = join(root, "event.json");
  const output = join(root, "output.txt");
  writeFileSync(
    payload,
    JSON.stringify({
      number,
      inputs: { pr: input },
      repository: { default_branch: "main" }
    })
  );
  writeFileSync(output, "");
  const bash =
    process.platform === "win32" ?
      join(process.env.ProgramFiles, "Git", "bin", "bash.exe")
    : "bash";
  const result = spawnSync(bash, ["--noprofile", "--norc", "-s"], {
    input: workflow.jobs.context.steps[0].run,
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: name,
      GITHUB_EVENT_PATH: payload,
      GITHUB_OUTPUT: output,
      GITHUB_REF: ref,
      GITHUB_SHA: sha,
      GITHUB_WORKFLOW_SHA: workflowSha
    },
    encoding: "utf8",
    timeout: 5000
  });
  return { ...result, output: readFileSync(output, "utf8") };
}

describe("advisory workflow trust contract", () => {
  it("uses relevant target events including edits/label repairs without branch, path or draft exclusions", () => {
    expect(workflow.on).toEqual({
      pull_request_target: {
        types: [
          "opened",
          "reopened",
          "synchronize",
          "edited",
          "ready_for_review",
          "labeled",
          "unlabeled"
        ]
      },
      workflow_dispatch: {
        inputs: {
          pr: {
            description: "Single pull request number to reconcile",
            required: true,
            type: "string"
          }
        }
      }
    });
    expect(workflow.permissions).toEqual({});
    expect(Object.keys(workflow.jobs)).toEqual(["context", "advisory"]);
    expect(workflow.jobs.context).not.toHaveProperty("permissions");
    expect(advisory.permissions).toEqual({
      contents: "read",
      "pull-requests": "write"
    });
    expect(advisory["runs-on"]).toBe("ubuntu-latest");
    expect(advisory).not.toHaveProperty("environment");
    expect(advisory).not.toHaveProperty("continue-on-error");
    expect(advisory["timeout-minutes"]).toBe(10);
  });

  it("filters only owned label events at job level and serializes validated event/manual PRs together", () => {
    expect(advisory.needs).toEqual(["context"]);
    expect(advisory.if).toBe(
      "${{\n  needs.context.outputs.pr != '' &&\n  (github.event_name == 'workflow_dispatch' ||\n   (github.event.action != 'labeled' && github.event.action != 'unlabeled') ||\n   contains(fromJSON('[\"risk:low\",\"risk:medium\",\"risk:high\",\"review-instructions-changed\"]'), github.event.label.name))\n}}"
    );
    const filterNames = JSON.parse(
      advisory.if.match(/fromJSON\('([^']+)'\)/)[1]
    );
    expect(filterNames.sort()).toEqual(
      Object.values(LABELS)
        .map((label) => label.name)
        .sort()
    );
    expect(advisory.concurrency).toEqual({
      group:
        "review-risk-${{ github.repository }}-${{ needs.context.outputs.pr }}",
      "cancel-in-progress": false
    });
    expect(workflow.jobs.context.outputs).toEqual({
      pr: "${{ steps.context.outputs.pr }}"
    });
  });

  it("executes only immutable trusted default-branch code, with pinned actions and no app installation/artifacts", () => {
    expect(advisory.env).toEqual({
      REVIEW_RISK_ENABLED: "${{ vars.REVIEW_RISK_ENABLED }}"
    });
    expect(advisory.steps).toEqual([
      {
        name: "Checkout trusted default-branch policy",
        uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        with: {
          ref: "${{ github.workflow_sha }}",
          "persist-credentials": false
        }
      },
      {
        name: "Use repository Node version",
        uses: "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
        with: {
          "node-version-file": ".node-version",
          "package-manager-cache": false
        }
      },
      {
        name: "Reconcile advisory or report disabled",
        run: "node scripts/review-risk.mjs",
        env: { GITHUB_TOKEN: "${{ github.token }}" }
      }
    ]);
  });

  it.each([
    ["pull_request_target", "0012"],
    ["workflow_dispatch", "0012"]
  ])(
    "executes actual context validation for %s with normalized PR key",
    (name, input) => {
      const result = resolveContext({ name, input });
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toBe("pr=12\n");
    }
  );

  it.each([
    { name: "workflow_dispatch", ref: "refs/heads/non-default" },
    { ref: "refs/heads/stack-parent" },
    { sha: "main" },
    { workflowSha: "b".repeat(40) },
    { name: "workflow_dispatch", input: "" },
    { name: "workflow_dispatch", input: "12\nshell" },
    { name: "workflow_dispatch", input: "0" },
    { name: "workflow_dispatch", input: "-1" },
    { name: "workflow_dispatch", input: "1.5" },
    { name: "workflow_dispatch", input: "9007199254740992" },
    { number: null }
  ])("rejects unsafe context before checkout %#", (options) => {
    const result = resolveContext(options);
    expect(result.status).toBe(1);
    expect(result.output).toBe("");
  });
});
