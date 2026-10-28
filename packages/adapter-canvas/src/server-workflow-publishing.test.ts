import { readFileSync } from "node:fs";
import { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cliExec, runCommand } from "./gh.js";
import { workflowTemplates } from "./infra.js";
import {
  deleteRadiusEnvironmentViaWorkflow,
  discoverEnvironmentTarget,
  ensureDeployWorkflowsOnBranch
} from "./server.js";

// The repository's GitHub state behind the gh boundary: committed files keyed by
// `branch:path`, the commits Radius made, and every `gh` command it ran.
const repo = vi.hoisted(() => ({
  files: new Map<string, string>(),
  commits: [] as Array<{ path: string; branch: string; message: string }>,
  failCommits: false
}));

vi.mock("./gh.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gh.js")>();
  return {
    ...actual,
    cliExec: vi.fn(),
    runCommand: vi.fn(),
    getDefaultBranch: async () => "main",
    getBranchHeadSha: async () => "sha-main",
    // Workflow templates come from this checkout's `.github/extension`.
    fetchFileFromRepoResult: async (
      owner: string,
      path: string,
      ref: string
    ) => {
      if (owner === "radius-project/ai-extensions") {
        return {
          content: readFileSync(
            new URL(`../../../${path}`, import.meta.url),
            "utf8"
          ),
          error: null
        };
      }
      const content = repo.files.get(`${ref}:${path}`);
      return content === undefined ?
          { content: null, error: "HTTP 404" }
        : { content, error: null };
    },
    fetchFileFromRepo: async (_owner: string, path: string, branch = "main") =>
      repo.files.get(`${branch}:${path}`) ?? null,
    commitFileToRepo: async (
      _owner: string,
      path: string,
      content: string,
      branch: string,
      message: string
    ) => {
      if (repo.failCommits) throw new Error("HTTP 403: protected branch");
      repo.files.set(`${branch}:${path}`, content);
      repo.commits.push({ path, branch, message });
      return true;
    }
  };
});

const REPO = "octo/shop";
const DISPATCH_REFUSED = "HTTP 403: Resource not accessible by integration";

// Every `gh` command lands here. Contents reads answer from the fake
// repository; dispatching a workflow is refused, which ends the deletion
// before it waits on a run.
const ghCommands: string[][] = [];
function answerGh(): void {
  vi.mocked(cliExec).mockImplementation((_file, args, _options, callback) => {
    ghCommands.push(args);
    const contents = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)\?ref=(.+)$/.exec(
      args[1] ?? ""
    );
    if (args[0] === "api" && contents) {
      const sha = repo.files.has(
        `${decodeURIComponent(contents[2] ?? "")}:${contents[1]}`
      );
      callback(
        sha ? null : Object.assign(new Error("Not Found"), { code: 1 }),
        sha ? "abc123\n" : "",
        sha ? "" : "gh: Not Found (HTTP 404)"
      );
    } else if (args[0] === "workflow" && args[1] === "run") {
      callback(
        Object.assign(new Error("exit 1"), { code: 1 }),
        "",
        DISPATCH_REFUSED
      );
    } else {
      callback(
        Object.assign(new Error("unexpected"), { code: 1 }),
        "",
        `unexpected gh ${args.join(" ")}`
      );
    }
    return new ChildProcess();
  });
}

async function seed(
  branch: string,
  includeAws: boolean,
  files: string[]
): Promise<void> {
  const generated = await workflowTemplates(includeAws).delete("dev");
  for (const file of files) {
    repo.files.set(
      `${branch}:.github/workflows/${file}`,
      generated[file] ?? ""
    );
  }
}

const committedFiles = () =>
  repo.commits.map(({ path }) => path.split("/").pop());
const dispatches = () =>
  ghCommands.filter(([command, action]) => command === "workflow" && action);

beforeEach(() => {
  repo.files.clear();
  repo.commits = [];
  repo.failCommits = false;
  ghCommands.length = 0;
  answerGh();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deleting a Radius environment through its workflow", () => {
  it("commits the missing AWS provider workflow, verifies it, then dispatches", async () => {
    await seed("main", true, [
      "delete-environment.yml",
      "delete-environment-azure.yml"
    ]);

    const result = await deleteRadiusEnvironmentViaWorkflow(true, REPO, "dev");

    expect(committedFiles()).toEqual(["delete-environment-aws.yml"]);
    expect(
      repo.files.get("main:.github/workflows/delete-environment.yml")
    ).toMatch(/^ {2}aws:/m);
    expect(dispatches()).toEqual([
      expect.arrayContaining([
        "workflow",
        "run",
        "delete-environment.yml",
        "environment=dev",
        REPO
      ])
    ]);
    expect(result).toEqual({ outcome: "failed", detail: DISPATCH_REFUSED });
  });

  it("dispatches without any AWS workflow while the switch is off", async () => {
    await seed("main", false, [
      "delete-environment.yml",
      "delete-environment-azure.yml"
    ]);

    const result = await deleteRadiusEnvironmentViaWorkflow(false, REPO, "dev");

    expect(repo.commits).toEqual([]);
    expect(
      repo.files.get("main:.github/workflows/delete-environment.yml")
    ).not.toMatch(/^ {2}aws:/m);
    expect(dispatches()).toHaveLength(1);
    expect(result).toEqual({ outcome: "failed", detail: DISPATCH_REFUSED });
  });

  it("does not dispatch when the AWS provider workflow could not be committed", async () => {
    await seed("main", true, [
      "delete-environment.yml",
      "delete-environment-azure.yml"
    ]);
    repo.failCommits = true;

    const result = await deleteRadiusEnvironmentViaWorkflow(true, REPO, "dev");

    expect(dispatches()).toEqual([]);
    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("delete-environment-aws.yml");
    expect(result.detail).toContain(
      `Radius did not start the deletion of "dev" in ${REPO}.`
    );
  });
});

describe("publishing deploy workflows to a working branch", () => {
  it.each([
    [
      true,
      [
        "run-rad-commands.yml",
        "run-rad-commands-azure.yml",
        "run-rad-commands-aws.yml"
      ]
    ],
    [false, ["run-rad-commands.yml", "run-rad-commands-azure.yml"]]
  ])(
    "commits every workflow the dispatch needs (switch on: %s)",
    async (includeAws, expected) => {
      const written: string[] = [];
      const log = vi.fn();

      await ensureDeployWorkflowsOnBranch(
        includeAws,
        REPO,
        "feature/x",
        "dev",
        log,
        (file) => written.push(file)
      );

      expect(written).toEqual(expected);
      expect(repo.commits.map(({ branch }) => branch)).toEqual(
        expected.map(() => "feature/x")
      );
      expect(
        /^ {2}aws:/m.test(
          repo.files.get("feature/x:.github/workflows/run-rad-commands.yml") ??
            ""
        )
      ).toBe(includeAws);
      expect(log).toHaveBeenCalledWith(
        `Publishing deploy workflow(s) to branch "feature/x": ${expected.join(", ")}`
      );
    }
  );

  it("adds only the AWS provider workflow to a branch that has the others", async () => {
    for (const file of ["run-rad-commands.yml", "run-rad-commands-azure.yml"]) {
      repo.files.set(`feature/x:.github/workflows/${file}`, "existing");
    }
    const written: string[] = [];

    await ensureDeployWorkflowsOnBranch(
      true,
      REPO,
      "feature/x",
      "dev",
      () => {},
      (file) => written.push(file)
    );

    expect(written).toEqual(["run-rad-commands-aws.yml"]);
    expect(
      repo.files.get("feature/x:.github/workflows/run-rad-commands.yml")
    ).toBe("existing");
  });
});

describe("reading the environment a deletion targets", () => {
  it("returns the deploy role an AWS environment recorded", async () => {
    vi.mocked(runCommand).mockResolvedValueOnce(
      "AWS_ACCOUNT_ID\t123456789012\nAWS_ROLE_ARN\tarn:aws:iam::123456789012:role/deployer"
    );

    expect(await discoverEnvironmentTarget(REPO, "dev")).toEqual({
      provider: "aws",
      clientId: "",
      tenantId: "",
      repoId: 0,
      roleArn: "arn:aws:iam::123456789012:role/deployer"
    });
    expect(runCommand).toHaveBeenCalledOnce();
  });

  it("returns no role for an Azure environment", async () => {
    vi.mocked(runCommand)
      .mockResolvedValueOnce("AZURE_CLIENT_ID\tclient\nAZURE_TENANT_ID\ttenant")
      .mockResolvedValueOnce("42");

    expect(await discoverEnvironmentTarget(REPO, "dev")).toEqual({
      provider: "azure",
      clientId: "client",
      tenantId: "tenant",
      repoId: 42,
      roleArn: ""
    });
  });
});
