// HTTP integration for the page renderers: every canvas page served through the
// real production request handler on a loopback server, covering page selection
// (RF-09), the unknown-page fallback, active graph view synchronisation, and the
// in-progress deployment redirect.
//
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getOrCreateServer, stopServer } from "../../../src/server.js";
import { deployedGraphPage } from "../../../src/pages/deployed-graph-page.js";
import { deployingPage } from "../../../src/pages/deploying-page.js";
import { environmentPage } from "../../../src/pages/environment-page.js";
import { graphDiffPage } from "../../../src/pages/graph-diff-page.js";
import { graphPage } from "../../../src/pages/graph-page.js";
import { plannedGraphPage } from "../../../src/pages/planned-graph-page.js";
import type { CanvasServerEntry } from "../../../src/server/types.js";
import type { CanvasState } from "../../../src/shared.js";
import { browserEntryMarker } from "../../../src/browser/scripts.js";
import { readBrowserPageState } from "../../support/pages/browser-state.js";
import {
  HOSTILE_STATE,
  expectSafeInlineScripts
} from "../../support/pages/hostile-state.js";

const INSTANCE_ID = "pages-http-test";

let entry: CanvasServerEntry;

async function get(path: string): Promise<{
  status: number;
  contentType: string | null;
  body: string;
}> {
  const response = await fetch(entry.baseUrl + path);
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text()
  };
}

function resetState(next: CanvasState = {}): void {
  for (const key of Object.keys(entry.state)) delete entry.state[key];
  Object.assign(entry.state, next);
}

beforeAll(async () => {
  entry = await getOrCreateServer(INSTANCE_ID, "graph");
});

afterAll(async () => {
  await stopServer(INSTANCE_ID, true);
});

describe("canvas pages over real loopback HTTP", () => {
  it("binds the loopback interface and answers the default page as HTML", async () => {
    resetState({ contextRepo: "octo/app", contextBranch: "feature/x" });
    const url = new URL(entry.baseUrl);
    expect(url.hostname).toBe("127.0.0.1");
    expect(Number(url.port)).toBeGreaterThan(0);

    const response = await get("/");

    expect(response.status).toBe(200);
    expect(response.contentType).toBe("text/html; charset=utf-8");
    // The instance was opened on the default canvas page, so a bare load keeps
    // rendering it rather than falling back to the environment page.
    expect(response.body).toBe(graphPage(entry.state));
    expect(response.body).toContain(
      '<a href="?page=graph" data-page="graph" data-radius-graph-page="graph" class="rad-subtab rad-subtab--active"'
    );
  });

  it.each([
    ["graph", () => graphPage(entry.state), 'data-page="graph"'],
    ["planned", () => plannedGraphPage(entry.state), 'id="planned-subtitle"'],
    [
      "graph-diff",
      () => graphDiffPage(entry.state),
      'id="graph-diff-subtitle"'
    ],
    [
      "deployed",
      () => deployedGraphPage(entry.state),
      'id="deployed-subtitle"'
    ],
    [
      "credentials",
      () => environmentPage(entry.state),
      '<section id="pane-credentials" style="">'
    ],
    [
      "environment",
      () => environmentPage(entry.state),
      '<section id="pane-environments" style="">'
    ],
    [
      "deploying",
      () => deployingPage(entry.state),
      "<title>Deployments — Radius</title>"
    ]
  ])(
    "serves ?page=%s with the renderer that owns it",
    async (page, render, marker) => {
      resetState({ contextRepo: "octo/app", contextBranch: "feature/x" });

      const response = await get(`/?page=${page}`);

      expect(response.status).toBe(200);
      expect(response.body).toContain(marker);
      expect(response.body).toBe(render());
    }
  );

  it.each([
    ["graph", "graph-page"],
    ["planned", "planned-graph-page"],
    ["graph-diff", "graph-diff-page"],
    ["deployed", "deployed-graph-page"],
    ["credentials", "environment-page"],
    ["environment", "environment-page"],
    ["deploying", "deploying-page"]
  ] as const)(
    "serves ?page=%s with one page entry and one copy of each shared entry",
    async (page, pageEntry) => {
      resetState({ contextRepo: "octo/app", contextBranch: "feature/x" });
      const response = await get(`/?page=${page}`);

      for (const entry of [
        "graph",
        "delete-dialog",
        "heartbeat",
        "operation-chip",
        "graph-chip",
        pageEntry
      ] as const) {
        expect(
          response.body.split(`\n${browserEntryMarker(entry)}\n`)
        ).toHaveLength(2);
      }
    }
  );

  it("serves a deployment result with one result entry and shared entries", async () => {
    resetState({
      contextRepo: "octo/app",
      contextBranch: "feature/x",
      deployResult: { message: "Deployment started" },
      deployAttempt: { id: "attempt-1" }
    });

    const response = await get("/?page=environment");

    for (const entry of [
      "graph",
      "delete-dialog",
      "heartbeat",
      "operation-chip",
      "graph-chip",
      "deploy-result-page"
    ] as const) {
      expect(
        response.body.split(`\n${browserEntryMarker(entry)}\n`)
      ).toHaveLength(2);
    }
  });

  // The diff page carries the worktree branch to the browser so each node can be
  // routed to a local file or a github.com URL; through the real server this is
  // the only place that value is produced.
  it.each([
    ["the workspace repository matches", "octo/app", "feature/x"],
    ["it belongs to another repository", "other/app", ""]
  ])(
    "serves the graph diff workspace branch when %s",
    async (_label, workspaceRepo, expected) => {
      resetState({
        contextRepo: "octo/app",
        diffTargetRepo: "octo/app",
        diffBase: "main",
        diffHead: "feature/x",
        workspacePath: "C:\\work\\app",
        workspaceRepo,
        workspaceBranch: "feature/x"
      });

      const response = await get("/?page=graph-diff");

      expect(response.status).toBe(200);
      expect(
        readBrowserPageState(response.body, "radius-graph-diff-state")
      ).toMatchObject({ workspaceBranch: expected });
    }
  );

  it("falls back to the environment page for a page value it does not know", async () => {
    resetState({ contextRepo: "octo/app" });

    const response = await get("/?page=not-a-page");

    expect(response.status).toBe(200);
    expect(response.body).toBe(environmentPage(entry.state));
    expect(response.body).toContain(
      '<section id="pane-environments" style="">'
    );
  });

  it.each([
    ["graph", "graph"],
    ["planned", "planned"],
    ["graph-diff", "diff"]
  ])(
    "records %s as the active graph view for the next unqualified load",
    async (page, activeGraphView) => {
      resetState({ contextRepo: "octo/app" });

      await get(`/?page=${page}`);

      expect(entry.state.activeGraphView).toBe(activeGraphView);
      expect(entry.page).toBe(page);
    }
  );

  it("keeps a non-graph page from claiming an active graph view", async () => {
    resetState({ contextRepo: "octo/app" });

    await get("/?page=deploying");

    expect(entry.state.activeGraphView).toBeUndefined();
    expect(entry.page).toBe("deploying");
  });

  it("activates the sub-tab that matches the requested environment page", async () => {
    resetState({ contextRepo: "octo/app" });
    await get("/?page=credentials");
    expect(entry.state.activeSubtab).toBe("credentials");

    await get("/?page=environment");
    expect(entry.state.activeSubtab).toBe("environments");
  });

  it("redirects an implicit environment landing to the live deployment", async () => {
    resetState({ contextRepo: "octo/app", deployStatus: "in_progress" });
    await get("/?page=environment");

    const implicit = await get("/");

    expect(implicit.body).toBe(deployingPage(entry.state));
    expect(implicit.body).toContain("<title>Deployments — Radius</title>");
  });

  it("honors an explicit environment navigation while a deployment is in progress", async () => {
    resetState({ contextRepo: "octo/app", deployStatus: "in_progress" });

    const explicit = await get("/?page=environment");

    expect(explicit.body).toBe(environmentPage(entry.state));
    expect(explicit.body).toContain(
      '<section id="pane-environments" style="">'
    );
  });

  it("serves the page without requesting a browser asset from the network", async () => {
    resetState({ contextRepo: "octo/app" });

    const response = await get("/?page=graph");

    expect(response.body).not.toMatch(/<script[^>]+src=/);
    expect(response.body).not.toContain('rel="stylesheet"');
    expect(response.body).not.toContain("unpkg.com");
  });

  it.each([
    "graph",
    "planned",
    "graph-diff",
    "deployed",
    "credentials",
    "environment",
    "deploying"
  ])(
    "keeps ?page=%s safe when the instance state carries an injection payload",
    async (page) => {
      resetState({
        contextRepo: HOSTILE_STATE,
        contextBranch: HOSTILE_STATE,
        envName: HOSTILE_STATE,
        diffBase: HOSTILE_STATE,
        diffHead: HOSTILE_STATE,
        branches: [HOSTILE_STATE],
        branchShas: { [HOSTILE_STATE]: HOSTILE_STATE },
        graphResources: [
          { id: HOSTILE_STATE, name: HOSTILE_STATE, connections: [] }
        ],
        plannedResources: [
          { id: HOSTILE_STATE, name: HOSTILE_STATE, connections: [] }
        ],
        diffResources: [
          { id: HOSTILE_STATE, name: HOSTILE_STATE, connections: [] }
        ]
      });

      const response = await get(`/?page=${page}`);

      expect(response.status).toBe(200);
      expectSafeInlineScripts(response.body);
      expect(response.body).not.toContain("<script>alert(1)</script>");
    }
  );
});
