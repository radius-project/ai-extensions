// BU-05, BU-06: the React Flow view.
//
// The node card, the flow application and the error boundary are real component
// functions, so a recording React drives them and the produced element tree,
// its handlers and the update path are asserted without a browser. Layout,
// painting and pointer behaviour stay Chromium concerns.

import { describe, it, expect } from "vitest";
import {
  createErrorBoundary,
  createGraphApp,
  createNodeComponent,
  fitTypeLabel,
  mountGraph
} from "./view.js";
import { buildGraph, resolveGraphSettings } from "./build.js";
import {
  childComponent,
  childrenOf,
  createFakeFlowInstance,
  createGraphVendor,
  findAllByType,
  findByClass,
  flattenElements,
  isRenderedElement,
  refOf
} from "../../../test/support/browser/graph-vendor.js";
import {
  createFakeClock,
  createFakeElement
} from "../../../test/support/browser/fakes.js";
import type { GraphNodeData, GraphOptions } from "./build.js";
import type { UpdaterBinding } from "./view.js";
import type { DomElement } from "../ports.js";
import type { RenderedElement } from "../../../test/support/browser/graph-vendor.js";

function node(overrides: Partial<GraphNodeData> = {}): GraphNodeData {
  return {
    id: "app/web",
    borderColor: "var(--rad-node-border)",
    borderWidth: 2.5,
    borderStyle: "solid",
    bgColor: "var(--rad-node-bg)",
    icon: "data:image/svg+xml,icon",
    nodeName: "web",
    typeLabel: "Compute/containers",
    codeRef: "src/web.ts#L4",
    sourceUrl: "https://github.test/o/r/blob/main/src/web.ts#L4",
    srcPath: "src/web.ts",
    srcLine: 4,
    defFile: ".radius/app.bicep",
    defLine: 0,
    resourceType: "Radius.Compute/containers",
    diffStatus: "",
    deployStatus: "",
    portalUrl: "",
    cloudResources: "[]",
    ...overrides
  };
}

interface Recorded {
  external: string[];
  local: Array<[string, number, string]>;
  toggled: Array<[string, DomElement | null]>;
  opened: Array<[string, DomElement | null]>;
}

function renderCard(
  data: GraphNodeData,
  options: GraphOptions = {}
): {
  tree: unknown;
  recorded: Recorded;
  vendor: ReturnType<typeof createGraphVendor>;
} {
  const vendor = createGraphVendor();
  const recorded: Recorded = {
    external: [],
    local: [],
    toggled: [],
    opened: []
  };
  const component = createNodeComponent(vendor, resolveGraphSettings(options), {
    openExternal: (url) => recorded.external.push(url),
    openLocalSource: (path, line, fallback) =>
      recorded.local.push([path, line, fallback]),
    toggleDetails: (value, card) => recorded.toggled.push([value.id, card]),
    openDetails: (value, card) => recorded.opened.push([value.id, card])
  });
  return { tree: component({ data }), recorded, vendor };
}

function props(element: RenderedElement | undefined): Record<string, unknown> {
  if (!element) throw new Error("expected an element");
  return element.props;
}

function callHandler(
  element: RenderedElement | undefined,
  name: string,
  event: Record<string, unknown> = {}
): void {
  const handler = props(element)[name];
  if (typeof handler !== "function") throw new Error(`no ${name} handler`);
  (handler as (value: unknown) => void)({
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
    ...event
  });
}

describe("type label fitting", () => {
  it("shrinks the label until it fits, down to the floor", () => {
    const element = {
      clientWidth: 100,
      style: { fontSize: "" },
      get scrollWidth() {
        return parseFloat(this.style.fontSize) * 10;
      }
    };
    expect(fitTypeLabel(element)).toBe(10);
    expect(element.style.fontSize).toBe("10px");
  });

  it("stops at the minimum rather than shrinking forever", () => {
    const element = {
      clientWidth: 1,
      scrollWidth: 500,
      style: { fontSize: "" }
    };
    expect(fitTypeLabel(element)).toBe(7);
    expect(element.style.fontSize).toBe("7px");
  });

  it("leaves a label that already fits at the base size", () => {
    const element = {
      clientWidth: 500,
      scrollWidth: 10,
      style: { fontSize: "" }
    };
    expect(fitTypeLabel(element)).toBe(13);
  });

  it("does nothing for something that cannot be measured", () => {
    expect(fitTypeLabel(null)).toBeNull();
    expect(fitTypeLabel({ scrollWidth: 1 })).toBeNull();
  });
});

describe("node card", () => {
  it("renders the figma card with its handles, icon, title and type", () => {
    const { tree, vendor } = renderCard(node());
    const shell = tree as RenderedElement;
    expect(shell.props.className).toBe("rad-node-shell");
    const handles = findAllByType(tree, vendor.reactFlow.Handle);
    expect(handles).toHaveLength(2);
    expect(props(handles[0]).position).toBe("top");
    expect(props(handles[1]).position).toBe("bottom");

    const card = findByClass(tree, "rad-node");
    expect(props(card)["data-node-id"]).toBe("app/web");
    expect(props(card).style).toEqual({
      boxSizing: "border-box",
      background: "var(--rad-node-bg)",
      borderStyle: "solid",
      borderWidth: "2.5px",
      borderColor: "var(--rad-node-border)"
    });
    expect(props(findByClass(tree, "rad-node__icon")).src).toBe(
      "data:image/svg+xml,icon"
    );
    expect(childrenOf(findByClass(tree, "rad-node__title"))).toEqual(["web"]);
    expect(props(findByClass(tree, "rad-node__type")).title).toBe(
      "Compute/containers"
    );
  });

  it("falls back to the theme defaults for a node with no colours", () => {
    const { tree } = renderCard(
      node({
        icon: "",
        bgColor: "",
        borderColor: "",
        borderStyle: "",
        borderWidth: 0
      })
    );
    expect(props(findByClass(tree, "rad-node")).style).toEqual({
      boxSizing: "border-box",
      background: "var(--rad-node-bg)",
      borderStyle: "solid",
      borderWidth: "2.5px",
      borderColor: "var(--rad-node-border)"
    });
    expect(findByClass(tree, "rad-node__icon")).toBeUndefined();
  });

  it("opts the interactive children out of the pane's drag, pan and key handling", () => {
    const { tree } = renderCard(node());
    // React Flow treats Space and Enter as node-selection keys and cancels the
    // event before the browser can synthesise a click, so every interactive
    // control inside a node carries `nokey` to stay keyboard-activatable.
    expect(
      props(findByClass(tree, "rad-node__dots nodrag nopan nokey")).type
    ).toBe("button");
    expect(
      findByClass(tree, "rad-node__source nodrag nopan nokey")
    ).toBeDefined();
  });

  it("opens the details panel from the card and toggles it from the dots", () => {
    const { tree, recorded } = renderCard(node());
    const card = createFakeElement("card");
    callHandler(findByClass(tree, "rad-node"), "onClick", {
      currentTarget: card
    });
    expect(recorded.opened).toEqual([["app/web", card]]);

    const dots = createFakeElement("dots");
    const owner = createFakeElement("owner");
    dots.ancestors.set(".rad-node", owner);
    callHandler(
      findByClass(tree, "rad-node__dots nodrag nopan nokey"),
      "onClick",
      {
        currentTarget: dots
      }
    );
    expect(recorded.toggled).toEqual([["app/web", owner]]);
  });

  it("renders a deployed node's concrete portal URL as a native link", () => {
    const portalUrl = "https://portal.azure.com/resource/mysql";
    const { tree, recorded } = renderCard(node({ portalUrl }), {
      deployMode: true
    });
    const link = findByClass(tree, "rad-node__portal nodrag nopan nokey");

    expect(props(link)).toMatchObject({
      href: portalUrl,
      target: "_blank",
      rel: "noopener noreferrer",
      "aria-label": "Open web in Azure Portal"
    });
    callHandler(link, "onClick");
    expect(recorded.opened).toEqual([]);
  });

  it("does not render an unsafe deployed portal link", () => {
    const { tree, recorded } = renderCard(
      node({ portalUrl: "javascript:alert(1)" }),
      { deployMode: true }
    );

    callHandler(findByClass(tree, "rad-node"), "onClick");

    expect(
      findByClass(tree, "rad-node__portal nodrag nopan nokey")
    ).toBeUndefined();
    expect(recorded.opened).toEqual([["app/web", null]]);
  });

  it("falls back to the clicked element when there is no card ancestor", () => {
    const { tree, recorded } = renderCard(node());
    const dots = createFakeElement("dots");
    callHandler(
      findByClass(tree, "rad-node__dots nodrag nopan nokey"),
      "onClick",
      {
        currentTarget: dots
      }
    );
    expect(recorded.toggled).toEqual([["app/web", dots]]);
    callHandler(
      findByClass(tree, "rad-node__dots nodrag nopan nokey"),
      "onClick",
      {
        currentTarget: null
      }
    );
    expect(recorded.toggled[1][1]).toBeNull();
  });

  it("opens the on-disk file for a local graph and keeps the remote URL as its href", () => {
    const { tree, recorded } = renderCard(node(), { localSource: true });
    const row = findByClass(tree, "rad-node__source nodrag nopan nokey");
    expect(props(row).href).toBe(
      "https://github.test/o/r/blob/main/src/web.ts#L4"
    );
    expect(props(row).target).toBeUndefined();
    let prevented = 0;
    let stopped = 0;
    callHandler(row, "onClick", {
      preventDefault: () => {
        prevented += 1;
      },
      stopPropagation: () => {
        stopped += 1;
      }
    });
    expect(prevented).toBe(1);
    expect(stopped).toBe(1);
    expect(recorded.local).toEqual([
      ["src/web.ts", 4, "https://github.test/o/r/blob/main/src/web.ts#L4"]
    ]);
  });

  it("shows a disabled row for a local node with no code reference", () => {
    const { tree } = renderCard(node({ srcPath: "", sourceUrl: "" }), {
      localSource: true
    });
    const row = findByClass(tree, "rad-node__source");
    expect(props(row).role).toBe("button");
    expect(props(row)["aria-disabled"]).toBe("true");
    expect(props(row).title).toBe("No source reference found");
    expect(props(row).onClick).toBeUndefined();
  });

  it("opens a remote source link through the host without selecting the card", () => {
    const { tree, recorded } = renderCard(node());
    const row = findByClass(tree, "rad-node__source nodrag nopan nokey");
    expect(props(row).target).toBe("_blank");
    expect(props(row).rel).toBe("noopener noreferrer");
    let prevented = 0;
    let stopped = 0;
    callHandler(row, "onClick", {
      preventDefault: () => {
        prevented += 1;
      },
      stopPropagation: () => {
        stopped += 1;
      }
    });
    expect(prevented).toBe(1);
    expect(stopped).toBe(1);
    expect(recorded.external).toEqual([
      "https://github.test/o/r/blob/main/src/web.ts#L4"
    ]);
    expect(recorded.local).toEqual([]);
  });

  it("renders an inert row when a remote node has no source URL", () => {
    const { tree } = renderCard(node({ sourceUrl: "" }));
    const row = findByClass(tree, "rad-node__source");
    expect(props(row).role).toBe("button");
    expect(props(row).href).toBeUndefined();
  });

  it("uses '#' as the href for a local node whose remote URL is unknown", () => {
    const { tree } = renderCard(node({ sourceUrl: "" }), { localSource: true });
    expect(
      props(findByClass(tree, "rad-node__source nodrag nopan nokey")).href
    ).toBe("#");
  });

  it.each([
    ["progress", "In progress", ""],
    ["success", "Deployed", ""],
    ["failed", "Failed", ""]
  ])(
    "labels the %s badge for assistive technology",
    (kind, alt, progressClass) => {
      const { tree } = renderCard(
        node({
          deployBadge: "data:image/svg+xml,badge",
          deployBadgeKind: kind
        })
      );
      const badge = flattenElements(tree).find((element) =>
        String(element.props.className ?? "").startsWith("rad-node__badge")
      );
      expect(props(badge).alt).toBe(alt);
      expect(props(badge).className).toBe(`rad-node__badge${progressClass}`);
    }
  );

  it("renders no badge outside a deployment", () => {
    const { tree } = renderCard(node());
    expect(
      flattenElements(tree).some((element) =>
        String(element.props.className ?? "").includes("rad-node__badge")
      )
    ).toBe(false);
  });

  it("fits the type label after layout, keyed on the label itself", () => {
    const { tree, vendor } = renderCard(node());
    expect(vendor.react.layoutEffects).toHaveLength(1);
    expect(vendor.react.layoutEffects[0].deps).toEqual(["Compute/containers"]);
    const typeElement = {
      clientWidth: 10,
      scrollWidth: 50,
      style: { fontSize: "" }
    };
    vendor.react.refs[0].current = typeElement;
    vendor.react.layoutEffects[0].effect();
    expect(typeElement.style.fontSize).toBe("7px");
    // React keeps a ref out of props, so the card's type element carries the
    // very ref the layout effect measures.
    const typeNode = findByClass(tree, "rad-node__type");
    expect(typeNode ? refOf(typeNode) : undefined).toBe(vendor.react.refs[0]);
  });
});

describe("flow application", () => {
  function renderApp() {
    const vendor = createGraphVendor();
    const clock = createFakeClock();
    const updater: UpdaterBinding = { fn: null };
    const built = buildGraph(resolveGraphSettings(), [
      { id: "a", name: "a", connections: [{ id: "b" }] },
      { id: "b", name: "b" }
    ]);
    const app = createGraphApp(vendor, clock, { rad: "RadNode" }, updater);
    const tree = app({ initialNodes: built.nodes, initialEdges: built.edges });
    return { vendor, clock, updater, built, tree };
  }

  it("configures React Flow the way the shipped graph does", () => {
    const { tree, vendor } = renderApp();
    const root = tree as RenderedElement;
    expect(root.type).toBe(vendor.reactFlow.default);
    expect(root.props.nodeTypes).toEqual({ rad: "RadNode" });
    expect(root.props.fitView).toBe(true);
    expect(root.props.fitViewOptions).toEqual({ padding: 0.18 });
    expect(root.props.minZoom).toBe(0.2);
    expect(root.props.maxZoom).toBe(2);
    expect(root.props.nodesDraggable).toBe(true);
    expect(root.props.nodesConnectable).toBe(false);
    expect(root.props.elementsSelectable).toBe(true);
    // The wrapper must not be a focusable button around the card's own
    // controls, or every node becomes a nested interactive element.
    expect(root.props.nodesFocusable).toBe(false);
    expect(root.props.edgesFocusable).toBe(false);
    expect(root.props.proOptions).toEqual({ hideAttribution: true });
    // Plain figma edges: no arrowheads, and no minimap child.
    expect(root.props.edges).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "a-->b" })])
    );
    expect(
      (root.props.edges as Array<Record<string, unknown>>).some(
        (edge) => "markerEnd" in edge
      )
    ).toBe(false);
    expect(findAllByType(tree, vendor.reactFlow.Background)).toHaveLength(1);
    expect(props(findAllByType(tree, vendor.reactFlow.Background)[0]).gap).toBe(
      16
    );
    expect(
      props(findAllByType(tree, vendor.reactFlow.Controls)[0]).showInteractive
    ).toBe(false);
    expect(
      flattenElements(tree).some((element) => element.type === "MiniMap")
    ).toBe(false);
  });

  it("never passes a themed colour token into the Background SVG attribute", () => {
    const { tree, vendor } = renderApp();
    const background = findAllByType(tree, vendor.reactFlow.Background)[0];
    for (const value of Object.values(props(background))) {
      expect(String(value)).not.toContain("var(--");
    }
  });

  it("fits the viewport shortly after mounting", () => {
    const { tree, clock } = renderApp();
    const instance = createFakeFlowInstance();
    callHandler(tree as RenderedElement, "onInit", {});
    const onInit = props(tree as RenderedElement).onInit as (
      value: unknown
    ) => void;
    onInit(instance);
    expect(instance.fits).toEqual([]);
    clock.tick(30);
    expect(instance.fits).toEqual([{ padding: 0.18 }]);
  });

  it("pushes an update into React state and re-fits, preserving the viewport", () => {
    const { tree, clock, vendor, updater } = renderApp();
    const instance = createFakeFlowInstance();
    (props(tree as RenderedElement).onInit as (value: unknown) => void)(
      instance
    );
    vendor.react.runEffects();
    clock.tick(30);

    expect(updater.fn).toBeTypeOf("function");
    updater.fn?.([], []);
    expect(vendor.reactFlow.nodeUpdates).toHaveLength(1);
    expect(vendor.reactFlow.edgeUpdates).toHaveLength(1);
    clock.tick(40);
    expect(instance.fits).toEqual([
      { padding: 0.18 },
      { padding: 0.18, duration: 200 }
    ]);
  });

  it("survives a viewport that refuses to fit", () => {
    const { tree, clock } = renderApp();
    const instance = createFakeFlowInstance();
    instance.failing = true;
    (props(tree as RenderedElement).onInit as (value: unknown) => void)(
      instance
    );
    expect(() => clock.tick(30)).not.toThrow();
  });

  it("does not schedule a re-fit before the flow has reported itself", () => {
    const { clock, vendor, updater } = renderApp();
    vendor.react.runEffects();
    updater.fn?.([], []);
    expect(clock.pending).toBe(0);
  });

  it("unbinds the updater when the application is torn down", () => {
    const { vendor, updater } = renderApp();
    vendor.react.runEffects();
    expect(updater.fn).toBeTypeOf("function");
    vendor.react.runCleanups();
    expect(updater.fn).toBeNull();
  });
});

describe("error boundary", () => {
  it("renders its children until a render fails, then offers a reload", () => {
    const vendor = createGraphVendor();
    let reloads = 0;
    const Boundary = createErrorBoundary(vendor, () => {
      reloads += 1;
    });
    const instance = new Boundary({ children: "graph" });
    expect(instance.render()).toBe("graph");

    instance.state = Boundary.getDerivedStateFromError();
    const fallback = instance.render();
    expect(isRenderedElement(fallback)).toBe(true);
    expect(props(fallback as RenderedElement).className).toBe("status error");
    const button = flattenElements(fallback).find(
      (element) => element.type === "button"
    );
    expect(childrenOf(button)).toEqual(["Reload graph"]);
    callHandler(button, "onClick");
    expect(reloads).toBe(1);
  });
});

describe("mountGraph", () => {
  function mount(options: { failUnmount?: boolean } = {}) {
    const vendor = createGraphVendor();
    const clock = createFakeClock();
    const host = createFakeElement("host");
    const built = buildGraph(resolveGraphSettings(), [{ id: "a", name: "a" }]);
    const mounted = mountGraph({
      vendor,
      clock,
      host,
      settings: resolveGraphSettings(),
      deps: {
        openExternal: () => undefined,
        openLocalSource: () => undefined,
        openDetails: () => undefined,
        toggleDetails: () => undefined
      },
      reload: () => undefined,
      nodes: built.nodes,
      edges: built.edges
    });
    if (options.failUnmount) vendor.reactDom.roots[0].failUnmount = true;
    return { vendor, clock, host, built, mounted };
  }

  it("creates one root on the host and renders the boundary around the app", () => {
    const { vendor, host } = mount();
    expect(vendor.reactDom.roots).toHaveLength(1);
    expect(vendor.reactDom.hosts).toEqual([host]);
    const rendered = vendor.reactDom.roots[0].rendered[0] as RenderedElement;
    expect(childrenOf(rendered)).toHaveLength(1);
    const app = childComponent(rendered);
    expect(app.props.initialNodes).toHaveLength(1);
  });

  it("reports that an update could not be applied before the app bound", () => {
    const { mounted, built } = mount();
    expect(mounted.update(built.nodes, built.edges)).toBe(false);
  });

  it("applies an update once the mounted application has bound", () => {
    const { vendor, mounted, built } = mount();
    const app = childComponent(
      vendor.reactDom.roots[0].rendered[0] as RenderedElement
    );
    app.type({
      initialNodes: built.nodes,
      initialEdges: built.edges
    });
    vendor.react.runEffects();
    expect(mounted.update(built.nodes, built.edges)).toBe(true);
    expect(vendor.reactFlow.nodeUpdates).toHaveLength(1);
  });

  it("unmounts once and tolerates a root React already discarded", () => {
    const { vendor, mounted } = mount({ failUnmount: true });
    expect(() => mounted.unmount()).not.toThrow();
    expect(vendor.reactDom.roots[0].unmounts).toBe(1);
  });
});
