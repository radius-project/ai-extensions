import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { parse, parseDocument } from "yaml";
import { DEPLOY_AWS_FILE, DEPLOY_DISPATCHER_FILE } from "@radius-project/core";
import {
  createDeploymentWorkflows,
  type DeploymentWorkflowPorts
} from "./deployment-workflows.js";
import { deploymentTemplates } from "../test/fixtures/deployment-workflows.js";

function fixture(includeAws = false) {
  const files = new Map<string, string>();
  const ports = {
    readRepositoryFile: vi.fn<DeploymentWorkflowPorts["readRepositoryFile"]>(
      async (_repo, path) => {
        const file = path.slice(path.lastIndexOf("/") + 1);
        if (!deploymentTemplates[file])
          throw new Error(`Unexpected template: ${path}`);
        return { content: deploymentTemplates[file] };
      }
    ),
    now: () => 0,
    ghOrThrow: vi
      .fn<DeploymentWorkflowPorts["ghOrThrow"]>()
      .mockResolvedValue("blob"),
    readFile: vi.fn<DeploymentWorkflowPorts["readFile"]>(
      async (_repo, path, branch) => files.get(`${branch}:${path}`) ?? null
    ),
    defaultBranch: vi
      .fn<DeploymentWorkflowPorts["defaultBranch"]>()
      .mockResolvedValue("main"),
    branchHead: vi
      .fn<DeploymentWorkflowPorts["branchHead"]>()
      .mockResolvedValue("head"),
    commitFile: vi.fn<DeploymentWorkflowPorts["commitFile"]>(
      async (_repo, path, content, branch) => {
        files.set(`${branch}:${path}`, content);
        return true;
      }
    ),
    environmentProvider: vi
      .fn<DeploymentWorkflowPorts["environmentProvider"]>()
      .mockResolvedValue("azure"),
    reportDiagnostic: vi.fn()
  } satisfies DeploymentWorkflowPorts;
  return {
    files,
    ports,
    workflows: createDeploymentWorkflows(includeAws, ports)
  };
}

describe("deployment workflow production bindings", () => {
  it("validates consumer identity without requiring a package-manager lockfile", async () => {
    const action = parse(
      await readFile(
        new URL(
          "../../../.github/extension/actions/validate-deployment-identity/action.yml",
          import.meta.url
        ),
        "utf8"
      )
    );
    expect(action.runs.steps[0].with).toEqual({
      "node-version": "24",
      "package-manager-cache": false
    });
  });

  it.each([
    {
      name: "wrong application input type",
      path: ["on", "workflow_call", "inputs", "application", "type"],
      value: "boolean",
      error: "string application input"
    },
    {
      name: "missing preflight identity",
      path: ["jobs", "run", "steps", 1, "id"],
      value: undefined,
      error: "before cloud work"
    },
    {
      name: "missing preflight action",
      path: ["jobs", "run", "steps", 1, "uses"],
      value: undefined,
      error: "before cloud work"
    },
    {
      name: "unrecognized preflight action",
      path: ["jobs", "run", "steps", 1, "uses"],
      value: "another/action@fixture",
      error: "before cloud work"
    },
    {
      name: "conditional preflight",
      path: ["jobs", "run", "steps", 1, "if"],
      value: "${{ always() }}",
      error: "before cloud work"
    },
    {
      name: "mismatched declared identity",
      path: ["jobs", "run", "steps", 1, "with", "application"],
      value: "another-app",
      error: "before cloud work"
    },
    {
      name: "mismatched preflight model",
      path: ["jobs", "run", "steps", 1, "with", "app-file"],
      value: ".radius/another.bicep",
      error: "before cloud work"
    },
    {
      name: "unchecked repository command fallback",
      path: ["jobs", "run", "steps", 1, "with", "rad-commands"],
      value: "${{ inputs.rad_commands }}",
      error: "before cloud work"
    },
    {
      name: "teardown after refused preflight",
      path: ["jobs", "run", "steps", 3],
      value: {
        uses: "radius-project/ai-extensions/.github/extension/actions/teardown@fixture",
        if: "${{ always() }}"
      },
      error: "must not run teardown"
    }
  ])(
    "refuses $name on the selected provider",
    async ({ path, value, error }) => {
      const h = fixture();
      await h.workflows.ensureCurrent(
        "owner/app",
        "dev",
        "azure",
        h.workflows.files,
        "topic"
      );
      const key = `topic:.github/workflows/${h.workflows.files[1]}`;
      const source = h.files.get(key);
      if (!source) throw new Error("Missing fixture workflow");
      const document = parseDocument(source);
      if (value === undefined) document.deleteIn(path);
      else document.setIn(path, value);
      h.files.set(key, document.toString());
      await expect(
        h.workflows.verifyAppFileInput("owner/app", "topic")
      ).rejects.toThrow(error);
    }
  );

  it.each(
    [
      ["dispatcher", "app_file"],
      ["provider", "app_file"],
      ["aws", "app_file"],
      ["dispatcher", "correlation_id"]
    ].flatMap(([kind, input]) =>
      [
        ["missing", undefined],
        ["null", null],
        ["scalar", "string"],
        ["array", []],
        ["missing type", {}],
        ["wrong type", { type: "boolean" }]
      ].map(([shape, value]) => ({ kind, input, shape, value }))
    )
  )(
    "gives upgrade guidance for $shape $input on $kind",
    async ({ kind, input, value }) => {
      const h = fixture(kind === "aws");
      await h.workflows.ensureCurrent(
        "owner/app",
        "dev",
        "azure",
        h.workflows.files,
        "topic"
      );
      const file =
        h.workflows.files[
          kind === "dispatcher" ? 0
          : kind === "aws" ? 2
          : 1
        ];
      const key = `topic:.github/workflows/${file}`;
      const source = h.files.get(key);
      if (!source) throw new Error("Missing fixture workflow");
      const document = parseDocument(source);
      const path = [
        "on",
        kind === "dispatcher" ? "workflow_dispatch" : "workflow_call",
        "inputs",
        input
      ];
      if (value === undefined) document.deleteIn(path);
      else document.setIn(path, value);
      h.files.set(key, document.toString());
      await expect(
        h.workflows.verifyAppFileInput("owner/app", "topic")
      ).rejects.toThrow(new RegExp(`${input}.*Update the Radius workflows`));
    }
  );

  it.each(["dispatcher", "provider"])(
    "gives actionable input guidance for absent or malformed %s parents",
    async (kind) => {
      const h = fixture();
      await h.workflows.ensureCurrent(
        "owner/app",
        "dev",
        "azure",
        h.workflows.files,
        "topic"
      );
      const file = h.workflows.files[kind === "dispatcher" ? 0 : 1];
      const key = `topic:.github/workflows/${file}`;
      const source = h.files.get(key);
      if (!source) throw new Error("Missing fixture workflow");
      for (const path of [
        ["on"],
        ["on", kind === "dispatcher" ? "workflow_dispatch" : "workflow_call"],
        [
          "on",
          kind === "dispatcher" ? "workflow_dispatch" : "workflow_call",
          "inputs"
        ]
      ]) {
        for (const value of [undefined, null, [], "invalid"]) {
          const document = parseDocument(source);
          if (value === undefined) document.deleteIn(path);
          else document.setIn(path, value);
          h.files.set(key, document.toString());
          await expect(
            h.workflows.verifyAppFileInput("owner/app", "topic")
          ).rejects.toThrow(`${file} must accept the string app_file input`);
        }
      }
    }
  );

  it.each([false, true])(
    "verifies the real generated templates after competing environment synchronization (AWS %s)",
    async (aws) => {
      const h = fixture(aws);
      h.ports.readRepositoryFile.mockImplementation(async (_repo, path) => ({
        content: await readFile(
          new URL(`../../../${path}`, import.meta.url),
          "utf8"
        )
      }));
      await Promise.all(
        ["dev", "prod"].map((environment) =>
          h.workflows.ensureCurrent(
            "owner/app",
            environment,
            "azure",
            h.workflows.files,
            "topic"
          )
        )
      );
      await expect(
        h.workflows.verifyAppFileInput("owner/app", "topic")
      ).resolves.toBeUndefined();
      for (const file of h.workflows.files) {
        const source = h.files.get(`topic:.github/workflows/${file}`);
        if (!source) throw new Error(`Missing generated workflow: ${file}`);
        const workflow: unknown = parse(source);
        const trigger =
          file === DEPLOY_DISPATCHER_FILE ? "workflow_dispatch" : (
            "workflow_call"
          );
        expect(workflow).toMatchObject({
          on: {
            [trigger]: {
              inputs: {
                app_file: {
                  type: "string",
                  required: false,
                  default: ""
                }
              }
            }
          }
        });
        if (file !== DEPLOY_DISPATCHER_FILE)
          expect(workflow).toMatchObject({
            env: { APP_FILE: "${{ inputs.app_file || '.radius/app.bicep' }}" }
          });
      }
    }
  );

  it.each([true, false])(
    "requires readback capability when workflow writes are declined (existing capability %s)",
    async (capable) => {
      const h = fixture();
      await h.workflows.ensureCurrent(
        "owner/app",
        "dev",
        "azure",
        h.workflows.files,
        "topic"
      );
      if (!capable) {
        const key = `topic:.github/workflows/${DEPLOY_DISPATCHER_FILE}`;
        h.files.set(
          key,
          h.files.get(key)?.replace("app_file:", "old_input:") ?? ""
        );
      }
      h.ports.commitFile.mockResolvedValue(false);
      await h.workflows.ensureCurrent(
        "owner/app",
        "prod",
        "azure",
        h.workflows.files,
        "topic"
      );
      const verified = h.workflows.verifyAppFileInput("owner/app", "topic");
      if (capable) await expect(verified).resolves.toBeUndefined();
      else await expect(verified).rejects.toThrow();
    }
  );

  it.each([false, true])(
    "verifies every enabled provider on the selected branch (AWS %s)",
    async (aws) => {
      const h = fixture(aws);
      await h.workflows.ensureCurrent(
        "owner/app",
        "dev",
        "azure",
        h.workflows.files,
        "topic"
      );
      await expect(
        h.workflows.verifyAppFileInput("owner/app", "topic")
      ).resolves.toBeUndefined();
      h.ports.commitFile.mockClear();
      await h.workflows.verifyAppFileInput("owner/app", "topic");
      expect(h.ports.commitFile).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["missing", "provider"],
    ["malformed", "provider"],
    ["non-object", "provider"],
    ["missing schema", "dispatcher"],
    ["missing correlation", "dispatcher"],
    ["uncorrelated title", "dispatcher"],
    ["no steps", "provider"],
    ["schema", "dispatcher"],
    ["schema", "provider"],
    ["forwarding", "dispatcher"],
    ["routing", "dispatcher"],
    ["effective", "provider"],
    ["runner", "provider"],
    ["job override", "provider"],
    ["step override", "provider"],
    ["no runner", "provider"]
  ])("refuses %s in the selected %s contract", async (failure, kind) => {
    const h = fixture();
    await h.workflows.ensureCurrent(
      "owner/app",
      "dev",
      "azure",
      h.workflows.files,
      "topic"
    );
    const file = h.workflows.files[kind === "dispatcher" ? 0 : 1];
    const key = `topic:.github/workflows/${file}`;
    const source = h.files.get(key);
    if (!source) throw new Error("Fixture was not synchronized");
    const replacements: Record<string, string> = {
      missing: "",
      malformed: "[",
      "non-object": "[]",
      "missing schema": source.replace("app_file:", "old_input:"),
      "missing correlation": source.replace(
        "correlation_id:",
        "old_correlation:"
      ),
      "uncorrelated title": source.replace(
        "${{ inputs.correlation_id }}",
        "uncorrelated"
      ),
      "no steps": source.slice(0, source.indexOf("    steps:")),
      schema: source.replace("type: string", "type: number"),
      forwarding: source.replace("${{ inputs.app_file }}", "default.bicep"),
      routing: source.replace(
        "./.github/workflows/run-rad-commands-azure.yml",
        "./.github/workflows/other.yml"
      ),
      effective: source.replace(
        "${{ inputs.app_file || '.radius/app.bicep' }}",
        ".radius/app.bicep"
      ),
      runner: source.replace("${{ env.APP_FILE }}", ".radius/app.bicep"),
      "job override": source.replace(
        "    runs-on:",
        "    env:\n      APP_FILE: wrong.bicep\n    runs-on:"
      ),
      "step override": source.replace(
        "        with:",
        "        env:\n          APP_FILE: wrong.bicep\n        with:"
      ),
      "no runner": source.replace(
        "/actions/run-rad-commands@",
        "/actions/other@"
      )
    };
    h.files.set(key, replacements[failure]);
    await expect(
      h.workflows.verifyAppFileInput("owner/app", "topic")
    ).rejects.toThrow();
  });

  it("propagates input-contract read failure", async () => {
    const h = fixture();
    h.ports.readFile.mockRejectedValue(new Error("unreadable"));
    await expect(
      h.workflows.verifyAppFileInput("owner/app", "topic")
    ).rejects.toThrow("unreadable");
  });

  it("does not republish existing workflows", async () => {
    const { ports, workflows } = fixture();
    const written = vi.fn();
    await workflows.ensureOnBranch(
      "owner/app",
      "feature/model",
      "dev",
      vi.fn(),
      written
    );
    expect(ports.ghOrThrow).toHaveBeenCalledWith(
      [
        "api",
        `/repos/owner/app/contents/.github/workflows/${DEPLOY_DISPATCHER_FILE}?ref=feature%2Fmodel`,
        "--jq",
        ".sha"
      ],
      15000
    );
    expect(ports.readRepositoryFile).not.toHaveBeenCalled();
    expect(ports.commitFile).not.toHaveBeenCalled();
    expect(written).not.toHaveBeenCalled();
  });

  it.each(["", "read failure"])(
    "publishes a missing preflight workflow after %s",
    async (reason) => {
      const { ports, workflows } = fixture();
      if (reason) ports.ghOrThrow.mockRejectedValueOnce(new Error(reason));
      else ports.ghOrThrow.mockResolvedValueOnce("");
      const log = vi.fn();
      const written = vi.fn();
      await workflows.ensureOnBranch("owner/app", "topic", "dev", log, written);
      expect(written).toHaveBeenCalledExactlyOnceWith(DEPLOY_DISPATCHER_FILE);
      expect(ports.commitFile.mock.calls[0].slice(0, 2)).toEqual([
        "owner/app",
        `.github/workflows/${DEPLOY_DISPATCHER_FILE}`
      ]);
      expect(log).toHaveBeenCalledWith(
        `Publishing deploy workflow(s) to branch "topic": ${DEPLOY_DISPATCHER_FILE}`
      );
    }
  );

  it("does not claim a concurrent publication as its own write", async () => {
    const { ports, workflows } = fixture();
    ports.ghOrThrow.mockResolvedValue("");
    ports.commitFile.mockResolvedValue(false);
    const written = vi.fn();
    await workflows.ensureOnBranch(
      "owner/app",
      "topic",
      "dev",
      vi.fn(),
      written
    );
    expect(written).not.toHaveBeenCalled();
  });

  it("propagates publication refusal before dispatch can proceed", async () => {
    const { ports, workflows } = fixture();
    ports.ghOrThrow.mockResolvedValue("");
    ports.commitFile.mockRejectedValue(new Error("protected branch"));
    await expect(
      workflows.ensureOnBranch("owner/app", "topic", "dev", vi.fn(), vi.fn())
    ).rejects.toThrow("protected branch");
  });

  it.each([
    ["", "topic"],
    ["owner/app", ""]
  ])("skips incomplete publication targets %s/%s", async (repo, branch) => {
    const { ports, workflows } = fixture();
    await workflows.ensureOnBranch(repo, branch, "dev", vi.fn(), vi.fn());
    expect(ports.ghOrThrow).not.toHaveBeenCalled();
  });

  it("synchronizes selected deployment files on both branches, providers first", async () => {
    const { ports, workflows } = fixture();
    const result = await workflows.ensureCurrent(
      "owner/app",
      "dev",
      "azure",
      workflows.files,
      "topic"
    );
    expect(result.created).toHaveLength(2);
    expect(result.updated).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(
      ports.commitFile.mock.calls.map((call) => [call[1], call[3]])
    ).toEqual([
      [`.github/workflows/${workflows.files[1]}`, "main"],
      [`.github/workflows/${workflows.files[0]}`, "main"],
      [`.github/workflows/${workflows.files[1]}`, "topic"],
      [`.github/workflows/${workflows.files[0]}`, "topic"]
    ]);
    expect(ports.environmentProvider).not.toHaveBeenCalled();
    expect(ports.reportDiagnostic).toHaveBeenCalledWith(
      expect.stringContaining("before dispatch")
    );
  });

  it("deduplicates the selected default branch and updates drift", async () => {
    const { files, ports, workflows } = fixture();
    for (const file of workflows.files)
      files.set(`main:.github/workflows/${file}`, "old");
    const result = await workflows.ensureCurrent(
      "owner/app",
      "dev",
      "azure",
      workflows.files,
      "main"
    );
    expect(result.updated).toHaveLength(2);
    expect(ports.commitFile).toHaveBeenCalledTimes(2);
  });

  it("honors the workflow allowlist without generating unrelated workflow families", async () => {
    const { ports, workflows } = fixture();
    const result = await workflows.ensureCurrent("owner/app", "dev", "", [
      `.github/workflows/${workflows.files[1]}`
    ]);
    expect(result.created).toEqual([`.github/workflows/${workflows.files[1]}`]);
    expect(ports.commitFile).toHaveBeenCalledTimes(1);
    expect(ports.readRepositoryFile).toHaveBeenCalledTimes(2);
  });

  it("includes concurrently created files in registration waits", async () => {
    const { ports, workflows } = fixture();
    ports.commitFile.mockResolvedValue(false);
    expect(
      (
        await workflows.ensureCurrent(
          "owner/app",
          "dev",
          "azure",
          workflows.files
        )
      ).created
    ).toHaveLength(2);
  });

  it("retains per-branch refusal details without treating Azure best-effort sync as a dispatch failure", async () => {
    const { ports, workflows } = fixture();
    ports.commitFile.mockRejectedValue(new Error("protected"));
    const result = await workflows.ensureCurrent(
      "owner/app",
      "dev",
      "azure",
      workflows.files
    );
    expect(result.failed).toHaveLength(2);
    expect(result.created).toEqual([]);
  });

  it.each(["missing branch", "template failure", "read failure"])(
    "reports Azure synchronization failure: %s",
    async (reason) => {
      const { ports, workflows } = fixture();
      if (reason === "missing branch")
        ports.defaultBranch.mockResolvedValue(null);
      if (reason === "template failure")
        ports.readRepositoryFile.mockRejectedValue(new Error(reason));
      if (reason === "read failure") ports.readFile.mockRejectedValue(reason);
      expect(
        await workflows.ensureCurrent(
          "owner/app",
          "dev",
          "azure",
          workflows.files
        )
      ).toEqual({
        created: [],
        updated: [],
        failed: []
      });
      expect(ports.commitFile).not.toHaveBeenCalled();
      expect(ports.reportDiagnostic).toHaveBeenCalledWith(
        expect.stringContaining("[radius workflow-presync] owner/app:")
      );
    }
  );

  it.each([
    ["", "dev", ["file"]],
    ["owner/app", "", ["file"]],
    ["owner/app", "dev", []]
  ] as const)(
    "does not synchronize incomplete target %#",
    async (repo, environment, files) => {
      const { ports, workflows } = fixture();
      expect(
        await workflows.ensureCurrent(repo, environment, "", [...files])
      ).toEqual({
        created: [],
        updated: [],
        failed: []
      });
      expect(ports.defaultBranch).not.toHaveBeenCalled();
    }
  );

  it("requires current AWS workflow readback on both selected branches", async () => {
    const { ports, workflows } = fixture(true);
    ports.environmentProvider.mockResolvedValue("aws");
    await workflows.ensureCurrent(
      "owner/app",
      "dev",
      "aws",
      workflows.files,
      "topic"
    );
    expect(ports.readFile).toHaveBeenCalledWith(
      "owner/app",
      `.github/workflows/${DEPLOY_AWS_FILE}`,
      "main"
    );
    expect(ports.readFile).toHaveBeenCalledWith(
      "owner/app",
      `.github/workflows/${DEPLOY_AWS_FILE}`,
      "topic"
    );
    expect(ports.defaultBranch).toHaveBeenCalledTimes(2);
  });

  it("rejects stale AWS workflows even when publication claims success", async () => {
    const { ports, workflows } = fixture(true);
    ports.environmentProvider.mockResolvedValue("aws");
    ports.commitFile.mockResolvedValue(true);
    await expect(
      workflows.ensureCurrent("owner/app", "dev", "aws", workflows.files)
    ).rejects.toThrow("not confirmed current");
  });

  it("uses the stored provider, not an editable request, when deciding AWS verification", async () => {
    const { ports, workflows } = fixture(true);
    await workflows.ensureCurrent("owner/app", "dev", "aws", workflows.files);
    expect(ports.environmentProvider).toHaveBeenCalledWith("owner/app", "dev");
    expect(ports.defaultBranch).toHaveBeenCalledTimes(1);
  });
});
