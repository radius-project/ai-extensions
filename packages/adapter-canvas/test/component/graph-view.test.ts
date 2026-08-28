// Browser component layer (P1-A, QR-01): the graph mounted in a real DOM.
//
// The node-environment unit suite calls these component functions directly with
// recorded hooks, which cannot show what React actually renders, what React
// Flow measures, or how a real click and a real key reach a handler. Everything
// here runs the shipped libraries in Chromium against the real modules.

import { describe, it, expect, afterEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import {
  buildGraph,
  resolveGraphSettings
} from "../../src/browser/graph/build.js";
import { layoutGraph } from "../../src/browser/graph/layout.js";
import { mountGraph } from "../../src/browser/graph/view.js";
import {
  createGraphHost,
  realClock,
  realGraphVendor
} from "./support/real-vendor.js";
import { SHELL_STYLE_CSS } from "../../src/pages/shell-styles.js";
import type { GraphNodeData } from "../../src/browser/graph/build.js";
import type { GraphResource } from "../../src/browser/graph/model.js";
import type { MountedGraph } from "../../src/browser/graph/view.js";
import type { DomElement } from "../../src/browser/ports.js";

const RESOURCES = [
  {
    id: "app/web",
    name: "web",
    type: "Radius.Compute/containers",
    codeReference: "src/web.ts#L4",
    connections: [{ id: "app/db" }]
  },
  { id: "app/db", name: "db", type: "Radius.Data/sqlDatabases" }
];

interface Recorded {
  external: string[];
  local: Array<[string, number, string]>;
  toggled: string[];
  opened: string[];
  reloads: number;
}

interface Mounted {
  graph: MountedGraph;
  host: HTMLElement;
  recorded: Recorded;
}

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
});

function mount(
  options: {
    localSource?: boolean;
    deployMode?: boolean;
    diffMode?: boolean;
    baseBranch?: string;
    workspaceBranch?: string;
    resources?: GraphResource[];
  } = {}
): Mounted {
  const settings = resolveGraphSettings({
    localSource: options.localSource ?? true,
    deployMode: options.deployMode,
    diffMode: options.diffMode,
    baseBranch: options.baseBranch,
    workspaceBranch: options.workspaceBranch,
    repoUrl: "https://github.test/o/r",
    branch: "feature-branch"
  });
  const built = buildGraph(settings, options.resources ?? RESOURCES);
  const vendor = realGraphVendor();
  layoutGraph(vendor.dagre, built.nodes, built.edges);

  const { host, dispose } = createGraphHost();
  const recorded: Recorded = {
    external: [],
    local: [],
    toggled: [],
    opened: [],
    reloads: 0
  };
  const graph = mountGraph({
    vendor,
    clock: realClock(),
    host,
    settings,
    nodes: built.nodes,
    edges: built.edges,
    reload: () => {
      recorded.reloads += 1;
    },
    deps: {
      openExternal: (url) => recorded.external.push(url),
      openLocalSource: (path, line, fallback) =>
        recorded.local.push([path, line, fallback]),
      toggleDetails: (data: GraphNodeData, card: DomElement | null) =>
        recorded.toggled.push(`${data.id}:${card ? "card" : "none"}`),
      openDetails: (data: GraphNodeData) => recorded.opened.push(data.id)
    }
  });
  disposers.push(() => {
    graph.unmount();
    dispose();
  });
  return { graph, host, recorded };
}

async function card(name: string): Promise<HTMLElement> {
  const title = await screen.findByText(name, { selector: ".rad-node__title" });
  const element = title.closest(".rad-node");
  if (!(element instanceof HTMLElement)) throw new Error(`no card for ${name}`);
  return element;
}

function rgbChannels(color: string): number[] {
  return color.match(/\d+/g)?.slice(0, 3).map(Number) ?? [];
}

function maximumChannelDelta(left: string, right: string): number {
  const leftChannels = rgbChannels(left);
  const rightChannels = rgbChannels(right);
  if (leftChannels.length !== 3 || rightChannels.length !== 3) {
    throw new Error(`expected RGB colors, received ${left} and ${right}`);
  }
  return Math.max(
    ...leftChannels.map((channel, index) =>
      Math.abs(channel - rightChannels[index])
    )
  );
}

describe("graph view in a real browser", () => {
  it("renders changed diff states with distinct fills and borders", async () => {
    const style = document.createElement("style");
    style.textContent = SHELL_STYLE_CSS;
    document.head.appendChild(style);
    disposers.push(() => style.remove());

    mount({
      diffMode: true,
      resources: [
        { id: "added", name: "added", diffStatus: "added" },
        { id: "removed", name: "removed", diffStatus: "removed" },
        { id: "modified", name: "modified", diffStatus: "modified" },
        { id: "unchanged", name: "unchanged", diffStatus: "unchanged" }
      ]
    });

    const styles = await Promise.all(
      ["added", "removed", "modified", "unchanged"].map(async (name) =>
        getComputedStyle(await card(name))
      )
    );
    const changed = styles.slice(0, 3);

    expect(
      new Set(changed.map(({ backgroundColor }) => backgroundColor))
    ).toHaveLength(3);
    expect(new Set(changed.map(({ borderColor }) => borderColor))).toHaveLength(
      3
    );
    for (let left = 0; left < changed.length; left += 1) {
      for (let right = left + 1; right < changed.length; right += 1) {
        expect(
          maximumChannelDelta(
            changed[left].backgroundColor,
            changed[right].backgroundColor
          )
        ).toBeGreaterThanOrEqual(4);
      }
    }
    for (const changedStyle of changed) {
      expect(changedStyle.backgroundColor).not.toBe(styles[3].backgroundColor);
      expect(changedStyle.borderColor).not.toBe(styles[3].borderColor);
    }
  });

  it("renders a card per resource with the real libraries", async () => {
    mount();

    const web = await card("web");
    const db = await card("db");

    expect(within(web).getByTitle("Compute/containers")).toBeTruthy();
    expect(web.getAttribute("data-node-id")).toBe("app/web");
    expect(db.getAttribute("data-node-id")).toBe("app/db");
    // Both cards occupy real space, which is the check a node-environment test
    // cannot make: React Flow only paints once it has measured its container.
    expect(web.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(db.getBoundingClientRect().height).toBeGreaterThan(0);
  });

  it("keeps long resource names inside the card", async () => {
    const name = "recommendationservice-".repeat(8);
    const style = document.createElement("style");
    style.textContent = SHELL_STYLE_CSS;
    document.head.appendChild(style);
    disposers.push(() => style.remove());

    mount({
      deployMode: true,
      resources: [
        {
          id: "app/recommendation",
          name,
          type: "Radius.Compute/containers",
          deployStatus: "success"
        }
      ]
    });

    const recommendation = await card(name);
    const title = within(recommendation).getByTitle(name);
    const badge = within(recommendation).getByAltText("Deployed");
    const titleBounds = title.getBoundingClientRect();
    const cardBounds = recommendation.getBoundingClientRect();
    const badgeBounds = badge.getBoundingClientRect();
    const styles = getComputedStyle(title);

    expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
    expect(styles.overflow).toBe("hidden");
    expect(styles.textOverflow).toBe("ellipsis");
    expect(titleBounds.right).toBeLessThanOrEqual(cardBounds.right);
    expect(titleBounds.right).toBeLessThanOrEqual(badgeBounds.left);
  });

  it("renders the deployed parent with its representative concrete root type", async () => {
    const { recorded } = mount({
      deployMode: true,
      resources: [
        {
          id: "mysql",
          name: "mysql",
          type: "Radius.Data/mySqlDatabases",
          deployStatus: "success",
          outputResources: [
            { id: "lock", type: "Microsoft.Authorization/locks" },
            {
              id: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.DBforMySQL/flexibleServers/server",
              type: "Microsoft.DBforMySQL/flexibleServers",
              portalUrl: "https://portal.azure.com/#@tenant/resource/server"
            },
            {
              id: "database",
              type: "Microsoft.DBforMySQL/flexibleServers/databases"
            }
          ]
        }
      ]
    });

    const mysql = await card("mysql");
    expect(
      within(mysql).getByTitle("Microsoft.DBforMySQL/flexibleServers")
    ).toBeTruthy();
    expect(mysql.getAttribute("data-node-id")).toBe("mysql");

    const portal = mysql.querySelector("a.rad-node__portal");
    if (!(portal instanceof HTMLAnchorElement)) {
      throw new Error("deployed node has no native portal link");
    }
    expect(portal.getAttribute("aria-label")).toBe(
      "Open mysql in Azure Portal"
    );
    expect(portal.getAttribute("href")).toBe(
      "https://portal.azure.com/#@tenant/resource/server"
    );
    expect(portal.getAttribute("target")).toBe("_blank");
    expect(recorded.opened).toEqual([]);
  });

  it("places connected nodes on separate rows using the real dagre layout", async () => {
    mount();

    const web = await card("web");
    const db = await card("db");

    // buildGraph declares web -> db, and the layout is configured top to bottom,
    // so the real engine must put the target below the source.
    expect(db.getBoundingClientRect().top).toBeGreaterThan(
      web.getBoundingClientRect().bottom
    );
  });

  it("exposes the details control by accessible name and activates it from the keyboard", async () => {
    const { recorded } = mount();
    const web = await card("web");
    const details = await within(web).findByRole("button", {
      name: "Show details"
    });

    details.focus();
    expect(document.activeElement).toBe(details);

    await userEvent.keyboard("{Enter}");
    expect(recorded.toggled).toEqual(["app/web:card"]);

    await userEvent.keyboard("[Space]");
    expect(recorded.toggled).toEqual(["app/web:card", "app/web:card"]);
    // The control keeps focus, so the next key still reaches the same card.
    expect(document.activeElement).toBe(details);
  });

  it("opens the workspace file from the source link without following the href", async () => {
    const { recorded } = mount({ localSource: true });
    const web = await card("web");
    const link = await within(web).findByRole("link", {
      name: /View source code/
    });

    await userEvent.click(link);

    expect(recorded.local).toHaveLength(1);
    expect(recorded.local[0][0]).toBe("src/web.ts");
    expect(recorded.local[0][1]).toBe(4);
    // A real navigation would have torn the document down.
    expect(document.body.contains(link)).toBe(true);
    // The card's own click handler must not also fire for a source click.
    expect(recorded.opened).toEqual([]);
  });

  it("opens a remote source link through the host without navigating the webview", async () => {
    const { recorded } = mount({ localSource: false });
    const web = await card("web");
    const link = await within(web).findByRole("link", {
      name: /View source code/
    });

    await userEvent.click(link);

    expect(recorded.external).toEqual([
      "https://github.test/o/r/blob/feature-branch/src/web.ts#L4"
    ]);
    expect(document.body.contains(link)).toBe(true);
    expect(recorded.opened).toEqual([]);
  });

  it("opens an exact GitHub source URL externally from a worktree graph", async () => {
    const sourceUrl =
      "https://github.com/acme/widgets/blob/release/src/web.ts#L4";
    const { recorded } = mount({
      localSource: true,
      resources: [
        {
          ...RESOURCES[0],
          codeReference: sourceUrl
        }
      ]
    });
    const web = await card("web");
    const link = await within(web).findByRole("link", {
      name: /View source code/
    });

    await userEvent.click(link);

    expect(recorded.external).toEqual([sourceUrl]);
    expect(recorded.local).toEqual([]);
    expect(document.body.contains(link)).toBe(true);
  });

  it("routes each diff node's source link by the branch that node lives on", async () => {
    // The worktree can only have one of the two compared branches checked out,
    // so a head-branch node must open locally while a removed node, whose file
    // lives on the base branch, must still go out to the host.
    const { recorded } = mount({
      diffMode: true,
      baseBranch: "main",
      workspaceBranch: "feature-branch",
      resources: [
        {
          id: "app/web",
          name: "web",
          type: "Radius.Compute/containers",
          codeReference: "src/web.ts#L4",
          diffStatus: "added"
        },
        {
          id: "app/old-worker",
          name: "old-worker",
          type: "Radius.Compute/containers",
          codeReference: "src/worker.ts#L9",
          diffStatus: "removed"
        }
      ]
    });

    const web = await card("web");
    await userEvent.click(
      await within(web).findByRole("link", { name: /View source code/ })
    );

    expect(recorded.local).toEqual([["src/web.ts", 4, expect.any(String)]]);
    expect(recorded.external).toEqual([]);

    const worker = await card("old-worker");
    await userEvent.click(
      await within(worker).findByRole("link", { name: /View source code/ })
    );

    expect(recorded.local).toHaveLength(1);
    expect(recorded.external).toEqual([
      "https://github.test/o/r/blob/main/src/worker.ts#L9"
    ]);
  });

  it("keeps every diff node remote when the worktree is on neither compared branch", async () => {
    const { recorded } = mount({
      diffMode: true,
      baseBranch: "main",
      workspaceBranch: "unrelated-branch",
      resources: [
        {
          id: "app/web",
          name: "web",
          type: "Radius.Compute/containers",
          codeReference: "src/web.ts#L4",
          diffStatus: "added"
        }
      ]
    });

    const web = await card("web");
    await userEvent.click(
      await within(web).findByRole("link", { name: /View source code/ })
    );

    expect(recorded.local).toEqual([]);
    expect(recorded.external).toEqual([
      "https://github.test/o/r/blob/feature-branch/src/web.ts#L4"
    ]);
  });

  it("marks the source row disabled when the node has no reference", async () => {
    mount({ localSource: true });
    const db = await card("db");

    const row = await within(db).findByRole("button", {
      name: /View source code/
    });
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(within(db).queryByRole("link")).toBeNull();
  });

  it("reaches every card by keyboard alone in document order", async () => {
    mount();
    await card("web");

    document.body.focus();
    const reached: string[] = [];
    for (let step = 0; step < 12; step += 1) {
      await userEvent.tab();
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) break;
      const owner = active.closest(".rad-node");
      const label =
        active.getAttribute("aria-label") ?? active.textContent?.trim() ?? "";
      if (owner instanceof HTMLElement) {
        reached.push(`${owner.getAttribute("data-node-id")}:${label}`);
      }
      if (reached.length >= 2 && reached[0] === reached.at(-1)) break;
    }

    // Every card's details control is reachable without a pointer.
    expect(reached).toContain("app/web:Show details");
    expect(reached).toContain("app/db:Show details");
  });

  it("re-renders through the real root when the controller pushes new data", async () => {
    const { graph } = mount();
    await card("web");

    const settings = resolveGraphSettings({ localSource: true });
    const next = buildGraph(settings, [
      { id: "app/cache", name: "cache", type: "Radius.Data/redisCaches" }
    ]);
    layoutGraph(realGraphVendor().dagre, next.nodes, next.edges);

    expect(graph.update(next.nodes, next.edges)).toBe(true);

    await waitFor(() => expect(screen.queryByText("web")).toBeNull());
    expect(
      screen.getByText("cache", { selector: ".rad-node__title" })
    ).toBeTruthy();
  });

  it("detaches the real root on unmount and stops answering updates", async () => {
    const { graph, host } = mount();
    await card("web");

    graph.unmount();

    await waitFor(() => expect(host.textContent).toBe(""));
    expect(graph.update([], [])).toBe(false);
    // A second teardown is harmless, which is what navigation relies on.
    expect(() => graph.unmount()).not.toThrow();
  });
});
