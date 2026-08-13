import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RADIUS_ACTION_DECLARATIONS,
  RADIUS_CANVAS_DESCRIPTION,
  RADIUS_CANVAS_DISPLAY_NAME,
  RADIUS_CANVAS_ID,
  RADIUS_CANVAS_PAGES,
  RADIUS_TOOL_DECLARATIONS
} from "../../../src/runtime/declarations.js";
import { createRadiusCanvas } from "../../../src/runtime/create-radius-canvas.js";
import {
  deployedGraphPage,
  deployingPage,
  environmentPage,
  graphDiffPage,
  graphPage,
  oidcPage,
  plannedGraphPage
} from "../../../src/pages.js";
import {
  createFakeDependencies,
  createFakeSession
} from "../../support/runtime/fakes.js";
import { SERVER_ROUTE_TABLE } from "../../../src/server/route-table.js";

interface CompatibilityFixture {
  canvas: {
    id: string;
    displayName: string;
    description: string;
    pages: string[];
  };
  acceptedSurface: {
    actions: string[];
    tools: string[];
    removedActions: string[];
    removedTools: string[];
  };
  routes: Array<{
    method: "ANY" | "GET" | "POST";
    path: string;
    match: "exact" | "prefix";
  }>;
  htmlMarkers: Record<string, string[]>;
  branchBehavior: {
    workspace: {
      repo: string;
      worktreeBranch: string;
      ignoredInputBranch: string;
    };
    remote: { repo: string; branch: string };
  };
  artifact: { path: string; sdkExternal: string };
}

interface RegistrationFixture {
  canvases: Array<{
    actions: Array<Record<string, unknown>>;
  }>;
  tools: Array<Record<string, unknown>>;
}

interface PreRemovalFixture {
  recordedBeforePhase0: boolean;
  actions: string[];
  tools: string[];
}

const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");

function filesUnder(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(path, entry.name);
    return entry.isDirectory() ? filesUnder(child) : [child];
  });
}
const fixture = JSON.parse(
  readFileSync(
    new URL("../../fixtures/runtime-compatibility.json", import.meta.url),
    "utf8"
  )
) as CompatibilityFixture;
const registration = JSON.parse(
  readFileSync(
    new URL("../../fixtures/artifact-registration.json", import.meta.url),
    "utf8"
  )
) as RegistrationFixture;
const preRemoval = JSON.parse(
  readFileSync(
    new URL(
      "../../fixtures/pre-removal-runtime-declarations.json",
      import.meta.url
    ),
    "utf8"
  )
) as PreRemovalFixture;

describe("Phase 0 reviewed compatibility oracles", () => {
  it("pins canvas metadata, all seven pages, and the accepted retained schemas", () => {
    expect({
      id: RADIUS_CANVAS_ID,
      displayName: RADIUS_CANVAS_DISPLAY_NAME,
      description: RADIUS_CANVAS_DESCRIPTION,
      pages: [...RADIUS_CANVAS_PAGES]
    }).toEqual(fixture.canvas);

    expect(RADIUS_ACTION_DECLARATIONS.map(({ name }) => name)).toEqual(
      fixture.acceptedSurface.actions
    );
    expect(RADIUS_TOOL_DECLARATIONS.map(({ name }) => name)).toEqual(
      fixture.acceptedSurface.tools
    );
    expect(
      RADIUS_ACTION_DECLARATIONS.map((declaration) => ({
        ...declaration,
        handlerCallable: true
      }))
    ).toEqual(registration.canvases[0].actions);
    expect(
      RADIUS_TOOL_DECLARATIONS.map((declaration) => ({
        ...declaration,
        handlerCallable: true
      }))
    ).toEqual(registration.tools);
  });

  it("preserves the pre-removal inventory while rejecting every removed declaration", () => {
    expect(preRemoval.recordedBeforePhase0).toBe(true);
    expect(preRemoval.actions).toHaveLength(6);
    expect(preRemoval.tools).toHaveLength(10);
    expect(preRemoval.actions).toEqual(
      expect.arrayContaining(fixture.acceptedSurface.removedActions)
    );
    expect(preRemoval.tools).toEqual(
      expect.arrayContaining(fixture.acceptedSurface.removedTools)
    );

    const currentNames = new Set([
      ...RADIUS_ACTION_DECLARATIONS.map(({ name }) => name),
      ...RADIUS_TOOL_DECLARATIONS.map(({ name }) => name)
    ]);
    for (const removed of [
      ...fixture.acceptedSurface.removedActions,
      ...fixture.acceptedSurface.removedTools
    ]) {
      expect(currentNames.has(removed), removed).toBe(false);
    }
  });

  it("keeps removed action and tool names out of shipping prompts, docs, and runtime sources", () => {
    const surfaces = [
      resolve(REPO_ROOT, "README.md"),
      resolve(REPO_ROOT, "plugins/radius/README.md"),
      ...filesUnder(resolve(REPO_ROOT, "plugins/radius/skills")),
      ...filesUnder(resolve(REPO_ROOT, "packages/adapter-canvas/src")).filter(
        (path) => !path.endsWith(".test.ts")
      )
    ];
    const removed = [
      ...fixture.acceptedSurface.removedActions,
      ...fixture.acceptedSurface.removedTools
    ];

    for (const path of surfaces) {
      const content = readFileSync(path, "utf8");
      for (const name of removed) {
        expect(content, `${path}: ${name}`).not.toContain(name);
      }
    }
  });

  it("pins all 37 loopback route method and path declarations", () => {
    expect(fixture.routes).toHaveLength(37);
    expect(SERVER_ROUTE_TABLE).toHaveLength(37);
    expect(
      SERVER_ROUTE_TABLE.map(({ method, path, match }) => ({
        method,
        path,
        match
      }))
    ).toEqual(fixture.routes);
  });

  it("pins selected stable markers for every page renderer", () => {
    const rendered: Record<string, string> = {
      credentials: oidcPage({}),
      graph: graphPage({
        contextRepo: "octo/app",
        contextBranch: "feature/test"
      }),
      planned: plannedGraphPage({
        contextRepo: "octo/app",
        contextBranch: "feature/test"
      }),
      "graph-diff": graphDiffPage({
        branches: ["main", "feature/test"],
        diffBase: "main",
        diffHead: "feature/test",
        diffTargetRepo: "octo/app",
        diffResources: [
          {
            id: "app",
            name: "app",
            type: "Applications.Core/containers",
            connections: []
          }
        ]
      }),
      deployed: deployedGraphPage({ contextRepo: "octo/app" }),
      environment: environmentPage({ contextRepo: "octo/app" }),
      deploying: deployingPage({
        contextRepo: "octo/app",
        contextBranch: "feature/test"
      })
    };

    expect(Object.keys(fixture.htmlMarkers)).toEqual(fixture.canvas.pages);
    for (const [page, markers] of Object.entries(fixture.htmlMarkers)) {
      for (const marker of markers) {
        expect(rendered[page], `${page}: ${marker}`).toContain(marker);
      }
    }
  });

  it("pins worktree selection versus explicit remote branch behavior", async () => {
    const { workspace, remote } = fixture.branchBehavior;
    const fake = createFakeDependencies({
      workspaceContext: {
        workspacePath: "/worktrees/app",
        repo: workspace.repo,
        branch: workspace.worktreeBranch
      }
    });
    fake.sessionHolder.set(createFakeSession());
    const canvas = createRadiusCanvas(fake.deps);

    await canvas.open({
      extensionId: "plugin:radius",
      canvasId: "radius",
      instanceId: "radius-panel",
      input: {
        page: "graph",
        repo: workspace.repo,
        branch: workspace.ignoredInputBranch
      }
    });
    expect(fake.servers.get("radius-panel")?.state.contextBranch).toBe(
      workspace.worktreeBranch
    );

    await canvas.open({
      extensionId: "plugin:radius",
      canvasId: "radius",
      instanceId: "remote-panel",
      input: { page: "graph", repo: remote.repo, branch: remote.branch }
    });
    expect(fake.servers.get("remote-panel")?.state.contextBranch).toBe(
      remote.branch
    );
  });

  it("pins the single built artifact path and external SDK import", () => {
    const build = readFileSync(
      resolve(REPO_ROOT, "packages/adapter-canvas/build.mjs"),
      "utf8"
    );
    const joined = (declaration: string): string[] => {
      const match = build.match(
        new RegExp(`const ${declaration} =\\s*\\n?\\s*join\\(([^)]*)\\);`)
      );
      if (!match)
        throw new Error(`build.mjs no longer declares ${declaration}`);
      return [...match[1].matchAll(/"([^"]+)"/g)].map((segment) => segment[1]);
    };
    const outfile = [
      ...joined("pluginDir"),
      ...joined("distDir"),
      ...joined("outfile")
    ].join("/");
    const externals = [
      ...(build.match(/external:\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(
        /"([^"]+)"/g
      )
    ].map((entry) => entry[1]);

    expect(outfile).toBe(fixture.artifact.path);
    expect(externals).toContain(fixture.artifact.sdkExternal);
  });
});
