import { describe, expect, it } from "vitest";
import { fitTypeLabel } from "./node.js";
import { ResourceNode } from "./node.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildGraph, resolveGraphSettings } from "./build.js";

describe("type label fitting", () => {
  it("rejects rendering an internal resource card without its graph context", () => {
    const node = buildGraph(resolveGraphSettings(), [{ id: "orphan" }])
      .nodes[0];
    expect(() =>
      renderToStaticMarkup(
        createElement(ResourceNode, {
          id: node.id,
          type: node.type,
          data: node.data,
          selected: false,
          dragging: false,
          isConnectable: false,
          positionAbsoluteX: 0,
          positionAbsoluteY: 0,
          zIndex: 0,
          draggable: false,
          selectable: false,
          deletable: false
        })
      )
    ).toThrow("inside RadiusGraph");
  });
  it("shrinks only until text fits the existing card", () => {
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
  it("keeps a readable floor for exceptionally long labels", () => {
    const element = {
      clientWidth: 1,
      scrollWidth: 500,
      style: { fontSize: "" }
    };
    expect(fitTypeLabel(element)).toBe(7);
    expect(element.style.fontSize).toBe("7px");
  });
  it("does not enlarge short labels beyond the incumbent size", () => {
    expect(
      fitTypeLabel({
        clientWidth: 500,
        scrollWidth: 10,
        style: { fontSize: "" }
      })
    ).toBe(13);
  });
});
