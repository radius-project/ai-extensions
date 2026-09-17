import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { expect, vi } from "vitest";
import {
  portForbidden,
  portSuccess,
  type AuthorizationRequest,
  type EnvironmentAccessPort,
  type SourceSelection
} from "@radius-project/core/lifecycle";
import {
  createGraphCompilationAdapter,
  nodeSourceFileSystem,
  type SourceFileSystem,
  type runRadAppGraph
} from "@radius-project/adapter-shared";
import { createCanvasDiscoveryContext } from "../../src/runtime/create-discovery-context.js";
import { createLifecycleBinding } from "../../src/runtime/create-lifecycle-binding.js";
import { bootstrapRadiusExtension } from "../../src/runtime/bootstrap.js";
import type { SessionPort } from "../../src/runtime/session.js";
import { authorizeFixture, createLifecycleFixture } from "./lifecycle.js";
import { createFakeDependencies } from "./runtime/fakes.js";

export const graphDefinition = ".radius/app.bicep";
export const graphBranch = "feature/graph";
export const graphBase: SourceSelection = {
  repo: "owner/repo",
  definition: graphDefinition,
  source: { kind: "git", ref: "main", expectedCommit: "a".repeat(40) }
};
export const graphHead: SourceSelection = {
  repo: "fork/repo",
  definition: graphDefinition,
  source: { kind: "git", ref: graphBranch, expectedCommit: "b".repeat(40) }
};
export type GraphSourceMode =
  "ok" | "missing" | "forbidden" | "network" | "malformed";

export function graphInputs(label: string): ReadonlyMap<string, Buffer> {
  return new Map([
    [
      graphDefinition,
      Buffer.from(
        "extension radius\n" +
          "var settings = loadJsonContent('./settings.json')\n" +
          "resource app 'Radius.Core/applications@2025-08-01-preview' = { name: 'app' }\n" +
          "resource cache 'Radius.Data/redisCaches@2025-08-01-preview' = { name: 'cache' }\n"
      )
    ],
    [".radius/settings.json", Buffer.from(JSON.stringify({ label }))],
    [
      ".radius/bicepconfig.json",
      Buffer.from('{"extensions":{"radius":"./custom-types.tgz"}}\r\n')
    ],
    [
      ".radius/custom-types.tgz",
      Buffer.from([31, 139, 8, 0, 255, 128, label.length])
    ],
    [".radius/custom-types.yaml", Buffer.from("name: fixture\n")],
    [
      ".radius/custom-recipe-pack.bicep",
      Buffer.from("param fixture string = 'fixture'\n")
    ]
  ]);
}

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function blobSha(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}
function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child !== ".." &&
    !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(child)
  );
}
async function filesUnder(root: string): Promise<Map<string, Buffer>> {
  const found = new Map<string, Buffer>();
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else
        found.set(
          relative(root, path).split("\\").join("/"),
          await readFile(path)
        );
    }
  }
  await visit(root);
  return found;
}

export async function createGraphBoundaryFixture(
  options: {
    baseMode?: GraphSourceMode;
    denyFork?: boolean;
    registrations?: EnvironmentAccessPort["registrations"];
  } = {}
) {
  const root = resolve(".artifacts", `canvas-graphs-${randomUUID()}`);
  const workspace = join(root, "worktree");
  const snapshotRoot = join(root, "snapshots");
  const compileRoot = join(root, "compilations");
  await mkdir(join(workspace, ".radius"), { recursive: true });
  await mkdir(snapshotRoot);
  await mkdir(compileRoot);
  const initial = graphInputs("uncommitted");
  for (const [path, bytes] of initial)
    await writeFile(join(workspace, path), bytes);
  const writes: string[] = [];
  const forbidden: string[] = [];
  function reject(name: string): never {
    forbidden.push(name);
    throw new Error(`Unmodeled graph boundary: ${name}`);
  }
  const authorizations: AuthorizationRequest[] = [];
  const fixture = createLifecycleFixture({
    caller: {
      principalRef: "github:fixture-reader",
      identityRef: "github:fixture-reader",
      sessionRef: "fixture-session",
      responder: "agent"
    },
    overrides: {
      identity: {
        authorize: async (request) => {
          authorizations.push(request);
          if (
            ![
              "application.list",
              "graph.get",
              "graph.diff",
              "capabilities.get"
            ].includes(request.operation) ||
            !["owner/repo", "fork/repo"].includes(request.target.repo)
          )
            return reject(
              `authorization:${request.operation}:${request.target.repo}`
            );
          if (
            options.denyFork &&
            request.target.repo === "fork/repo" &&
            "source" in request.target
          )
            return portForbidden();
          return portSuccess(authorizeFixture(request));
        }
      }
    }
  });
  const files: SourceFileSystem = {
    ...nodeSourceFileSystem,
    async write(path, bytes) {
      if (!inside(root, path) || inside(workspace, path))
        reject(`source write:${path}`);
      writes.push(path);
      await nodeSourceFileSystem.write(path, bytes);
    },
    async mkdir(path) {
      if (!inside(root, path) || inside(workspace, path))
        reject(`source mkdir:${path}`);
      await nodeSourceFileSystem.mkdir(path);
    },
    async remove(path) {
      if (!inside(root, path) || inside(workspace, path))
        reject(`source remove:${path}`);
      await nodeSourceFileSystem.remove(path);
    }
  };
  type CommandResult = { code: number; stdout: string; stderr: string };
  const commands = new Map<string, CommandResult>();
  const calls: string[][] = [];
  function get(path: string, result: CommandResult) {
    commands.set(
      JSON.stringify([
        "api",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        path
      ]),
      result
    );
  }
  function json(path: string, value: unknown) {
    get(path, { code: 0, stdout: JSON.stringify(value), stderr: "" });
  }
  function remote(
    selection: SourceSelection,
    label: string,
    mode: GraphSourceMode
  ) {
    if (selection.source.kind !== "git" || !selection.source.expectedCommit)
      throw new Error("Remote fixture requires a committed ref");
    const { repo } = selection;
    const { ref, expectedCommit: commit } = selection.source;
    const tree = sha(Buffer.from(`${repo}:${commit}`)).slice(0, 40);
    const payloads = graphInputs(label);
    json(`/repos/${repo}`, { full_name: repo });
    for (const value of [ref, commit])
      json(`/repos/${repo}/commits/${encodeURIComponent(value)}`, {
        sha: commit,
        commit: { tree: { sha: tree } }
      });
    json(`/repos/${repo}/git/trees/${tree}?recursive=1`, {
      sha: tree,
      truncated: false,
      tree:
        mode === "missing" ?
          []
        : [
            {
              path: ".radius",
              type: "tree",
              mode: "040000",
              sha: "e".repeat(40)
            },
            ...[...payloads].map(([path, bytes]) => ({
              path,
              type: "blob",
              mode: "100644",
              sha: blobSha(bytes),
              size: bytes.length
            }))
          ]
    });
    for (const [path, bytes] of payloads) {
      const endpoint = `/repos/${repo}/contents/${path}?ref=${commit}`;
      if (
        path === graphDefinition &&
        (mode === "forbidden" || mode === "network")
      ) {
        get(endpoint, {
          code: 1,
          stdout: "",
          stderr: mode === "forbidden" ? "HTTP 403" : "Connection failed"
        });
      } else {
        json(
          endpoint,
          path === graphDefinition && mode === "malformed" ?
            { content: 42 }
          : {
              sha: blobSha(bytes),
              encoding: "base64",
              content: bytes.toString("base64")
            }
        );
      }
    }
  }
  remote(graphBase, "committed-base", options.baseMode ?? "ok");
  remote(graphHead, "committed-head", "ok");
  // The retained PR tool accepts one repository but must still resolve each
  // branch remotely, even when head names the attached worktree branch.
  remote({ ...graphHead, repo: graphBase.repo }, "committed-head", "ok");
  const git = vi.fn(async (_directory: string, args: string[]) => {
    if (args.join(" ") === "rev-parse --abbrev-ref HEAD") return graphBranch;
    if (args.join(" ") === "rev-parse HEAD") return "c".repeat(40);
    return reject(`git:${args.join(" ")}`);
  });
  const hostBinding = () => ({
    bindingRef: "fixture-binding",
    sessionRef: fixture.caller.sessionRef
  });
  const executor = async (login: string) => ({
    login,
    async run(args: string[]) {
      calls.push([...args]);
      const result = commands.get(JSON.stringify(args));
      return result ? { ...result } : reject(`gh:${args.join(" ")}`);
    }
  });
  const context = createCanvasDiscoveryContext({
    authority: fixture.ports.identity,
    hostBinding,
    clock: fixture.ports.clock,
    ids: fixture.ports.ids,
    storageRoot: snapshotRoot,
    workspace: async () => ({
      workspacePath: workspace,
      repo: "owner/repo",
      branch: graphBranch
    }),
    files,
    git,
    executor
  });
  const compiled: Array<{
    file: string;
    cwd: string;
    inputs: Map<string, Buffer>;
  }> = [];
  const runGraph = vi.fn<typeof runRadAppGraph>(async (file, runOptions) => {
    const isolation = runOptions?.isolation;
    if (!isolation) return reject("compiler missing isolation");
    expect(inside(compileRoot, isolation.cwd)).toBe(true);
    expect(inside(isolation.cwd, file)).toBe(true);
    expect(relative(isolation.cwd, file).split("\\").join("/")).toBe(
      graphDefinition
    );
    expect(runOptions.radPath).toBe(process.execPath);
    expect(isolation.bicepPath).toBe(process.execPath);
    expect(runOptions.signal).toBeInstanceOf(AbortSignal);
    expect(runOptions.timeout).toBe(2_000);
    expect(isolation.env.PATH).toBe(join(root, "trusted-bin"));
    for (const key of [
      "HOME",
      "USERPROFILE",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "APPDATA",
      "LOCALAPPDATA",
      "GH_CONFIG_DIR",
      "AZURE_CONFIG_DIR",
      "AWS_CONFIG_FILE",
      "AWS_SHARED_CREDENTIALS_FILE"
    ]) {
      const path = isolation.env[key];
      if (!path) return reject(`missing isolated ${key}`);
      expect(inside(compileRoot, path)).toBe(true);
    }
    expect(isolation.env.HOME).toBe(isolation.env.USERPROFILE);
    expect(isolation.env.GITHUB_ACTIONS).toBe("");
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "AZURE_CLIENT_SECRET",
      "AZURE_FEDERATED_TOKEN_FILE",
      "AWS_ACCESS_KEY_ID",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "DOCKER_CONFIG"
    ])
      expect(isolation.env[key]).toBeUndefined();
    expect(runOptions.saveGraphJsonTo).toBeUndefined();
    const copied = new Map<string, Buffer>();
    for (const path of initial.keys())
      copied.set(path, await readFile(join(isolation.cwd, path)));
    const config = copied.get(".radius/bicepconfig.json");
    expect(config).toEqual(initial.get(".radius/bicepconfig.json"));
    const settings = copied.get(".radius/settings.json");
    if (!settings) throw new Error("Missing copied supporting file");
    compiled.push({ file, cwd: isolation.cwd, inputs: copied });
    return {
      resources: [
        {
          id: "cache",
          name: "cache",
          type: "Radius.Data/redisCaches",
          diffHash: `sha256:${sha(Buffer.concat([...copied.values()]))}`,
          connections: [],
          outputResources: []
        }
      ]
    };
  });
  try {
    const compiler = createGraphCompilationAdapter({
      source: context.source,
      files,
      storageRoot: compileRoot,
      ids: fixture.ports.ids,
      acquireBinaries: async () =>
        portSuccess({ radPath: process.execPath, bicepPath: process.execPath }),
      runGraph,
      trustedPath: [join(root, "trusted-bin")],
      ...(process.env.SystemRoot ? { systemRoot: process.env.SystemRoot } : {}),
      timeoutMs: 2_000
    });
    const binding = createLifecycleBinding({
      ...context,
      graphs: {
        source: context.source,
        graph: {
          ...compiler,
          observeDeployed: async () => reject("deployed observation")
        },
        environment:
          options.registrations ?
            { registrations: options.registrations }
          : context.environments
      },
      authority: fixture.ports.identity,
      hostBinding,
      clock: fixture.ports.clock,
      ids: fixture.ports.ids,
      knownLegacyOperations: () => []
    });
    return {
      root,
      workspace,
      binding,
      context,
      calls,
      authorizations,
      compiled,
      runGraph,
      git,
      writes,
      forbidden,
      reject,
      executor,
      async replaceWorkspaceInputs(label: string) {
        for (const [path, bytes] of graphInputs(label))
          await writeFile(join(workspace, path), bytes);
      },
      async expectUnchanged(label = "uncommitted") {
        expect(await filesUnder(workspace)).toEqual(graphInputs(label));
        expect(forbidden).toEqual([]);
        expect(await readdir(compileRoot)).toEqual([]);
        expect(await filesUnder(snapshotRoot)).toEqual(new Map());
        for (const invocation of compiled)
          await expect(readFile(invocation.file)).rejects.toMatchObject({
            code: "ENOENT"
          });
      },
      async close() {
        try {
          await binding.close();
          await fixture.binding.close();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    };
  } catch (error) {
    await context.discovery.close();
    await fixture.binding.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function startGraphRuntime(
  fixture: Awaited<ReturnType<typeof createGraphBoundaryFixture>>
) {
  const fake = createFakeDependencies({
    lifecycle: fixture.binding,
    radiusEnabled: true,
    workspaceContext: {
      workspacePath: fixture.workspace,
      repo: "owner/repo",
      branch: graphBranch
    }
  });
  const unexpected = () => fixture.reject("legacy runtime I/O");
  // Leave pure graph/source-ref functions and callback registration intact.
  // Every legacy external read, write, compiler and authoring path fails closed.
  for (const group of [
    fake.deps.github,
    fake.deps.rad,
    fake.deps.appModel,
    fake.deps.process
  ]) {
    for (const value of Object.values(group))
      if (vi.isMockFunction(value)) value.mockImplementation(unexpected);
  }
  fake.deps.github.getDefaultBranch = async (repo) => {
    if (repo !== "owner/repo")
      return fixture.reject("unexpected default branch");
    return "main";
  };
  fake.deps.core.fetchBicepFromRepo = unexpected;
  fake.deps.workspace.fetchWorkspaceBicep = unexpected;
  fake.deps.workspace.fetchWorkspaceTree = unexpected;
  fake.deps.getOrCreateServer = unexpected;
  fake.deps.deploy.fetch = unexpected;
  fake.deps.radiusAppBicepSkill = unexpected;
  fake.deps.withGhcrDockerConfig = unexpected;
  const open = vi.fn(async () => fixture.reject("SDK canvas.open"));
  const send = vi.fn(async () => fixture.reject("SDK send"));
  const session: SessionPort = {
    workspacePath: fixture.workspace,
    log: vi.fn(),
    rpc: { canvas: { open } },
    send,
    metadata: { snapshot: async () => fixture.reject("SDK metadata.snapshot") }
  };
  const extension = await bootstrapRadiusExtension(fake.deps, {
    createCanvas: (declaration) => declaration,
    joinSession: async (declaration) => {
      expect(declaration.canvases).toHaveLength(1);
      expect(
        declaration.tools.filter((tool) => tool.name === "radius_lifecycle")
      ).toHaveLength(1);
      return session;
    }
  }).catch(async (error: unknown) => {
    await fixture.close();
    throw error;
  });
  function tool(name: string) {
    const selected = extension.tools.find((entry) => entry.name === name);
    if (!selected) throw new Error(`Missing registered tool ${name}`);
    return selected;
  }
  return {
    extension,
    open,
    send,
    tool,
    async execute(intent: {
      operation: string;
      target: object;
      input: object;
    }): Promise<unknown> {
      return JSON.parse(String(await tool("radius_lifecycle").handler(intent)));
    }
  };
}
