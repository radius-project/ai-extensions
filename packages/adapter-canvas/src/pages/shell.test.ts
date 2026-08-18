import { describe, it, expect } from "vitest";
import { browserEntryMarker, browserScript } from "../browser/scripts.js";
import { pageShell } from "./shell.js";

describe("pageShell", () => {
  it("wraps body content in an HTML document with the title", () => {
    const html = pageShell("My Title", "<p>hello</p>");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("My Title — Radius");
    expect(html).toContain("<p>hello</p>");
  });

  it("previews feedback link destinations in native tooltips", () => {
    const html = pageShell("My Title", "<p>hello</p>");
    expect(html).toContain(
      'title="https://github.com/radius-project/ai-extensions/issues/new?template=feedback-or-bug-report.yml"'
    );
    expect(html).toContain('title="https://radapp.io"');
  });

  it("renders larger top-navigation icons without a border or filled background", () => {
    const html = pageShell("My Title", "<p>hello</p>");
    const iconStyles = html.match(/\.rad-topnav__icon\s*\{([^}]*)\}/)?.[1];
    expect(html).toContain("width:28px;height:28px");
    expect(iconStyles).toContain("background: transparent");
    expect(iconStyles).not.toContain("border:");
  });

  it("inherits the Copilot host theme without creating Radius-owned theme state", () => {
    const html = pageShell("My Title", "<p>hello</p>");
    expect(html).toContain("color-scheme: var(--color-scheme, inherit)");
    expect(html).toContain("--rad-bg: var(--background-color-default, Canvas)");
    expect(html).toContain("--rad-text: var(--text-color-default, CanvasText)");
    expect(html).toContain(
      "--rad-bg-subtle: color-mix(in srgb, var(--rad-text) 6%, var(--rad-bg))"
    );
    expect(html).toContain("--rad-neutral-bg: var(--rad-bg-subtle)");
    expect(html).toContain("--rad-node-bg: var(--rad-surface)");
    // Status colors still flow from the host, but are mixed toward the active
    // text color so a host palette that does not follow the canvas theme cannot
    // leave them unreadable (see shell-styles.test.ts for the contrast ratios).
    expect(html).toContain(
      "--rad-success: color-mix(in srgb, var(--text-color-success"
    );
    expect(html).toContain(
      "--rad-warning: color-mix(in srgb, var(--text-color-warning"
    );
    expect(html).toContain(
      "--rad-danger: color-mix(in srgb, var(--text-color-danger"
    );
    expect(html).not.toContain("localStorage");
    expect(html).not.toContain("matchMedia");
    expect(html).not.toContain("prefers-color-scheme");
    expect(html).not.toContain(
      "--rad-bg-subtle: var(--background-color-segmented"
    );
    expect(html).not.toContain(
      "--rad-neutral-bg: var(--background-color-segmented"
    );
  });

  it("keeps React Flow chrome transparent over the themed graph surface", () => {
    const html = pageShell("My Title", '<div id="graph-container"></div>');
    const flowStyles = html.match(
      /\.react-flow, \.react-flow__renderer, \.react-flow__pane\s*\{([^}]*)\}/
    )?.[1];
    expect(flowStyles).toContain("background: transparent");
  });

  it("excludes radio and checkbox inputs from the 100%-width form-field rule", () => {
    // The app-registration picker builds each option as a flex row of
    // [radio][text]. A bare `input` selector in the width:100% rule stretches
    // the radio to fill the row and shoves the label text far to the right
    // (see the empty GITHUB-card style regression). The width rule must skip
    // radios/checkboxes so they keep their intrinsic size.
    const html = pageShell("My Title", "<p>hello</p>");
    expect(html).toContain(
      'input:not([type="radio"]):not([type="checkbox"]), select, .rad-select {'
    );
    // The bare selector (which would balloon the radio) must be gone.
    expect(html).not.toMatch(/\n\s*input, select, \.rad-select \{/);
  });

  it("constrains graph type labels to the node card width", () => {
    const html = pageShell("My Title", "<p>hello</p>");
    const typeStyles = html.match(/\.rad-node__type\s*\{([^}]*)\}/)?.[1];
    expect(typeStyles).toContain("width: 100%");
    expect(typeStyles).toContain("overflow: hidden");
    expect(typeStyles).toContain("white-space: nowrap");
  });

  it("derives graph line colours from text/background, not host border tokens", () => {
    const html = pageShell("My Title", "<p>hello</p>");
    // Primer's --border-color-muted is FAINTER than --border-color-default, so
    // routing graph lines through --rad-stroke-strong (which falls back to it)
    // made them the weakest thing on the canvas. Mixing text into background
    // keeps contrast stable and inverts correctly in dark mode.
    for (const token of [
      "--rad-node-border",
      "--rad-edge",
      "--rad-edge-muted",
      "--rad-grid"
    ]) {
      const value = html.match(new RegExp(`${token}:\\s*([^;]+);`))?.[1];
      expect(value, `${token} should not be defined`).toBeTruthy();
      expect(value).toContain("color-mix");
      expect(value).toContain("var(--rad-text)");
      expect(value).not.toContain("--rad-stroke");
    }
  });

  it("keeps graph lines in a legible contrast order", () => {
    const html = pageShell("My Title", "<p>hello</p>");
    const pct = (token: string) =>
      Number(
        html
          .match(new RegExp(`${token}:\\s*([^;]+);`))?.[1]
          ?.match(/var\(--rad-text\)\s+(\d+)%/)?.[1]
      );
    // Edges read strongest, then node borders, then the muted edge; the
    // background grid stays well below all of them so it never competes.
    expect(pct("--rad-edge")).toBeGreaterThanOrEqual(pct("--rad-node-border"));
    expect(pct("--rad-node-border")).toBeGreaterThan(pct("--rad-edge-muted"));
    expect(pct("--rad-edge-muted")).toBeGreaterThan(pct("--rad-grid"));
    // All load-bearing lines need enough mix to stay visible in both themes.
    expect(pct("--rad-edge-muted")).toBeGreaterThanOrEqual(35);
  });
});

describe("operation status chip in the top navigation", () => {
  const shell = pageShell("Environments", "<div></div>", "environments");

  it("ships the chip on every page, hidden until it has something to report", () => {
    // It renders in the shell rather than on the environments page because
    // the whole point is to reach a user who has navigated away from there.
    const html = pageShell("Applications", "<div></div>", "applications");
    expect(html).toContain('id="rad-opchip"');
    expect(html).toContain('id="rad-opchip-label"');
    expect(html).toMatch(
      /<a class="rad-opchip" id="rad-opchip" href="\/\?page=environment" hidden/
    );
    expect(shell).toContain('id="rad-opchip"');
  });

  it("routes back to environments rather than opening anything on its own", () => {
    // Auto-focus on completion was rejected: it re-creates the modal's sin
    // with worse timing. The chip is a link the user chooses to follow.
    expect(shell).toContain('href="/?page=environment"');
    expect(shell).not.toContain('rad-opchip" onclick');
  });

  it("announces itself politely to assistive technology", () => {
    expect(shell).toMatch(/id="rad-opchip"[^>]*aria-live="polite"/);
    expect(shell).toContain(
      'class="rad-opchip__dot" id="rad-opchip-dot" aria-hidden="true"'
    );
  });

  it("carries the poller that fills it in", () => {
    expect(shell).toContain("/api/operations");
    expect(shell).toContain("radiusOpChipAck");
    expect(shell).toContain(browserEntryMarker("operation-chip"));
    expect(shell.split(browserScript("operation-chip"))).toHaveLength(2);
  });

  it("stops the pulse for anyone who has asked for less motion", () => {
    expect(shell).toContain("@media (prefers-reduced-motion: reduce)");
    expect(shell).toMatch(
      /prefers-reduced-motion[\s\S]*rad-opchip--running \.rad-opchip__dot \{ animation: none; \}/
    );
  });
});

describe("pageShell document structure", () => {
  const html = pageShell("Application Graph", '<p id="body">hello</p>');

  it("renders one complete document with the head, nav, body content and widgets in order", () => {
    expect(html.startsWith("<!doctype html>\n<html>\n<head>")).toBe(true);
    expect(html.trimEnd().endsWith("</body>\n</html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8" />');
    const order = [
      "<title>",
      '<nav class="rad-topnav">',
      '<div class="main-content">',
      '<p id="body">hello</p>',
      'id="rad-feedback"',
      'id="radius-reconnect-overlay"'
    ].map((marker) => html.indexOf(marker));
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order]).toEqual([...order].sort((a, b) => a - b));
  });

  it("closes each script block it opens and balances its style blocks", () => {
    const count = (needle: string) => html.split(needle).length - 1;
    const blocks = html.match(/<script>[\s\S]*?<\/script>/g) || [];
    expect(blocks).not.toHaveLength(0);
    expect(blocks).toHaveLength(count("</script>"));
    expect(count("<style>")).toBe(count("</style>"));
  });

  it("injects the shared delete dialog entry exactly once", () => {
    expect(html).toContain(browserEntryMarker("delete-dialog"));
    expect(html.split(browserScript("delete-dialog"))).toHaveLength(2);
  });

  it.each([
    ["Environments", "environments"],
    ["Credentials — Environments", "environments"],
    ["Deploying", "deployments"],
    ["Deployment Failed", "deployments"],
    ["Deployment Initiated", "deployments"],
    ["Application Graph", "applications"],
    ["Planned Graph", "applications"],
    ["", "applications"]
  ])(
    "derives the active top-nav section from the %s title",
    (title, active) => {
      const rendered = pageShell(title, "<p></p>");
      const activeTab = rendered.match(
        /<a href="\/\?page=([a-z-]+)" class="rad-topnav__tab rad-topnav__tab--active"/
      )?.[1];
      const expectedPage = {
        applications: "graph",
        environments: "environment",
        deployments: "deploying"
      }[active];
      expect(activeTab).toBe(expectedPage);
    }
  );

  it("prefers an explicit active section over the one implied by the title", () => {
    const rendered = pageShell("Application Graph", "<p></p>", "deployments");
    expect(rendered).toContain(
      '<a href="/?page=deploying" class="rad-topnav__tab rad-topnav__tab--active"'
    );
    expect(rendered).not.toContain(
      '<a href="/?page=graph" class="rad-topnav__tab rad-topnav__tab--active"'
    );
  });

  it("links every top-nav destination to a canvas page value", () => {
    const destinations = [
      ...html.matchAll(/<a href="\/\?page=([a-z-]+)" class="rad-topnav__tab/g)
    ].map((match) => match[1]);
    expect(destinations).toEqual(["graph", "environment", "deploying"]);
  });

  it("inlines the vendored graph libraries instead of requesting browser assets", () => {
    // The canvas webview blocks external scripts, so every asset the page needs
    // is inlined: no <script src>, no stylesheet link, no CDN reference.
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).not.toContain("unpkg.com");
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="data:');
  });

  it("ships the shared client scripts before the page body that calls them", () => {
    const graph = html.indexOf(browserEntryMarker("graph"));
    const deleteDialog = html.indexOf(browserEntryMarker("delete-dialog"));
    const body = html.indexOf('<div class="main-content">');
    expect(graph).toBeGreaterThan(-1);
    expect(deleteDialog).toBeGreaterThan(graph);
    expect(body).toBeGreaterThan(deleteDialog);
  });

  it("renders the reconnect overlay the heartbeat drives after the page body", () => {
    expect(html).toContain('id="radius-reconnect-overlay"');
    expect(html).toContain("/api/ping");
    expect(html.indexOf("/api/ping")).toBeGreaterThan(
      html.indexOf('id="radius-reconnect-overlay"')
    );
    expect(html).toContain("Reconnecting to Radius…");
  });

  it("injects the compiled heartbeat inline exactly once", () => {
    const marker = browserEntryMarker("heartbeat");
    expect(html.split(marker).length - 1).toBe(1);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html.indexOf(marker)).toBeGreaterThan(
      html.indexOf('id="radius-reconnect-overlay"')
    );
  });

  it.each(["graph"] as const)(
    "injects the compiled %s entry inline exactly once",
    (name) => {
      const marker = browserEntryMarker(name);
      expect(html.split(marker).length - 1).toBe(1);
      expect(html.indexOf(marker)).toBeLessThan(
        html.indexOf('<div class="main-content">')
      );
    }
  );

  it("renders the feedback widget with both destinations on every page", () => {
    expect(html).toContain('id="rad-feedback-btn"');
    expect(html).toContain(
      'href="https://github.com/radius-project/ai-extensions/issues/new?template=feedback-or-bug-report.yml"'
    );
    expect(html).toContain('href="https://radapp.io"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("emits parseable inline scripts for a bare shell", () => {
    const blocks = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const source = block.slice("<script>".length, -"</script>".length);
      expect(() => new Function(source)).not.toThrow();
    }
  });

  it("escapes the caller's title while composing the renderer's body as trusted markup", () => {
    // The title is a label, so it is escaped and can never open a tag or close
    // the <title> element. The body is markup a page renderer already composed
    // (escaping its own state into it), so the shell must not double-escape it.
    const rendered = pageShell(
      "A & B </title><script>alert(1)</script>",
      '<div data-x="1">&amp; trusted</div>'
    );
    expect(rendered).toContain(
      "<title>A &amp; B &lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; — Radius</title>"
    );
    expect(rendered).not.toContain("<script>alert(1)</script>");
    expect(rendered).toContain('<div data-x="1">&amp; trusted</div>');
    expect(rendered).not.toContain("&lt;div data-x");
  });

  it.each([
    "Application Graph",
    "Environments",
    "Deployments",
    "Graph Diff",
    "Deployed Graph",
    "Planned Graph",
    "Accounts",
    "Deployment Failed",
    "Deployment Initiated"
  ])("renders the ordinary %s title unchanged", (title) => {
    expect(pageShell(title, "<p></p>")).toContain(
      `<title>${title} — Radius</title>`
    );
  });

  it("keeps every script block parseable when the title carries a closing tag", () => {
    const rendered = pageShell("</script><script>alert(1)</script>", "<p></p>");
    const blocks = rendered.match(/<script>[\s\S]*?<\/script>/g) || [];
    expect(blocks).toHaveLength(rendered.split("</script>").length - 1);
    for (const block of blocks) {
      const source = block.slice("<script>".length, -"</script>".length);
      expect(() => new Function(source)).not.toThrow();
    }
  });
});
