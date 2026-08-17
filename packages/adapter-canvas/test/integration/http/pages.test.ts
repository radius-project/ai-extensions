// HTTP integration for the page renderers: every canvas page served through the
// real production request handler on a loopback server, covering page selection
// (RF-09), the unknown-page fallback, active graph view synchronisation, and the
// in-progress deployment redirect.
//
// The vendored CDN assets are the only external boundary the HTML path touches,
// so node:https is faked here; nothing else about the server is stubbed.
import { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const https = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("node:https", () => ({ default: https }));

import { getOrCreateServer } from "../../../src/server.js";
import {
  deployedGraphPage,
  deployingPage,
  environmentPage,
  graphDiffPage,
  graphPage,
  plannedGraphPage
} from "../../../src/pages.js";
import type { CanvasServerEntry } from "../../../src/server/types.js";
import type { CanvasState } from "../../../src/shared.js";
import {
  HOSTILE_STATE,
  expectSafeInlineScripts
} from "../../support/pages/hostile-state.js";

const INSTANCE_ID = "pages-http-test";

let entry: CanvasServerEntry;

// Offline vendor assets: the warm-up must resolve without reaching a CDN, so
// every request fails fast exactly as it does on a disconnected machine.
https.get.mockImplementation(() => {
  const request = new EventEmitter();
  queueMicrotask(() => request.emit("error", new Error("offline")));
  return request;
});

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

afterAll(() => {
  try {
    entry?.server?.close();
  } catch {
    /* best-effort */
  }
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
      '<a href="?page=graph" data-page="graph" class="rad-subtab rad-subtab--active"'
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
    // The only outbound requests are the faked vendor warm-up fetches.
    for (const call of https.get.mock.calls) {
      expect(String(call[0])).toContain("unpkg.com");
    }
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
