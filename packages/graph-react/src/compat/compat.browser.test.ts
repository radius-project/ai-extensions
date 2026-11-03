import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { ReactFlowProvider } from "reactflow";
import { afterEach, describe, expect, it } from "vitest";
import { waitFor, within } from "@testing-library/dom";
import { AppGraph } from "./index.js";
import { ResourceNode } from "./reactflow11.js";
import type { AppGraphData } from "./index.js";
import "../styles.css";

const prefix = "/planes/radius/local/resourceGroups/demo/providers/";
const web = {
  id: prefix + "Applications.Core/containers/web",
  name: "web",
  type: "Applications.Core/containers",
  provider: "Applications.Core",
  provisioningState: "CustomPending"
};
const dependency = {
  ...web,
  id: prefix + "Applications.Core/gateways/edge",
  name: "edge",
  type: "Applications.Core/gateways"
};
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
});
function mount() {
  const element = document.createElement("div");
  element.style.width = "800px";
  element.style.height = "600px";
  document.body.appendChild(element);
  const root = createRoot(element);
  disposers.push(() => {
    root.unmount();
    element.remove();
  });
  return { element, root };
}
const graph: AppGraphData = {
  name: "not-an-application-id",
  resources: [
    {
      ...web,
      connections: [
        { ...dependency, type: "Contoso.Net/widgets", direction: "Inbound" }
      ]
    },
    dependency
  ]
};

describe("public legacy compatibility components", () => {
  it.each([false, true])(
    "keeps actual %s connected graph positions stable across reversed input and fresh roots",
    async (connected) => {
      const first = mount();
      const second = mount();
      const left = {
        ...web,
        id: prefix + "Applications.Core/containers/core-app",
        name: "core-app"
      };
      const right = {
        ...web,
        id: prefix + "Radius.Core/containers/radius-app",
        name: "radius-app",
        type: "Radius.Core/containers"
      };
      const third = {
        ...web,
        id: prefix + "Radius.Compute/containers/third",
        name: "third"
      };
      const resources: AppGraphData["resources"] = [
        {
          ...left,
          connections:
            connected ?
              [
                { ...right, direction: "Inbound" as const },
                { ...third, direction: "Inbound" as const }
              ]
            : []
        },
        right,
        third
      ];
      first.root.render(h(AppGraph, { graph: { name: "first", resources } }));
      second.root.render(
        h(AppGraph, {
          graph: {
            name: "reversed",
            resources: [...resources].reverse().map((resource) => ({
              ...resource,
              connections:
                resource.connections ? [...resource.connections].reverse() : []
            }))
          }
        })
      );
      const positions = (element: HTMLElement) =>
        Object.fromEntries(
          Array.from(
            element.querySelectorAll<HTMLElement>(".react-flow__node")
          ).map((node) => [node.getAttribute("data-id"), node.style.transform])
        );
      await waitFor(() => {
        for (const { element } of [first, second]) {
          expect(element.querySelectorAll(".react-flow__node")).toHaveLength(3);
          expect(element.querySelectorAll(".react-flow__edge")).toHaveLength(
            connected ? 2 : 0
          );
          for (const node of element.querySelectorAll(".react-flow__node")) {
            expect(node.getBoundingClientRect().width).toBeGreaterThan(0);
            expect(node.getBoundingClientRect().height).toBeGreaterThan(0);
          }
        }
        expect(positions(first.element)).toEqual(positions(second.element));
      });
    }
  );
  it("renders a data-only ResourceNode in a real Flow11 provider without Flow12 context", async () => {
    const { element, root } = mount();
    root.render(h(ReactFlowProvider, null, h(ResourceNode, { data: web })));
    await within(element).findByRole("heading", { name: "web", level: 3 });
    expect(
      within(element).getByRole("heading", { name: web.type, level: 6 })
    ).toBeTruthy();
    expect(
      element.querySelector(".react-flow__handle.target[data-handlepos=top]")
    ).not.toBeNull();
    expect(
      element.querySelector(".react-flow__handle.source[data-handlepos=bottom]")
    ).not.toBeNull();
    expect(element.querySelector(".rad-node__icon")).toBeNull();
    expect(element.querySelector(".rad-node__badge")).toBeNull();
    expect(
      within(element).queryByRole("button", { name: "Show details" })
    ).toBeNull();
    expect(within(element).queryByText("CustomPending")).toBeNull();
    const card = element.querySelector("[data-node-id]");
    expect(card?.getAttribute("data-radius-resource-type")).toBe(web.type);
    expect(card?.getAttribute("data-radius-provisioning")).toBe(
      "CustomPending"
    );
    expect(card?.hasAttribute("data-radius-icon")).toBe(false);
    expect(card?.hasAttribute("data-radius-badge")).toBe(false);
    card?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(element.querySelector("[data-radius-details]")).toBeNull();
    root.render(
      h(
        ReactFlowProvider,
        null,
        h(ResourceNode, { data: { ...web, name: "updated" } })
      )
    );
    await within(element).findByRole("heading", { name: "updated", level: 3 });
    root.render(
      h(
        ReactFlowProvider,
        null,
        h(ResourceNode, { data: { ...web, type: "" } })
      )
    );
    await waitFor(() => {
      expect(element.querySelector("h6")?.textContent).toBe("");
      expect(element.querySelector("[data-radius-icon]")).toBeNull();
    });
  });
  it("uses the same card and real Flow12 layout for context-free AppGraph without invented identity", async () => {
    const { element, root } = mount();
    element.style.height = "240px";
    root.render(h(AppGraph, { graph }));
    await within(element).findByRole("heading", { name: "web", level: 3 });
    await waitFor(() =>
      expect(element.querySelectorAll(".react-flow__edge")).toHaveLength(1)
    );
    const graphElement = element.querySelector<HTMLElement>(".radius-graph");
    if (!graphElement) throw new Error("Expected the rendered graph root.");
    expect(getComputedStyle(graphElement).minHeight).toBe("0px");
    expect(graphElement.getBoundingClientRect().height).toBe(240);
    expect(graphElement.getBoundingClientRect().width).toBe(800);
    const edge = element.querySelector(".react-flow__edge");
    expect(edge?.getAttribute("data-id")).toBe(
      JSON.stringify([dependency.id, web.id])
    );
    expect(
      element
        .querySelector("[data-radius-kind]")
        ?.getAttribute("data-radius-kind")
    ).toBe("legacy-live");
    expect(
      element.querySelector("[data-node-id]")?.getAttribute("data-node-id")
    ).toBe(web.id);
    expect(
      element.querySelectorAll(
        ".rad-node__icon,.rad-node__badge,.rad-node__status,[data-radius-details]"
      )
    ).toHaveLength(0);
    expect(element.querySelector("[data-radius-part=legend]")).toBeNull();
    expect(
      within(element).getByRole("button", { name: "Zoom In" })
    ).toBeTruthy();
    expect(
      within(element).getByRole("button", { name: "Zoom Out" })
    ).toBeTruthy();
    expect(
      within(element).getByRole("button", { name: "Fit View" })
    ).toBeTruthy();
    expect(
      element.querySelector(".react-flow__controls-interactive")
    ).toBeNull();
    const before = Array.from(
      element.querySelectorAll(".react-flow__node")
    ).map((node) => [node.getAttribute("data-id"), node.getAttribute("style")]);
    root.render(
      h(AppGraph, {
        graph: {
          name: "other",
          resources: [
            {
              ...web,
              id: prefix + "Other/widgets/other",
              name: "other",
              type: "Other/widgets"
            }
          ]
        }
      })
    );
    await within(element).findByRole("heading", { name: "other", level: 3 });
    root.render(h(AppGraph, { graph }));
    await within(element).findByRole("heading", { name: "web", level: 3 });
    await waitFor(() =>
      expect(element.querySelectorAll(".react-flow__edge")).toHaveLength(1)
    );
    expect(
      Array.from(element.querySelectorAll(".react-flow__node")).map((node) => [
        node.getAttribute("data-id"),
        node.getAttribute("style")
      ])
    ).toEqual(before);
  });
  it("surfaces correction warnings and an explicit empty state rather than a blank canvas", async () => {
    const { element, root } = mount();
    root.render(
      h(AppGraph, {
        graph: {
          name: "",
          resources: [
            { ...web, connections: [{ ...web, direction: "Inbound" }] }
          ]
        }
      })
    );
    await within(element).findByRole("heading", { name: "web" });
    expect(within(element).getByRole("status").textContent).toContain(
      "self connection"
    );
    root.render(h(AppGraph, { graph: { name: "", resources: [] } }));
    await within(element).findByText("No resources in this application.");
  });
});
