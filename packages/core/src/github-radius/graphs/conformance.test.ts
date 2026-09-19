import { describe, expect, it } from "vitest";
import { computeGraphDiff } from "../../graph/index.js";
import { createGraphReader } from "./pipeline.js";
import { createAppModelStatusReader } from "./model-status.js";
import { requestModelAuthoring } from "./authoring.js";
import type { GraphPipelinePorts, GraphSource } from "./pipeline.js";
import type { AuthoringClaim } from "./authoring.js";

interface Resource {
  id: string;
  name: string;
  diffHash: string;
  diffStatus?: string;
}

function normalizeResources(values: unknown[]): Resource[] {
  return values.map((value) => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("id" in value) ||
      typeof value.id !== "string" ||
      !("name" in value) ||
      typeof value.name !== "string" ||
      !("diffHash" in value) ||
      typeof value.diffHash !== "string"
    ) {
      throw new Error("Invalid compiled graph resource");
    }
    return { id: value.id, name: value.name, diffHash: value.diffHash };
  });
}

describe("independent caller graph and authoring conformance", () => {
  it("composes real comparison and freshness with explicit committed and uncommitted sources", async () => {
    const workspace: GraphSource = {
      kind: "workspace",
      repo: "owner/app",
      branch: "feature",
      workspacePath: "authorized-workspace"
    };
    const base = { kind: "committed", repo: "owner/app", ref: "main" } as const;
    const head = {
      kind: "committed",
      repo: "owner/app",
      ref: "feature"
    } as const;
    const removed: string[] = [];
    const ports: GraphPipelinePorts<Resource> = {
      async readDefinition(source) {
        return {
          content:
            source.kind === "workspace" ? "local-uncommitted"
            : source.ref === "main" ? "previous"
            : "committed",
          bicepPath: ".radius/app.bicep"
        };
      },
      async stageArtifacts(source) {
        return {
          dir: source.kind === "workspace" ? source.workspacePath : source.ref,
          remote: source.kind === "committed"
        };
      },
      async buildGraphViaRad(content) {
        return [{ id: "api", name: "api", diffHash: content }];
      },
      normalizeResources,
      graphDefinitionHash: (content, artifacts) => `${content}:${artifacts}`,
      radArtifactsFingerprint: (directory) => directory ?? "",
      removeDirectory: (directory) => {
        removed.push(directory);
      },
      computeDiff: computeGraphDiff
    };
    const reader = createGraphReader(ports);
    expect(await reader.read(workspace)).toEqual({
      kind: "completed",
      resources: [{ id: "api", name: "api", diffHash: "local-uncommitted" }]
    });
    const comparison = await reader.compare(base, head);
    expect(comparison.kind).toBe("completed");
    if (comparison.kind !== "completed")
      throw new Error("Expected a completed comparison");
    expect(comparison.resources).toMatchObject([
      { id: "api", diffHash: "committed", diffStatus: "modified" }
    ]);
    expect(removed).toEqual(["main", "feature"]);

    const statuses = createAppModelStatusReader({
      readDefinition: ports.readDefinition,
      readFile: async () => null,
      listPaths: async () => ["Dockerfile"],
      workspaceHeadCommit: async () => "head",
      workspaceSourceChangedSince: async () => false,
      workspaceModelRecoverable: async () => false,
      generatorVersion: () => "1",
      hashAppBicep: (content) => content
    });
    expect(await statuses.resolveStatus(workspace)).toMatchObject({
      refreshable: true,
      freshness: {
        appBicepHash: "local-uncommitted",
        requiresConfirmation: true
      }
    });
    expect(await statuses.resolveStatus(head)).toMatchObject({
      refreshable: false,
      freshness: { appBicepHash: "committed" }
    });
  });

  it("treats an acknowledged agent request as a request, not a validated or published graph", async () => {
    const source: GraphSource = {
      kind: "workspace",
      repo: "owner/app",
      branch: "feature",
      workspacePath: "authorized-workspace"
    };
    const readDefinition = async () => ({
      content: null,
      bicepPath: ".radius/app.bicep"
    });
    const statusReader = createAppModelStatusReader({
      readDefinition,
      readFile: async () => null,
      listPaths: async () => ["Dockerfile"],
      workspaceHeadCommit: async () => "head",
      workspaceSourceChangedSince: async () => false,
      workspaceModelRecoverable: async () => false,
      generatorVersion: () => "1",
      hashAppBicep: (content) => content
    });
    let claim: AuthoringClaim | null = null;
    let reservation: string | undefined;
    let interactions = 0;
    const result = await requestModelAuthoring(
      { repo: source.repo, sources: [source] },
      {
        ...statusReader,
        modelingInFlight: async () => false,
        wait: async () => {},
        requestInteraction: async () => {
          interactions++;
        },
        staleNotice: () => {
          throw new Error("Unexpected advisory");
        },
        refreshKey: () => {
          throw new Error("Unexpected refresh");
        },
        shouldRequestRefresh: () => {
          throw new Error("Unexpected refresh");
        },
        releaseRefreshMemo: () => {
          throw new Error("Unexpected refresh");
        },
        claims: {
          current: () => claim,
          claim: (target, key) => {
            claim = { target, key };
            return claim;
          },
          owns: (value) => value === claim,
          release: () => {
            claim = null;
          },
          markDelivered: () => {}
        },
        reservation: {
          has: (key) => reservation === key,
          reserve: (key) => {
            reservation = key;
          },
          owns: (key) => reservation === key,
          release: () => {
            reservation = undefined;
          },
          beginAttempt: () => "attempt",
          releaseAttempt: () => {}
        }
      }
    );
    expect(result.kind).toBe("interaction-requested");
    expect(interactions).toBe(1);
    expect((await statusReader.resolveStatus(source)).freshness.status).toBe(
      "missing"
    );
  });
});
