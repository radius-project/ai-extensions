// Canvas adapter — the shared Application Graph heading and sub-tab navigation
// wrapping the modeled, planned, deployed, and diff graph pages.

import { radiusMark } from "../ui.js";

export function graphHeader(activePage: string): string {
  const pages = [
    { id: "graph", label: "Modeled" },
    { id: "planned", label: "Planned" },
    { id: "deployed", label: "Deployed" },
    { id: "graph-diff", label: "Diff" }
  ];
  const navLinks = pages
    .map((p) => {
      const cls =
        p.id === activePage ? "rad-subtab rad-subtab--active" : "rad-subtab";
      return `<a href="?page=${p.id}" data-page="${p.id}" data-radius-graph-page="${p.id}" class="${cls}">${p.label}</a>`;
    })
    .join("\n  ");
  // Each mode named in the lede links to its own sub-tab. Built from the same
  // `pages` list as the nav so the two can never point at different routes.
  const byLabel = Object.fromEntries(pages.map((p) => [p.label, p.id]));
  const ledeLink = (label: string) =>
    `<a href="?page=${byLabel[label]}" data-radius-graph-page="${byLabel[label]}" class="rad-lede-link"><strong>${label}</strong></a>`;
  return `
<div class="rad-heading">
  <h1>${radiusMark(26)}<span>Application Graph</span></h1>
  <p class="rad-lede">
    Visualize your application graph as you've designed it (${ledeLink(
      "Modeled"
    )}), as you want it deployed (${ledeLink(
      "Planned"
    )}), as it's running in your environments (${ledeLink(
      "Deployed"
    )}), or as it differs between branches (${ledeLink("Diff")}).
  </p>
</div>
<nav id="graph-nav" class="rad-subtabs">
  ${navLinks}
</nav>
<div id="graph-page-content">`;
}

export function graphHeaderClose() {
  return `</div>`;
}
