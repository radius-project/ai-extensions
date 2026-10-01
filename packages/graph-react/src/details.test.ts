// BU-06: which rows the node details panel offers, and where it is anchored.
//
// The rows are a pure function of a node's data, so the whole link matrix is
// asserted here without a DOM: which links a local versus a remote graph
// offers, how a failed deploy leads with its reason, and what a node with
// nothing to link to says instead. Rows carry raw text; `details-panel.ts`
// renders them, and `graph.browser.test.ts` covers that rendering in Chromium.

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  anchorPosition,
  azurePortalUrl,
  buildDetailRows,
  closesDetails,
  focusReturnTarget,
  panelPosition,
  rectOf,
  safeExternalUrl
} from "./details.js";
import { resolveGraphSettings } from "./build.js";
import { DetailsOverlay } from "./details-panel.js";
import type { GraphNodeData, GraphOptions } from "./build.js";

function node(overrides: Partial<GraphNodeData> = {}): GraphNodeData {
  return {
    id: "app/web",
    borderColor: "var(--rad-node-border)",
    borderWidth: 2.5,
    bgColor: "var(--rad-node-bg)",
    icon: "",
    nodeName: "web",
    typeLabel: "Compute/containers",
    concreteType: "",
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
  it("shows the selected concrete type as secondary detail, rendered as text", () => {
    const rows = buildDetailRows(
      settings(),
      node({ concreteType: "Microsoft.Example/<unsafe>" })
    );
    expect(rows[0]).toEqual({
      kind: "concrete",
      type: "Microsoft.Example/<unsafe>"
    });
    const html = renderToStaticMarkup(
      createElement(DetailsOverlay, {
        id: "details",
        open: true,
        left: 0,
        top: 0,
        rows: [rows[0]!]
      })
    );
    expect(html).toContain("Concrete type");
    expect(html).toContain("Microsoft.Example/&lt;unsafe&gt;");
    expect(html).not.toContain("Microsoft.Example/<unsafe>");
  });

  it("omits concrete type details when no resolved type is available", () => {
    expect(buildDetailRows(settings(), node())[0]).toMatchObject({
      label: "View source code"
    });
  });

  it("leads a failure message before the concrete type", () => {
    const rows = buildDetailRows(
      settings(),
      node({
        concreteType: "Microsoft.Example/resources",
        deployStatus: "failed",
        deployMessage: "quota exceeded"
      })
    );
    expect(rows[0]).toEqual({
      kind: "message",
      text: "quota exceeded",
      failure: true
    });
    expect(rows[1]).toEqual({
      kind: "concrete",
      type: "Microsoft.Example/resources"
    });
  });
  it("renders inert and local labels as text and keeps an unlined local fallback", () => {
    const html = renderToStaticMarkup(
      createElement(DetailsOverlay, {
        id: "details",
        open: true,
        left: 0,
        top: 0,
        rows: [
          { kind: "inert", icon: "link", label: "<label>" },
          {
            kind: "local",
            icon: "source",
            label: "<source>",
            path: "src/a.ts",
            line: 0,
            fallbackUrl: ""
          }
        ]
      })
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("&lt;label&gt;");
    expect(html).toContain("&lt;source&gt;");
    expect(html.match(/href=/g)).toHaveLength(1);
    expect(html).toContain('href="#"');
    expect(html).toContain(">src/a.ts</div>");
    expect(html).not.toContain("src/a.ts:0");
  });

  it("summarizes a live node and keeps an optional raw status", () => {
    const live = settings({ liveMode: true });
    const data = node({
      nodeName: "<web>",
      resourceType: "<type>",
      provisioningState: "<pending>",
      defFile: "",
      sourceUrl: ""
    });
    // The row carries the provider's text verbatim. Escaping is the renderer's
    // job, so no caller can accidentally double-escape or unescape it.
    expect(buildDetailRows(live, data)).toEqual([
      { kind: "summary", name: "<web>", type: "<type>" },
      { kind: "status", state: "<pending>" }
    ]);
    expect(
      buildDetailRows(live, { ...data, provisioningState: undefined })
    ).toEqual([{ kind: "summary", name: "<web>", type: "<type>" }]);
  });

  it("marks an invalid destination inert instead of linking to it", () => {
    const rows = buildDetailRows(
      settings(),
      node({ sourceUrl: "javascript:alert(1)", defFile: "" })
    );
    expect(rows).toEqual([
      { kind: "inert", icon: "source", label: "View source code" }
    ]);
  });

  it("clears unsafe local fallbacks without discarding the file or line", () => {
    expect(
      buildDetailRows(
        settings({ localSource: true, repoUrl: "javascript:alert(1)" }),
        node({ sourceUrl: "javascript:alert(1)", srcLine: 0 })
      )
    ).toEqual([
      {
        kind: "local",
        icon: "source",
        label: "View source code",
        path: "src/web.ts",
        line: 0,
        fallbackUrl: ""
      },
      {
        kind: "local",
        icon: "definition",
        label: "View app definition",
        path: ".radius/app.bicep",
        line: 12,
        fallbackUrl: ""
      }
    ]);
  });

  it("offers native links for a remote graph", () => {
    expect(buildDetailRows(settings(), node())).toEqual([
      {
        kind: "external",
        icon: "source",
        label: "View source code",
        href: "https://github.test/o/r/blob/main/src/web.ts#L4",
        showUrl: true
      },
      {
        kind: "external",
        icon: "definition",
        label: "View app definition",
        href: "https://github.test/o/r/blob/main/.radius/app.bicep#L12",
        showUrl: true
      }
    ]);
  });

  it("routes both rows to the host for a local-workspace graph", () => {
    expect(buildDetailRows(settings({ localSource: true }), node())).toEqual([
      {
        kind: "local",
        icon: "source",
        label: "View source code",
        path: "src/web.ts",
        line: 4,
        fallbackUrl: "https://github.test/o/r/blob/main/src/web.ts#L4"
      },
      {
        kind: "local",
        icon: "definition",
        label: "View app definition",
        path: ".radius/app.bicep",
        line: 12,
        fallbackUrl: "https://github.test/o/r/blob/main/.radius/app.bicep#L12"
      }
    ]);
  });

  it("keeps an exact GitHub source URL external for a local-workspace graph", () => {
    const sourceUrl =
      "https://github.com/acme/widgets/blob/release/src/web.ts#L4";
    const rows = buildDetailRows(
      settings({ localSource: true }),
      node({ codeRef: sourceUrl, sourceUrl, srcPath: "", srcLine: 0 })
    );
    expect(rows[0]).toEqual({
      kind: "external",
      icon: "source",
      label: "View source code",
      href: sourceUrl,
      showUrl: true
    });
  });

  it("omits the source row for a local node with no code reference", () => {
    const rows = buildDetailRows(
      settings({ localSource: true }),
      node({ srcPath: "", srcLine: 0, sourceUrl: "" })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "View app definition" });
  });

  it("omits the definition row for a local node without a definition", () => {
    const rows = buildDetailRows(
      settings({ localSource: true }),
      node({ defFile: "" })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "View source code" });
  });

  // A worktree branch that was never pushed has no github.com URL that
  // resolves, so on the diff page each node is routed by its own branch.
  it("routes the head-branch rows of a diff to the host", () => {
    const rows = buildDetailRows(
      settings({
        diffMode: true,
        branch: "feature-x",
        baseBranch: "main",
        workspaceBranch: "feature-x"
      }),
      node({
        sourceBranch: "feature-x",
        diffStatus: "added",
        sourceUrl: "https://github.test/o/r/blob/feature-x/src/web.ts#L4"
      })
    );
    expect(rows[0]).toEqual({
      kind: "local",
      icon: "source",
      label: "View source code",
      path: "src/web.ts",
      line: 4,
      fallbackUrl: "https://github.test/o/r/blob/feature-x/src/web.ts#L4"
    });
    expect(rows[1]).toMatchObject({
      kind: "local",
      path: ".radius/app.bicep"
    });
  });

  it("keeps a removed node in a diff pointing at the base branch remotely", () => {
    const rows = buildDetailRows(
      settings({
        diffMode: true,
        branch: "feature-x",
        baseBranch: "main",
        workspaceBranch: "feature-x"
      }),
      node({
        sourceBranch: "main",
        diffStatus: "removed",
        sourceUrl: "https://github.test/o/r/blob/main/src/web.ts#L4"
      })
    );
    expect(rows[0]).toMatchObject({
      kind: "external",
      href: "https://github.test/o/r/blob/main/src/web.ts#L4"
    });
    expect(rows[1]).toMatchObject({
      kind: "external",
      href: "https://github.test/o/r/blob/main/.radius/app.bicep#L12"
    });
  });

  it("keeps every diff row remote when the worktree is on neither branch", () => {
    const rows = buildDetailRows(
      settings({
        diffMode: true,
        branch: "feature-x",
        baseBranch: "main",
        workspaceBranch: "unrelated"
      }),
      node({ sourceBranch: "feature-x" })
    );
    expect(rows[0]).toMatchObject({ kind: "external" });
  });

  it("keeps the definition row usable without a repository URL", () => {
    const rows = buildDetailRows(
      resolveGraphSettings({ localSource: true }),
      node({ sourceUrl: "" })
    );
    expect(rows[0]).toMatchObject({ kind: "local", fallbackUrl: "" });
  });

  it("gates the remote definition row on a repository URL and a definition file", () => {
    expect(
      buildDetailRows(resolveGraphSettings(), node({ sourceUrl: "" }))
    ).toEqual([{ kind: "empty" }]);
    expect(
      buildDetailRows(settings(), node({ defFile: "" })).some(
        (row) => "label" in row && row.label === "View app definition"
      )
    ).toBe(false);
  });

  it("uses the page branch and an unlined definition when node overrides are absent", () => {
    const rows = buildDetailRows(
      settings(),
      node({ sourceBranch: undefined, defLine: 0 })
    );
    expect(rows[1]).toMatchObject({
      href: "https://github.test/o/r/blob/main/.radius/app.bicep"
    });
  });

  it("leads with the producer's message and marks a failure", () => {
    expect(
      buildDetailRows(
        settings(),
        node({ deployStatus: "failed", deployMessage: "quota exceeded" })
      )[0]
    ).toEqual({ kind: "message", text: "quota exceeded", failure: true });

    expect(
      buildDetailRows(
        settings(),
        node({ deployStatus: "in_progress", deployMessage: "creating" })
      )[0]
    ).toEqual({ kind: "message", text: "creating", failure: false });
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
    expect(rows.slice(2)).toEqual([
      {
        kind: "external",
        icon: "link",
        label: "View in portal",
        href: "https://portal.test/live",
        showUrl: false
      },
      {
        kind: "external",
        icon: "link",
        label: "View in Azure portal",
        href: azurePortalUrl("/subscriptions/s/rg/one"),
        showUrl: false
      },
      {
        kind: "external",
        icon: "link",
        label: "two in Azure portal",
        href: "https://portal.azure.com/#@tenant/resource/exact",
        showUrl: false
      },
      {
        kind: "external",
        icon: "link",
        label: "servers in Azure portal",
        href: azurePortalUrl("/subscriptions/s/rg/three"),
        showUrl: false
      },
      {
        kind: "external",
        icon: "link",
        label: "resource in Azure portal",
        href: azurePortalUrl("/subscriptions/s/rg/unnamed"),
        showUrl: false
      },
      {
        kind: "external",
        icon: "link",
        label: "resource in Azure portal",
        href: azurePortalUrl("/subscriptions/s/rg/four"),
        showUrl: false
      }
    ]);
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
    // The unsafe producer URL is dropped in favour of the ARM id, and the
    // entry with no ARM id contributes no row at all.
    expect(rows.slice(2)).toEqual([
      {
        kind: "external",
        icon: "link",
        label: "unsafe in Azure portal",
        href: azurePortalUrl("/subscriptions/s/rg/unsafe"),
        showUrl: false
      }
    ]);
    expect(
      buildDetailRows(
        settings(),
        node({ cloudResources: JSON.stringify([{ name: "missing" }]) })
      )
    ).toHaveLength(2);
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
    expect(
      buildDetailRows(
        resolveGraphSettings(),
        node({ sourceUrl: "", defFile: "", cloudResources: "" })
      )
    ).toEqual([{ kind: "empty" }]);
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

  it("anchors at the container origin when either box cannot be measured", () => {
    const container = {
      getBoundingClientRect: () => ({
        left: 0,
        right: 800,
        top: 0,
        width: 800
      })
    };
    const card = {
      getBoundingClientRect: () => ({
        left: 100,
        right: 320,
        top: 40,
        width: 220
      })
    };
    expect(anchorPosition(container, card)).toEqual({ left: 328, top: 40 });
    expect(anchorPosition({}, {})).toEqual({ left: 0, top: 0 });
    expect(anchorPosition(container, {})).toEqual({ left: 0, top: 0 });
    expect(anchorPosition(null, card)).toEqual({ left: 0, top: 0 });
    expect(anchorPosition(container, null)).toEqual({ left: 0, top: 0 });
  });
});

describe("panel dismissal and focus return", () => {
  function target(matches: string[]): unknown {
    return { closest: (selector: string) => matches.includes(selector) };
  }

  it("keeps the panel open for the panel and for cards, and closes otherwise", () => {
    expect(closesDetails(target(["[data-radius-details]"]))).toBe(false);
    expect(closesDetails(target([".rad-node[data-node-id]"]))).toBe(false);
    expect(closesDetails(target([]))).toBe(true);
  });

  it("ignores a click target that cannot be matched against a selector", () => {
    expect(closesDetails(null)).toBe(false);
    expect(closesDetails("pane")).toBe(false);
    expect(closesDetails({})).toBe(false);
  });

  it("returns focus only to something that can take it", () => {
    const focusable = { focus: () => {} };
    expect(focusReturnTarget(focusable)).toBe(focusable);
    expect(focusReturnTarget(null)).toBeNull();
    expect(focusReturnTarget({})).toBeNull();
    expect(focusReturnTarget("body")).toBeNull();
  });
});
