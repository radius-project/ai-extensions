import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { successfulSelectedGhExecutor } from "../../test/support/server/selected-gh.js";
import type { SelectedGhExecutor } from "../gh.js";
import { syncRepoWorkflows } from "../infra.js";
import { createDeploymentWorkflowPorts } from "./deployment-workflows.js";

function fixture(response: { code: number; stdout: string; stderr: string }) {
  const run = vi.fn<SelectedGhExecutor["run"]>(async () => response);
  const executor = successfulSelectedGhExecutor({ login: "fixture-user", run });
  return { ports: createDeploymentWorkflowPorts(executor), executor, run };
}

describe("selected deployment workflow bindings", () => {
  it("synchronizes workflows through the pinned executor on the real default and selected branches", async () => {
    const files = [
      "verify-azure.yml",
      "run-rad-commands.yml",
      "run-rad-commands-azure.yml",
      "delete-application.yml",
      "delete-azure.yml",
      "delete-environment.yml",
      "delete-environment-azure.yml"
    ];
    const templates = new Map(
      files.map((file) => [
        file,
        readFileSync(
          new URL(`../../../../.github/extension/${file}`, import.meta.url),
          "utf8"
        )
      ])
    );
    const run = vi.fn<SelectedGhExecutor["run"]>(async (args) => {
      if (args.includes("PUT")) return { code: 0, stdout: "{}", stderr: "" };
      const endpoint = args[1];
      if (endpoint === "/repos/fixture/app")
        return { code: 0, stdout: '{"default_branch":"trunk"}', stderr: "" };
      if (endpoint.startsWith("/repos/fixture/app/git/ref/heads/"))
        return {
          code: 0,
          stdout: JSON.stringify({ object: { sha: "a".repeat(40) } }),
          stderr: ""
        };
      if (endpoint.startsWith("/repos/fixture/app/contents/"))
        return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
      const url = new URL(endpoint, "https://fixture.invalid");
      const name = url.pathname.split("/").at(-1);
      const template = name && templates.get(name);
      if (
        !url.pathname.startsWith(
          "/repos/radius-project/ai-extensions/contents/.github/extension/"
        ) ||
        !template
      )
        throw new Error(`Unexpected command ${JSON.stringify(args)}`);
      return {
        code: 0,
        stdout: Buffer.from(template).toString("base64"),
        stderr: ""
      };
    });
    const ports = createDeploymentWorkflowPorts(
      successfulSelectedGhExecutor({ login: "fixture-user", run })
    );
    const branch = "feature/model & validation";
    const result = await syncRepoWorkflows(
      "fixture/app",
      [{ name: "dev", provider: "azure" }],
      {
        only: ["run-rad-commands.yml", "run-rad-commands-azure.yml"],
        workingBranch: branch,
        create: true
      },
      ports
    );
    expect(result.failed).toEqual([]);
    expect(result.created).toEqual([
      ".github/workflows/run-rad-commands.yml",
      ".github/workflows/run-rad-commands-azure.yml"
    ]);
    const writes = run.mock.calls.filter(([args]) => args.includes("PUT"));
    expect(writes).toHaveLength(4);
    const bodies = writes.map(([, options]) =>
      JSON.parse(options?.stdin ?? "{}")
    );
    expect(bodies.map((body) => body.branch)).toEqual([
      "trunk",
      "trunk",
      branch,
      branch
    ]);
    expect(
      bodies.every(
        (body) => typeof body.content === "string" && body.content.length > 0
      )
    ).toBe(true);
    expect(
      run.mock.calls.some(([args]) =>
        args[1]?.includes("ref=feature%2Fmodel%20%26%20validation")
      )
    ).toBe(true);
  });

  it.each(["null", "[]", "false"])(
    "refuses malformed repository metadata %s",
    async (stdout) => {
      const { ports } = fixture({ code: 0, stdout, stderr: "" });
      await expect(ports.getDefaultBranch("fixture/app")).rejects.toThrow(
        "invalid repository metadata"
      );
    }
  );

  it.each(["{}", '{"default_branch":false}', '{"default_branch":" "}'])(
    "never substitutes main when the default branch is unresolved: %s",
    async (stdout) => {
      const { ports, run } = fixture({ code: 0, stdout, stderr: "" });
      await expect(
        syncRepoWorkflows("fixture/app", [{ name: "dev" }], {}, ports)
      ).rejects.toThrow("Could not resolve");
      expect(run).toHaveBeenCalledOnce();
    }
  );

  it.each([
    { stderr: "HTTP 403: denied", expected: "redacted failure" },
    { stderr: "", expected: "Could not read repository metadata." }
  ])(
    "surfaces metadata failure without trying another account",
    async ({ stderr, expected }) => {
      const { ports, executor, run } = fixture({ code: 1, stdout: "", stderr });
      executor.redact = (text) => (text === stderr ? "redacted failure" : text);
      await expect(ports.getDefaultBranch("fixture/app")).rejects.toThrow(
        expected
      );
      expect(run).toHaveBeenCalledOnce();
    }
  );

  it("distinguishes an absent branch from inaccessible repository metadata", async () => {
    const { ports, run } = fixture({ code: 1, stdout: "", stderr: "HTTP 404" });
    expect(
      await ports.getBranchHeadSha("fixture/app", "not-pushed")
    ).toBeNull();
    await expect(ports.getDefaultBranch("fixture/app")).rejects.toThrow(
      "HTTP 404"
    );
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each([
    "{}",
    '{"object":false}',
    '{"object":{}}',
    '{"object":{"sha":42}}',
    '{"object":{"sha":"invalid"}}'
  ])("rejects invalid branch identity %s", async (stdout) => {
    const { ports } = fixture({ code: 0, stdout, stderr: "" });
    await expect(
      ports.getBranchHeadSha("fixture/app", "feature")
    ).rejects.toThrow("invalid branch identity");
  });

  it("reads exact selected file content and distinguishes absence from failure", async () => {
    const { ports, run } = fixture({
      code: 0,
      stdout: JSON.stringify({
        type: "file",
        encoding: "base64",
        content: Buffer.from("body").toString("base64")
      }),
      stderr: ""
    });
    expect(
      await ports.fetchFileFromRepo("fixture/app", "file.yml", "feature&other")
    ).toBe("body");
    expect(run).toHaveBeenCalledWith(
      ["api", "/repos/fixture/app/contents/file.yml?ref=feature%26other"],
      { timeout: 15000 }
    );
    run.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "HTTP 404" });
    expect(
      await ports.fetchFileFromRepo("fixture/app", "missing.yml", "branch")
    ).toBeNull();
    run.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "HTTP 403" });
    await expect(
      ports.fetchFileFromRepo("fixture/app", "file.yml", "branch")
    ).rejects.toThrow("HTTP 403");
    expect(run).toHaveBeenCalledTimes(3);
  });
});
