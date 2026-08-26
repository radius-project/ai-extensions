import { describe, it, expect, beforeEach, vi } from "vitest";
import { parse as parseYaml } from "yaml";

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
      "name: verify\non:\n  workflow_dispatch:\n    inputs:\n      environment:\n        required: true\njobs:\n  v:\n    default: '{{ENV}}'\n    uses: radius-project/radius/.github/extension/actions/verify-ghcr-push@{{RADIUS_REF}}\n",
    "verify-aws.yml":
      "name: verify\non:\n  workflow_dispatch:\n    inputs:\n      environment:\n        required: true\njobs:\n  v:\n    default: '{{ENV}}'\n    uses: radius-project/radius/.github/extension/actions/verify-ghcr-push@{{RADIUS_REF}}\n",
    "run-rad-commands.yml":
      "name: deploy\non:\n  workflow_dispatch:\n    inputs:\n      environment:\n        default: '{{ENV}}'\njobs:\n  detect:\n    run: echo hi\n",
    "run-rad-commands-azure.yml":
      "name: deploy-azure\nenv:\n  APP_FILE: '{{APP_FILE}}'\njobs:\n  a:\n    uses: radius-project/radius/.github/extension/actions/run-rad-commands@{{RADIUS_REF}}\n",
    "delete-application.yml":
      "name: delete\non:\n  workflow_dispatch:\n    inputs:\n      environment:\n        default: '{{ENV}}'\njobs:\n  detect:\n    run: echo hi\n",
    "delete-azure.yml":
      "name: delete-azure\njobs:\n  a:\n    steps:\n      - name: Delete Radius resource\n        uses: radius-project/radius/.github/extension/actions/delete-resource@{{RADIUS_REF}}\n"
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
  configureControlPlaneHostAliases,
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

describe("control-plane host aliases", () => {
  const STEP_TEMPLATE = `jobs:
  delete:
    steps:
      - name: Register cloud credentials with Radius
        run: echo register

      - name: Delete Radius resource
        uses: radius-project/radius/.github/extension/actions/delete-resource@main
        with:
          name: trader-x

      - name: Teardown
        run: echo bye
`;

  function stepNames(workflow: string): string[] {
    const parsed = parseYaml(workflow) as {
      jobs: { delete: { steps: { name: string }[] } };
    };
    return parsed.jobs.delete.steps.map((step) => step.name);
  }

  it("runs the alias step immediately before the delete", () => {
    const workflow = configureControlPlaneHostAliases(STEP_TEMPLATE);

    expect(stepNames(workflow)).toEqual([
      "Register cloud credentials with Radius",
      "Make control-plane services reachable for paginated listings",
      "Delete Radius resource",
      "Teardown"
    ]);
  });

  it("keeps the surrounding step indentation so the workflow stays parseable", () => {
    const workflow = configureControlPlaneHostAliases(STEP_TEMPLATE);
    const inserted = workflow
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .filter((line) => !STEP_TEMPLATE.split("\n").includes(line));

    expect(inserted.length).toBeGreaterThan(0);
    for (const line of inserted) {
      expect(line.startsWith("      ")).toBe(true);
    }
    expect(() => parseYaml(workflow)).not.toThrow();
  });

  it("port-forwards each control-plane service and aliases its in-cluster names", () => {
    const parsed = parseYaml(
      configureControlPlaneHostAliases(STEP_TEMPLATE)
    ) as {
      jobs: { delete: { steps: { name: string; run?: string }[] } };
    };
    const run =
      parsed.jobs.delete.steps.find(
        (step) =>
          step.name ===
          "Make control-plane services reachable for paginated listings"
      )?.run ?? "";

    expect(run).toContain("for service in dynamic-rp applications-rp ucp; do");
    expect(run).toContain(
      'kubectl port-forward -n radius-system "service/$service" "$port:$port" --address 127.0.0.1'
    );
    expect(run).toContain(
      'echo "127.0.0.1 $service.radius-system $service.radius-system.svc $service.radius-system.svc.cluster.local" | sudo tee -a /etc/hosts'
    );
    // A busy port would otherwise satisfy the readiness probe and alias the
    // service to whatever else is listening.
    expect(run).toContain("Port $port is already in use");
  });

  it.each([
    {
      name: "the delete-resource action is gone",
      template: "jobs:\n  delete:\n    steps:\n      - run: rad app delete\n"
    },
    {
      name: "the action is no longer referenced from a step",
      template:
        "jobs:\n  delete:\n    uses: radius-project/radius/.github/extension/actions/delete-resource@main\n"
    }
  ])("refuses a template where $name", ({ template }) => {
    expect(() => configureControlPlaneHostAliases(template)).toThrow(
      /no longer contains a delete-resource step/u
    );
  });

  it("patches the generated provider workflow but not the dispatcher", async () => {
    h.upstream = { ...BASE_UPSTREAM };
    const files = await generateDeleteWorkflow("dev");

    expect(files["delete-azure.yml"]).toContain(
      "Make control-plane services reachable for paginated listings"
    );
    expect(files["delete-application.yml"]).not.toContain(
      "Make control-plane services reachable"
    );
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
