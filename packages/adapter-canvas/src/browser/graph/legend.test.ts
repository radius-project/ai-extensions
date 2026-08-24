// BU-05: the graph legend.
//
// The deployed view explains deploy status; every other view lists the resource
// categories actually present, in first-seen order, with the icon the type or
// recipe pack owns.

import { describe, it, expect } from "vitest";
import {
  buildCategoryLegendHtml,
  buildStatusLegendHtml,
  collectLegendCategories,
  STATUS_LEGEND_ITEMS
} from "./legend.js";

describe("status legend", () => {
  it("explains the three deploy states with the shipped badge glyphs", () => {
    expect(STATUS_LEGEND_ITEMS.map((item) => item.label)).toEqual([
      "Pending / deploying",
      "Deployed",
      "Failed"
    ]);
    const html = buildStatusLegendHtml([
      { name: "pending", deployStatus: "pending" },
      { name: "deployed", deployStatus: "success" },
      { name: "failed", deployStatus: "failed" }
    ]);
    expect(html.split('class="legend-item"').length - 1).toBe(3);
    expect(html).toContain("Pending / deploying");
    expect(html.split("data:image/svg+xml,").length - 1).toBe(3);
    expect(html).toContain('width="14" height="14"');
    expect(decodeURIComponent(html)).toContain(
      "animation:spin 1s linear infinite"
    );
  });

  it("shows only statuses present in the deployed graph", () => {
    const terminal = buildStatusLegendHtml([
      { name: "api", deployStatus: "success" },
      { name: "db", deployStatus: "failed" }
    ]);
    expect(terminal).toContain("Deployed");
    expect(terminal).toContain("Failed");
    expect(terminal).not.toContain("Pending / deploying");
    expect(decodeURIComponent(terminal)).not.toContain("animation:spin");

    const live = buildStatusLegendHtml([
      { name: "api", deployStatus: "in_progress" }
    ]);
    expect(live).toContain("Pending / deploying");
    expect(decodeURIComponent(live)).toContain("animation:spin");
  });
});

describe("category legend", () => {
  it("lists each category once, in first-seen order, including output types", () => {
    const categories = collectLegendCategories([
      { name: "web", type: "Radius.Compute/containers" },
      { name: "api", type: "Radius.Compute/containers" },
      {
        name: "db",
        type: "Radius.Data/mySqlDatabases",
        outputResources: [
          null,
          { name: "s", displayType: "Radius.Cache/redisCaches" }
        ]
      }
    ]);
    expect(categories.map((category) => category.name)).toEqual([
      "Compute",
      "Data Store",
      "Cache"
    ]);
  });

  it("files an unrecognized type under the catch-all category", () => {
    expect(collectLegendCategories([{ name: "x" }])).toEqual([
      { name: "Other", icon: "" }
    ]);
  });

  it("renders a spacer when a category has no icon", () => {
    const html = buildCategoryLegendHtml([
      { name: "Compute", icon: "data:image/svg+xml,icon" },
      { name: "Other", icon: "" }
    ]);
    expect(html).toContain('<img src="data:image/svg+xml,icon"');
    expect(html).toContain('<span style="display:inline-block;width:14px');
    expect(html.split('class="legend-item"').length - 1).toBe(2);
  });

  it("escapes a category name and icon so neither can become markup", () => {
    const html = buildCategoryLegendHtml([
      { name: "<b>x</b>", icon: 'data:"><img onerror=1' }
    ]);
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("&quot;&gt;&lt;img");
  });
});
