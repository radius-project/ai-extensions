// BU-06: the node details panel.
//
// The panel's rows are pure functions of a node's data, and the panel itself
// owns exactly one delegated listener per container. Both are covered here:
// which links a local versus a remote graph offers, how a failed deploy leads
// with its reason, that names from a provider are escaped, and that opening,
// toggling, closing and destroying leave the page in a known state.

import { describe, it, expect } from "vitest";
import {
  azurePortalUrl,
  buildDetailRows,
  createDetailsPanel,
  ICON_DEF,
  ICON_LINK,
  ICON_SRC,
  linkRow,
  localLinkRow,
  PANEL_ID,
  panelPosition,
  rectOf,
  safeExternalUrl
} from "./details.js";
import { resolveGraphSettings } from "./build.js";
import {
  createFakeBrowser,
  createFakeElement
} from "../../../test/support/browser/fakes.js";
import type { GraphNodeData, GraphOptions } from "./build.js";
import type { DomElement } from "../ports.js";

function node(overrides: Partial<GraphNodeData> = {}): GraphNodeData {
  return {
    id: "app/web",
    borderColor: "var(--rad-node-border)",
    borderWidth: 2.5,
    bgColor: "var(--rad-node-bg)",
    icon: "",
    nodeName: "web",
    typeLabel: "Compute/containers",
    codeRef: "src/web.ts#L4",
    sourceUrl: "https://github.test/o/r/blob/main/src/web.ts#L4",
    sourceBranch: "main",
    srcPath: "src/web.ts",
    srcLine: 4,
    defFile: ".radius/app.bicep",
    defLine: 12,
    resourceType: "Radius.Compute/containers",
    diffStatus: "",
    deployStatus: "",
    portalUrl: "",
    cloudResources: "[]",
    ...overrides
  };
}

function settings(options: GraphOptions = {}) {
  return resolveGraphSettings({
    repoUrl: "https://github.test/o/r",
    ...options
  });
}

describe("detail rows", () => {
  it("uses inert safe links for invalid direct and local destinations", () => {
    expect(
      linkRow(ICON_LINK, "<label>", "javascript:alert(1)", true)
    ).toContain('<a href="#"');
    expect(
      linkRow(ICON_LINK, "<label>", "javascript:alert(1)", true)
    ).not.toContain("data-external-url");
    expect(
      linkRow(ICON_LINK, "label", "https://example.test", false)
    ).not.toContain("word-break:break-all");
    const local = localLinkRow(ICON_SRC, "<source>", "src/a.ts", 0, "bad");
    expect(local).toContain('href="#"');
    expect(local).toContain('data-local-line="0"');
    expect(local).toContain("&lt;source&gt;");
  });

  it("offers native links for a remote graph", () => {
    const rows = buildDetailRows(settings(), node());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(ICON_SRC);
    expect(rows[0]).toContain(
      'href="https://github.test/o/r/blob/main/src/web.ts#L4"'
    );
    expect(rows[0]).toContain(
      'data-external-url="https://github.test/o/r/blob/main/src/web.ts#L4"'
    );
    expect(rows[0]).toContain('target="_blank" rel="noopener noreferrer"');
    expect(rows[0]).toContain("View source code");
    expect(rows[1]).toContain(ICON_DEF);
    expect(rows[1]).toContain(
      'href="https://github.test/o/r/blob/main/.radius/app.bicep#L12"'
    );
  });

  it("routes both rows to the editor canvas for a local-workspace graph", () => {
    const rows = buildDetailRows(settings({ localSource: true }), node());
    expect(rows[0]).toContain('data-local-src="src/web.ts"');
    expect(rows[0]).toContain('data-local-line="4"');
    expect(rows[0]).toContain(
      'data-fallback-url="https://github.test/o/r/blob/main/src/web.ts#L4"'
    );
    expect(rows[0]).not.toContain('target="_blank"');
    expect(rows[1]).toContain('data-local-src=".radius/app.bicep"');
    expect(rows[1]).toContain('data-local-line="12"');
  });

  it("keeps an exact GitHub source URL external for a local-workspace graph", () => {
    const sourceUrl =
      "https://github.com/acme/widgets/blob/release/src/web.ts#L4";
    const rows = buildDetailRows(
      settings({ localSource: true }),
      node({ codeRef: sourceUrl, sourceUrl, srcPath: "", srcLine: 0 })
    );
    expect(rows[0]).toContain(`href="${sourceUrl}"`);
    expect(rows[0]).toContain('target="_blank" rel="noopener noreferrer"');
    expect(rows[0]).not.toContain("data-local-src");
  });

  it("omits the source row for a local node with no code reference", () => {
    const rows = buildDetailRows(
      settings({ localSource: true }),
      node({ srcPath: "", srcLine: 0, sourceUrl: "" })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("View app definition");
  });

  it("omits the definition row for a local node without a definition", () => {
    const rows = buildDetailRows(
      settings({ localSource: true }),
      node({ defFile: "" })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("View source code");
  });

  it("keeps the definition row usable without a repository URL", () => {
    const rows = buildDetailRows(
      resolveGraphSettings({ localSource: true }),
      node({ sourceUrl: "" })
    );
    expect(rows[0]).toContain('data-fallback-url=""');
    expect(rows[0]).toContain('href="#"');
  });

  it("gates the remote definition row on a repository URL and a definition file", () => {
    expect(
      buildDetailRows(resolveGraphSettings(), node({ sourceUrl: "" }))
    ).toEqual([expect.stringContaining("No links available.")]);
    expect(
      buildDetailRows(settings(), node({ defFile: "" })).some((row) =>
        row.includes("View app definition")
      )
    ).toBe(false);
  });

  it("uses the page branch and an unlined definition when node overrides are absent", () => {
    const rows = buildDetailRows(
      settings(),
      node({ sourceBranch: undefined, defLine: 0 })
    );
    expect(rows[1]).toContain(
      "https://github.test/o/r/blob/main/.radius/app.bicep"
    );
    expect(rows[1]).not.toContain("#L");
  });

  it("leads with the producer's message and marks a failure", () => {
    const failed = buildDetailRows(
      settings(),
      node({ deployStatus: "failed", deployMessage: "quota exceeded" })
    );
    expect(failed[0]).toContain("quota exceeded");
    expect(failed[0]).toContain("var(--rad-danger,#cf222e)");

    const running = buildDetailRows(
      settings(),
      node({ deployStatus: "in_progress", deployMessage: "creating" })
    );
    expect(running[0]).toContain("var(--rad-text-secondary)");
  });

  it("escapes a message, a path and a cloud name that carry markup", () => {
    const rows = buildDetailRows(
      settings({ localSource: true }),
      node({
        srcPath: '<img src=x onerror="1">',
        deployMessage: "<script>alert(1)</script>",
        cloudResources: JSON.stringify([
          { name: "<b>db</b>", id: "/subscriptions/s/rg/db" }
        ])
      })
    );
    const joined = rows.join("");
    expect(joined).not.toContain("<script>alert(1)</script>");
    expect(joined).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(joined).toContain("&lt;img src=x onerror=&quot;1&quot;&gt;");
    expect(joined).toContain("&lt;b&gt;db&lt;/b&gt; in Azure portal");
  });

  it("adds a live portal link and every cloud resource", () => {
    const rows = buildDetailRows(
      settings(),
      node({
        portalUrl: "https://portal.test/live",
        cloudId: "/subscriptions/s/rg/one",
        cloudResources: JSON.stringify([
          {
            name: "two",
            id: "/subscriptions/s/rg/two",
            portalUrl: "https://portal.azure.com/#@tenant/resource/exact"
          },
          { type: "Microsoft.Sql/servers", id: "/subscriptions/s/rg/three" },
          { type: "/", id: "/subscriptions/s/rg/unnamed" },
          { id: "/subscriptions/s/rg/four" },
          "not-a-record"
        ])
      })
    );
    const joined = rows.join("");
    expect(joined).toContain(ICON_LINK);
    expect(joined).toContain('href="https://portal.test/live"');
    expect(joined).toContain(azurePortalUrl("/subscriptions/s/rg/one"));
    expect(joined).toContain("two in Azure portal");
    expect(joined).toContain(
      'href="https://portal.azure.com/#@tenant/resource/exact"'
    );
    expect(joined).toContain("servers in Azure portal");
    expect(joined).toContain("resource in Azure portal");
  });

  it("rejects non-HTTPS portal links and cloud entries without ARM ids", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBe("");
    expect(safeExternalUrl("not a url")).toBe("");
    expect(safeExternalUrl("https://portal.test/live")).toBe(
      "https://portal.test/live"
    );
    const rows = buildDetailRows(
      settings(),
      node({
        portalUrl: "javascript:alert(1)",
        cloudResources: JSON.stringify([
          { name: "bad", id: "relative" },
          {
            name: "unsafe",
            id: "/subscriptions/s/rg/unsafe",
            portalUrl: "javascript:alert(1)"
          }
        ])
      })
    );
    expect(rows.join("")).not.toContain("javascript:");
    expect(rows.join("")).not.toContain("bad in Azure portal");
    expect(rows.join("")).not.toContain("javascript:");
    expect(rows.join("")).toContain(
      azurePortalUrl("/subscriptions/s/rg/unsafe")
    );
    expect(
      buildDetailRows(
        settings(),
        node({ cloudResources: JSON.stringify([{ name: "missing" }]) })
      ).join("")
    ).not.toContain("missing in Azure portal");
  });

  it("keeps the other rows when the serialized cloud list is unusable", () => {
    expect(
      buildDetailRows(settings(), node({ cloudResources: "{" }))
    ).toHaveLength(2);
    expect(
      buildDetailRows(settings(), node({ cloudResources: '"text"' }))
    ).toHaveLength(2);
  });

  it("says so when a node has no links at all", () => {
    const rows = buildDetailRows(
      resolveGraphSettings(),
      node({ sourceUrl: "", defFile: "", cloudResources: "" })
    );
    expect(rows).toEqual([expect.stringContaining("No links available.")]);
  });
});

describe("panel position", () => {
  it("anchors to the right of the card, in container coordinates", () => {
    expect(
      panelPosition(
        { left: 100, right: 900, top: 50, width: 800 },
        { left: 200, right: 420, top: 150, width: 220 }
      )
    ).toEqual({ left: 328, top: 100 });
  });

  it("flips to the left when the panel would overflow the container", () => {
    expect(
      panelPosition(
        { left: 0, right: 400, top: 0, width: 400 },
        { left: 150, right: 370, top: 20, width: 220 }
      )
    ).toEqual({ left: 4, top: 20 });
  });

  it("never places the panel outside the container", () => {
    expect(
      panelPosition(
        { left: 500, right: 900, top: 300, width: 400 },
        { left: 100, right: 320, top: 100, width: 220 }
      )
    ).toEqual({ left: 0, top: 0 });
  });

  it("reads a rect only from something that can be measured", () => {
    expect(rectOf(null)).toBeNull();
    expect(rectOf("not-an-element")).toBeNull();
    expect(rectOf({})).toBeNull();
    for (const rect of [
      { left: "1", right: 2, top: 3, width: 4 },
      { left: 1, right: "2", top: 3, width: 4 },
      { left: 1, right: 2, top: "3", width: 4 },
      { left: 1, right: 2, top: 3, width: "4" }
    ]) {
      expect(rectOf({ getBoundingClientRect: () => rect })).toBeNull();
    }
    expect(rectOf({ getBoundingClientRect: () => "not-a-rect" })).toBeNull();
    expect(
      rectOf({
        getBoundingClientRect: () => ({
          left: 1,
          right: 2,
          top: 3,
          width: 4
        })
      })
    ).toEqual({ left: 1, right: 2, top: 3, width: 4 });
  });
});

interface PanelHarness {
  browser: ReturnType<typeof createFakeBrowser>;
  container: ReturnType<typeof createFakeElement>;
  external: string[];
  opened: Array<[string, number, string]>;
  panel: ReturnType<typeof createDetailsPanel>;
  panelElement: ReturnType<typeof createFakeElement>;
}

function setup(options: GraphOptions = {}): PanelHarness {
  const browser = createFakeBrowser();
  const container = createFakeElement("graph-container");
  const external: string[] = [];
  const opened: Array<[string, number, string]> = [];
  const panel = createDetailsPanel(
    browser.context,
    container,
    settings(options),
    {
      openExternal: (url) => {
        external.push(url);
      },
      openLocalSource: (path, line, fallback) => {
        opened.push([path, line, fallback]);
      }
    }
  );
  const panelElement = container.appended[0];
  return { browser, container, external, opened, panel, panelElement };
}

function measurable(element: DomElement, rect: Record<string, number>) {
  return Object.assign(element, { getBoundingClientRect: () => rect });
}

describe("details panel", () => {
  it("adds one hidden panel to the container and binds one listener", () => {
    const { container, panelElement } = setup();
    expect(container.appended).toHaveLength(1);
    expect(panelElement.id).toBe(PANEL_ID);
    expect(panelElement.style.display).toBe("none");
    expect(panelElement.getAttribute("style")).toContain("position:absolute");
    expect(container.listenerCount("click")).toBe(1);
  });

  it("opens beside the card it was given and remembers where focus was", () => {
    const harness = setup();
    measurable(harness.container, {
      left: 0,
      right: 800,
      top: 0,
      width: 800
    });
    const card = measurable(createFakeElement("card"), {
      left: 100,
      right: 320,
      top: 40,
      width: 220
    });
    const previouslyFocused = createFakeElement("dots");
    harness.browser.document.activeElement = previouslyFocused;

    harness.panel.open(node(), card);

    expect(harness.panel.isOpen).toBe(true);
    expect(harness.panelElement.style.left).toBe("328px");
    expect(harness.panelElement.style.top).toBe("40px");
    expect(harness.panelElement.innerHTML).toContain("View source code");

    harness.panel.close();
    expect(harness.panel.isOpen).toBe(false);
    expect(previouslyFocused.focusCount).toBe(1);
  });

  it("positions at the container origin when nothing can be measured", () => {
    const harness = setup();
    harness.panel.open(node(), createFakeElement("card"));
    expect(harness.panelElement.style.left).toBe("0px");
    expect(harness.panelElement.style.top).toBe("0px");
  });

  it("positions at the origin when only the container can be measured", () => {
    const harness = setup();
    measurable(harness.container, {
      left: 0,
      right: 800,
      top: 0,
      width: 800
    });
    harness.panel.open(node(), createFakeElement("card"));
    expect(harness.panelElement.style.left).toBe("0px");
  });

  it("toggles closed for the same card and re-anchors for another", () => {
    const harness = setup();
    const first = createFakeElement("card-1");
    const second = createFakeElement("card-2");

    harness.panel.toggle(node(), first);
    expect(harness.panel.isOpen).toBe(true);
    harness.panel.toggle(node(), first);
    expect(harness.panel.isOpen).toBe(false);

    harness.panel.toggle(node(), first);
    harness.panel.toggle(node({ nodeName: "api" }), second);
    expect(harness.panel.isOpen).toBe(true);
    expect(harness.panelElement.innerHTML).toContain("View source code");
  });

  it("keeps the original focus target across a re-anchor", () => {
    const harness = setup();
    const focused = createFakeElement("dots");
    harness.browser.document.activeElement = focused;
    harness.panel.open(node(), createFakeElement("card-1"));
    harness.browser.document.activeElement = createFakeElement("other");
    harness.panel.open(node(), createFakeElement("card-2"));
    harness.panel.close();
    expect(focused.focusCount).toBe(1);
  });

  it("closes when the empty pane is clicked and stays open inside itself", () => {
    const harness = setup();
    harness.panel.open(node(), createFakeElement("card"));

    const insidePanel = createFakeElement("link");
    insidePanel.ancestors.set("#" + PANEL_ID, harness.panelElement);
    harness.container.dispatch("click", { target: insidePanel });
    expect(harness.panel.isOpen).toBe(true);

    const insideCard = createFakeElement("title");
    insideCard.ancestors.set(
      ".rad-node[data-node-id]",
      createFakeElement("card")
    );
    harness.container.dispatch("click", { target: insideCard });
    expect(harness.panel.isOpen).toBe(true);

    harness.container.dispatch("click", { target: createFakeElement("pane") });
    expect(harness.panel.isOpen).toBe(false);
  });

  it("delegates a local row click to the editor canvas open", () => {
    const harness = setup({ localSource: true });
    const row = createFakeElement("row");
    row.setAttribute("data-local-src", "src/web.ts");
    row.setAttribute("data-local-line", "4");
    row.setAttribute("data-fallback-url", "https://github.test/o/r/blob/x");
    row.ancestors.set("[data-local-src]", row);
    let prevented = 0;

    harness.container.dispatch("click", {
      target: row,
      preventDefault: () => {
        prevented += 1;
      }
    });

    expect(prevented).toBe(1);
    expect(harness.opened).toEqual([
      ["src/web.ts", 4, "https://github.test/o/r/blob/x"]
    ]);
  });

  it("delegates an external row click to the Canvas host", () => {
    const harness = setup({ localSource: true });
    const row = createFakeElement("row");
    const url = "https://github.com/acme/widgets/blob/release/src/web.ts#L4";
    row.setAttribute("data-external-url", url);
    row.ancestors.set("[data-external-url]", row);
    let prevented = 0;

    harness.container.dispatch("click", {
      target: row,
      preventDefault: () => {
        prevented += 1;
      }
    });

    expect(prevented).toBe(1);
    expect(harness.external).toEqual([url]);
    expect(harness.opened).toEqual([]);
  });

  it("rejects an unsafe delegated external URL", () => {
    const harness = setup();
    const row = createFakeElement("row");
    row.setAttribute("data-external-url", "javascript:alert(1)");
    row.ancestors.set("[data-external-url]", row);

    harness.container.dispatch("click", { target: row });

    expect(harness.external).toEqual([]);
  });

  it("treats a row with unreadable attributes as an open with no line", () => {
    const harness = setup({ localSource: true });
    const row = createFakeElement("row");
    row.ancestors.set("[data-local-src]", row);
    harness.container.dispatch("click", { target: row });
    expect(harness.opened).toEqual([["", 0, ""]]);
  });

  it("ignores a click whose target cannot be walked", () => {
    const harness = setup();
    harness.panel.open(node(), createFakeElement("card"));
    harness.container.dispatch("click", { target: { nodeName: "svg" } });
    harness.container.dispatch("click", { target: "text" });
    expect(harness.panel.isOpen).toBe(true);
    harness.container.dispatch("click", {
      target: { closest: () => undefined }
    });
    expect(harness.panel.isOpen).toBe(false);
  });

  it("ignores an open call with no data", () => {
    const harness = setup();
    harness.panel.open(undefined as never, createFakeElement("card"));
    expect(harness.panel.isOpen).toBe(false);
  });

  it("removes its listener and its element when destroyed", () => {
    const harness = setup();
    harness.panel.open(node(), createFakeElement("card"));
    harness.panel.destroy();
    expect(harness.container.listenerCount("click")).toBe(0);
    expect(harness.panelElement.removed).toBe(true);
  });
});
