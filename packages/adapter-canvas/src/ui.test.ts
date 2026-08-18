import { describe, expect, it } from "vitest";
import { subTabs } from "./ui.js";

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
