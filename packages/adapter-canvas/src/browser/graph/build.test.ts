// BU-04, BU-05: the application-graph node and edge builder.
//
// Every rule the legacy renderer expressed only through pixels — which node is
// drawn, what it is labelled, which branch its source link points at, how an
// edge is coloured in a diff, and what a planned or deploying graph collapses —
// is a pure function of the resource list, so it is asserted directly here.

import { describe, it, expect } from "vitest";
import {
  buildGraph,
  isLocalSourceNode,
  nodeColors,
  RADIUS_DEPLOY_STATUS_COLORS,
  radiusMapLineType,
  resolveGraphSettings
} from "./build.js";
import type { GraphOptions } from "./build.js";
import type { GraphResource } from "./model.js";

function settings(options: GraphOptions = {}) {
  return resolveGraphSettings(options);
}

const web: GraphResource = {
  id: "app/web",
  name: "web",
  type: "Radius.Compute/containers@2023-10-01-preview",
  codeReference: "src/web/app.ts#L12",
  connections: [{ id: "app/db", direction: "Outbound" }]
};

const db: GraphResource = {
  id: "app/db",
  name: "db",
  type: "Radius.Data/mySqlDatabases@2023-10-01-preview",
  outputResources: [
    {
      id: "/subscriptions/s1/rg/db",
      name: "server",
      type: "Microsoft.DBforMySQL/flexibleServers"
    },
    { id: "k8s/secret", name: "creds", type: "core/Secret" }
  ]
};

// A diff compares two branches and a worktree holds at most one of them, so
// "is this file on disk?" is a per-node question there. Getting it wrong is
// silent: the node renders a github.com URL for a branch that was never pushed,
// and clicking it does nothing at all.
describe("per-node source locality", () => {
  it("falls back to the page flag when no workspace branch is supplied", () => {
    expect(
      isLocalSourceNode(settings({ localSource: true }), { sourceBranch: "" })
    ).toBe(true);
    expect(
      isLocalSourceNode(settings({ localSource: false }), {
        sourceBranch: "anything"
      })
    ).toBe(false);
  });

  it("ignores the page flag once a workspace branch is supplied", () => {
    const resolved = settings({
      localSource: false,
      branch: "feature-x",
      workspaceBranch: "feature-x"
    });
    expect(isLocalSourceNode(resolved, { sourceBranch: "feature-x" })).toBe(
      true
    );
  });

  it("keeps a node from the other compared branch remote", () => {
    const resolved = settings({
      diffMode: true,
      branch: "feature-x",
      baseBranch: "main",
      workspaceBranch: "feature-x"
    });
    expect(isLocalSourceNode(resolved, { sourceBranch: "main" })).toBe(false);
    expect(isLocalSourceNode(resolved, { sourceBranch: "feature-x" })).toBe(
      true
    );
  });

  it("treats a node with no branch of its own as the page's branch", () => {
    expect(
      isLocalSourceNode(
        settings({ branch: "feature-x", workspaceBranch: "feature-x" }),
        { sourceBranch: undefined }
      )
    ).toBe(true);
    expect(
      isLocalSourceNode(
        settings({ branch: "main", workspaceBranch: "feature-x" }),
        { sourceBranch: undefined }
      )
    ).toBe(false);
  });

  it("resolves locality against the worktree branch even when it is the base", () => {
    const resolved = settings({
      diffMode: true,
      branch: "main",
      baseBranch: "feature-x",
      workspaceBranch: "feature-x"
    });
    expect(isLocalSourceNode(resolved, { sourceBranch: "feature-x" })).toBe(
      true
    );
    expect(isLocalSourceNode(resolved, { sourceBranch: "main" })).toBe(false);
  });

  it("never matches an empty workspace branch against an empty node branch", () => {
    expect(
      isLocalSourceNode(settings({ branch: "", workspaceBranch: "" }), {
        sourceBranch: ""
      })
    ).toBe(false);
  });
});

describe("options", () => {
  it.each([
    ["straight", "straight"],
    ["Step", "step"],
    ["smoothstep", "smoothstep"],
    ["taxi", "smoothstep"],
    ["segments", "smoothstep"],
    ["", "default"],
    [undefined, "default"],
    ["unknown", "default"]
  ])("maps line type %s to the %s edge", (input, expected) => {
    expect(radiusMapLineType(input)).toBe(expected);
  });

  it("applies the defaults the pages rely on", () => {
    const resolved = settings();
    expect(resolved).toEqual({
      diffMode: false,
      deployMode: false,
      plannedMode: false,
      resolvedMode: false,
      repoUrl: "",
      branch: "main",
      baseBranch: "main",
      localSource: false,
      workspaceBranch: "",
      edgeType: "default",
      showLegend: false,
      enablePopup: true
    });
  });

  it("treats planned and deploying alike as resolved graphs", () => {
    expect(settings({ plannedMode: true }).resolvedMode).toBe(true);
    expect(settings({ deployMode: true }).resolvedMode).toBe(true);
  });

  it("defaults the diff base branch to the page branch and prefers an explicit one", () => {
    expect(settings({ branch: "feature" }).baseBranch).toBe("feature");
    expect(settings({ branch: "feature", baseBranch: "main" }).baseBranch).toBe(
      "main"
    );
  });

  it("keeps the details panel on unless a caller disables it", () => {
    expect(settings({ enablePopup: false }).enablePopup).toBe(false);
    expect(settings({ enablePopup: true }).enablePopup).toBe(true);
  });
});

describe("node colours", () => {
  it("colours only the border by diff status and keeps the host surface", () => {
    const diff = settings({ diffMode: true });
    expect(nodeColors(diff, { diffStatus: "added" })).toEqual({
      bg: "var(--rad-node-bg)",
      border: "var(--rad-success)"
    });
    expect(nodeColors(diff, { diffStatus: "removed" }).border).toBe(
      "var(--rad-danger)"
    );
    expect(nodeColors(diff, { diffStatus: "modified" }).border).toBe(
      "var(--rad-warning)"
    );
    expect(nodeColors(diff, { diffStatus: "unchanged" }).border).toBe(
      "var(--rad-node-border)"
    );
    expect(nodeColors(diff, {}).border).toBe("var(--rad-node-border)");
  });

  it("keeps a managed cluster gray unless it failed, and colours other nodes by status", () => {
    const deploy = settings({ deployMode: true });
    const cluster: GraphResource = {
      name: "aks",
      type: "Microsoft.ContainerService/managedClusters@2024-01-01",
      deployStatus: "success"
    };
    expect(nodeColors(deploy, cluster)).toEqual(
      RADIUS_DEPLOY_STATUS_COLORS.pending
    );
    expect(nodeColors(deploy, { ...cluster, deployStatus: "failed" })).toEqual(
      RADIUS_DEPLOY_STATUS_COLORS.failed
    );
    expect(
      nodeColors(deploy, { name: "web", deployStatus: "success" })
    ).toEqual(RADIUS_DEPLOY_STATUS_COLORS.success);
    expect(nodeColors(deploy, { name: "web" })).toEqual(
      RADIUS_DEPLOY_STATUS_COLORS.pending
    );
    expect(
      nodeColors(deploy, { name: "web", deployStatus: "unrecognized" })
    ).toEqual(RADIUS_DEPLOY_STATUS_COLORS.pending);
  });

  it("recognizes a managed cluster from a resolved output as well as its own type", () => {
    const deploy = settings({ deployMode: true });
    expect(
      nodeColors(deploy, {
        name: "env",
        deployStatus: "success",
        outputResources: [
          { type: "Microsoft.ContainerService/managedClusters@2024-01-01" }
        ]
      })
    ).toEqual(RADIUS_DEPLOY_STATUS_COLORS.pending);
  });

  it("uses semantic tokens rather than literal colours", () => {
    for (const colors of Object.values(RADIUS_DEPLOY_STATUS_COLORS)) {
      expect(colors.bg).toMatch(/^var\(--rad-/);
      expect(colors.border).toMatch(/^var\(--rad-/);
    }
  });
});

describe("modeled graph", () => {
  it("filters visualization-only image resources and their associated secret", () => {
    const imageId = "app/api-image";
    const built = buildGraph(settings(), [
      {
        id: "app/api",
        name: "api",
        type: "Radius.Compute/containers",
        connections: [{ id: imageId, direction: "Outbound" }]
      },
      {
        id: imageId,
        name: "apiImage",
        type: "Radius.Compute/containerImages"
      },
      {
        id: "app/registry-creds",
        name: "radius-ghcr-registry-creds",
        type: "Radius.Security/secrets",
        connections: [{ id: imageId, direction: "Inbound" }]
      }
    ]);
    expect(built.nodes.map((node) => node.id)).toEqual(["app/api"]);
    expect(built.edges).toEqual([]);
  });

  it("renders one node per resource plus its concrete outputs", () => {
    const built = buildGraph(settings(), [web, db]);
    expect(built.nodes.map((node) => node.id)).toEqual([
      "app/web",
      "app/db",
      "app/db/output/0/server",
      "app/db/output/1/creds"
    ]);
    expect(built.nodes.every((node) => node.type === "rad")).toBe(true);
    expect(built.nodes.every((node) => node.draggable)).toBe(true);
    expect(built.dataById["app/web"].nodeName).toBe("web");
    expect(built.dataById["app/web"].typeLabel).toBe("Compute/containers");
  });

  it("connects outbound connections whose target exists and expands outputs", () => {
    const built = buildGraph(settings(), [web, db]);
    expect(built.edges.map((edge) => edge.id)).toEqual([
      "app/web-->app/db",
      "app/db-->app/db/output/0/server",
      "app/db-->app/db/output/1/creds"
    ]);
    expect(built.edges[0].style).toEqual({
      stroke: "var(--rad-edge-muted)",
      strokeWidth: 2.5
    });
    // Output connectors are dashed with the wider gap outside planned mode.
    expect(built.edges[1].style.strokeDasharray).toBe("6 4");
  });

  it("drops a connection whose target is not in the graph and de-duplicates edges", () => {
    const built = buildGraph(settings(), [
      {
        id: "a",
        name: "a",
        connections: [
          { id: "missing", direction: "Outbound" },
          { id: "b", direction: "Outbound" },
          { id: "b", direction: "Outbound" },
          { id: "b", direction: "Inbound" }
        ]
      },
      { id: "b", name: "b" }
    ]);
    expect(built.edges.map((edge) => edge.id)).toEqual(["a-->b"]);
  });

  it("names a connection by name when it carries no id", () => {
    const built = buildGraph(settings(), [
      { name: "a", connections: [{ name: "b" }] },
      { name: "b" }
    ]);
    expect(built.edges.map((edge) => edge.id)).toEqual(["a-->b"]);
  });

  it("skips an output another resource already owns", () => {
    const built = buildGraph(settings(), [
      {
        id: "app/cache",
        name: "cache",
        outputResources: [{ id: "shared/secret", name: "cache" }]
      },
      {
        id: "app/web",
        name: "web",
        outputResources: [{ id: "shared/secret", name: "cache" }]
      }
    ]);
    expect(built.nodes.map((node) => node.id)).toEqual([
      "app/cache",
      "app/cache/output/0/cache",
      "app/web"
    ]);
  });

  it("labels an output by display type, then type, then name", () => {
    const built = buildGraph(settings(), [
      {
        name: "db",
        outputResources: [
          { name: "a", displayType: "Display", type: "T" },
          { name: "b", type: "T" },
          { name: "c" }
        ]
      }
    ]);
    expect(built.dataById["db/output/0/a"].typeLabel).toBe("Display");
    expect(built.dataById["db/output/1/b"].typeLabel).toBe("T");
    expect(built.dataById["db/output/2/c"].typeLabel).toBe("c");
    expect(built.dataById["db/output/0/a"].bgColor).toBe(
      "var(--rad-bg-subtle)"
    );
  });

  it("normalizes missing identifiers, labels, connections, and cloud metadata", () => {
    const built = buildGraph(settings(), [
      {
        name: "owner",
        outputResources: [
          {
            id: "/subscriptions/s1/rg/unnamed",
            type: "Microsoft.Storage/storageAccounts"
          },
          { id: "/subscriptions/s1/rg/typeless" },
          null,
          {}
        ],
        connections: [null, {}]
      },
      {}
    ]);
    expect(built.nodes.map((entry) => entry.id)).toEqual([
      "owner",
      "owner/output/0/resource-0",
      "owner/output/1/resource-1",
      "owner/output/3/resource-3",
      "resource-1"
    ]);
    expect(built.dataById["resource-1"].nodeName).toBe("resource-1");
    expect(built.dataById["owner/output/0/resource-0"].nodeName).toBe(
      "Microsoft.Storage/storageAccounts"
    );
    expect(built.dataById["owner"].cloudResources).toContain(
      '"name":"","type":"Microsoft.Storage/storageAccounts"'
    );
    expect(built.edges.some((edge) => edge.target === "")).toBe(false);
  });

  it("uses a display type when a resolved output has no concrete type", () => {
    const built = buildGraph(settings({ plannedMode: true }), [
      {
        id: "app/db",
        name: "db",
        outputResources: [{ displayType: "Provider/database" }]
      }
    ]);
    expect(built.dataById["app/db"].typeLabel).toBe("Provider/database");
  });

  it("marks an ARM output as a cloud resource on its own node and its parent", () => {
    const built = buildGraph(settings(), [db]);
    expect(built.dataById["app/db"].cloudResources).toBe(
      JSON.stringify([
        {
          name: "server",
          type: "Microsoft.DBforMySQL/flexibleServers",
          id: "/subscriptions/s1/rg/db"
        }
      ])
    );
    expect(built.dataById["app/db/output/0/server"].cloudId).toBe(
      "/subscriptions/s1/rg/db"
    );
    expect(built.dataById["app/db/output/1/creds"].cloudId).toBe("");
  });

  it("defaults the app definition to the committed app.bicep", () => {
    const built = buildGraph(settings(), [web]);
    expect(built.dataById["app/web"].defFile).toBe(".radius/app.bicep");
    expect(built.dataById["app/web"].defLine).toBe(0);
    const custom = buildGraph(settings(), [
      { ...web, definitionFile: "infra/app.bicep", definitionLine: 31 }
    ]);
    expect(custom.dataById["app/web"].defFile).toBe("infra/app.bicep");
    expect(custom.dataById["app/web"].defLine).toBe(31);
  });

  it("uses one border width for every mode", () => {
    for (const options of [
      {},
      { diffMode: true },
      { plannedMode: true },
      { deployMode: true }
    ]) {
      const built = buildGraph(settings(options), [web]);
      expect(built.dataById["app/web"].borderWidth).toBe(2.5);
    }
  });
});

describe("source links", () => {
  it("deep-links a code reference and falls back to the branch tree", () => {
    const built = buildGraph(
      settings({ repoUrl: "https://github.test/o/r", branch: "feature" }),
      [web, { id: "app/api", name: "api" }]
    );
    expect(built.dataById["app/web"].sourceUrl).toBe(
      "https://github.test/o/r/blob/feature/src/web/app.ts#L12"
    );
    expect(built.dataById["app/api"].sourceUrl).toBe(
      "https://github.test/o/r/tree/feature"
    );
  });

  it("normalizes a Windows code reference in both the URL and the local path", () => {
    const built = buildGraph(
      settings({ repoUrl: "https://github.test/o/r", localSource: true }),
      [{ id: "w", name: "w", codeReference: "src\\web\\app.ts#L7" }]
    );
    expect(built.dataById["w"].sourceUrl).toBe(
      "https://github.test/o/r/blob/main/src/web/app.ts#L7"
    );
    expect(built.dataById["w"].srcPath).toBe("src/web/app.ts");
    expect(built.dataById["w"].srcLine).toBe(7);
  });

  it("has no source URL at all without repository context", () => {
    const built = buildGraph(settings(), [web]);
    expect(built.dataById["app/web"].sourceUrl).toBe("");
  });
});

describe("diff graph", () => {
  const base = { repoUrl: "https://github.test/o/r", diffMode: true };

  it("colours an edge by the connection's own diff status", () => {
    const resources: GraphResource[] = [
      {
        id: "a",
        name: "a",
        connections: [
          { id: "b", diffStatus: "added" },
          { id: "c", diffStatus: "removed" },
          { id: "d", diffStatus: "unchanged" }
        ]
      },
      { id: "b", name: "b" },
      { id: "c", name: "c" },
      { id: "d", name: "d" }
    ];
    const built = buildGraph(settings(base), resources);
    const stroke = (id: string) =>
      built.edges.find((edge) => edge.id === id)?.style.stroke;
    expect(stroke("a-->b")).toBe("var(--rad-success)");
    expect(stroke("a-->c")).toBe("var(--rad-danger)");
    expect(stroke("a-->d")).toBe("var(--rad-edge-muted)");
  });

  it("falls back to the endpoints' statuses only when the connection has none", () => {
    const built = buildGraph(settings(base), [
      { id: "a", name: "a", diffStatus: "added", connections: [{ id: "b" }] },
      { id: "b", name: "b", diffStatus: "unchanged" },
      { id: "c", name: "c", diffStatus: "removed", connections: [{ id: "b" }] },
      {
        id: "d",
        name: "d",
        diffStatus: "unchanged",
        connections: [{ id: "b" }]
      }
    ]);
    const stroke = (id: string) =>
      built.edges.find((edge) => edge.id === id)?.style.stroke;
    expect(stroke("a-->b")).toBe("var(--rad-success)");
    expect(stroke("c-->b")).toBe("var(--rad-danger)");
    expect(stroke("d-->b")).toBe("var(--rad-edge-muted)");
  });

  it("points a removed resource's source and definition links at the base branch", () => {
    const built = buildGraph(
      settings({ ...base, branch: "head", baseBranch: "main" }),
      [
        {
          id: "gone",
          name: "gone",
          diffStatus: "removed",
          codeReference: "src/gone.ts"
        },
        {
          id: "kept",
          name: "kept",
          diffStatus: "modified",
          codeReference: "src/kept.ts"
        }
      ]
    );
    expect(built.dataById["gone"].sourceBranch).toBe("main");
    expect(built.dataById["gone"].sourceUrl).toBe(
      "https://github.test/o/r/blob/main/src/gone.ts"
    );
    expect(built.dataById["kept"].sourceBranch).toBe("head");
    expect(built.dataById["kept"].sourceUrl).toBe(
      "https://github.test/o/r/blob/head/src/kept.ts"
    );
  });

  it("keeps the modeled card surface and expands outputs like the modeled graph", () => {
    const built = buildGraph(settings(base), [db]);
    expect(built.dataById["app/db"].bgColor).toBe("var(--rad-node-bg)");
    expect(built.nodes).toHaveLength(3);
  });
});

describe("planned and deploying graphs", () => {
  it("keeps modeled topology and relabels with the resolved concrete type", () => {
    const built = buildGraph(settings({ plannedMode: true }), [db]);
    expect(built.nodes.map((node) => node.id)).toEqual(["app/db"]);
    expect(built.dataById["app/db"].typeLabel).toBe(
      "Microsoft.DBforMySQL/flexibleServers"
    );
    expect(built.dataById["app/db"].nodeName).toBe("db");
  });

  it("prefers the primary workload over supporting recipe outputs, in any order", () => {
    const built = buildGraph(settings({ plannedMode: true }), [
      {
        id: "cache",
        name: "cache",
        outputResources: [
          { name: "s", type: "core/Secret" },
          { name: "d", type: "apps/Deployment" },
          { name: "svc", type: "core/Service" }
        ]
      }
    ]);
    expect(built.dataById["cache"].typeLabel).toBe("apps/Deployment");
  });

  it("shows the MySQL root resource instead of its lock and child resources", () => {
    const built = buildGraph(settings({ deployMode: true }), [
      {
        id: "mysql",
        name: "mysql",
        type: "Radius.Data/mySqlDatabases",
        outputResources: [
          { name: "lock", type: "Microsoft.Authorization/locks" },
          {
            name: "server",
            type: "Microsoft.DBforMySQL/flexibleServers"
          },
          {
            name: "database",
            type: "Microsoft.DBforMySQL/flexibleServers/databases"
          },
          {
            name: "firewall",
            type: "Microsoft.DBforMySQL/flexibleServers/firewallRules"
          }
        ]
      }
    ]);
    expect(built.dataById.mysql.typeLabel).toBe(
      "Microsoft.DBforMySQL/flexibleServers"
    );
  });

  it("uses the representative output's exact portal URL on the deployed parent", () => {
    const portalUrl =
      "https://portal.azure.com/#@tenant/resource/subscriptions/s1/resourceGroups/rg/providers/Microsoft.DBforMySQL/flexibleServers/mysql";
    const built = buildGraph(settings({ deployMode: true }), [
      {
        id: "mysql",
        name: "mysql",
        type: "Radius.Data/mySqlDatabases",
        outputResources: [
          {
            id: "/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Authorization/locks/mysql",
            name: "lock",
            type: "Microsoft.Authorization/locks",
            portalUrl: "https://portal.azure.com/lock"
          },
          {
            id: "/subscriptions/s1/resourceGroups/rg/providers/Microsoft.DBforMySQL/flexibleServers/mysql",
            name: "server",
            type: "Microsoft.DBforMySQL/flexibleServers",
            portalUrl
          }
        ]
      }
    ]);

    expect(built.dataById.mysql.portalUrl).toBe(portalUrl);
    expect(JSON.parse(built.dataById.mysql.cloudResources)).toContainEqual(
      expect.objectContaining({ name: "server", portalUrl })
    );
  });

  it("builds a tenant-neutral Azure URL for an older deployed graph", () => {
    const id =
      "/subscriptions/s1/resourceGroups/rg/providers/Microsoft.DBforMySQL/flexibleServers/mysql";
    const built = buildGraph(settings({ deployMode: true }), [
      {
        id: "mysql",
        name: "mysql",
        outputResources: [
          {
            id,
            name: "server",
            type: "Microsoft.DBforMySQL/flexibleServers"
          }
        ]
      }
    ]);

    expect(built.dataById.mysql.portalUrl).toBe(
      `https://portal.azure.com/#@/resource${id}/overview`
    );
  });

  it("keeps the modeled resource's own icon rather than the output's glyph", () => {
    const built = buildGraph(settings({ plannedMode: true }), [
      {
        id: "cache",
        name: "cache",
        icon: "https://icons.test/cache.png",
        outputResources: [{ name: "d", type: "apps/Deployment" }]
      }
    ]);
    expect(built.dataById["cache"].icon).toBe("https://icons.test/cache.png");
  });

  it("falls back to the modeled type when no output resolves", () => {
    const built = buildGraph(settings({ plannedMode: true }), [web]);
    expect(built.dataById["app/web"].typeLabel).toBe("Compute/containers");
  });

  it("draws planned nodes and every planned edge dashed", () => {
    const built = buildGraph(settings({ plannedMode: true }), [
      { id: "a", name: "a", connections: [{ id: "b" }] },
      { id: "b", name: "b" }
    ]);
    expect(built.dataById["a"].borderStyle).toBe("dashed");
    expect(built.edges[0].style.strokeDasharray).toBe("4 4");
    expect(built.edges[0].style.stroke).toBe("var(--rad-edge)");
  });

  it("keeps deploying borders solid and adds the corner badge", () => {
    const built = buildGraph(settings({ deployMode: true }), [
      { id: "a", name: "a", deployStatus: "success", deployMessage: "done" },
      { id: "b", name: "b", deployStatus: "failed" },
      { id: "c", name: "c" }
    ]);
    expect(built.dataById["a"].borderStyle).toBe("solid");
    expect(built.dataById["a"].deployBadgeKind).toBe("success");
    expect(built.dataById["b"].deployBadgeKind).toBe("failed");
    expect(built.dataById["c"].deployBadgeKind).toBe("progress");
    expect(built.dataById["a"].deployBadge).toMatch(/^data:image\/svg\+xml,/);
    expect(built.dataById["a"].deployMessage).toBe("done");
  });

  it("keeps the indefinite progress asset through state updates until status is terminal", () => {
    const deploy = settings({ deployMode: true });
    for (let update = 0; update < 10; update++) {
      const built = buildGraph(deploy, [
        {
          id: "a",
          name: "a",
          deployStatus: update % 2 === 0 ? "pending" : "in_progress"
        }
      ]);
      const svg = decodeURIComponent(
        (built.dataById["a"]?.deployBadge ?? "").slice(
          "data:image/svg+xml,".length
        )
      );
      expect(svg).toContain("animation:spin 1s linear infinite");
    }

    for (const status of ["success", "failed"]) {
      const built = buildGraph(deploy, [
        { id: "a", name: "a", deployStatus: status }
      ]);
      const svg = decodeURIComponent(
        (built.dataById["a"]?.deployBadge ?? "").slice(
          "data:image/svg+xml,".length
        )
      );
      expect(svg).not.toContain("@keyframes spin");
    }
  });

  it("carries no badge outside deploy mode", () => {
    const built = buildGraph(settings(), [
      { id: "a", name: "a", deployStatus: "success" }
    ]);
    expect(built.dataById["a"].deployBadge).toBe("");
    expect(built.dataById["a"].deployBadgeKind).toBe("");
  });

  it("never mounts output resources as child nodes while deploying", () => {
    const built = buildGraph(settings({ deployMode: true }), [db]);
    expect(built.nodes).toHaveLength(1);
    expect(built.edges).toHaveLength(0);
  });
});
