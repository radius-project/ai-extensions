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
import type { GraphNodeData } from "../../src/browser/graph/build.js";
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

function mount(options: { localSource?: boolean } = {}): Mounted {
  const settings = resolveGraphSettings({
    localSource: options.localSource ?? true,
    branch: "feature-branch"
  });
  const built = buildGraph(settings, RESOURCES);
  const vendor = realGraphVendor();
  layoutGraph(vendor.dagre, built.nodes, built.edges);

  const { host, dispose } = createGraphHost();
  const recorded: Recorded = { local: [], toggled: [], opened: [], reloads: 0 };
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

describe("graph view in a real browser", () => {
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
