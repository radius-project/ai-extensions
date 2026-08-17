// BU-04, BU-05, BU-06, BU-11: the graph renderer surface.
//
// This is the API the graph pages call, so these cover the whole lifecycle: a
// missing vendor bundle, a render failure, the empty graph, the populated
// render and its legend, updating in place while a deployment runs, replacing a
// render on the same container, destroying it, and the loading and error
// states.

import { describe, it, expect } from "vitest";
import {
  asGraphController,
  createGraphSurface,
  GRAPH_LIBRARY_ERROR,
  GRAPH_LOADING_HTML,
  GRAPH_RENDER_ERROR,
  OPEN_SOURCE_PATH
} from "./surface.js";
import { PANEL_ID } from "./details.js";
import {
  createFakeBrowser,
  createFakeElement,
  flushPromises,
  jsonResponse
} from "../../../test/support/browser/fakes.js";
import {
  createFakeGraphVendor,
  findByClass
} from "../../../test/support/browser/graph-fakes.js";
import type { FakeElement } from "../../../test/support/browser/fakes.js";
import type { FakeGraphVendor } from "../../../test/support/browser/graph-fakes.js";
import type { GraphResource } from "./model.js";
import type { DomElement } from "../ports.js";

const RESOURCES: GraphResource[] = [
  {
    id: "app/web",
    name: "web",
    type: "Radius.Compute/containers",
    connections: [{ id: "app/db" }]
  },
  { id: "app/db", name: "db", type: "Radius.Data/mySqlDatabases" }
];

describe("graph controller guard", () => {
  it("wraps only complete controller values", () => {
    expect(asGraphController(null)).toBeNull();
    expect(asGraphController({ update() {} })).toBeNull();
    expect(asGraphController({ destroy() {} })).toBeNull();
    let destroyed = 0;
    const next = {
      update: () => null,
      destroy: () => {
        destroyed++;
      }
    };
    const wrapped = asGraphController({
      update: () => next,
      destroy: () => {
        destroyed++;
      }
    });
    expect(wrapped?.update([])?.update([])).toBeNull();
    wrapped?.destroy();
    expect(destroyed).toBe(1);
  });
});

interface Parent {
  element: FakeElement;
  inserted: Array<[DomElement, DomElement]>;
  legends: DomElement[];
}

function setup(options: { vendor?: FakeGraphVendor | null } = {}) {
  const browser = createFakeBrowser();
  const container = createFakeElement("graph-container");
  browser.document.add(container);
  const legends: DomElement[] = [];
  const inserted: Array<[DomElement, DomElement]> = [];
  const parent = {
    querySelectorAll: () => legends,
    replaceChild: () => null,
    insertBefore: (node: DomElement, before: DomElement) => {
      inserted.push([node, before]);
      legends.push(node);
      return node;
    }
  };
  Object.assign(container, { parentNode: parent });
  const vendor =
    options.vendor === undefined ? createFakeGraphVendor() : options.vendor;
  const surface = createGraphSurface(browser.context, () => vendor);
  return {
    browser,
    container,
    surface,
    vendor,
    parent: { element: container, inserted, legends } satisfies Parent
  };
}

describe("missing container", () => {
  it("does nothing when the page has no such container", () => {
    const harness = setup();
    expect(harness.surface.render("absent", RESOURCES)).toBeNull();
    expect(() => harness.surface.setLoading("absent")).not.toThrow();
    expect(() => harness.surface.setError("absent", "x")).not.toThrow();
  });
});

describe("vendor bundle", () => {
  it("offers a reload instead of throwing when the libraries did not load", () => {
    const harness = setup({ vendor: null });
    expect(harness.surface.render("graph-container", RESOURCES)).toBeNull();
    expect(harness.container.appended).toHaveLength(2);
    const [error, retry] = harness.container.appended as FakeElement[];
    expect(error.className).toBe("status error");
    expect(error.textContent).toBe(GRAPH_LIBRARY_ERROR);
    expect(retry.textContent).toBe("Reload graph");
    expect(retry.getAttribute("type")).toBe("button");
    retry.dispatch("click");
    expect(harness.browser.nav.reloads).toBe(1);
  });
});

describe("render failure", () => {
  it("recovers with a reload action and reports the failure", () => {
    const harness = setup();
    harness.vendor!.reactDom.createRoot = () => {
      throw new Error("React exploded");
    };

    expect(harness.surface.render("graph-container", RESOURCES)).toBeNull();

    const error = (harness.container.appended as FakeElement[]).find(
      (element) => element.className === "status error"
    );
    expect(error?.textContent).toBe(GRAPH_RENDER_ERROR);
    expect(harness.browser.logger.errors).toEqual([
      {
        message: "Rendering the application graph failed.",
        detail: expect.any(Error)
      }
    ]);
  });

  it("cleans an incomplete render record before retrying", () => {
    const harness = setup();
    const createElement = harness.browser.context.dom.createElement;
    let fail = true;
    harness.browser.context.dom.createElement = (tagName) => {
      if (fail) {
        fail = false;
        throw new Error("DOM unavailable");
      }
      return createElement(tagName);
    };

    expect(harness.surface.render("graph-container", RESOURCES)).toBeNull();
    expect(harness.surface.render("graph-container", RESOURCES)).not.toBeNull();
  });
});

describe("empty graph", () => {
  it("clears the container and keeps a controller that can repopulate", () => {
    const harness = setup();
    harness.container.innerHTML = "<div>old</div>";
    const controller = harness.surface.render("graph-container", []);
    expect(controller).not.toBeNull();
    expect(harness.container.innerHTML).toBe("");
    expect(harness.vendor!.reactDom.roots).toHaveLength(0);

    // Still empty: the same controller answers.
    expect(controller?.update([])).toBe(controller);
    expect(controller?.update(null)).toBe(controller);

    const populated = controller?.update(RESOURCES);
    expect(populated).not.toBe(controller);
    expect(harness.vendor!.reactDom.roots).toHaveLength(1);
  });

  it("treats a null resource list as an empty graph", () => {
    const harness = setup();
    expect(harness.surface.render("graph-container", null)).not.toBeNull();
    expect(harness.vendor!.reactDom.roots).toHaveLength(0);
  });

  it("answers the empty controller when a repopulating render cannot run", () => {
    const harness = setup();
    const controller = harness.surface.render("graph-container", []);
    harness.vendor!.reactDom.createRoot = () => {
      throw new Error("React exploded");
    };
    expect(controller?.update(RESOURCES)).toBe(controller);
  });

  it("tears the empty render down on request", () => {
    const harness = setup();
    harness.surface.render("graph-container", [])?.destroy();
    expect(harness.container.appended).toEqual([]);
  });
});

describe("populated graph", () => {
  it("mounts the flow in its own host and adds the details panel", () => {
    const harness = setup();
    harness.container.innerHTML = "<div>old</div>";

    harness.surface.render("graph-container", RESOURCES);

    expect(harness.container.innerHTML).toBe("");
    expect(harness.container.style.position).toBe("relative");
    expect(harness.container.style.display).toBe("block");
    expect(harness.container.style.minHeight).toBe("450px");
    const [host, panel] = harness.container.appended as FakeElement[];
    expect(host.className).toBe("rad-flow-host");
    expect(host.getAttribute("style")).toContain("position:absolute");
    expect(panel.id).toBe(PANEL_ID);
    expect(harness.vendor!.reactDom.hosts).toEqual([host]);
  });

  it("lays the graph out before mounting it", () => {
    const harness = setup();
    harness.surface.render("graph-container", RESOURCES);
    expect(harness.vendor!.dagre?.graphs).toHaveLength(1);
    expect(harness.vendor!.dagre?.graphs[0].nodes.map((n) => n.id)).toEqual([
      "app/web",
      "app/db"
    ]);
  });

  it("skips the details panel when a caller disabled it", () => {
    const harness = setup();
    harness.surface.render("graph-container", RESOURCES, {
      enablePopup: false
    });
    expect(harness.container.appended).toHaveLength(1);
    expect(harness.container.listenerCount("click")).toBe(0);
  });

  it("replaces a previous render rather than stacking hosts and handlers", () => {
    const harness = setup();
    harness.surface.render("graph-container", RESOURCES);
    const first = harness.container.appended[0] as FakeElement;
    harness.container.matches.set(".rad-flow-host, #node-popup", [first]);

    harness.surface.render("graph-container", RESOURCES);

    expect(harness.vendor!.reactDom.roots[0].unmounts).toBe(1);
    expect(first.removed).toBe(true);
    expect(harness.container.listenerCount("click")).toBe(1);
  });

  it("removes a legend left over from an earlier render", () => {
    const harness = setup();
    const stale = createFakeElement("stale-legend");
    harness.parent.legends.push(stale);
    harness.surface.render("graph-container", RESOURCES);
    expect(stale.removed).toBe(true);
  });

  it("renders the category legend before the container when asked", () => {
    const harness = setup();
    harness.surface.render("graph-container", RESOURCES, { showLegend: true });
    const legend = harness.parent.inserted[0][0] as FakeElement;
    expect(legend.className).toBe("legend");
    expect(legend.innerHTML).toContain("Compute");
    expect(legend.innerHTML).toContain("Data Store");
    expect(harness.parent.inserted[0][1]).toBe(harness.container);
  });

  it("builds the legend from the same filtered resources as the graph", () => {
    const harness = setup();
    harness.surface.render(
      "graph-container",
      [
        ...RESOURCES,
        {
          id: "app/image",
          name: "image",
          type: "Radius.Compute/containerImages"
        }
      ],
      { showLegend: true }
    );
    const legend = harness.parent.inserted[0][0] as FakeElement;
    expect(legend.innerHTML).not.toContain("Registry");
  });

  it("renders the deploy status legend while deploying", () => {
    const harness = setup();
    harness.surface.render("graph-container", RESOURCES, {
      showLegend: true,
      deployMode: true
    });
    const legend = harness.parent.inserted[0][0] as FakeElement;
    expect(legend.innerHTML).toContain("Pending / deploying");
    expect(legend.innerHTML).not.toContain("Compute");
  });

  it("shows no legend for a diff, and none when nothing was asked for", () => {
    const harness = setup();
    harness.surface.render("graph-container", RESOURCES, {
      showLegend: true,
      diffMode: true
    });
    harness.surface.render("graph-container", RESOURCES);
    expect(harness.parent.inserted).toEqual([]);
  });

  it("shows no category legend when the graph contributes none", () => {
    const harness = setup();
    harness.surface.render("graph-container", [], { showLegend: true });
    expect(harness.parent.inserted).toEqual([]);
  });

  it("renders without a parent element to hang a legend on", () => {
    const browser = createFakeBrowser();
    const container = createFakeElement("graph-container");
    browser.document.add(container);
    const surface = createGraphSurface(browser.context, () =>
      createFakeGraphVendor()
    );
    expect(
      surface.render("graph-container", RESOURCES, { showLegend: true })
    ).not.toBeNull();

    Object.assign(container, { parentNode: { nodeName: "div" } });
    expect(
      surface.render("graph-container", RESOURCES, { showLegend: true })
    ).not.toBeNull();
  });
});

describe("controller", () => {
  it("re-lays out and pushes an update into the mounted view", () => {
    const harness = setup();
    const controller = harness.surface.render("graph-container", RESOURCES);
    const rendered = harness.vendor!.reactDom.roots[0].rendered[0] as {
      children: Array<{ type: (props: unknown) => unknown; props: unknown }>;
    };
    const app = rendered.children[0];
    app.type(app.props);
    harness.vendor!.react.runEffects();

    expect(
      controller?.update([
        { id: "app/web", name: "web", deployStatus: "success" }
      ])
    ).toBe(controller);

    expect(harness.vendor!.dagre?.graphs).toHaveLength(2);
    expect(harness.vendor!.reactFlow.nodeUpdates).toHaveLength(1);
    expect(harness.vendor!.reactFlow.nodeUpdates[0]).toHaveLength(1);
  });

  it("remounts when React has not bound the updater yet", () => {
    const harness = setup();
    const controller = harness.surface.render("graph-container", RESOURCES);
    const next = controller?.update([{ id: "app/new", name: "new" }]);
    expect(next).not.toBeNull();
    expect(next).not.toBe(controller);
    expect(harness.vendor!.reactDom.roots).toHaveLength(2);
    expect(harness.vendor!.reactDom.roots[0].unmounts).toBe(1);
  });

  it("ignores an update with no resource list", () => {
    const harness = setup();
    const controller = harness.surface.render("graph-container", RESOURCES);
    expect(controller?.update(null)).toBe(controller);
    expect(harness.vendor!.dagre?.graphs).toHaveLength(1);
  });

  it("falls back to the empty render when the graph is emptied", () => {
    const harness = setup();
    const controller = harness.surface.render("graph-container", RESOURCES);
    const [host, panel] = harness.container.appended as FakeElement[];
    const emptied = controller?.update([]);
    expect(emptied).not.toBe(controller);
    expect(harness.vendor!.reactDom.roots[0].unmounts).toBe(1);
    expect(host.removed).toBe(true);
    expect(panel.removed).toBe(true);
    expect(harness.container.innerHTML).toBe("");
  });

  it("unmounts the view, removes the panel and the host on destroy", () => {
    const harness = setup();
    const controller = harness.surface.render("graph-container", RESOURCES);
    const [host, panel] = harness.container.appended as FakeElement[];

    controller?.destroy();

    expect(harness.vendor!.reactDom.roots[0].unmounts).toBe(1);
    expect(host.removed).toBe(true);
    expect(panel.removed).toBe(true);
    expect(harness.container.listenerCount("click")).toBe(0);
    // Idempotent: a second destroy has nothing left to do.
    expect(() => controller?.destroy()).not.toThrow();
    expect(harness.vendor!.reactDom.roots[0].unmounts).toBe(1);
  });

  it("prevents a stale populated controller from changing its replacement", () => {
    const harness = setup();
    const first = harness.surface.render("graph-container", RESOURCES);
    const replacement = harness.surface.render("graph-container", RESOURCES);

    expect(first?.update([{ id: "app/stale", name: "stale" }])).toBe(first);
    first?.destroy();

    expect(harness.vendor!.dagre?.graphs).toHaveLength(2);
    expect(harness.vendor!.reactDom.roots[1].unmounts).toBe(0);
    replacement?.destroy();
    expect(harness.vendor!.reactDom.roots[1].unmounts).toBe(1);
  });

  it("prevents a stale empty controller from destroying a populated graph", () => {
    const harness = setup();
    const empty = harness.surface.render("graph-container", []);
    const populated = empty?.update(RESOURCES);

    expect(empty?.update([{ id: "app/stale", name: "stale" }])).toBe(empty);
    empty?.destroy();

    expect(harness.vendor!.dagre?.graphs).toHaveLength(1);
    expect(harness.vendor!.reactDom.roots[0].unmounts).toBe(0);
    populated?.destroy();
    expect(harness.vendor!.reactDom.roots[0].unmounts).toBe(1);
  });

  it("destroys every active container through the page-level cleanup", () => {
    const harness = setup();
    const second = createFakeElement("graph-secondary");
    harness.browser.document.add(second);
    harness.surface.render("graph-container", RESOURCES);
    harness.surface.render("graph-secondary", RESOURCES);

    harness.surface.destroyAll();

    expect(harness.vendor!.reactDom.roots.map((root) => root.unmounts)).toEqual(
      [1, 1]
    );
  });
});

describe("opening source", () => {
  it("posts the repo-relative path to the local server", async () => {
    const harness = setup();
    harness.browser.net.handle(OPEN_SOURCE_PATH, () =>
      jsonResponse({ ok: true })
    );

    harness.surface.openLocalSource("src/web.ts", 4, "https://github.test/x");
    await flushPromises();

    expect(harness.browser.net.calls[0].init).toEqual({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "src/web.ts", line: 4 })
    });
    expect(harness.browser.external.opened).toEqual([]);
  });

  it("falls back to the remote URL when the file is not on this checkout", async () => {
    const harness = setup();
    harness.browser.net.handle(OPEN_SOURCE_PATH, () =>
      jsonResponse({ error: "NOT_ON_WORKTREE" }, false, 409)
    );

    harness.surface.openLocalSource("src/web.ts", 0, "https://github.test/x");
    await flushPromises();

    expect(harness.browser.external.opened).toEqual(["https://github.test/x"]);
  });

  it("falls back when the request itself fails", async () => {
    const harness = setup();
    harness.browser.net.handle(OPEN_SOURCE_PATH, () =>
      Promise.reject(new Error("offline"))
    );

    harness.surface.openLocalSource("src/web.ts", 0, "https://github.test/x");
    await flushPromises();

    expect(harness.browser.external.opened).toEqual(["https://github.test/x"]);
  });

  it("opens the remote URL directly when there is no local path", () => {
    const harness = setup();
    harness.surface.openLocalSource("", 0, "https://github.test/x");
    expect(harness.browser.net.calls).toEqual([]);
    expect(harness.browser.external.opened).toEqual(["https://github.test/x"]);
  });

  it("ignores an external open with no URL", () => {
    const harness = setup();
    harness.surface.openExternal("");
    expect(harness.browser.external.opened).toEqual([]);
  });

  it("sends the node's line number with the request", async () => {
    const harness = setup();
    harness.browser.net.handle(OPEN_SOURCE_PATH, () => jsonResponse({}));
    harness.surface.openLocalSource("src/web.ts", 31, "");
    await flushPromises();
    expect(harness.browser.net.calls[0].init?.body).toBe(
      JSON.stringify({ path: "src/web.ts", line: 31 })
    );
  });
});

describe("loading and error states", () => {
  it("shows the generation progress panel", () => {
    const harness = setup();
    harness.surface.setLoading("graph-container");
    expect(harness.container.innerHTML).toBe(GRAPH_LOADING_HTML);
    expect(harness.container.innerHTML).toContain('id="progress-steps"');
  });

  it("shows a message as text, never as markup", () => {
    const harness = setup();
    harness.surface.setError("graph-container", "<img src=x onerror=1>");
    const status = harness.container.appended[0] as FakeElement;
    expect(harness.container.innerHTML).toBe("");
    expect(status.className).toBe("status error");
    expect(status.textContent).toBe("<img src=x onerror=1>");
  });

  it("tears down an active render before showing loading or error state", () => {
    const loading = setup();
    loading.surface.render("graph-container", RESOURCES);
    loading.surface.setLoading("graph-container");
    expect(loading.vendor!.reactDom.roots[0].unmounts).toBe(1);

    const failing = setup();
    failing.surface.render("graph-container", RESOURCES);
    failing.surface.setError("graph-container", "failed");
    expect(failing.vendor!.reactDom.roots[0].unmounts).toBe(1);
  });
});

describe("node interactions", () => {
  it("wires a card click to the details panel", () => {
    const harness = setup();
    harness.surface.render("graph-container", RESOURCES, {
      repoUrl: "https://github.test/o/r"
    });
    const panel = harness.container.appended[1] as FakeElement;
    // The card component the view built is reachable through the node types the
    // application was given, so drive it the way React would.
    const app = (
      harness.vendor!.reactDom.roots[0].rendered[0] as {
        children: Array<{
          type: (props: unknown) => unknown;
          props: { initialNodes: Array<{ data: unknown }> };
        }>;
      }
    ).children[0];
    const nodeData = app.props.initialNodes[0].data;
    const tree = app.type(app.props) as { props: Record<string, unknown> };
    const nodeTypes = tree.props.nodeTypes as {
      rad: (props: { data: unknown }) => unknown;
    };
    const card = findByClass(nodeTypes.rad({ data: nodeData }), "rad-node");
    const owner = createFakeElement("card");

    (card?.props.onClick as (event: unknown) => void)({
      currentTarget: owner
    });

    expect(panel.style.display).toBe("");
    expect(panel.innerHTML).toContain("View app definition");
    expect(panel.innerHTML).toContain(
      "https://github.test/o/r/blob/main/.radius/app.bicep"
    );

    (card?.props.onClick as (event: unknown) => void)({});
    const dots = findByClass(
      nodeTypes.rad({ data: nodeData }),
      "rad-node__dots nodrag nopan"
    );
    const dot = createFakeElement("dots");
    dot.ancestors.set(".rad-node", owner);
    (
      dots?.props.onClick as (event: {
        preventDefault(): void;
        stopPropagation(): void;
        currentTarget: unknown;
      }) => void
    )({
      preventDefault() {},
      stopPropagation() {},
      currentTarget: dot
    });
    expect(panel.style.display).toBe("none");
    (
      dots?.props.onClick as (event: {
        preventDefault(): void;
        stopPropagation(): void;
      }) => void
    )({
      preventDefault() {},
      stopPropagation() {}
    });
  });

  it("does not create or open a details panel when popups are disabled", () => {
    const harness = setup();
    harness.surface.render("graph-container", RESOURCES, {
      enablePopup: false
    });
    expect(harness.container.appended).toHaveLength(1);
    expect(harness.container.listenerCount("click")).toBe(0);

    const rendered = harness.vendor!.reactDom.roots[0].rendered[0] as {
      children: Array<{
        type: (props: unknown) => unknown;
        props: { initialNodes: Array<{ data: unknown }> };
      }>;
    };
    const app = rendered.children[0];
    const tree = app.type(app.props) as { props: Record<string, unknown> };
    const nodeTypes = tree.props.nodeTypes as {
      rad: (props: { data: unknown }) => unknown;
    };
    const card = findByClass(
      nodeTypes.rad({ data: app.props.initialNodes[0].data }),
      "rad-node"
    );
    expect(() =>
      (card?.props.onClick as (event: unknown) => void)({
        currentTarget: createFakeElement("card")
      })
    ).not.toThrow();
    harness.surface.destroyAll();
  });

  it("routes the mounted error boundary reload through navigation", () => {
    const harness = setup();
    harness.surface.render("graph-container", RESOURCES);
    const boundaryElement = harness.vendor!.reactDom.roots[0].rendered[0] as {
      type: {
        new (props: Record<string, unknown>): {
          state: Record<string, unknown>;
          render(): unknown;
        };
        getDerivedStateFromError(): Record<string, unknown>;
      };
      props: Record<string, unknown>;
    };
    const boundary = new boundaryElement.type(boundaryElement.props);
    boundary.state = boundaryElement.type.getDerivedStateFromError();
    const fallback = boundary.render();
    const button = findByClass(fallback, "rad-btn rad-btn--secondary");
    (button?.props.onClick as () => void)();
    expect(harness.browser.nav.reloads).toBe(1);
  });
});
