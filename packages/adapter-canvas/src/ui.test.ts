import { describe, expect, it } from "vitest";
import { radiusBrandMarkSvg } from "@radius-project/graph-react/brand";
import { radiusMark, subTabs } from "./ui.js";

describe("radiusMark", () => {
  it("draws the shared library brand mark at the requested size", () => {
    expect(radiusMark(26)).toBe(radiusBrandMarkSvg({ size: 26 }));
  });

  it("defaults to the shared 28px mark", () => {
    expect(radiusMark()).toBe(radiusBrandMarkSvg());
  });

  it("stays decorative beside the heading text it accompanies", () => {
    expect(radiusMark(26)).toContain('aria-hidden="true"');
  });
});

describe("subTabs", () => {
  it("emits delegated graph navigation without inline behavior", () => {
    const html = subTabs(
      [
        { id: "graph", label: "Modeled" },
        { id: "planned", label: "<Planned>" }
      ],
      "planned"
    );
    expect(html).toContain('data-radius-graph-page="graph"');
    expect(html).toContain(
      'data-radius-graph-page="planned" class="rad-subtab rad-subtab--active"'
    );
    expect(html).toContain("&lt;Planned&gt;");
    expect(html).not.toMatch(/\son[a-z]+=/);
  });
});
