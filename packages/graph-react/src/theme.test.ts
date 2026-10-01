import { describe, expect, it } from "vitest";
import { graphStyle, styledEdges } from "./theme.js";

describe("host graph styles", () => {
  it("leaves stylesheet inputs alone when no theme overrides are supplied", () => {
    expect(graphStyle()).toEqual({});
    const input = {
      height: 300,
      colorScheme: "dark",
      "--radius-graph-accent": "var(--host-link)"
    };
    expect(graphStyle(input, { accent: undefined })).toEqual(input);
    expect(graphStyle(input)).not.toBe(input);
  });

  it("applies only explicit theme values without mutating the host style", () => {
    const input = {
      "--radius-graph-text": "blue",
      "--radius-graph-node-radius": "0px"
    };
    expect(
      graphStyle(input, {
        text: "white",
        background: "black",
        mutedText: "silver",
        accent: "cyan",
        fontFamily: "serif",
        colorScheme: "dark"
      })
    ).toEqual({
      "--radius-graph-text": "white",
      "--radius-graph-background": "black",
      "--radius-graph-muted": "silver",
      "--radius-graph-accent": "cyan",
      "--radius-graph-font": "serif",
      "--radius-graph-node-radius": "0px",
      colorScheme: "dark"
    });
    expect(input["--radius-graph-text"]).toBe("blue");
    expect(graphStyle(undefined, { accent: "" })).toEqual({
      "--radius-graph-accent": ""
    });
  });

  it("preserves edge geometry and semantic paint as overridable CSS inputs", () => {
    const edge = {
      id: "a-b",
      source: "a",
      target: "b",
      type: "default",
      style: { stroke: "var(--rad-diff-added)", strokeWidth: 2.5 }
    };
    expect(styledEdges([])).toEqual([]);
    expect(
      styledEdges([
        edge,
        { ...edge, style: { ...edge.style, strokeDasharray: "4 4" } }
      ])
    ).toEqual([
      {
        ...edge,
        className: "radius-graph__edge",
        style: {
          "--rad-edge-default-stroke": "var(--rad-diff-added)",
          "--rad-edge-default-width": "2.5",
          "--rad-edge-default-dash": "none"
        }
      },
      {
        ...edge,
        className: "radius-graph__edge",
        style: {
          "--rad-edge-default-stroke": "var(--rad-diff-added)",
          "--rad-edge-default-width": "2.5",
          "--rad-edge-default-dash": "4 4"
        }
      }
    ]);
    expect(edge.style).toEqual({
      stroke: "var(--rad-diff-added)",
      strokeWidth: 2.5
    });
  });
});
