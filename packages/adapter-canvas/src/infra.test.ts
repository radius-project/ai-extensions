import { describe, it, expect, beforeEach, vi } from "vitest";
import * as yaml from "js-yaml";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface RecordedCommit {
  path: string;
  content: string;
  branch: string;
  message: string;
}

interface InfraMockState {
  committed: Record<string, Record<string, string>>;
  commits: RecordedCommit[];
  upstream: Record<string, string>;
  // When true, commitFileToRepo rejects (mirrors gh.ts, which throws on a failed
  // PUT — e.g. a protected branch) so tests can exercise the `failed` path.
  failCommits: boolean;
}

// Shared mock state for the ./gh.ts stub. `vi.hoisted` runs before the module
// factory below so the mock can close over it. `committed` is keyed by branch:
// `{ [branch]: { [path]: body } }`, mirroring that each branch has its own copy
// of the committed workflow files (and an unpushed branch has none). BASE_UPSTREAM
// is created inside the hoisted factory so it exists before the factory runs (a
// module-level const would be in the temporal dead zone when hoisted runs).
const { h, BASE_UPSTREAM } = vi.hoisted<{
  h: InfraMockState;
  BASE_UPSTREAM: Record<string, string>;
}>(() => {
  const BASE_UPSTREAM: Record<string, string> = {
    // Minimal stand-ins for radius-project/radius/.github/extension templates.
    "verify-azure.yml":
      "name: verify\njobs:\n  v:\n    default: '{{ENV}}'\n    uses: radius-project/radius/.github/extension/actions/verify-ghcr-push@{{RADIUS_REF}}\n",
    "verify-aws.yml":
      "name: verify\njobs:\n  v:\n    default: '{{ENV}}'\n    uses: radius-project/radius/.github/extension/actions/verify-ghcr-push@{{RADIUS_REF}}\n",
    "run-rad-commands.yml":
      "name: deploy\non:\n  workflow_dispatch:\n    inputs:\n      environment:\n        default: '{{ENV}}'\njobs:\n  detect:\n    run: echo hi\n",
    "run-rad-commands-azure.yml":
      "name: deploy-azure\nenv:\n  APP_FILE: '{{APP_FILE}}'\njobs:\n  a:\n    uses: radius-project/radius/.github/extension/actions/run-rad-commands@{{RADIUS_REF}}\n",
    "delete-application.yml": `name: delete
on:
  workflow_dispatch:
    inputs:
      environment:
        default: '{{ENV}}'
      application:
        required: true
jobs:
  azure:
    uses: ./.github/workflows/delete-azure.yml
    with:
      environment: \${{ inputs.environment }}
      resource_type: application
      name: \${{ inputs.application }}
`,
    // A trimmed but structurally faithful copy of the real upstream
    // radius-project/radius/.github/extension/delete-azure.yml: job-level
    // `environment:`/`env:` between `  delete:` and its `steps:`, the
    // `AZURE_CLIENT_ID`-gated Azure Login, and the GHCR docker/login-action
    // used later for the restore/teardown actions. This is the shape
    // `addDeleteStateCheck` actually patches in production, so a wrong
    // injection point here would fail these tests too.
    "delete-azure.yml": `name: Radius - Delete (Azure)
on:
  workflow_call:
    inputs:
      environment:
        type: string
        required: true
      resource_type:
        type: string
        required: true
      name:
        type: string
        required: true
permissions:
  id-token: write
  contents: write
  packages: write
env:
  ENVIRONMENT: \${{ inputs.environment }}
jobs:
  delete:
    name: Delete with Radius
    runs-on: ubuntu-24.04
    environment: \${{ inputs.environment }}
    env:
      RADIUS_STATE_BACKEND: \${{ vars.RADIUS_STATE_BACKEND }}
      RADIUS_STATE_REGISTRY: \${{ vars.RADIUS_STATE_REGISTRY }}
      RADIUS_STATE_ARCHIVE: \${{ vars.RADIUS_STATE_ARCHIVE }}
    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v4

      - name: Azure Login (OIDC)
        if: \${{ vars.AZURE_CLIENT_ID != '' }}
        uses: azure/login@f5d393ae46f8fde4be8b75f32e3fc50e654ad0ca # v3.0.1
        with:
          client-id: \${{ vars.AZURE_CLIENT_ID }}
          tenant-id: \${{ vars.AZURE_TENANT_ID }}
          subscription-id: \${{ vars.AZURE_SUBSCRIPTION_ID }}

      - name: Log in to GHCR for the state archive
        uses: docker/login-action@dbcb813823bdd20940b903addbd779551569679f # v4.6.0
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}

      - name: Restore Radius state
        uses: radius-project/radius/.github/extension/actions/restore-state@{{RADIUS_REF}}

      - name: Delete Radius resource
        uses: radius-project/radius/.github/extension/actions/delete-resource@{{RADIUS_REF}}
        with:
          resource-type: \${{ inputs.resource_type }}
          name: \${{ inputs.name }}

      - name: Teardown
        if: always()
        uses: radius-project/radius/.github/extension/actions/teardown@{{RADIUS_REF}}
`
  };
  return {
    BASE_UPSTREAM,
    h: {
      committed: {}, // branch -> { path -> committed body } (absent = file missing)
      commits: [], // recorded commitFileToRepo calls
      failCommits: false, // when true, commitFileToRepo rejects
      upstream: { ...BASE_UPSTREAM }
    }
  };
});

vi.mock("./gh.js", () => ({
  cliExec: () => {},
  fetchFileFromRepoResult: async (_repo: string, path: string) => {
    const file = path.split("/").pop();
    const body = file ? h.upstream[file] : undefined;
    return body == null ?
        { content: null, error: `no template ${file}` }
      : { content: body, error: null };
  },
  getDefaultBranch: async () => "main",
  getBranchHeadSha: async (_repo: string, branch: string) =>
    branch in h.committed ? `sha-${branch}` : "",
  fetchFileFromRepo: async (_repo: string, path: string, branch = "main") => {
    const files = h.committed[branch];
    return files && path in files ? files[path] : null;
  },
  commitFileToRepo: async (
    _repo: string,
    path: string,
    content: string,
    branch: string,
    message: string
  ) => {
    if (h.failCommits) throw new Error("protected branch");
    h.commits.push({ path, content, branch, message });
    (h.committed[branch] ||= {})[path] = content;
    return true;
  }
}));

const {
  syncRepoWorkflows,
  generateVerifyWorkflow,
  generateDeployWorkflow,
  generateDeleteWorkflow,
  addDeleteStateCheck,
  configureVerifyGhcrProbe
} = await import("./infra.js");

const VERIFY_PATH = ".github/workflows/radius-verify-credentials.yml";

function workflowJob(yaml: string, name: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) return "";
  const end = lines.findIndex(
    (line, index) => index > start && /^  [a-z][a-z0-9-]*:$/.test(line)
  );
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

// Build the full expected committed-file map the extension would produce for one
// environment, so tests can seed an "in sync" branch.
async function expectedFilesFor(
  env: string,
  provider: string
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  files[VERIFY_PATH] = await generateVerifyWorkflow(env, provider);
  for (const [name, body] of Object.entries(
    await generateDeployWorkflow(env, ".radius/app.bicep")
  )) {
    files[`.github/workflows/${name}`] = body;
  }
  for (const [name, body] of Object.entries(
    await generateDeleteWorkflow(env)
  )) {
    files[`.github/workflows/${name}`] = body;
  }
  return files;
}

const STALE_AZURE_VERIFY =
  "name: verify\njobs:\n  v:\n    run: echo STALE ${{ vars.AZURE_CLIENT_ID }}\n";
const STALE_AWS_VERIFY =
  "name: verify\njobs:\n  v:\n    run: echo STALE ${{ vars.AWS_ROLE_ARN }}\n";

describe("generated workflow YAML validation", () => {
  beforeEach(() => {
    h.upstream = { ...BASE_UPSTREAM };
  });

  it.each([
    {
      name: "deploy environment",
      generate: () => generateDeployWorkflow("it's-prod", ".radius/app.bicep"),
      context: 'deploy workflow "run-rad-commands.yml"'
    },
    {
      name: "deploy app file",
      generate: () => generateDeployWorkflow("prod", ".radius/app's.bicep"),
      context: 'deploy workflow "run-rad-commands-azure.yml"'
    },
    {
      name: "delete environment",
      generate: () => generateDeleteWorkflow("it's-prod"),
      context: 'delete workflow "delete-application.yml"'
    },
    {
      name: "verify environment",
      generate: () => generateVerifyWorkflow("it's-prod", "azure"),
      context: 'verify workflow "verify-azure.yml"'
    }
  ])(
    "rejects an invalid $name scalar before commit",
    async ({ generate, context }) => {
      await expect(generate()).rejects.toThrow(
        `Generated ${context} is invalid YAML`
      );
    }
  );
});

describe("GHCR verification probe", () => {
  it("checks push permission with a non-mutating upload session", () => {
    const workflow = configureVerifyGhcrProbe(
      "steps:\n  - name: Verify GHCR package push permission\n    uses: action\n  - name: Summary\n    run: echo done\n"
    );
    expect(workflow).toContain("secrets.GITHUB_TOKEN");
    expect(workflow).toContain("/blobs/uploads/");
    expect(workflow).toContain('status}" != "202"');
    expect(workflow).toContain("| node -e");
    expect(workflow).not.toContain("| jq ");
    expect(workflow).not.toContain("uses: action");
    expect(workflow).toContain("- name: Summary");
  });
});

describe("generateDeleteWorkflow", () => {
  it("detects state inside the existing delete job before Azure OIDC", async () => {
    const workflows = await generateDeleteWorkflow("dev");
    const azure = workflows["delete-azure.yml"];
    const cloudDelete = workflowJob(azure, "delete");

    expect(workflowJob(azure, "detect-state")).toBe("");
    expect(cloudDelete).toContain("id: state");
    expect(cloudDelete).toContain(
      "if: ${{ steps.state.outputs.has_state == 'true' }}"
    );
    expect(cloudDelete).toContain("Azure Login (OIDC)");
    expect(workflows["delete-application.yml"]).toContain("force_local_only:");
    expect(workflows["delete-application.yml"]).toContain(
      "force_local_only: ${{ inputs.force_local_only }}"
    );
    const dispatcher = yaml.load(workflows["delete-application.yml"]) as {
      on: { workflow_dispatch: { inputs: Record<string, unknown> } };
    };
    expect(dispatcher.on.workflow_dispatch.inputs).toHaveProperty(
      "force_local_only"
    );
  });

  it("produces a workflow that parses as valid YAML with the expected job graph", async () => {
    const workflows = await generateDeleteWorkflow("dev");
    const azure = workflows["delete-azure.yml"];
    // Confirms the splice produces YAML GitHub will accept, not just a string
    // that happens to contain the right substrings.
    const parsed = yaml.load(azure) as {
      on: { workflow_call: { inputs: Record<string, unknown> } };
      jobs: Record<string, { steps: Array<{ name?: string; if?: string }> }>;
    };
    expect(Object.keys(parsed.jobs)).toEqual(
      expect.arrayContaining(["delete"])
    );
    expect(parsed.jobs["detect-state"]).toBeUndefined();
    expect(parsed.on.workflow_call.inputs).toHaveProperty("force_local_only");
    expect(parsed.jobs.delete.steps[1]).toMatchObject({
      name: "Detect persisted Radius state"
    });
    expect(
      parsed.jobs.delete.steps.find(
        (step) => step.name === "Azure Login (OIDC)"
      )?.if
    ).toBe(
      "${{ steps.state.outputs.has_state == 'true' && (vars.AZURE_CLIENT_ID != '') }}"
    );
    expect(
      parsed.jobs.delete.steps.find((step) => step.name === "Teardown")?.if
    ).toBe("${{ steps.state.outputs.has_state == 'true' && (always()) }}");
    // The original job's own steps (Azure Login, restore-state, delete,
    // teardown) must survive the splice untouched.
    expect(parsed.jobs.delete.steps).toHaveLength(7);
  });

  it("rejects an upstream preflight job that would reintroduce a second approval", () => {
    const workflow =
      "name: delete-azure\njobs:\n  detect-state:\n    runs-on: ubuntu-24.04\n  delete:\n    runs-on: ubuntu-24.04\n";

    expect(() => addDeleteStateCheck(workflow)).toThrow(
      /upstream includes a separate "detect-state" job/
    );
  });

  it("throws (rather than silently no-opping) when no delete job exists", () => {
    const workflow =
      "name: delete-azure\njobs:\n  some-job:\n    runs-on: ubuntu-24.04\n";

    // A renamed/reshaped upstream `delete:` job must fail loudly instead of
    // committing a workflow that silently lost its state gate.
    expect(() => addDeleteStateCheck(workflow)).toThrow(
      /expected a top-level "  delete:" job/
    );
  });

  it("throws when the delete job key appears only inside a comment or nested mapping", () => {
    // A "  delete:" substring indented differently, or preceded by other
    // characters, must not be treated as the job anchor.
    const workflow =
      "name: delete-azure\njobs:\n  some-job:\n    # not a real   delete: job\n    runs-on: ubuntu-24.04\n";

    expect(() => addDeleteStateCheck(workflow)).toThrow();
  });

  it("throws when Checkout is the last delete step", () => {
    const workflow = `on:
  workflow_call:
    inputs:
      environment:
        type: string
permissions:
  contents: read
jobs:
  delete:
    steps:
      - name: Checkout
        uses: actions/checkout@v4
`;

    expect(() => addDeleteStateCheck(workflow)).toThrow(
      /expected a step after "Checkout"/
    );
  });

  it("throws when Checkout is followed by another job instead of a delete step", () => {
    const workflow = `on:
  workflow_call:
    inputs:
      environment:
        type: string
permissions:
  contents: read
jobs:
  delete:
    steps:
      - name: Checkout
        uses: actions/checkout@v4
  another-job:
    runs-on: ubuntu-24.04
`;

    expect(() => addDeleteStateCheck(workflow)).toThrow(
      /expected a step after "Checkout"/
    );
  });

  describe("detect-state shell logic", () => {
    // Extracts the actual `run:` script for the delete job's "Detect persisted
    // Radius state" step from the generated workflow, so these tests exercise the
    // real shell logic (parsed out of real YAML) rather than a hand-copied
    // stand-in that could drift from production.
    function detectStateScript(azureYaml: string): string {
      const parsed = yaml.load(azureYaml) as {
        jobs: {
          delete: {
            steps: Array<{ id?: string; run?: string }>;
          };
        };
      };
      const step = parsed.jobs.delete.steps.find((s) => s.id === "state");
      if (!step?.run) throw new Error("detect-state script step not found");
      return step.run;
    }

    interface RunResult {
      status: number;
      output: Record<string, string>;
      summary: string;
    }

    // Runs the extracted script under bash with a stubbed `curl`/`git` on
    // PATH, capturing $GITHUB_OUTPUT and $GITHUB_STEP_SUMMARY like the real
    // runner would. `binScripts` maps a binary name (e.g. "curl") to the body
    // of a stub script placed ahead of the real binary on PATH.
    function runDetectState(
      script: string,
      env: Record<string, string>,
      binScripts: Record<string, string> = {}
    ): RunResult {
      const dir = mkdtempSync(join(tmpdir(), "detect-state-"));
      const binDir = join(dir, "bin");
      mkdirSync(binDir, { recursive: true });
      for (const [name, body] of Object.entries(binScripts)) {
        const binPath = join(binDir, name);
        writeFileSync(binPath, body);
        chmodSync(binPath, 0o755);
      }
      const outputFile = join(dir, "output");
      const summaryFile = join(dir, "summary");
      writeFileSync(outputFile, "");
      writeFileSync(summaryFile, "");
      let status = 0;
      try {
        execFileSync("bash", ["-c", script], {
          env: {
            PATH: `${binDir}:${process.env.PATH}`,
            GITHUB_OUTPUT: outputFile,
            GITHUB_STEP_SUMMARY: summaryFile,
            ...env
          },
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch (err) {
        status = (err as { status?: number }).status ?? 1;
      }
      const output: Record<string, string> = {};
      for (const line of readFileSync(outputFile, "utf8").split("\n")) {
        const [key, ...rest] = line.split("=");
        if (key) output[key] = rest.join("=");
      }
      return { status, output, summary: readFileSync(summaryFile, "utf8") };
    }

    const CURL_STUB = `#!/usr/bin/env bash
set -euo pipefail
url="\${@: -1}"
if [[ "$url" == *"/token"* ]]; then
  echo '{"token":"mock-token"}'
  exit 0
fi
out_file=""
prev=""
for arg in "$@"; do
  if [[ "$prev" == "-o" ]]; then
    out_file="$arg"
  fi
  prev="$arg"
done
echo -n "\${MOCK_MANIFEST_BODY:-}" > "$out_file"
echo -n "\${MOCK_MANIFEST_STATUS:-200}"
`;

    function gitStub(exitCode: number): string {
      return `#!/usr/bin/env bash\nexit ${exitCode}\n`;
    }

    let script: string;
    beforeEach(async () => {
      const workflows = await generateDeleteWorkflow("dev");
      script = detectStateScript(workflows["delete-azure.yml"]);
    });

    it("reports has_state=true when the GHCR manifest is present (HTTP 200)", () => {
      const result = runDetectState(
        script,
        {
          STATE_BACKEND: "oci",
          STATE_REGISTRY: "ghcr.io/acme/app-radius-state-dev-abc123",
          STATE_ARCHIVE: "radius-state",
          GHCR_ACTOR: "actor",
          GHCR_TOKEN: "token",
          MOCK_MANIFEST_STATUS: "200"
        },
        { curl: CURL_STUB }
      );
      expect(result.status).toBe(0);
      expect(result.output.has_state).toBe("true");
    });

    it("fails closed when GHCR confirms the manifest is absent without an explicit override", () => {
      const result = runDetectState(
        script,
        {
          STATE_BACKEND: "oci",
          STATE_REGISTRY: "ghcr.io/acme/app-radius-state-dev-abc123",
          STATE_ARCHIVE: "radius-state",
          GHCR_ACTOR: "actor",
          GHCR_TOKEN: "token",
          MOCK_MANIFEST_STATUS: "404"
        },
        { curl: CURL_STUB }
      );
      expect(result.status).not.toBe(0);
      expect(result.output.has_state).toBeUndefined();
    });

    it("allows a confirmed-absent GHCR package only with force_local_only", () => {
      const result = runDetectState(
        script,
        {
          STATE_BACKEND: "oci",
          STATE_REGISTRY: "ghcr.io/acme/app-radius-state-dev-abc123",
          STATE_ARCHIVE: "radius-state",
          GHCR_ACTOR: "actor",
          GHCR_TOKEN: "token",
          FORCE_LOCAL_ONLY: "true",
          MOCK_MANIFEST_STATUS: "401",
          MOCK_MANIFEST_BODY:
            '{"errors":[{"code":"NAME_UNKNOWN","message":"repository name not known to registry"}]}'
        },
        { curl: CURL_STUB }
      );
      expect(result.status).toBe(0);
      expect(result.output.has_state).toBe("false");
    });

    it("allows a confirmed-absent GHCR tag only with force_local_only", () => {
      const result = runDetectState(
        script,
        {
          STATE_BACKEND: "oci",
          STATE_REGISTRY: "ghcr.io/acme/app-radius-state-dev-abc123",
          STATE_ARCHIVE: "radius-state",
          GHCR_ACTOR: "actor",
          GHCR_TOKEN: "token",
          FORCE_LOCAL_ONLY: "true",
          MOCK_MANIFEST_STATUS: "403",
          MOCK_MANIFEST_BODY:
            '{"errors":[{"code":"MANIFEST_UNKNOWN","message":"manifest unknown"}]}'
        },
        { curl: CURL_STUB }
      );
      expect(result.status).toBe(0);
      expect(result.output.has_state).toBe("false");
    });

    it("fails closed on an inconclusive registry response (HTTP 500)", () => {
      const result = runDetectState(
        script,
        {
          STATE_BACKEND: "oci",
          STATE_REGISTRY: "ghcr.io/acme/app-radius-state-dev-abc123",
          STATE_ARCHIVE: "radius-state",
          GHCR_ACTOR: "actor",
          GHCR_TOKEN: "token",
          MOCK_MANIFEST_STATUS: "500",
          MOCK_MANIFEST_BODY: "internal error"
        },
        { curl: CURL_STUB }
      );
      expect(result.status).not.toBe(0);
      expect(result.output.has_state).toBeUndefined();
    });

    it("fails closed on a 401/403 that doesn't carry NAME_UNKNOWN/MANIFEST_UNKNOWN", () => {
      const result = runDetectState(
        script,
        {
          STATE_BACKEND: "oci",
          STATE_REGISTRY: "ghcr.io/acme/app-radius-state-dev-abc123",
          STATE_ARCHIVE: "radius-state",
          GHCR_ACTOR: "actor",
          GHCR_TOKEN: "token",
          MOCK_MANIFEST_STATUS: "403",
          MOCK_MANIFEST_BODY: '{"errors":[{"code":"UNAUTHORIZED"}]}'
        },
        { curl: CURL_STUB }
      );
      expect(result.status).not.toBe(0);
      expect(result.output.has_state).toBeUndefined();
    });

    it("fails closed when RADIUS_STATE_REGISTRY is not configured", () => {
      const result = runDetectState(script, {
        STATE_BACKEND: "oci",
        STATE_REGISTRY: "",
        STATE_ARCHIVE: "radius-state",
        GHCR_ACTOR: "actor",
        GHCR_TOKEN: "token"
      });
      expect(result.status).not.toBe(0);
      expect(result.output.has_state).toBeUndefined();
    });

    it("reports has_state=true when the radius-state git branch exists", () => {
      const result = runDetectState(
        script,
        { STATE_BACKEND: "git" },
        { git: gitStub(0) }
      );
      expect(result.status).toBe(0);
      expect(result.output.has_state).toBe("true");
    });

    it("allows a confirmed-absent git state branch only with force_local_only", () => {
      const result = runDetectState(
        script,
        { STATE_BACKEND: "git", FORCE_LOCAL_ONLY: "true" },
        { git: gitStub(2) }
      );
      expect(result.status).toBe(0);
      expect(result.output.has_state).toBe("false");
    });

    it("fails closed when a git state branch is absent without force_local_only", () => {
      const result = runDetectState(
        script,
        { STATE_BACKEND: "git" },
        { git: gitStub(2) }
      );
      expect(result.status).not.toBe(0);
      expect(result.output.has_state).toBeUndefined();
    });

    it("fails closed on any other non-zero git ls-remote status", () => {
      const result = runDetectState(
        script,
        { STATE_BACKEND: "git" },
        { git: gitStub(128) }
      );
      expect(result.status).not.toBe(0);
      expect(result.output.has_state).toBeUndefined();
    });
  });
});

describe("syncRepoWorkflows", () => {
  beforeEach(() => {
    h.committed = {};
    h.commits = [];
    h.failCommits = false;
    h.upstream = { ...BASE_UPSTREAM };
  });

  it("no-ops when there are no managed environments", async () => {
    const res = await syncRepoWorkflows("acme/app", []);
    expect(res.skipped).toBe(true);
    expect(h.commits).toEqual([]);
  });

  it("makes no commits when every committed file already matches upstream", async () => {
    h.committed.main = await expectedFilesFor("dev", "azure");
    const res = await syncRepoWorkflows("acme/app", [
      { name: "dev", provider: "azure" }
    ]);
    expect(res.updated).toEqual([]);
    expect(h.commits).toEqual([]);
  });

  it("rewrites a drifted file with the freshly generated content", async () => {
    h.committed.main = await expectedFilesFor("dev", "azure");
    h.committed.main[VERIFY_PATH] = STALE_AZURE_VERIFY;
    const res = await syncRepoWorkflows("acme/app", [
      { name: "dev", provider: "azure" }
    ]);
    expect(res.updated).toEqual([VERIFY_PATH]);
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].path).toBe(VERIFY_PATH);
    expect(h.commits[0].content).toBe(
      await generateVerifyWorkflow("dev", "azure")
    );
    expect(h.commits[0].branch).toBe("main");
  });

  it("skips files the extension never committed (missing on the repo)", async () => {
    // Repo has none of the workflow files yet.
    const res = await syncRepoWorkflows("acme/app", [
      { name: "dev", provider: "azure" }
    ]);
    expect(res.updated).toEqual([]);
    expect(h.commits).toEqual([]);
  });

  it("treats a file matching ANY managed environment as in sync (no ping-pong)", async () => {
    // File carries the second environment's baked-in default; still in sync.
    h.committed.main = {
      [VERIFY_PATH]: await generateVerifyWorkflow("prod", "azure")
    };
    const res = await syncRepoWorkflows("acme/app", [
      { name: "dev", provider: "azure" },
      { name: "prod", provider: "azure" }
    ]);
    expect(res.updated).toEqual([]);
    expect(h.commits).toEqual([]);
  });

  it("preserves the committed provider when rewriting the shared verify file", async () => {
    // Drifted AWS verify file in a repo that has both an azure and aws env:
    // it must be rewritten from the AWS template, not the azure one.
    h.committed.main = { [VERIFY_PATH]: STALE_AWS_VERIFY };
    const res = await syncRepoWorkflows("acme/app", [
      { name: "dev", provider: "azure" },
      { name: "prod", provider: "aws" }
    ]);
    expect(res.updated).toEqual([VERIFY_PATH]);
    expect(h.commits[0].content).toBe(
      await generateVerifyWorkflow("prod", "aws")
    );
  });

  it("keeps an AWS verify file in sync when the env provider is unknown", async () => {
    // server.ts passes provider "" when it can't infer one. A committed AWS
    // verify file that already matches upstream must NOT be rewritten with the
    // Azure template — the unknown provider generates BOTH candidates.
    h.committed.main = {
      [VERIFY_PATH]: await generateVerifyWorkflow("dev", "aws")
    };
    const res = await syncRepoWorkflows("acme/app", [
      { name: "dev", provider: "" }
    ]);
    expect(res.updated).toEqual([]);
    expect(h.commits).toEqual([]);
  });

  it("rewrites a drifted AWS verify file with the AWS template when provider is unknown", async () => {
    h.committed.main = { [VERIFY_PATH]: STALE_AWS_VERIFY };
    const res = await syncRepoWorkflows("acme/app", [
      { name: "dev", provider: "" }
    ]);
    expect(res.updated).toEqual([VERIFY_PATH]);
    // Must use the AWS template (matching the committed file's provider), not
    // the Azure one, even though the env provider couldn't be inferred.
    expect(h.commits[0].content).toBe(
      await generateVerifyWorkflow("dev", "aws")
    );
  });

  it("also updates the working branch when it has drifted", async () => {
    h.committed.main = await expectedFilesFor("dev", "azure");
    h.committed.feature = await expectedFilesFor("dev", "azure");
    h.committed.main[VERIFY_PATH] = STALE_AZURE_VERIFY;
    h.committed.feature[VERIFY_PATH] = STALE_AZURE_VERIFY;

    const res = await syncRepoWorkflows(
      "acme/app",
      [{ name: "dev", provider: "azure" }],
      {
        workingBranch: "feature"
      }
    );

    expect(res.branches).toEqual(["main", "feature"]);
    expect(res.updated).toEqual([VERIFY_PATH]); // de-duped across branches
    const branches = h.commits.map((c) => c.branch).sort();
    expect(branches).toEqual(["feature", "main"]);
    for (const c of h.commits) {
      expect(c.content).toBe(await generateVerifyWorkflow("dev", "azure"));
    }
  });

  it("updates the working branch even when the default branch is already in sync", async () => {
    h.committed.main = await expectedFilesFor("dev", "azure"); // in sync
    h.committed.feature = await expectedFilesFor("dev", "azure");
    h.committed.feature[VERIFY_PATH] = STALE_AZURE_VERIFY; // only the branch drifted

    const res = await syncRepoWorkflows(
      "acme/app",
      [{ name: "dev", provider: "azure" }],
      {
        workingBranch: "feature"
      }
    );

    expect(res.updated).toEqual([VERIFY_PATH]);
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].branch).toBe("feature");
  });

  it("does not double-commit when the working branch IS the default branch", async () => {
    h.committed.main = await expectedFilesFor("dev", "azure");
    h.committed.main[VERIFY_PATH] = STALE_AZURE_VERIFY;
    const res = await syncRepoWorkflows(
      "acme/app",
      [{ name: "dev", provider: "azure" }],
      {
        workingBranch: "main"
      }
    );
    expect(res.branches).toEqual(["main"]);
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].branch).toBe("main");
  });

  it("silently skips an unpushed working branch (no committed files to read)", async () => {
    h.committed.main = await expectedFilesFor("dev", "azure"); // in sync
    // No `h.committed.feature` at all — branch not pushed, files unreadable.
    const res = await syncRepoWorkflows(
      "acme/app",
      [{ name: "dev", provider: "azure" }],
      {
        workingBranch: "feature"
      }
    );
    expect(res.updated).toEqual([]);
    expect(h.commits).toEqual([]);
  });

  it("with `only`, syncs just the targeted workflow files and ignores drift in others", async () => {
    // Both the delete workflow and the verify workflow have drifted, but a
    // pre-delete sync should only touch the delete files.
    h.committed.main = await expectedFilesFor("dev", "azure");
    h.committed.main[VERIFY_PATH] = STALE_AZURE_VERIFY;
    h.committed.main[".github/workflows/delete-application.yml"] =
      "name: stale-delete\n";

    const res = await syncRepoWorkflows(
      "acme/app",
      [{ name: "dev", provider: "azure" }],
      {
        only: ["delete-application.yml", "delete-azure.yml"]
      }
    );

    expect(res.updated).toEqual([".github/workflows/delete-application.yml"]);
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].path).toBe(".github/workflows/delete-application.yml");
    // The drifted verify file was outside `only`, so it must be left untouched.
    expect(h.commits.some((c) => c.path === VERIFY_PATH)).toBe(false);
  });

  it("accepts full paths in `only` and matches on the bare filename", async () => {
    h.committed.main = await expectedFilesFor("dev", "azure");
    h.committed.main[".github/workflows/run-rad-commands.yml"] =
      "name: stale-deploy\n";

    const res = await syncRepoWorkflows(
      "acme/app",
      [{ name: "dev", provider: "azure" }],
      {
        only: [
          ".github/workflows/run-rad-commands.yml",
          ".github/workflows/run-rad-commands-azure.yml"
        ]
      }
    );

    expect(res.updated).toEqual([".github/workflows/run-rad-commands.yml"]);
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].path).toBe(".github/workflows/run-rad-commands.yml");
  });

  it("with `create`, authors a missing workflow on the default branch", async () => {
    // Repo has the deploy + verify files but is missing the delete workflows.
    h.committed.main = await expectedFilesFor("dev", "azure");
    delete h.committed.main[".github/workflows/delete-application.yml"];
    delete h.committed.main[".github/workflows/delete-azure.yml"];

    const res = await syncRepoWorkflows(
      "acme/app",
      [{ name: "dev", provider: "azure" }],
      {
        only: ["delete-application.yml", "delete-azure.yml"],
        create: true
      }
    );

    expect(res.created.sort()).toEqual([
      ".github/workflows/delete-application.yml",
      ".github/workflows/delete-azure.yml"
    ]);
    // Newly-authored files are reported under `created`, not `updated`.
    expect(res.updated).toEqual([]);
    expect(res.failed).toEqual([]);
    const created = h.commits.map((c) => c.path).sort();
    expect(created).toEqual([
      ".github/workflows/delete-application.yml",
      ".github/workflows/delete-azure.yml"
    ]);
    expect(h.commits.every((c) => c.branch === "main")).toBe(true);
    const expected = await generateDeleteWorkflow("dev");
    const dispatcher = h.commits.find(
      (c) => c.path === ".github/workflows/delete-application.yml"
    );
    expect(dispatcher?.content).toBe(expected["delete-application.yml"]);
  });

  it("without `create`, still skips a missing workflow (no authoring)", async () => {
    h.committed.main = await expectedFilesFor("dev", "azure");
    delete h.committed.main[".github/workflows/delete-application.yml"];
    delete h.committed.main[".github/workflows/delete-azure.yml"];

    const res = await syncRepoWorkflows(
      "acme/app",
      [{ name: "dev", provider: "azure" }],
      {
        only: ["delete-application.yml", "delete-azure.yml"]
      }
    );

    expect(res.updated).toEqual([]);
    expect(res.created).toEqual([]);
    expect(h.commits).toEqual([]);
  });

  it("with `create`, does NOT author onto an unpushed working branch", async () => {
    // Default branch is fully in sync; the working branch isn't pushed, so its
    // missing files must not be authored even though `create` is set.
    h.committed.main = await expectedFilesFor("dev", "azure");
    // No `h.committed.feature` — branch absent on the remote.

    const res = await syncRepoWorkflows(
      "acme/app",
      [{ name: "dev", provider: "azure" }],
      {
        workingBranch: "feature",
        create: true
      }
    );

    expect(res.updated).toEqual([]);
    expect(res.created).toEqual([]);
    expect(res.failed).toEqual([]);
    expect(h.commits).toEqual([]);
  });

  it("reports a commit failure in `failed` and does not abort the pass", async () => {
    // The default branch is missing the delete workflows, but committing to it
    // is rejected (e.g. a protected branch). The failure must be surfaced in
    // `failed` — carrying the branch — rather than swallowed.
    h.committed.main = await expectedFilesFor("dev", "azure");
    delete h.committed.main[".github/workflows/delete-application.yml"];
    delete h.committed.main[".github/workflows/delete-azure.yml"];
    h.failCommits = true;

    const res = await syncRepoWorkflows(
      "acme/app",
      [{ name: "dev", provider: "azure" }],
      {
        only: ["delete-application.yml", "delete-azure.yml"],
        create: true
      }
    );

    expect(res.created).toEqual([]);
    expect(res.updated).toEqual([]);
    expect(res.failed.map((f) => f.path).sort()).toEqual([
      ".github/workflows/delete-application.yml",
      ".github/workflows/delete-azure.yml"
    ]);
    expect(res.failed.every((f) => f.branch === "main")).toBe(true);
  });
});
