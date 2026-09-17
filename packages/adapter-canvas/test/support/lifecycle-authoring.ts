import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import {
  buildEffectiveInputManifest,
  portForbidden,
  portFailure,
  portSuccess,
  sameLifecycleData,
  type AgentAssignment,
  type AgentOutcome,
  type AuthorizationRequest,
  type CallerContext,
  type SourceSelection
} from "@radius-project/core/lifecycle";
import { normalizeAppBicep } from "@radius-project/core/modeling";
import {
  createDefinitionPromotionAdapter,
  createDefinitionValidationAdapter,
  nodeSourceFileSystem,
  spawnRad,
  type DefinitionPromotionMachinery,
  type SourceReadDependencies
} from "@radius-project/adapter-shared";
import { collectSourceInputs } from "../../../adapter-shared/src/lifecycle/source-access-closure.js";
import { createLifecycleBinding } from "../../src/runtime/create-lifecycle-binding.js";
import {
  createLifecycleAgent,
  type LifecycleAgentReceipt,
  type TrustedLifecycleAgentHost
} from "../../src/runtime/lifecycle-agent.js";
import { bootstrapRadiusExtension } from "../../src/runtime/bootstrap.js";
import type { SessionPort } from "../../src/runtime/session.js";
import { authorizeFixture } from "./lifecycle.js";
import { createFakeDependencies } from "./runtime/fakes.js";

const scripts = fileURLToPath(
  new URL(
    "../../../../extensions/radius/skills/radius-app-bicep/scripts/",
    import.meta.url
  )
);
const native: DefinitionPromotionMachinery = await import(
  join(scripts, "promote-app-model.mjs")
);
const type = "Radius.Core/applications@2025-08-01-preview";
export const authorDefinition = ".radius/app.bicep";
export const authorBranch = "feature/author";
export const authorCommit = "a".repeat(40);
export const digest = (bytes: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function authorInputs(
  options: { schema?: boolean; dockerfile?: boolean } = {}
) {
  const definition =
    (options.schema === false ?
      ""
    : "var schema = loadJsonContent('resolved-types.json')\n") +
    (options.dockerfile === false ?
      ""
    : "var docker = loadTextContent('../Dockerfile')\n") +
    `resource app '${type}' = {\n` +
    "  name: 'validation-app'\n  location: 'global'\n" +
    "  properties: { environment: 'validation' }\n}\n";
  const inputs = new Map([[authorDefinition, definition]]);
  if (options.schema !== false)
    inputs.set(
      ".radius/resolved-types.json",
      JSON.stringify({
        contractVersion: 1,
        types: { [type]: { environment: false } }
      })
    );
  if (options.dockerfile !== false) inputs.set("Dockerfile", "FROM scratch\n");
  return inputs;
}

/** Authority and native compiler transport are fixtures; validation and promotion are real. */
export async function createAuthoringBoundaryFixture(
  options: {
    trustedHost?: boolean;
    schema?: boolean;
    warning?: boolean;
    dockerfile?: boolean;
  } = {}
) {
  const root = resolve(".artifacts", `lifecycle-authoring-${randomUUID()}`);
  try {
    const workspace = join(root, "workspace");
    const storageRoot = join(root, "snapshots");
    const compileRoot = join(root, "compilation");
    const inputs = authorInputs(options);
    const calls: string[] = [];
    const forbidden: string[] = [];
    const authorizations: AuthorizationRequest[] = [];
    const assignments: AgentAssignment[] = [];
    const control = {
      requestId: "fixture-control",
      cancellation: { aborted: false, onAbort: () => () => {} }
    };
    const caller: CallerContext = {
      principalRef: "fixture-principal",
      identityRef: "fixture-identity",
      sessionRef: "fixture-session",
      responder: "agent",
      agentBindingRef: "fixture-agent",
      approvedHostActionRef: "fixture-approval"
    };
    let currentCaller = caller;
    let approved = true;
    let sequence = 0;
    const ids = { next: (kind: string) => `${kind}-${++sequence}` };
    const clock = { now: () => "2026-09-16T12:00:00Z" };
    const reject = (operation: string): never => {
      forbidden.push(operation);
      throw new Error(`Unmodeled authoring boundary: ${operation}`);
    };
    await Promise.all(
      [workspace, storageRoot, compileRoot].map((path) =>
        mkdir(path, { recursive: true })
      )
    );
    const writeInputs = async (destination: string) => {
      for (const [path, text] of inputs) {
        const file = join(destination, path);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, text);
      }
    };
    await writeInputs(workspace);
    await spawnRad("git", ["init", "--quiet"], {
      cwd: workspace,
      inheritEnv: false,
      env: {
        SystemRoot: process.env.SystemRoot,
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(root, "absent-git-config")
      },
      timeout: 3_000
    });
    const sourceDependencies: SourceReadDependencies = {
      storageRoot,
      files: nodeSourceFileSystem,
      ids,
      clock,
      limits: {
        maxFiles: 100,
        maxFileBytes: 100_000,
        maxTotalBytes: 1_000_000
      },
      authority: {
        resolve: async (scope, selection) => {
          if (
            !sameLifecycleData(scope.target, selection) ||
            scope.principalRef !== caller.principalRef ||
            !["owner/repo", "fork/repo"].includes(selection.repo)
          )
            return portForbidden();
          return selection.source.kind === "workspace" ?
              portSuccess({
                kind: "workspace",
                repo: selection.repo,
                workspaceRef: selection.source.workspaceRef,
                rootPath: workspace
              })
            : portSuccess({
                kind: "git",
                repo: selection.repo,
                accessRef: "fixture-remote"
              });
        }
      },
      git: {
        workspaceState: async () =>
          portSuccess({ branch: authorBranch, commit: authorCommit }),
        resolveCommit: async () => {
          calls.push("resolveCommit");
          return portSuccess(authorCommit);
        },
        materializeCommit: async (_source, commit, destination) => {
          if (commit !== authorCommit) return reject("unpinned remote");
          calls.push("materializeCommit");
          await writeInputs(destination);
          return portSuccess(undefined);
        },
        readCommit: async () => portSuccess(authorCommit)
      }
    };
    const source = createDefinitionPromotionAdapter({
      source: sourceDependencies,
      staging: native
    });
    const selection = async (): Promise<SourceSelection> => {
      const collected = await collectSourceInputs(
        nodeSourceFileSystem,
        workspace,
        authorDefinition,
        sourceDependencies.limits,
        control.cancellation,
        "capture",
        true
      );
      const manifest = buildEffectiveInputManifest(
        {
          definition: authorDefinition,
          inputs: collected.inputs,
          closure: collected.complete ? "complete" : "incomplete"
        },
        digest
      );
      if (
        manifest.status !== "ok" ||
        manifest.value.completeness !== "complete"
      )
        throw new Error("Incomplete authoring fixture");
      return {
        repo: "owner/repo",
        definition: authorDefinition,
        source: {
          kind: "workspace",
          workspaceRef: "fixture-workspace",
          branch: authorBranch,
          expectedFingerprint: manifest.value.fingerprint
        }
      };
    };
    const compiler = join(root, "compiler.mjs");
    await writeFile(
      compiler,
      "import fs from 'node:fs';\n" +
        "if(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.NODE_OPTIONS) throw Error('Inherited credentials');\n" +
        "if(process.argv[2] !== 'build' || process.argv[4] !== '--diagnostics-format' || process.argv[5] !== 'sarif' || process.argv[6] !== '--stdout') throw Error('Invalid compiler transport');\n" +
        "if(!fs.readFileSync(process.argv[3], 'utf8').includes(\"resource app\")) throw Error('Incorrect source');\n" +
        `console.log(${JSON.stringify(
          JSON.stringify({
            resources: {
              app: {
                type,
                properties: {
                  name: "validation-app",
                  location: "global",
                  properties: { environment: "validation" }
                }
              }
            }
          })
        )});\n` +
        `console.error(${JSON.stringify(
          JSON.stringify({
            runs: [
              {
                results:
                  options.warning ?
                    [{ level: "warning", ruleId: "BCP036" }]
                  : []
              }
            ]
          })
        )});\n`
    );
    const runProcess = vi.fn<typeof spawnRad>(
      async (executable, args, configuration) => {
        if (args[0] === "build")
          return spawnRad(process.execPath, [compiler, ...args], configuration);
        return spawnRad(executable, args, configuration);
      }
    );
    const validator = createDefinitionValidationAdapter({
      source,
      files: nodeSourceFileSystem,
      storageRoot: compileRoot,
      ids,
      acquireBinaries: async () =>
        portSuccess({ radPath: process.execPath, bicepPath: process.execPath }),
      trustedPath: [],
      ...(process.env.SystemRoot ? { systemRoot: process.env.SystemRoot } : {}),
      timeoutMs: 3_000,
      nodePath: process.execPath,
      scriptPath: join(scripts, "validate-bicep.mjs"),
      runProcess
    });
    const receipts = new Map<string, LifecycleAgentReceipt>();
    const outcomes = new Map<string, AgentOutcome>();
    const host: TrustedLifecycleAgentHost = {
      binding: () => currentCaller,
      issueAssignment: vi.fn(async (_scope, assignment) => {
        const receipt = {
          principalRef: caller.principalRef,
          sessionRef: caller.sessionRef,
          agentBindingRef: "fixture-agent",
          deliveryRef: `delivery-${receipts.size}`,
          operationId: assignment.action.operationId,
          actionId: assignment.action.actionId
        };
        receipts.set(receipt.actionId, receipt);
        return portSuccess(receipt);
      }),
      verifyAssignment: vi.fn(async (receipt, scope, assignment) => {
        if (
          !approved ||
          !sameLifecycleData(receipt, receipts.get(receipt.actionId)) ||
          !sameLifecycleData(
            scope.target,
            assignment.staging.snapshot.selection
          )
        )
          return portForbidden();
        return (
            sameLifecycleData(
              await selection(),
              assignment.staging.snapshot.selection
            )
          ) ?
            portSuccess(undefined)
          : portFailure("SOURCE_CHANGED");
      }),
      dispatch: vi.fn(async (_receipt, work) => {
        assignments.push(work.assignment);
        const definition = inputs.get(authorDefinition);
        if (!definition) return reject("missing fixture definition");
        const staged = {
          "app.bicep": definition,
          "bicepconfig.json": "{}",
          "app.origin.json": JSON.stringify({
            generatedAt: clock.now(),
            sourceCommit: authorCommit,
            skillVersion: "fixture",
            appBicepHash: digest(normalizeAppBicep(definition))
          })
        };
        for (const [name, text] of Object.entries(staged))
          await writeFile(join(work.stagingLocation, name), text);
        outcomes.set(work.assignment.action.actionId, {
          kind: "agent.outcome",
          status: "completed",
          stagedOutputRefs: Object.keys(staged).map(
            (name) => `${work.assignment.staging.stagingRef}/${name}`
          )
        });
        return portSuccess(undefined);
      }),
      verifyOutcome: vi.fn(async (receipt, _caller, _action, outcome) =>
        sameLifecycleData(outcomes.get(receipt.actionId), outcome) ?
          portSuccess(undefined)
        : portForbidden()
      ),
      cancel: vi.fn<TrustedLifecycleAgentHost["cancel"]>(async () =>
        reject("unexpected remote cancellation")
      )
    };
    const agent = createLifecycleAgent({
      ...(options.trustedHost ? { host } : {}),
      discoverSkill: async () =>
        portSuccess({ skillRef: "fixture-trusted-skill" }),
      stagingLocation: source.stagingLocation
    });
    const binding = createLifecycleBinding({
      ids,
      clock,
      authority: {
        resolveCaller: async () => portSuccess(currentCaller),
        authorize: async (request) => {
          authorizations.push(request);
          if (
            ["definition.author", "operation.repair"].includes(
              request.operation
            ) &&
            !approved
          )
            return portForbidden();
          return portSuccess({
            ...authorizeFixture(request),
            ...((
              ["definition.author", "operation.repair"].includes(
                request.operation
              )
            ) ?
              { approvalRef: "fixture-approval" }
            : {})
          });
        },
        authorizeResponse: async (responder, action) =>
          responder.principalRef === caller.principalRef && approved ?
            portSuccess({
              authorizationRef: "fixture-response",
              principalRef: caller.principalRef,
              operation: "operation.respond",
              operationId: action.operationId,
              target: action.target,
              source: action.source
            })
          : portForbidden()
      },
      hostBinding: () => ({
        bindingRef: "fixture-host",
        sessionRef: caller.sessionRef
      }),
      resolveWorkspaceSource: async () =>
        portSuccess((await selection()).source),
      knownLegacyOperations: () => [
        {
          operationId: "legacy-author",
          family: "definition",
          owner: "legacy",
          needsControl: true
        }
      ],
      definitions: {
        source,
        validator,
        ...(options.trustedHost ?
          {
            authoring: {
              source,
              agent,
              repairProvider: async () => portSuccess("azure" as const)
            }
          }
        : {})
      }
    });
    return {
      root,
      workspace,
      source,
      binding,
      validator,
      agent,
      host,
      runProcess,
      inputs,
      calls,
      forbidden,
      authorizations,
      assignments,
      control,
      selection,
      caller,
      reject,
      setCaller(value: CallerContext) {
        currentCaller = value;
      },
      revokeApproval() {
        approved = false;
      },
      response(actionId: string) {
        const receipt = receipts.get(actionId);
        const outcome = outcomes.get(actionId);
        if (!receipt || !outcome)
          throw new Error("No dispatched fixture outcome");
        return {
          operation: "operation.respond",
          target: { repo: "owner/repo" },
          input: {
            operationId: receipt.operationId,
            actionId,
            response: outcome
          }
        };
      },
      attest(actionId: string, outcome: AgentOutcome) {
        if (!receipts.has(actionId))
          throw new Error("Cannot attest an unassigned action.");
        outcomes.set(actionId, outcome);
      },
      async expectUnchanged() {
        for (const [path, text] of inputs)
          expect(await readFile(join(workspace, path), "utf8")).toBe(text);
        expect((await readdir(workspace)).sort()).toEqual([
          ".git",
          ".radius",
          ...(options.dockerfile === false ? [] : ["Dockerfile"])
        ]);
        expect((await readdir(join(workspace, ".radius"))).sort()).toEqual([
          "app.bicep",
          ...(options.schema === false ? [] : ["resolved-types.json"])
        ]);
        expect(forbidden).toEqual([]);
        expect(await readdir(compileRoot)).toEqual([]);
        expect(
          (
            await readdir(storageRoot, { recursive: true, withFileTypes: true })
          ).filter((entry) => entry.isFile())
        ).toEqual([]);
      },
      async close() {
        try {
          await binding.close();
        } finally {
          agent.close();
          await source.close();
          await rm(root, { recursive: true, force: true });
        }
      }
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function startAuthoringRuntime(
  fixture: Awaited<ReturnType<typeof createAuthoringBoundaryFixture>>
) {
  const fake = createFakeDependencies({
    lifecycle: fixture.binding,
    radiusEnabled: true,
    workspaceContext: {
      workspacePath: fixture.workspace,
      repo: "owner/repo",
      branch: authorBranch
    }
  });
  const unexpected = () => fixture.reject("legacy runtime I/O");
  for (const group of [
    fake.deps.github,
    fake.deps.rad,
    fake.deps.appModel,
    fake.deps.process
  ])
    for (const value of Object.values(group))
      if (vi.isMockFunction(value)) value.mockImplementation(unexpected);
  fake.deps.getOrCreateServer = unexpected;
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
      expect(
        declaration.tools.filter((tool) => tool.name === "radius_lifecycle")
      ).toHaveLength(1);
      return session;
    }
  });
  const tool = extension.tools.find((tool) => tool.name === "radius_lifecycle");
  if (!tool) throw new Error("No lifecycle registration");
  return {
    extension,
    open,
    send,
    session,
    fake,
    async execute(intent: {
      operation: string;
      target: object;
      input: object;
    }): Promise<unknown> {
      return JSON.parse(String(await tool.handler(intent)));
    }
  };
}
