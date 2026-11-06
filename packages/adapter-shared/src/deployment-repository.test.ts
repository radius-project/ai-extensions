import { describe, expect, it, vi } from "vitest";
import type { GhCommandExecError } from "@radius-project/core";
import { createDeploymentRepository } from "./deployment-repository.js";
import type { DeploymentCommandExecutor } from "./deployment-command-bindings.js";
import { workflowBlobSha } from "./setup-workflow-content.js";

function fixture(
  ...responses: {
    error?: GhCommandExecError;
    stdout?: string;
    stderr?: string;
  }[]
) {
  const end = vi.fn();
  const execute = vi.fn<DeploymentCommandExecutor>(
    (_command, _args, _options, callback) => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected repository command.");
      callback(
        response.error ?? null,
        response.stdout ?? "",
        response.stderr ?? ""
      );
      return { stdin: { end } };
    }
  );
  return {
    execute,
    end,
    repository: createDeploymentRepository({
      execute,
      redactDiagnostic: (message) =>
        message.replaceAll("private-detail", "[redacted]")
    })
  };
}

describe("deployment repository bindings", () => {
  it("reads JSON with explicit API headers, timeout, and closed stdin", async () => {
    const { repository, execute, end } = fixture({
      stdout: '{"value":"present"}'
    });
    expect(
      await repository.readJson("/fixture", {
        headers: { "X-GitHub-Api-Version": "2022-11-28" },
        timeout: 40
      })
    ).toEqual({
      ok: true,
      status: 200,
      json: { value: "present" },
      stderr: ""
    });
    expect(execute.mock.calls[0].slice(0, 3)).toEqual([
      "gh",
      ["api", "/fixture", "-H", "X-GitHub-Api-Version: 2022-11-28"],
      { timeout: 40 }
    ]);
    expect(end).toHaveBeenCalledWith();
  });

  it("preserves an empty JSON response and reports malformed JSON", async () => {
    const { repository, end } = fixture({}, { stdout: "not-json" });
    end.mockImplementation(() => {
      throw new Error("already closed");
    });
    expect(await repository.readJson("/empty")).toEqual({
      ok: true,
      status: 200,
      json: null,
      stderr: ""
    });
    expect(await repository.readJson("/malformed")).toMatchObject({
      ok: false,
      status: 200,
      json: null,
      stderr: expect.stringContaining("failed to parse response:")
    });
  });

  it.each([
    { error: { code: 1 }, stderr: "private-detail (HTTP 403)", status: 403 },
    { error: { code: 1 }, stderr: "private-detail HTTP 404", status: 404 },
    { error: { code: 1, message: "private-detail" }, status: null },
    { error: { code: 1 }, status: null }
  ])(
    "reports JSON command failures without exposing diagnostics %#",
    async ({ error, stderr, status }) => {
      const { repository } = fixture({ error, stderr });
      const result = await repository.readJson("/failure");
      expect(result).toMatchObject({ ok: false, json: null, status });
      expect(result.stderr).not.toContain("private-detail");
    }
  );

  it("reads UTF-8 content and explicit repository branches", async () => {
    const encoded = Buffer.from("caf\u00e9", "utf8").toString("base64");
    const { execute, repository } = fixture(
      { stdout: encoded },
      { stdout: encoded }
    );
    expect(
      await repository.readFile("owner/app", ".radius/app.bicep", "topic")
    ).toBe("caf\u00e9");
    expect(
      await repository.readFileResult("owner/app", ".radius/app.bicep", "topic")
    ).toEqual({
      content: "caf\u00e9",
      error: null,
      status: 200
    });
    expect(execute).toHaveBeenCalledWith(
      "gh",
      [
        "api",
        "/repos/owner/app/contents/.radius/app.bicep?ref=topic",
        "--jq",
        ".content"
      ],
      { timeout: 15000 },
      expect.any(Function)
    );
  });

  it("supports content API callers and preserves their timeout", async () => {
    const { execute, repository } = fixture({ stdout: "dGV4dA==" });
    expect(await repository.readContent("/fixture", 31)).toBe("text");
    expect(execute.mock.calls[0][2]).toEqual({ timeout: 31 });
  });

  it.each([
    {
      error: { code: 1 },
      stderr: "HTTP 403 private-detail",
      expected: "[redacted]",
      status: 403
    },
    {
      error: { code: 1, message: "private-detail" },
      expected: "[redacted]",
      status: null
    },
    { error: { code: 1 }, expected: "[object Object]", status: null }
  ])(
    "reports and redacts repository failures %#",
    async ({ error, stderr, expected, status }) => {
      const { repository } = fixture({ error, stderr }, { error, stderr });
      const result = await repository.readContentResult("/fixture");
      expect(result.content).toBeNull();
      expect(result.error).toContain(expected);
      expect(result.error).not.toContain("private-detail");
      expect(result.status).toBe(status);
      expect(await repository.readContent("/fixture")).toBeNull();
    }
  );

  it.each(["", " \n"])(
    "distinguishes an empty API response from a decoded file: %s",
    async (stdout) => {
      const { repository } = fixture({ stdout });
      expect(await repository.readContentResult("/fixture")).toEqual({
        content: null,
        error: "empty response from gh api",
        status: 200
      });
    }
  );

  it("uses the default-branch and encoded branch-ref endpoints", async () => {
    const { execute, repository } = fixture(
      { stdout: " trunk \n" },
      { stdout: " head \n" }
    );
    expect(await repository.defaultBranch("owner/app", 41)).toBe("trunk");
    expect(await repository.branchHead("owner/app", "feature/model", 42)).toBe(
      "head"
    );
    expect(execute.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      [["api", "/repos/owner/app", "--jq", ".default_branch"], { timeout: 41 }],
      [
        [
          "api",
          "/repos/owner/app/git/ref/heads/feature%2Fmodel",
          "--jq",
          ".object.sha"
        ],
        { timeout: 42 }
      ]
    ]);
  });

  it("preserves unavailable branch evidence as empty rather than guessing main", async () => {
    const { repository } = fixture(
      { error: { code: 1 } },
      {},
      { error: { code: 1 } }
    );
    expect(await repository.defaultBranch("owner/app")).toBe("");
    expect(await repository.branchHead("owner/app", "topic")).toBe("");
    expect(await repository.branchHead("owner/app", "topic")).toBe("");
  });

  it("avoids committing an identical Git blob", async () => {
    const content = "name: workflow";
    const sha = workflowBlobSha(Buffer.from(content).toString("base64"));
    const { repository, execute, end } = fixture({ stdout: sha });
    expect(
      await repository.commitFile(
        "owner/app",
        "workflow.yml",
        content,
        "topic",
        "message"
      )
    ).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(end).not.toHaveBeenCalled();
  });

  it.each(["", "old-blob"])(
    "sends create/update contents on stdin with prior blob %s",
    async (sha) => {
      const { repository, execute, end } = fixture({ stdout: sha }, {});
      expect(
        await repository.commitFile(
          "owner/app",
          "workflow.yml",
          "body",
          "topic",
          "message",
          71
        )
      ).toBe(true);
      expect(execute.mock.calls[1][1]).toEqual([
        "api",
        "--method",
        "PUT",
        "/repos/owner/app/contents/workflow.yml",
        "--input",
        "-"
      ]);
      expect(execute.mock.calls[1][2]).toEqual({ timeout: 71 });
      expect(JSON.parse(end.mock.calls[0][0])).toEqual({
        message: "message",
        content: Buffer.from("body").toString("base64"),
        branch: "topic",
        ...(sha ? { sha } : {})
      });
    }
  );

  it.each([{ code: 1, message: "private-detail" }, { code: 1 }])(
    "rejects a failed write without credential retry %#",
    async (error) => {
      const { repository, execute } = fixture({}, { error });
      await expect(
        repository.commitFile(
          "owner/app",
          "workflow.yml",
          "body",
          "topic",
          "message"
        )
      ).rejects.toThrow(error.message ? "[redacted]" : "[object Object]");
      expect(execute).toHaveBeenCalledTimes(2);
    }
  );

  it("prefers redacted write stderr and retains the callback result when stdin closes early", async () => {
    const { repository, end } = fixture(
      {},
      {
        error: { code: 1, message: "fallback" },
        stderr: "private-detail"
      }
    );
    end.mockImplementation(() => {
      throw new Error("already closed");
    });
    await expect(
      repository.commitFile(
        "owner/app",
        "workflow.yml",
        "body",
        "topic",
        "message"
      )
    ).rejects.toThrow("[redacted]");
  });

  it.each([
    ["AZURE_CLIENT_ID\tclient", "azure"],
    ["AZURE_CLIENT_ID\t\nAWS_ROLE_ARN\tfixture-role", "aws"],
    ["UNRELATED\tvalue", ""]
  ])(
    "classifies the stored non-empty provider markers",
    async (stdout, provider) => {
      const { repository, execute } = fixture({ stdout });
      expect(
        await repository.environmentProvider("owner/app", "dev team")
      ).toBe(provider);
      expect(execute.mock.calls[0][1][1]).toBe(
        "/repos/owner/app/environments/dev%20team/variables?per_page=100"
      );
    }
  );

  it("fails provider verification on an unreadable environment", async () => {
    const { repository } = fixture({ error: { code: 1 } });
    await expect(
      repository.environmentProvider("owner/app", "dev")
    ).rejects.toEqual({ code: 1 });
  });
});
