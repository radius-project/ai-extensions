import { expect, it, vi } from "vitest";
import {
  inspectDeploymentGraph,
  projectInspectedTopology,
  type DeploymentInspectionReader,
  type DeploymentRunSnapshot
} from "./deployed-graph.js";
import { inspectApplicationDefinition } from "./deployments.js";
import type {
  DeployProgress,
  WorkflowArtifact
} from "../deploy-artifact-evidence.js";
import {
  mergeDeployedGraphMetadata,
  mergeDeployedGraphDisplayMetadata,
  projectDeployedGraph
} from "../graph/deployed.js";

const run: DeploymentRunSnapshot = {
  matchesSelection: true,
  id: 42,
  active: false,
  unconfirmed: false,
  finishedAt: Date.parse("2026-09-10T00:00:00Z")
};
const progress: DeployProgress = {
  application: "store",
  environment: "prod",
  state: "failed",
  runId: 42,
  schemaVersion: 1,
  sequence: 1,
  resources: [{ name: "store-db", type: "example/db" }]
};
const artifact = {
  id: 1,
  name: "radius-deploy-status-prod",
  created_at: "2026-09-11T00:00:00Z"
} satisfies WorkflowArtifact;

function harness(
  selection: DeploymentRunSnapshot,
  observed: DeployProgress | null,
  metadata: WorkflowArtifact = artifact
) {
  const graph = [{ name: "model" }];
  const reader = {
    graph: vi.fn<DeploymentInspectionReader["graph"]>(async () => ({
      status: "ok",
      graph,
      artifact: metadata
    })),
    progress: vi.fn(async () => observed),
    read: vi.fn(async () => ({ status: "ok", progress: observed }))
  };
  const input = {
    run: selection,
    openReader: vi.fn(() => reader),
    assertObserving: vi.fn(),
    acceptProgress: vi.fn(),
    inventorySelection: { application: "store", environment: "prod" },
    inventoryIsCurrent: vi.fn(() => true)
  };
  return { input, reader, graph };
}

it("reports no deployment evidence for an active run without a graph artifact or progress", async () => {
  const definition = await inspectApplicationDefinition(
    "octo/store",
    "feature/store",
    async () => ({
      kind: "read",
      source:
        "resource app 'Applications.Core/applications@2023' = { name: 'store' }"
    })
  );
  expect(definition).toEqual({
    kind: "defined",
    name: "store",
    path: ".radius/app.bicep",
    branch: "feature/store"
  });

  const { input, reader } = harness({ ...run, active: true }, null);
  reader.graph.mockResolvedValueOnce({
    status: "missing",
    graph: null
  });
  const result = await inspectDeploymentGraph(input);
  expect(result).toMatchObject({
    kind: "observed",
    observation: {
      graph: null,
      progress: null,
      artifactRunId: null,
      inventory: null
    }
  });
  expect(input.openReader).toHaveBeenCalledWith(run.id);
  expect(input.acceptProgress).not.toHaveBeenCalled();
  expect(reader.read).not.toHaveBeenCalled();
});

it("accepts progress for the exact active run even without a graph artifact", async () => {
  const { input, reader } = harness({ ...run, active: true }, progress);
  reader.graph.mockResolvedValueOnce({ status: "missing", graph: null });

  expect(await inspectDeploymentGraph(input)).toMatchObject({
    kind: "observed",
    observation: {
      graph: null,
      progress,
      artifactRunId: run.id,
      inventory: null
    }
  });
  expect(input.acceptProgress).toHaveBeenCalledExactlyOnceWith(progress, false);
});

it("uses zero as an exact active run id and does not consult inventory currency", async () => {
  const { input, reader, graph } = harness(
    { ...run, active: true, id: 0 },
    { ...progress, runId: 0 }
  );
  expect(await inspectDeploymentGraph(input)).toMatchObject({
    kind: "observed",
    observation: { graph, artifactRunId: 0, inventory: null }
  });
  expect(input.openReader).toHaveBeenCalledWith(0);
  expect(reader.read).toHaveBeenCalledOnce();
  expect(input.inventoryIsCurrent).not.toHaveBeenCalled();
});

it.each([
  {
    run: { ...run, active: true },
    progress: { ...progress, runId: 43 },
    artifact
  },
  {
    run,
    progress: { ...progress, runId: 43 },
    artifact: { ...artifact, created_at: "2026-09-10T00:00:00Z" }
  },
  {
    run: { ...run, unconfirmed: true },
    progress: { ...progress, runId: undefined },
    artifact
  }
])(
  "ignores evidence that cannot establish the selected attempt ($run)",
  async (scenario) => {
    const { input, reader } = harness(
      scenario.run,
      scenario.progress,
      scenario.artifact
    );
    expect(await inspectDeploymentGraph(input)).toMatchObject({
      kind: "observed",
      observation: {
        graph: null,
        progress: null,
        artifactRunId: null,
        inventory: null
      }
    });
    expect(reader.read).not.toHaveBeenCalled();
    expect(input.acceptProgress).not.toHaveBeenCalled();
  }
);

it("accepts a newer terminal run for display but not as the tracked run's inventory", async () => {
  const { input, graph } = harness(run, { ...progress, runId: 43 });
  expect(await inspectDeploymentGraph(input)).toMatchObject({
    kind: "observed",
    observation: { graph, newerRun: true, artifactRunId: 43, inventory: null }
  });
  expect(input.acceptProgress).toHaveBeenCalledWith(
    expect.objectContaining({ runId: 43 }),
    true
  );
});

it("keeps an independently observed graph and suppresses inventory if the attempt changes", async () => {
  const { input, graph, reader } = harness(run, progress);
  reader.read.mockImplementationOnce(async () => {
    input.inventoryIsCurrent.mockReturnValue(false);
    return { status: "ok", progress };
  });
  expect(await inspectDeploymentGraph(input)).toMatchObject({
    kind: "observed",
    observation: { graph, progress, inventory: null }
  });
  expect(input.inventoryIsCurrent).toHaveBeenCalledOnce();
});

it("preserves accepted display evidence if the revalidated resource read fails", async () => {
  const { input, graph, reader } = harness(run, progress);
  const error = new Error("artifact unavailable");
  reader.read.mockRejectedValueOnce(error);
  expect(await inspectDeploymentGraph(input)).toMatchObject({
    kind: "read-failed",
    error,
    observation: { graph, progress, inventory: null }
  });
});

it("keeps topology, enriches outputs in evidence order, and projects output status to its parent", () => {
  const parent = {
    id: "store",
    name: "store",
    type: "Radius.Data/mySqlDatabases",
    connections: [{ id: "api", direction: "Inbound" }]
  };
  const api = { id: "api", name: "api", type: "Radius.Compute/containers" };
  const deployedServer = {
    id: "deployed-server",
    type: "Microsoft.DBforMySQL/flexibleServers"
  };
  const deployedService = { id: "deployed-service", type: "core/Service" };
  const monitorOutput = { type: "apps/Deployment", displayType: "Worker" };

  expect(
    projectInspectedTopology(
      [parent, api],
      {
        planned: [
          {
            id: parent.id,
            name: "planned",
            outputResources: [
              {
                ...deployedServer,
                id: "planned-server",
                displayType: "MySQL"
              },
              { id: "planned-only", type: "core/ConfigMap" }
            ]
          }
        ],
        deployment: [
          {
            id: parent.id,
            name: "deployed",
            connections: [{ id: "wrong", direction: "Outbound" }],
            outputResources: [deployedServer, deployedService]
          }
        ],
        monitor: [
          {
            id: parent.id,
            name: "monitored",
            outputResources: [
              { ...deployedServer, displayType: "Do not overwrite" },
              {
                ...deployedService,
                id: "monitor-service",
                displayType: "Service"
              },
              { ...monitorOutput, id: "monitor-worker" }
            ]
          }
        ]
      },
      new Map([[deployedServer.id, "failed"]]),
      {
        mergeDeployedGraphMetadata,
        mergeDeployedGraphDisplayMetadata,
        projectDeployedGraph
      }
    )
  ).toMatchObject([
    {
      ...parent,
      outputResources: [
        { ...deployedServer, displayType: "MySQL" },
        { ...deployedService, displayType: "Service" },
        monitorOutput
      ],
      deployStatus: "failed"
    },
    { ...api, outputResources: [], deployStatus: "pending" }
  ]);
});
