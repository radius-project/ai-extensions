// Canvas adapter — the graph legend (BU-05).
//
// The legend is built from what is actually on screen: the deployed page
// explains deploy status, every other page lists the resource categories the
// current graph contains, in first-seen order.

import { browserCssMaskUrl, escapeBrowserHtml } from "../html.js";
import {
  radiusDeployBadgeKind,
  radiusDeployBadgeSvg,
  radiusGetTypeStyle,
  radiusResolveIconSource
} from "./model.js";
import type { GraphResource, ResourceOutput } from "./model.js";
import type { DeployBadgeKind } from "./model.js";

export interface LegendCategory {
  name: string;
  icon: string;
  // True when the icon paints itself in `currentColor` and must therefore be
  // themed by this UI through a CSS mask rather than shown as an image.
  monochrome?: boolean;
}

// The deployed view's legend explains deploy STATUS, not resource category:
// every node carries a status badge, and the badge is the primary signal there
// because fills stay neutral so labels stay readable.
export const STATUS_LEGEND_ITEMS: ReadonlyArray<{
  kind: DeployBadgeKind;
  label: string;
}> = [
  { kind: "progress", label: "Pending / deploying" },
  { kind: "success", label: "Deployed" },
  { kind: "failed", label: "Failed" }
];

export function buildStatusLegendHtml(
  resources: readonly GraphResource[]
): string {
  const visibleKinds = new Set(
    resources.map((resource) => radiusDeployBadgeKind(resource.deployStatus))
  );
  return STATUS_LEGEND_ITEMS.filter((item) => visibleKinds.has(item.kind))
    .map(
      (item) =>
        '<div class="legend-item"><img src="' +
        escapeBrowserHtml(radiusDeployBadgeSvg(item.kind)) +
        '" width="14" height="14" style="vertical-align:middle;" alt="" />' +
        escapeBrowserHtml(item.label) +
        "</div>"
    )
    .join("");
}

// Categories present in the graph, including those contributed only by output
// resources, in first-seen order.
export function collectLegendCategories(
  resources: readonly GraphResource[]
): LegendCategory[] {
  const seen = new Set<string>();
  const categories: LegendCategory[] = [];
  const note = (
    resource: GraphResource | ResourceOutput | null | undefined
  ): void => {
    if (!resource) return;
    const type = resource.type || resource.displayType || "";
    const category = radiusGetTypeStyle(type).category;
    if (seen.has(category)) return;
    seen.add(category);
    const icon = radiusResolveIconSource(resource);
    categories.push({
      name: category,
      icon: icon.src,
      monochrome: icon.monochrome
    });
  };
  for (const resource of resources) {
    note(resource);
    for (const output of resource.outputResources || []) note(output);
  }
  return categories;
}

// A monochrome legend icon is painted through a CSS mask so it follows the
// canvas theme; everything else keeps its own colours as an image. The mask URL
// is percent-encoded for the CSS `url()` context and the whole declaration is
// then HTML-escaped, so a hostile icon string can escape neither.
function legendIconHtml(category: LegendCategory): string {
  if (!category.icon) {
    return '<span style="display:inline-block;width:14px;height:14px;vertical-align:middle;"></span>';
  }
  if (!category.monochrome) {
    return (
      '<img src="' +
      escapeBrowserHtml(category.icon) +
      '" width="14" height="14" style="vertical-align:middle;" alt="" />'
    );
  }
  const mask = browserCssMaskUrl(category.icon) + " center/contain no-repeat";
  return (
    '<span aria-hidden="true" style="' +
    escapeBrowserHtml(
      "display:inline-block;width:14px;height:14px;vertical-align:middle;" +
        "background-color:var(--rad-text, currentColor);" +
        "-webkit-mask:" +
        mask +
        ";mask:" +
        mask +
        ";"
    ) +
    '"></span>'
  );
}

export function buildCategoryLegendHtml(
  categories: readonly LegendCategory[]
): string {
  return categories
    .map(
      (category) =>
        '<div class="legend-item">' +
        legendIconHtml(category) +
        escapeBrowserHtml(category.name) +
        "</div>"
    )
    .join("");
}
