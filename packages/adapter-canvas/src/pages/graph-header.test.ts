import { describe, it, expect } from "vitest";
import { graphHeader, graphHeaderClose } from "./graph-header.js";

describe("graphHeader / graphHeaderClose", () => {
  it("renders the nav header and matching close markup", () => {
    expect(graphHeader("graph")).toContain("<");
    expect(graphHeaderClose()).toContain("<");
  });

  it("links each mode named in the lede to its own sub-tab", () => {
    const html = graphHeader("graph");
    const expected: Array<[string, string]> = [
      ["Modeled", "graph"],
      ["Planned", "planned"],
      ["Deployed", "deployed"],
      ["Diff", "graph-diff"]
    ];
    for (const [label, page] of expected) {
      expect(html).toContain(
        `<a href="?page=${page}" data-radius-graph-page="${page}" class="rad-lede-link"><strong>${label}</strong></a>`
      );
    }
  });

  it("keeps the lede links pointing at the same routes as the nav", () => {
    const html = graphHeader("planned");
    // Every route referenced by a lede link must also exist as a nav sub-tab.
    const ledeRoutes = [
      ...html.matchAll(
        /data-radius-graph-page="([^"]+)" class="rad-lede-link"/g
      )
    ];
    expect(ledeRoutes).toHaveLength(4);
    for (const [, route] of ledeRoutes) {
      expect(html).toContain(`data-page="${route}"`);
    }
  });
});

describe("graphHeader page selection", () => {
  it.each(["graph", "planned", "deployed", "graph-diff"])(
    "marks %s as the active sub-tab and leaves the others inactive",
    (page) => {
      const html = graphHeader(page);
      const active = [
        ...html.matchAll(
          /<a href="\?page=([a-z-]+)" data-page="[a-z-]+" data-radius-graph-page="[a-z-]+" class="rad-subtab rad-subtab--active"/g
        )
      ].map((match) => match[1]);
      expect(active).toEqual([page]);
    }
  );

  it("offers exactly the four graph page values", () => {
    const pages = [
      ...graphHeader("graph").matchAll(/data-page="([a-z-]+)"/g)
    ].map((match) => match[1]);
    expect(pages).toEqual(["graph", "planned", "deployed", "graph-diff"]);
  });

  it("activates nothing for an unrecognised page rather than guessing", () => {
    const html = graphHeader("nope");
    expect(html).not.toContain("rad-subtab--active");
    expect(html).toContain('data-page="graph"');
  });

  it("contains no inline event handlers", () => {
    expect(graphHeader("graph")).not.toMatch(/\son[a-z]+=/);
  });

  it("opens the graph content wrapper that graphHeaderClose closes", () => {
    expect(graphHeader("graph")).toContain('<div id="graph-page-content">');
    expect(graphHeaderClose()).toBe("</div>");
  });

  it("keeps the heading and its brand mark above the sub-tabs", () => {
    const html = graphHeader("graph");
    expect(html).toContain("<span>Application Graph</span>");
    expect(html.indexOf('<div class="rad-heading">')).toBeLessThan(
      html.indexOf('<nav id="graph-nav"')
    );
  });
});
