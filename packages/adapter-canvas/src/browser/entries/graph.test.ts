import { describe, expect, it } from "vitest";
import {
  createFakeBrowserScope,
  createFakeElement
} from "../../../test/support/browser/fakes.js";
import { createFakeGraphVendor } from "../../../test/support/browser/graph-fakes.js";
import { PAGE_REGISTRY_GLOBAL } from "../globals.js";
import { resolvePageRegistry } from "../registry.js";
import { GRAPH_ENTRY_GLOBALS, installGraphEntry } from "./graph.js";
import type { DomElement } from "../ports.js";

function callGlobal(
  scope: Record<string, unknown>,
  name: string,
  ...args: unknown[]
): unknown {
  const fn = scope[name];
  if (typeof fn !== "function") {
    throw new Error(`Expected global "${name}" to be a function.`);
  }
  return (fn as (...callArgs: unknown[]) => unknown)(...args);
}

function baseFixture() {
  const browser = createFakeBrowserScope();
  const container = createFakeElement("graph-container");
  browser.document.add(container);
  const inserted: Array<[DomElement, DomElement]> = [];
  const legends: DomElement[] = [];
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
  return { browser, container, legends };
}

function fixture() {
  const base = baseFixture();
  const vendor = createFakeGraphVendor();
  Object.assign(base.browser.scope, {
    React: vendor.react,
    ReactDOM: vendor.reactDom,
    ReactFlow: vendor.reactFlow,
    dagre: vendor.dagre
  });
  return { ...base, vendor };
}

function fixtureWithoutVendor() {
  return baseFixture();
}

describe("graph browser entry", () => {
  it("installs through the shared registry, wires navigation once and publishes exactly the intended globals", () => {
    const { browser } = fixture();

    installGraphEntry(browser.scope);
    installGraphEntry(browser.scope);

    expect(browser.scope[PAGE_REGISTRY_GLOBAL]).toBe(
      resolvePageRegistry(browser.scope)
    );
    expect(browser.document.listenerCount("click")).toBe(1);
    expect(browser.page.listenerCount("popstate")).toBe(1);
    for (const name of GRAPH_ENTRY_GLOBALS) {
      expect(browser.scope[name]).toBeTypeOf("function");
    }

    resolvePageRegistry(browser.scope).teardownAll();
    expect(browser.document.listenerCount("click")).toBe(0);
    expect(browser.page.listenerCount("popstate")).toBe(0);
  });

  it("renders filtered resources with threaded options and a legend, then destroys them on teardown", () => {
    const { browser, container, legends, vendor } = fixture();
    installGraphEntry(browser.scope);

    const rendered = callGlobal(
      browser.scope,
      "radiusRenderGraph",
      "graph-container",
      [
        { id: "app/web", name: "web", codeReference: "web.bicep#L3" },
        "not-a-resource",
        42,
        null
      ],
      {
        showLegend: true,
        diffMode: false,
        repoUrl: "https://github.com/octo/app",
        branch: "feature",
        enablePopup: "not-a-boolean",
        curveStyle: 7
      }
    );

    expect(rendered).not.toBeNull();
    // Only the one genuine resource-shaped entry became a node, threading
    // repoUrl into its source link.
    const root = vendor.reactDom.roots[0];
    const boundary = root.rendered[0] as {
      children: Array<{
        props: {
          initialNodes: ReadonlyArray<{ data: { sourceUrl: string } }>;
        };
      }>;
    };
    const app = boundary.children[0];
    expect(app.props.initialNodes).toHaveLength(1);
    expect(app.props.initialNodes[0].data.sourceUrl).toContain(
      "https://github.com/octo/app"
    );
    // showLegend threaded through and diffMode (false) did not suppress it.
    expect(legends.length).toBeGreaterThan(0);
    expect(container.appended.length + legends.length).toBeGreaterThan(0);

    resolvePageRegistry(browser.scope).teardownAll();
    expect(vendor.reactDom.roots.every((r) => r.unmounts > 0)).toBe(true);
  });

  it("treats a non-array resources argument as none and renders nothing", () => {
    const { browser, vendor } = fixture();
    installGraphEntry(browser.scope);

    const rendered = callGlobal(
      browser.scope,
      "radiusRenderGraph",
      "graph-container",
      "not-an-array",
      {}
    );

    expect(rendered).not.toBeNull();
    expect(vendor.reactDom.roots).toHaveLength(0);
  });

  it("ignores a non-record options argument and a non-string container id", () => {
    const { browser } = fixture();
    installGraphEntry(browser.scope);

    expect(() => {
      callGlobal(
        browser.scope,
        "radiusRenderGraph",
        42,
        [{ id: "app/web" }],
        "not-an-object"
      );
    }).not.toThrow();
  });

  it("reports a missing graph library without a vendor bundle", () => {
    const { browser, container } = fixtureWithoutVendor();
    installGraphEntry(browser.scope);

    callGlobal(
      browser.scope,
      "radiusRenderGraph",
      "graph-container",
      [{ id: "app/web" }],
      {}
    );

    expect(container.querySelector(".error")?.textContent).toContain(
      "graph library"
    );
  });

  it("delegates loading and error state to the surface by container id", () => {
    const { browser, container } = fixture();
    installGraphEntry(browser.scope);

    callGlobal(browser.scope, "radiusSetGraphLoading", "graph-container");
    expect(container.innerHTML).not.toBe("");

    callGlobal(
      browser.scope,
      "radiusSetGraphError",
      "graph-container",
      "boom detail"
    );
    expect(container.querySelector(".error")?.textContent).toBe("boom detail");
  });
});
