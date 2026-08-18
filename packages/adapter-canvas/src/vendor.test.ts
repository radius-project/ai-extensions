import { describe, expect, it } from "vitest";
import {
  ensureVendorScripts,
  getInlineVendorScripts,
  getInlineVendorStyles
} from "./vendor.js";
import { readVendorAssets } from "./vendor-assets.js";

describe("fixed Radius Canvas vendor assets", () => {
  it("reads the exact installed graph library files", () => {
    const assets = readVendorAssets();
    expect(assets.react).toContain("React");
    expect(assets.reactDom).toContain("ReactDOM");
    expect(assets.reactFlow).toContain("ReactFlow");
    expect(assets.dagre).toContain("dagre");
    expect(assets.reactFlowCss).toContain(".react-flow");
  });

  it("embeds scripts in the required global initialization order", async () => {
    await ensureVendorScripts();
    const html = getInlineVendorScripts();
    const react = html.indexOf("React");
    const reactDom = html.indexOf("ReactDOM");
    const reactFlow = html.indexOf("ReactFlow");
    const dagre = html.indexOf("dagre");
    expect(react).toBeGreaterThanOrEqual(0);
    expect(reactDom).toBeGreaterThan(react);
    expect(reactFlow).toBeGreaterThan(reactDom);
    expect(dagre).toBeGreaterThan(reactFlow);
    expect(html).not.toContain("unpkg.com");
  });

  it("embeds React Flow CSS before the page's own styles and escapes closing tags", () => {
    const styles = getInlineVendorStyles();
    expect(styles.startsWith("<style>")).toBe(true);
    expect(styles).toContain(".react-flow");
    expect(styles).not.toMatch(/<\/style>[\s\S]*<\/style>/i);
  });
});
