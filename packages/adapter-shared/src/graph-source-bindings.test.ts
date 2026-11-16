import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGraphOrchestrator,
  type GraphSourceIdentity
} from "@radius-project/core";
import type { DeploymentCommandExecutor } from "./deployment-command-bindings.js";
import { createGraphSourceBindings } from "./graph-source-bindings.js";

const revision = "a".repeat(40);
const repo = "owner/repository";
const rootPaths: string[] = [];

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(process.cwd(), ".graph-source-test-")
  );
  rootPaths.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    rootPaths
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

function harness(
  root: string,
  responses: Record<string, unknown> = {},
  errors: Record<string, string> = {}
) {
  const calls: string[] = [];
  const execute: DeploymentCommandExecutor = (
    command,
    args,
    _options,
    callback
  ) => {
    expect(command).toBe("gh");
    const apiPath = args[1];
    calls.push(apiPath);
    if (apiPath in errors) {
      callback(new Error(errors[apiPath]), "", errors[apiPath]);
    } else {
      if (!(apiPath in responses))
        throw new Error(`Unexpected request: ${apiPath}`);
      callback(null, JSON.stringify(responses[apiPath]), "");
    }
    return {};
  };
  const sources = createGraphSourceBindings({
    execute,
    stagingRoot: path.join(root, "staging"),
    redactDiagnostic: (message) =>
      message.replace(/private-detail/g, "[redacted]")
  });
  return { sources, calls, responses };
}

const commitPath = `/repos/${repo}/commits/feature%2Fbranch`;
const filePath = (file: string) =>
  `/repos/${repo}/contents/${file}?ref=${revision}`;
const encoded = (content: string | Buffer) => {
  const bytes = Buffer.from(content);
  return {
    encoding: "base64",
    size: bytes.length,
    content: bytes.toString("base64")
  };
};
const remoteSource: GraphSourceIdentity = {
  kind: "github",
  repo,
  ref: "feature/branch",
  revision,
  definitionPath: ".radius/app.bicep"
};
const local = (root: string) => ({
  repo,
  ref: "feature/branch",
  workspace: { repo, ref: "feature/branch", path: root, authorized: true }
});

describe("graph source bindings", () => {
  it("uses authorized saved workspace content, including empty preferred definitions", async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, ".radius"));
    await fs.writeFile(path.join(root, ".radius", "app.bicep"), "");
    await fs.writeFile(path.join(root, "app.bicep"), "older root model");
    const { sources, calls } = harness(root);
    const result = await sources.read(local(root));
    expect(result).toMatchObject({
      status: "present",
      content: "",
      source: {
        kind: "workspace",
        ref: "feature/branch",
        definitionPath: ".radius/app.bicep"
      }
    });
    expect(calls).toEqual([]);
    const graph = createGraphOrchestrator({
      stage: sources.stage,
      compile: async () => {
        throw new Error("compiler must not run");
      },
      diff: () => {
        throw new Error("unexpected diff");
      }
    });
    await expect(graph.authored(result)).rejects.toMatchObject({
      code: "empty"
    });
  });

  it("tries root only after confirmed preferred absence and never falls back remotely", async () => {
    const root = await fixture();
    const { sources, calls } = harness(root);
    expect(await sources.read(local(root))).toMatchObject({
      status: "absent",
      source: { kind: "workspace" }
    });
    await fs.writeFile(path.join(root, "app.bicep"), "root model");
    expect(await sources.read(local(root))).toMatchObject({
      status: "present",
      content: "root model",
      source: { definitionPath: "app.bicep" }
    });
    expect(calls).toEqual([]);
  });

  it("stops on an unreadable preferred definition instead of selecting root", async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, ".radius", "app.bicep"), {
      recursive: true
    });
    await fs.writeFile(path.join(root, "app.bicep"), "older");
    const { sources, calls } = harness(root);
    expect(await sources.read(local(root))).toMatchObject({
      status: "unavailable",
      source: { definitionPath: ".radius/app.bicep", kind: "workspace" }
    });
    expect(calls).toEqual([]);
  });

  it.each(["unauthorized", "other-repo", "other-ref", "committed-only"])(
    "uses pinned GitHub content for %s selections",
    async (mode) => {
      const root = await fixture();
      const { sources, calls } = harness(root, {
        [commitPath]: { sha: revision },
        [filePath(".radius/app.bicep")]: encoded("committed")
      });
      const request = local(root);
      if (mode === "unauthorized") request.workspace.authorized = false;
      if (mode === "other-repo") request.workspace.repo = "other/repository";
      if (mode === "other-ref") request.workspace.ref = "other";
      const result = await sources.read({
        ...request,
        committedOnly: mode === "committed-only"
      });
      expect(result).toMatchObject({
        status: "present",
        content: "committed",
        source: remoteSource
      });
      expect(calls).toEqual([commitPath, filePath(".radius/app.bicep")]);
    }
  );

  it("confirms ref readability before interpreting model 404 as absence", async () => {
    const root = await fixture();
    const { sources, calls } = harness(
      root,
      { [commitPath]: { sha: revision } },
      {
        [filePath(".radius/app.bicep")]: "Not Found (HTTP 404)",
        [filePath("app.bicep")]: "Not Found (HTTP 404)"
      }
    );
    expect(await sources.read({ repo, ref: "feature/branch" })).toMatchObject({
      status: "absent",
      source: { revision, kind: "github" }
    });
    expect(calls).toEqual([
      commitPath,
      filePath(".radius/app.bicep"),
      filePath("app.bicep")
    ]);
    const denied = harness(
      root,
      {},
      { [commitPath]: "private-detail (HTTP 404)" }
    );
    expect(
      await denied.sources.read({ repo, ref: "feature/branch" })
    ).toMatchObject({
      status: "unavailable",
      diagnostic: "[redacted] (HTTP 404)"
    });
    expect(denied.calls).toEqual([commitPath]);
  });

  it.each([null, { sha: "not-a-revision" }, [], { sha: 42 }])(
    "rejects malformed commit metadata %j",
    async (commit) => {
      const root = await fixture();
      const { sources, calls } = harness(root, { [commitPath]: commit });
      expect(await sources.read({ repo, ref: "feature/branch" })).toMatchObject(
        { status: "unavailable" }
      );
      expect(calls).toEqual([commitPath]);
    }
  );

  it.each([
    null,
    [],
    { encoding: "none", content: "", size: 0 },
    { encoding: "base64", content: 3, size: 0 },
    { encoding: "base64", content: "", size: -1 },
    { encoding: "base64", content: "!!!!", size: 0 },
    { encoding: "base64", content: "YQ==", size: 2 },
    { encoding: "base64", content: "", size: 0.1 }
  ])(
    "does not mistake malformed or unsupported content %j for absence",
    async (content) => {
      const root = await fixture();
      const { sources, calls } = harness(root, {
        [commitPath]: { sha: revision },
        [filePath(".radius/app.bicep")]: content
      });
      expect(await sources.read({ repo, ref: "feature/branch" })).toMatchObject(
        { status: "unavailable" }
      );
      expect(calls).toHaveLength(2);
    }
  );

  it("preserves remote empty definitions and explicit paths without selecting another", async () => {
    const root = await fixture();
    const { sources, calls } = harness(root, {
      [commitPath]: { sha: revision },
      [filePath("models/custom.bicep")]: encoded("")
    });
    expect(
      await sources.read({
        repo,
        ref: "feature/branch",
        definitionPath: "models/custom.bicep"
      })
    ).toMatchObject({
      status: "present",
      content: "",
      source: { definitionPath: "models/custom.bicep", revision }
    });
    expect(calls).toHaveLength(2);
  });

  it("reads captured supporting files at the same revision without resolving the branch again", async () => {
    const root = await fixture();
    const { sources, calls } = harness(root, {
      [commitPath]: { sha: revision },
      [filePath(".radius/app.bicep")]: encoded("model"),
      [filePath(".radius/origin.json")]: encoded("{}")
    });
    const selected = await sources.read({ repo, ref: "feature/branch" });
    expect(
      await sources.readFile(selected.source, ".radius/origin.json")
    ).toMatchObject({
      status: "present",
      content: "{}",
      source: { revision }
    });
    expect(calls).toEqual([
      commitPath,
      filePath(".radius/app.bicep"),
      filePath(".radius/origin.json")
    ]);
  });

  it("revalidates captured revisions before treating their file 404 as absence", async () => {
    const root = await fixture();
    const { sources, calls } = harness(
      root,
      {},
      {
        [`/repos/${repo}/commits/${revision}`]: "Not Found (HTTP 404)"
      }
    );
    expect(
      await sources.readFile(remoteSource, ".radius/origin.json")
    ).toMatchObject({ status: "unavailable" });
    expect(calls).toEqual([`/repos/${repo}/commits/${revision}`]);
    expect(
      await sources.readFile({ ...remoteSource, revision: undefined }, "file")
    ).toMatchObject({ status: "unavailable" });
  });

  it.each([
    "../outside.bicep",
    "/absolute.bicep",
    "C:\\outside.bicep",
    "nested\\..\\outside",
    "a//b",
    "a/./b",
    "bad\0path"
  ])("confines explicit path %j", async (definitionPath) => {
    const root = await fixture();
    const { sources, calls } = harness(root);
    expect(
      await sources.read({ ...local(root), definitionPath })
    ).toMatchObject({ status: "unavailable" });
    expect(calls).toEqual([]);
  });

  it("blocks symlink escapes, including absent descendants, without remote fallback", async () => {
    const root = await fixture();
    const outside = await fixture();
    await fs.writeFile(path.join(outside, "app.bicep"), "outside");
    await fs.symlink(outside, path.join(root, "link"), "dir");
    const { sources, calls } = harness(root);
    for (const definitionPath of ["link/app.bicep", "link/missing/app.bicep"]) {
      expect(
        await sources.read({ ...local(root), definitionPath })
      ).toMatchObject({
        status: "unavailable",
        diagnostic: expect.stringContaining("escapes")
      });
    }
    expect(calls).toEqual([]);
  });

  it("reports missing workspace identity and malformed selection explicitly", async () => {
    const root = await fixture();
    const { sources } = harness(root);
    expect(
      await sources.readFile(
        { ...remoteSource, kind: "workspace" },
        "app.bicep"
      )
    ).toMatchObject({ status: "unavailable" });
    expect(await sources.read({ repo: "", ref: "" })).toMatchObject({
      status: "unavailable"
    });
  });

  it("uses readable captured revisions without following mutable branches", async () => {
    const root = await fixture();
    const { sources, calls } = harness(root, {
      [`/repos/${repo}/commits/${revision}`]: { sha: revision },
      [filePath(".radius/app.bicep")]: encoded("captured")
    });
    expect(
      await sources.readFile(remoteSource, ".radius/app.bicep")
    ).toMatchObject({
      status: "present",
      content: "captured"
    });
    expect(calls).toEqual([
      `/repos/${repo}/commits/${revision}`,
      filePath(".radius/app.bicep")
    ]);
  });

  it.each([null, {}, { sha: "b".repeat(40) }])(
    "does not grant readable-revision proof to %j",
    async (proof) => {
      const root = await fixture();
      const { sources } = harness(root, {
        [`/repos/${repo}/commits/${revision}`]: proof
      });
      expect(await sources.readFile(remoteSource, "app.bicep")).toMatchObject({
        status: "unavailable",
        diagnostic: expect.stringContaining("no longer readable")
      });
    }
  );

  it("keeps repository transport and authorization failures unavailable, including for preferred files", async () => {
    const root = await fixture();
    const { sources, calls } = harness(
      root,
      { [commitPath]: { sha: revision } },
      {
        [filePath(".radius/app.bicep")]: "private-detail (HTTP 503)"
      }
    );
    expect(await sources.read({ repo, ref: "feature/branch" })).toMatchObject({
      status: "unavailable",
      diagnostic: "[redacted] (HTTP 503)"
    });
    expect(calls).toHaveLength(2);
  });

  it("runs a panel-free authored graph with pinned binary staging and explicit compiler ownership", async () => {
    const root = await fixture();
    const binary = Buffer.from([255, 0, 128, 31, 139]);
    const { sources, calls } = harness(root, {
      [commitPath]: { sha: revision },
      [filePath(".radius/app.bicep")]: encoded("model"),
      [filePath(".radius/bicepconfig.json")]: encoded(
        '{"extensions":{"custom":"types.tgz"}}'
      ),
      [filePath(".radius/types.tgz")]: encoded(binary)
    });
    let stagedDir = "";
    const graph = createGraphOrchestrator({
      stage: sources.stage,
      async compile(content, definitionPath, options) {
        expect([content, definitionPath]).toEqual([
          "model",
          ".radius/app.bicep"
        ]);
        expect(options.cleanupRadArtifactsDir).toBe(false);
        stagedDir = options.radArtifactsDir;
        expect(await fs.readFile(path.join(stagedDir, "types.tgz"))).toEqual(
          binary
        );
        return [{ name: "application" }];
      },
      diff: () => {
        throw new Error("unexpected diff");
      }
    });
    expect(
      await graph.authored(await sources.read({ repo, ref: "feature/branch" }))
    ).toMatchObject({
      status: "authored",
      source: { revision },
      resources: [{ name: "application" }]
    });
    expect(calls).toEqual([
      commitPath,
      filePath(".radius/app.bicep"),
      filePath(".radius/bicepconfig.json"),
      filePath(".radius/types.tgz")
    ]);
    await expect(fs.stat(stagedDir)).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it.each(["workspace", "github"] as const)(
    "preserves JSONC config bytes and referenced binary artifacts for %s sources",
    async (kind) => {
      const root = await fixture();
      const config = Buffer.from(
        [
          "{",
          '  // "extensions": "not a real property",',
          '  "extensions": { "custom": "./nested/types.tgz", },',
          '  "url": "https://example.test/a//b",',
          '  "commentLike": "/* literal */ // retained",',
          "  /* block comment */",
          "}"
        ].join("\r\n"),
        "utf8"
      );
      const binary = Buffer.from([255, 0, 128, 31, 139]);
      await fs.mkdir(path.join(root, ".radius", "nested"), { recursive: true });
      await fs.writeFile(path.join(root, ".radius", "app.bicep"), "model");
      await fs.writeFile(
        path.join(root, ".radius", "bicepconfig.json"),
        config
      );
      await fs.writeFile(
        path.join(root, ".radius", "nested", "types.tgz"),
        binary
      );
      const { sources, calls } = harness(root, {
        [commitPath]: { sha: revision },
        [filePath(".radius/app.bicep")]: encoded("model"),
        [filePath(".radius/bicepconfig.json")]: encoded(config),
        [filePath(".radius/nested/types.tgz")]: encoded(binary)
      });
      const selected = await sources.read({
        ...local(root),
        committedOnly: kind === "github"
      });
      if (selected.status !== "present") throw new Error("Expected model");
      const staged = await sources.stage(selected);
      try {
        expect(staged.owned).toBe(kind === "github");
        expect(
          await fs.readFile(path.join(staged.dir, "bicepconfig.json"))
        ).toEqual(config);
        expect(
          await fs.readFile(path.join(staged.dir, "nested", "types.tgz"))
        ).toEqual(binary);
        expect(calls).toHaveLength(kind === "github" ? 4 : 0);
      } finally {
        await staged.dispose();
      }
      expect(
        await fs.readFile(path.join(root, ".radius", "bicepconfig.json"))
      ).toEqual(config);
    }
  );

  it.each(["workspace", "github"] as const)(
    "rejects malformed JSONC from %s without discarding its configuration",
    async (kind) => {
      const root = await fixture();
      const malformed =
        '{ /* recoverable prefix */ "extensions": {"custom":,}}';
      await fs.mkdir(path.join(root, ".radius"));
      await fs.writeFile(path.join(root, ".radius", "app.bicep"), "model");
      await fs.writeFile(
        path.join(root, ".radius", "bicepconfig.json"),
        malformed
      );
      const { sources, calls } = harness(root, {
        [commitPath]: { sha: revision },
        [filePath(".radius/app.bicep")]: encoded("model"),
        [filePath(".radius/bicepconfig.json")]: encoded(malformed)
      });
      const selected = await sources.read({
        ...local(root),
        committedOnly: kind === "github"
      });
      if (selected.status !== "present") throw new Error("Expected model");
      await expect(sources.stage(selected)).rejects.toMatchObject({
        code: "invalid-artifact",
        message: "Graph bicepconfig.json is not valid JSON."
      });
      expect(calls).toHaveLength(kind === "github" ? 3 : 0);
      expect(
        await fs.readFile(
          path.join(root, ".radius", "bicepconfig.json"),
          "utf8"
        )
      ).toBe(malformed);
      await expect(fs.stat(path.join(root, "staging"))).rejects.toMatchObject({
        code: "ENOENT"
      });
    }
  );

  it("reports selected executor exceptions and empty external diagnostics explicitly", async () => {
    const root = await fixture();
    const { sources } = harness(
      root,
      { [commitPath]: { sha: revision } },
      {
        [filePath(".radius/app.bicep")]: ""
      }
    );
    expect(await sources.read({ repo, ref: "feature/branch" })).toMatchObject({
      status: "unavailable",
      diagnostic: "GitHub graph file unavailable."
    });
    const throwing = createGraphSourceBindings({
      execute() {
        throw "selected executor unavailable";
      },
      stagingRoot: path.join(root, "staging"),
      redactDiagnostic: (message) => message
    });
    expect(await throwing.readFile(remoteSource, "app.bicep")).toMatchObject({
      status: "unavailable",
      diagnostic: "selected executor unavailable"
    });
  });
});
