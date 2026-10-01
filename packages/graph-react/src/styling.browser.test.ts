import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { mountRadiusGraph } from "./mount.js";
import type { RadiusGraphProps } from "./graph.js";
import "./styles.css";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const graph: RadiusGraphProps["graph"] = {
  kind: "modeled",
  resources: [
    {
      id: "web",
      name: "web",
      type: "Radius.Compute/containers",
      codeReference: "web.bicep#L4",
      connections: [{ id: "db" }]
    },
    { id: "db", name: "db" }
  ]
};

function mount(props: Partial<RadiusGraphProps> = {}) {
  const host = document.createElement("div");
  host.style.cssText = "width:850px;height:600px;";
  document.body.append(host);
  const input = { graph, options: { showLegend: true }, ...props };
  const controller = mountRadiusGraph(host, input);
  cleanups.push(() => {
    controller.unmount();
    host.remove();
  });
  return { host, controller, input };
}

function stylesheet(text: string) {
  const element = document.createElement("style");
  element.textContent = text;
  // Host CSS does not have to win by being injected after the package CSS.
  document.head.prepend(element);
  cleanups.push(() => element.remove());
  return element;
}

function element(host: HTMLElement, selector: string): HTMLElement {
  const result = host.querySelector(selector);
  if (!(result instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
  return result;
}

const hostCss = `
  .host-graph { color: #102a43; background: #f0f4f8; font-family: serif; }
  .host-graph [data-radius-part="node"] {
    background: #fff4d6; border: 3px solid #73510d; border-radius: 2px; padding: 12px;
  }
  .host-graph [data-radius-part="node-title"] { color: #402a05; font-size: 18px; }
  .host-graph [data-radius-part="node-type"] { font-size: 16px; white-space: normal; }
  .host-graph [data-radius-part="legend"] { display: flex; gap: 20px; margin: 0; }
  .host-graph [data-radius-part="legend-item"] { display: flex; gap: 8px; }
  .host-graph [data-radius-part="details"] {
    background: #102a43; color: white; border: 3px solid #829ab1; border-radius: 0; padding: 10px;
  }
  .host-graph [data-radius-part="details-link"] { color: #b3ecff; font-size: 16px; }
  .host-graph [data-radius-part="details-subtitle"] { color: #bcccdc; }
  .host-graph [data-radius-part="details-message"][data-radius-failure="true"] { color: #ffcccc; }
  .host-graph .react-flow__controls-button { background: #102a43; color: white; }
  .host-graph .radius-graph__edge .react-flow__edge-path { stroke: #73510d; stroke-width: 4px; }
  .host-graph :focus-visible { outline: 3px solid #0969da; outline-offset: 3px; }
`;

describe("host stylesheet ownership", () => {
  it.each(["before", "after"])(
    "does not restyle another Flow renderer when host CSS loads %s",
    async (order) => {
      const css = stylesheet(
        ".react-flow__controls-button { width: 36px; height: 36px; padding: 2px; }"
      );
      if (order === "after") document.head.append(css);
      const peer = document.createElement("button");
      peer.className = "react-flow__controls-button";
      peer.textContent = "Host graph control";
      document.body.append(peer);
      cleanups.push(() => peer.remove());
      const mounted = mount();
      await within(mounted.host).findByRole("group", { name: "web" });
      expect(getComputedStyle(peer).width).toBe("36px");
      expect(getComputedStyle(peer).height).toBe("36px");
      expect(getComputedStyle(peer).boxSizing).toBe("border-box");
      expect(peer.getBoundingClientRect().width).toBe(36);
      expect(peer.getBoundingClientRect().height).toBe(36);
      const control = element(mounted.host, ".react-flow__controls-button");
      expect(getComputedStyle(control).width).toBe("26px");
      expect(getComputedStyle(control).height).toBe("26px");
    }
  );

  it("uses one renderer with independent host and default skins and no inline paint", async () => {
    stylesheet(hostCss);
    const onOpenSource = vi.fn();
    const custom = mount({
      appearance: "custom",
      className: "host-graph",
      options: { showLegend: true, localSource: true },
      callbacks: { onOpenSource }
    });
    const standard = mount();
    const outside = document.createElement("button");
    outside.style.background = "rgb(11, 22, 33)";
    document.body.append(outside);
    cleanups.push(() => outside.remove());
    const web = await within(custom.host).findByRole("group", { name: "web" });
    const original = await within(standard.host).findByRole("group", {
      name: "web"
    });
    expect(getComputedStyle(web).backgroundColor).toBe("rgb(255, 244, 214)");
    expect(getComputedStyle(web).borderRadius).toBe("2px");
    expect(getComputedStyle(web).borderWidth).toBe("3px");
    expect(getComputedStyle(original).borderRadius).toBe("16px");
    expect(getComputedStyle(outside).backgroundColor).toBe("rgb(11, 22, 33)");
    expect(web.style.background).toBe("");
    expect(web.style.borderColor).toBe("");
    expect(
      getComputedStyle(element(custom.host, '[data-radius-part="node-type"]'))
        .fontSize
    ).toBe("16px");
    expect(
      getComputedStyle(element(custom.host, '[data-radius-part="legend"]')).gap
    ).toBe("20px");
    const spacer = element(
      custom.host,
      '[data-radius-part="legend-icon"]:not(img)'
    );
    expect(getComputedStyle(spacer).width).toBe("14px");
    expect(getComputedStyle(spacer).height).toBe("14px");
    const db = within(custom.host).getByRole("group", { name: "db" });
    expect(db.getBoundingClientRect().top).toBeGreaterThan(
      web.getBoundingClientRect().bottom
    );
    await waitFor(() => {
      const edge = custom.host.querySelector(".react-flow__edge-path");
      expect(edge && getComputedStyle(edge).stroke).toBe("rgb(115, 81, 13)");
      expect(edge && getComputedStyle(edge).strokeWidth).toBe("4px");
    });
    const controls = element(custom.host, ".react-flow__controls-button");
    expect(getComputedStyle(controls).backgroundColor).toBe("rgb(16, 42, 67)");
    const toggle = within(web).getByRole("button", { name: "Show details" });
    toggle.focus();
    await userEvent.keyboard("{Enter}");
    const panel = element(custom.host, '[data-radius-part="details"]');
    expect(getComputedStyle(panel).backgroundColor).toBe("rgb(16, 42, 67)");
    expect(getComputedStyle(panel).borderRadius).toBe("0px");
    expect(getComputedStyle(panel).position).toBe("absolute");
    expect(panel.style.background).toBe("");
    expect(Number.isFinite(parseFloat(panel.style.left))).toBe(true);
    const source = within(panel).getByRole("link", {
      name: "View source code"
    });
    expect(getComputedStyle(source).color).toBe("rgb(179, 236, 255)");
    await userEvent.click(source);
    expect(onOpenSource).toHaveBeenCalledExactlyOnceWith({
      path: "web.bicep",
      line: 4,
      fallbackUrl: ""
    });
    await userEvent.keyboard("{Escape}");
    expect(panel.style.display).toBe("none");
    expect(document.activeElement).toBe(toggle);
    expect(getComputedStyle(toggle).outlineWidth).toBe("3px");
  });

  it("changes appearance and CSS without replacing nodes, focus, details or viewport", async () => {
    const css = stylesheet(hostCss);
    const mounted = mount();
    const web = await within(mounted.host).findByRole("group", { name: "web" });
    const toggle = within(web).getByRole("button", { name: "Show details" });
    toggle.focus();
    await userEvent.keyboard("{Enter}");
    const panel = element(mounted.host, '[data-radius-part="details"]');
    const viewport = element(mounted.host, ".react-flow__viewport");
    const transform = viewport.style.transform;
    mounted.controller.update({
      ...mounted.input,
      appearance: "custom",
      className: "host-graph"
    });
    await waitFor(() => expect(getComputedStyle(web).borderRadius).toBe("2px"));
    expect(element(mounted.host, '[data-radius-part="details"]')).toBe(panel);
    expect(within(mounted.host).getByRole("group", { name: "web" })).toBe(web);
    expect(panel.style.display).not.toBe("none");
    expect(viewport.style.transform).toBe(transform);
    const label = element(mounted.host, '[data-radius-part="node-type"]');
    expect(label.style.fontSize).toBe("");
    css.textContent +=
      '.host-graph [data-radius-part="node"] { border-radius: 6px; }';
    expect(getComputedStyle(web).borderRadius).toBe("6px");
    mounted.controller.update(mounted.input);
    await waitFor(() =>
      expect(getComputedStyle(web).borderRadius).toBe("16px")
    );
    expect(label.style.fontSize).toBe("13px");
    expect(panel.style.display).not.toBe("none");
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(toggle);
  });

  it("lets custom hosts fill a short container and style empty and semantic states", async () => {
    stylesheet(
      hostCss +
        `
      .host-graph [data-radius-part="empty"] { color: #73510d; }
      .host-graph [data-radius-part="error"] { color: #9c1616; }
      .host-graph [data-radius-part="node"][data-radius-deploy="failed"] { border-style: double; }
    `
    );
    const mounted = mount({
      appearance: "custom",
      className: "host-graph",
      graph: { kind: "modeled", resources: [] }
    });
    mounted.host.style.height = "280px";
    const empty = await within(mounted.host).findByRole("status");
    expect(getComputedStyle(empty).color).toBe("rgb(115, 81, 13)");
    expect(
      within(mounted.host).getByRole("region").getBoundingClientRect().height
    ).toBe(280);
    mounted.controller.update({
      ...mounted.input,
      graph: {
        kind: "deployed-projection",
        resources: [
          {
            id: "failed",
            name: "failed",
            deployStatus: "failed",
            deployMessage: "Quota exceeded"
          }
        ]
      }
    });
    const failed = await within(mounted.host).findByRole("group", {
      name: "failed"
    });
    expect(getComputedStyle(failed).borderStyle).toBe("double");
    await userEvent.click(
      within(failed).getByRole("button", { name: "Show details" })
    );
    expect(
      getComputedStyle(
        element(mounted.host, '[data-radius-part="details-message"]')
      ).color
    ).toBe("rgb(255, 204, 204)");
    mounted.controller.unmount();
    expect(mounted.host.childElementCount).toBe(0);
  });

  it("styles diagnostics and error recovery through the same host selectors", async () => {
    stylesheet(`
      .host-graph [data-radius-part="warning"] { color: #73510d; }
      .host-graph [data-radius-part="error"] { color: #9c1616; }
      .host-graph [data-radius-part="retry"] { border-radius: 0; }
    `);
    const context = {
      connectionId: "host-styles",
      plane: { type: "radius", name: "local" },
      applicationId:
        "/planes/radius/local/resourceGroups/demo/providers/Radius.Core/applications/example"
    };
    const mounted = mount({
      appearance: "custom",
      className: "host-graph",
      graph: {
        kind: "live",
        context,
        resources: [],
        warnings: [
          {
            code: "unresolved-connection",
            severity: "warning",
            resourceId: context.applicationId,
            message: "Some connections were omitted."
          },
          {
            code: "duplicate-resource",
            severity: "info",
            resourceId: context.applicationId,
            message: "A duplicate was ignored."
          }
        ]
      }
    });
    const warning = await within(mounted.host).findByText(
      "Some connections were omitted. A duplicate was ignored."
    );
    expect(getComputedStyle(warning).color).toBe("rgb(115, 81, 13)");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      mounted.controller.update({
        ...mounted.input,
        graph: {
          kind: "live",
          context: { ...context, applicationId: "invalid" },
          resources: [],
          warnings: []
        },
        callbacks: {
          onRetry: () => {
            mounted.controller.update(mounted.input);
          }
        }
      });
      const failure = await within(mounted.host).findByRole("alert");
      expect(getComputedStyle(failure).color).toBe("rgb(156, 22, 22)");
      const retry = within(failure).getByRole("button", {
        name: "Reload graph"
      });
      expect(retry.dataset.radiusPart).toBe("retry");
      await userEvent.click(retry);
      await within(mounted.host).findByText(
        "Some connections were omitted. A duplicate was ignored."
      );
      expect(within(mounted.host).queryByRole("alert")).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("allows typed tokens to customize the default skin without clearing CSS inputs", async () => {
    const mounted = mount({
      style: {
        "--radius-graph-accent": "#067a6f",
        "--radius-graph-node-radius": "4px",
        "--radius-graph-details-radius": "2px",
        "--radius-graph-edge-color": "#067a6f"
      }
    });
    const web = await within(mounted.host).findByRole("group", { name: "web" });
    expect(getComputedStyle(web).borderRadius).toBe("4px");
    const section = within(mounted.host).getByRole("region");
    expect(section.style.getPropertyValue("--radius-graph-accent")).toBe(
      "#067a6f"
    );
    mounted.controller.update({
      ...mounted.input,
      theme: { accent: "#8a3000" }
    });
    await waitFor(() =>
      expect(section.style.getPropertyValue("--radius-graph-accent")).toBe(
        "#8a3000"
      )
    );
    mounted.controller.update(mounted.input);
    await waitFor(() =>
      expect(section.style.getPropertyValue("--radius-graph-accent")).toBe(
        "#067a6f"
      )
    );
  });
});
