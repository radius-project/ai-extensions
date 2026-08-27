import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
    // Carries the `on: workflow_dispatch: inputs:` block the real upstream
    // template has. Production always dispatches with `-f environment=`, so a
    // template without it would 422, and the operation marker is inserted into
    // that same inputs block.
    "verify-azure.yml":
      "name: verify\non:\n  workflow_dispatch:\n    inputs:\n      environment:\n        required: true\njobs:\n  v:\n    default: '{{ENV}}'\n    steps:\n      - name: Verify GHCR package push permission\n        uses: radius-project/radius/.github/extension/actions/verify-ghcr-push@{{RADIUS_REF}}\n",
    "verify-aws.yml":
      "name: verify\non:\n  workflow_dispatch:\n    inputs:\n      environment:\n        required: true\njobs:\n  v:\n    default: '{{ENV}}'\n    steps:\n      - name: Verify GHCR package push permission\n        uses: radius-project/radius/.github/extension/actions/verify-ghcr-push@{{RADIUS_REF}}\n",
    "run-rad-commands.yml":
      "name: deploy\non:\n  workflow_dispatch:\n    inputs:\n      environment:\n        default: '{{ENV}}'\n  workflow_run:\n    workflows: [verify]\n    types: [completed]\njobs:\n  detect:\n    run: echo hi\n  azure:\n    uses: ./.github/workflows/run-rad-commands-azure.yml\n  aws:\n    uses: ./.github/workflows/run-rad-commands-aws.yml\n",
    "run-rad-commands-azure.yml":
      "name: deploy-azure\non:\n  workflow_call:\n    inputs:\n      environment:\n        type: string\n        required: true\nenv:\n  APP_FILE: '{{APP_FILE}}'\njobs:\n  a:\n    uses: radius-project/radius/.github/extension/actions/run-rad-commands@{{RADIUS_REF}}\n",
    "delete-application.yml":
      "name: delete\non:\n  workflow_dispatch:\n    inputs:\n      environment:\n        default: '{{ENV}}'\njobs:\n  detect:\n    run: echo hi\n  azure:\n    uses: ./.github/workflows/delete-azure.yml\n  aws:\n    uses: ./.github/workflows/delete-aws.yml\n",
    "delete-azure.yml":
      "name: delete-azure\non:\n  workflow_call:\n    inputs:\n      environment:\n        type: string\n        required: true\njobs:\n  a:\n    uses: radius-project/radius/.github/extension/actions/delete-resource@{{RADIUS_REF}}\n"
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

let templateFetchTime = Date.now();

function expireTemplateCache(): void {
  templateFetchTime += 61_000;
  vi.spyOn(Date, "now").mockReturnValue(templateFetchTime);
}

afterEach(() => {
  vi.restoreAllMocks();
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
  configureVerifyGhcrProbe,
  configureVerifyOperationMarker
} = await import("./infra.js");
const { hasVerificationOperationMarker } =
  await import("./verification-run-identity.js");

const VERIFY_PATH = ".github/workflows/radius-verify-credentials.yml";

describe("verification operation marker", () => {
  it("adds the dispatch input and run title exposed by GitHub run metadata", () => {
    const workflow = configureVerifyOperationMarker(`
name: verify
on:
  workflow_dispatch:
    inputs:
      environment:
        required: true
jobs:
  verify:
    runs-on: ubuntu-latest
`);

    expect(workflow).toContain(
      "run-name: Radius verify ${{ inputs.environment }} [${{ inputs.radius_operation }}]"
    );
    expect(workflow).toContain("      radius_operation:");
    expect(workflow).toContain("        required: false");
  });

  it("binds generated verify workflows to the marker the planner looks for", async () => {
    // `verification-plan` decides whether to send `-f radius_operation` by
    // asking `hasVerificationOperationMarker` about the installed file. If a
    // generated workflow stopped satisfying that predicate, the dispatch would
    // send an input GitHub rejects with 422 — a refusal the journal reads as
    // conclusive — failing every environment creation with a message about the
    // dispatch rather than about this template.
    for (const provider of ["azure", "aws"]) {
      expect(
        hasVerificationOperationMarker(
          await generateVerifyWorkflow("dev", provider)
        )
      ).toBe(true);
    }
  });

  it("refuses a template that no longer exposes a dispatch inputs block", () => {
    expect(() =>
      configureVerifyOperationMarker("name: verify\njobs:\n  v:\n    run: x\n")
    ).toThrow(/no longer exposes/u);
  });
});

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
    expireTemplateCache();
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

  it("rejects a parseable workflow whose document root is not a mapping", async () => {
    h.upstream["run-rad-commands-azure.yml"] =
      "- name: deploy-azure\n- name: another item\n";

    await expect(
      generateDeployWorkflow("prod", ".radius/app.bicep")
    ).rejects.toThrow(
      /deploy workflow "run-rad-commands-azure\.yml".*document root must be a mapping/u
    );
  });

  it("rejects a workflow with no jobs", async () => {
    h.upstream["delete-azure.yml"] =
      "name: delete-azure\non:\n  workflow_call:\n    inputs:\n      environment:\n        type: string\n        required: true\njobs: {}\n";

    await expect(generateDeleteWorkflow("prod")).rejects.toThrow(
      /`jobs` must be a non-empty mapping/u
    );
  });

  it.each([
    "push",
    "pull_request",
    "pull_request_target",
    "workflow_run",
    "schedule"
  ])("rejects the unsafe automatic `%s` trigger", async (trigger) => {
    h.upstream["verify-azure.yml"] = BASE_UPSTREAM["verify-azure.yml"].replace(
      "  workflow_dispatch:",
      `  ${trigger}:\n  workflow_dispatch:`
    );

    await expect(generateVerifyWorkflow("prod", "azure")).rejects.toThrow(
      `unsafe automatic trigger \`${trigger}\` is not allowed`
    );
  });

  it("rejects unresolved placeholders not recognized by the core renderer", async () => {
    h.upstream["delete-azure.yml"] += 'x-upstream: "{{future_token}}"\n';

    await expect(generateDeleteWorkflow("prod")).rejects.toThrow(
      /unresolved \{\{\.\.\.\}\} template placeholder remains/u
    );
  });

  it("rejects a verify workflow missing its environment dispatch input", async () => {
    h.upstream["verify-azure.yml"] = BASE_UPSTREAM["verify-azure.yml"].replace(
      "      environment:",
      "      renamed_environment:"
    );

    await expect(generateVerifyWorkflow("prod", "azure")).rejects.toThrow(
      /workflow dispatch input `environment` is required/u
    );
  });

  it("rejects verification-step drift that bypasses the trusted GHCR rewrite", async () => {
    h.upstream["verify-azure.yml"] = BASE_UPSTREAM["verify-azure.yml"].replace(
      "Verify GHCR package push permission",
      "Check GHCR package push permission"
    );

    await expect(generateVerifyWorkflow("prod", "azure")).rejects.toThrow(
      /trusted non-mutating GHCR push-permission probe is required/u
    );
  });

  it("rejects a provider workflow missing its reusable workflow contract", async () => {
    h.upstream["run-rad-commands-azure.yml"] = BASE_UPSTREAM[
      "run-rad-commands-azure.yml"
    ].replace("  workflow_call:", "  workflow_dispatch:");

    await expect(
      generateDeployWorkflow("prod", ".radius/app.bicep")
    ).rejects.toThrow(
      /reusable `workflow_call` trigger must be the only trigger/u
    );
  });

  it("rejects a dispatcher missing its environment input", async () => {
    h.upstream["delete-application.yml"] = BASE_UPSTREAM[
      "delete-application.yml"
    ].replace("      environment:", "      renamed_environment:");

    await expect(generateDeleteWorkflow("prod")).rejects.toThrow(
      /workflow dispatch input `environment` is required/u
    );
  });

  it("rejects a provider workflow missing its environment input", async () => {
    h.upstream["delete-azure.yml"] = BASE_UPSTREAM["delete-azure.yml"].replace(
      "      environment:",
      "      renamed_environment:"
    );

    await expect(generateDeleteWorkflow("prod")).rejects.toThrow(
      /workflow call input `environment` is required/u
    );
  });

  it("rejects an unsafe direct trigger on a reusable provider workflow", async () => {
    h.upstream["delete-azure.yml"] = BASE_UPSTREAM["delete-azure.yml"].replace(
      "  workflow_call:",
      "  push:\n  workflow_call:"
    );

    await expect(generateDeleteWorkflow("prod")).rejects.toThrow(
      /unsafe automatic trigger `push` is not allowed/u
    );
  });

  it("requires dispatchers to remain workflow-dispatch-only", async () => {
    h.upstream["delete-application.yml"] = BASE_UPSTREAM[
      "delete-application.yml"
    ].replace(
      "  workflow_dispatch:",
      "  repository_dispatch:\n  workflow_dispatch:"
    );

    await expect(generateDeleteWorkflow("prod")).rejects.toThrow(
      /must be triggered only by `workflow_dispatch`/u
    );
  });

  it("rejects dispatcher drift that leaves an AWS job or reference", async () => {
    h.upstream["delete-application.yml"] = BASE_UPSTREAM[
      "delete-application.yml"
    ].replace("  aws:", "  AWS:");

    await expect(generateDeleteWorkflow("prod")).rejects.toThrow(
      /must not contain an AWS job or workflow reference/u
    );
  });

  it("rejects dispatcher drift that hides an AWS reference under another job name", async () => {
    h.upstream["delete-application.yml"] = BASE_UPSTREAM[
      "delete-application.yml"
    ].replace("  aws:", "  cloud:");

    await expect(generateDeleteWorkflow("prod")).rejects.toThrow(
      /must not contain an AWS job or workflow reference/u
    );
  });

  it("rejects dispatcher drift that removes the Azure provider reference", async () => {
    h.upstream["run-rad-commands.yml"] = BASE_UPSTREAM[
      "run-rad-commands.yml"
    ].replace(
      "./.github/workflows/run-rad-commands-azure.yml",
      "./.github/workflows/run-rad-commands-renamed.yml"
    );

    await expect(
      generateDeployWorkflow("prod", ".radius/app.bicep")
    ).rejects.toThrow(
      /dispatcher must invoke `\.\/\.github\/workflows\/run-rad-commands-azure\.yml`/u
    );
  });

  it("accepts dispatchers whose unsafe structures were already removed", async () => {
    h.upstream["run-rad-commands.yml"] = `name: deploy
on:
  workflow_dispatch:
    inputs:
      environment:
        default: "{{ENV}}"
jobs:
  detect:
    run: echo hi
  azure:
    uses: ./.github/workflows/run-rad-commands-azure.yml
`;

    await expect(
      generateDeployWorkflow("prod", ".radius/app.bicep")
    ).resolves.toHaveProperty("run-rad-commands.yml");
  });

  it("accepts unrelated upstream metadata, permissions, env, comments, and steps", async () => {
    h.upstream["verify-azure.yml"] = `# upstream comment
x-upstream-metadata: retained
permissions:
  contents: read
env:
  UPSTREAM_FLAG: enabled
${BASE_UPSTREAM["verify-azure.yml"]}
      - name: Unrelated upstream step
        run: echo retained
`;
    h.upstream["run-rad-commands-azure.yml"] =
      `# provider comment\npermissions:\n  contents: read\n` +
      BASE_UPSTREAM["run-rad-commands-azure.yml"];
    h.upstream["delete-azure.yml"] =
      `# provider comment\nenv:\n  UPSTREAM_FLAG: enabled\n` +
      BASE_UPSTREAM["delete-azure.yml"];

    await expect(generateVerifyWorkflow("prod", "azure")).resolves.toContain(
      "x-upstream-metadata: retained"
    );
    await expect(
      generateDeployWorkflow("prod", ".radius/app.bicep")
    ).resolves.toHaveProperty("run-rad-commands-azure.yml");
    await expect(generateDeleteWorkflow("prod")).resolves.toHaveProperty(
      "delete-azure.yml"
    );
  });
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
    expect(workflow).toContain(
      'curl() { command curl --connect-timeout 10 --max-time 30 "$@"; }'
    );
    expect(workflow).not.toContain("| jq ");
    expect(workflow).not.toContain("uses: action");
    expect(workflow).toContain("- name: Summary");
  });
});

describe("syncRepoWorkflows", () => {
  beforeEach(() => {
    h.committed = {};
    h.commits = [];
    h.failCommits = false;
    h.upstream = { ...BASE_UPSTREAM };
    expireTemplateCache();
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
