import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Step {
  name: string;
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string | boolean>;
  env?: Record<string, string>;
}

interface Workflow {
  on: Record<string, unknown>;
  permissions: object;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: {
    contracts: {
      if: string;
      permissions: object;
      "timeout-minutes": number;
      steps: Step[];
    };
  };
}

function workflow(): Workflow {
  return parse(
    readFileSync(
      fileURLToPath(
        new URL(
          "../../../../.github/workflows/github-api-contract.yml",
          import.meta.url
        )
      ),
      "utf8"
    )
  );
}

describe("GitHub API contract workflow safety", () => {
  it("runs only by schedule or manual dispatch on the trusted repository", () => {
    const value = workflow();
    expect(Object.keys(value.on).sort()).toEqual([
      "schedule",
      "workflow_dispatch"
    ]);
    expect(value.jobs.contracts.if).toContain(
      "github.repository == 'radius-project/ai-extensions'"
    );
    expect(value.jobs.contracts.if).toContain(
      "github.event_name == 'workflow_dispatch' || vars.GITHUB_CONTRACT_ENABLED == 'true'"
    );
    expect(value.permissions).toEqual({});
    expect(value.jobs.contracts.permissions).toEqual({ contents: "read" });
    expect(value.concurrency).toEqual({
      group: "github-api-contract-sandbox",
      "cancel-in-progress": false
    });
    expect(value.jobs.contracts["timeout-minutes"]).toBe(15);
  });

  it("narrows all installation tokens to the sandbox and required permissions", () => {
    const tokens = workflow().jobs.contracts.steps.filter((step) =>
      step.uses?.startsWith("actions/create-github-app-token@")
    );
    expect(tokens.map((step) => step.id)).toEqual([
      "setup",
      "masked",
      "restricted"
    ]);
    const permissions = tokens.map((step) => {
      expect(step.with?.owner).toBe("${{ steps.sandbox.outputs.owner }}");
      expect(step.with?.repositories).toBe("${{ steps.sandbox.outputs.name }}");
      expect(step.with?.["skip-token-revoke"]).toBeUndefined();
      return Object.fromEntries(
        Object.entries(step.with || {}).filter(([key]) =>
          key.startsWith("permission-")
        )
      );
    });
    expect(permissions).toEqual([
      {
        "permission-administration": "write",
        "permission-actions": "read",
        "permission-contents": "write",
        "permission-workflows": "write"
      },
      { "permission-metadata": "read" },
      { "permission-contents": "write", "permission-actions": "read" }
    ]);
    const run = workflow().jobs.contracts.steps.at(-1);
    expect(run?.run).toBe("pnpm run test:github-contract");
    expect(run?.env?.RUN_LIVE_GITHUB_API_TESTS).toBe("1");
    expect(run?.env?.GITHUB_CONTRACT_SETUP_TOKEN).toBe(
      "${{ steps.setup.outputs.token }}"
    );
    expect(run?.env?.GITHUB_CONTRACT_MASKED_TOKEN).toBe(
      "${{ steps.masked.outputs.token }}"
    );
    expect(run?.env?.GITHUB_CONTRACT_RESTRICTED_TOKEN).toBe(
      "${{ steps.restricted.outputs.token }}"
    );
  });
});
