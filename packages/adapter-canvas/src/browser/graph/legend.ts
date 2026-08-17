// Canvas adapter — the graph legend (BU-05).
//
// The legend is built from what is actually on screen: the deployed page
// explains deploy status, every other page lists the resource categories the
// current graph contains, in first-seen order.

import { escapeBrowserHtml } from "../html.js";
import {
  radiusDeployBadgeSvg,
  radiusGetTypeStyle,
  radiusResolveIcon
} from "./model.js";
import type { GraphResource, ResourceOutput } from "./model.js";

export interface LegendCategory {
  name: string;
  icon: string;
}

// The deployed view's legend explains deploy STATUS, not resource category:
// every node carries a status badge, and the badge is the primary signal there
// because fills stay neutral so labels stay readable.
export const STATUS_LEGEND_ITEMS: ReadonlyArray<{
  kind: string;
  label: string;
}> = [
  { kind: "progress", label: "Pending / deploying" },
  { kind: "success", label: "Deployed" },
  { kind: "failed", label: "Failed" }
];

export function buildStatusLegendHtml(): string {
  return STATUS_LEGEND_ITEMS.map(
    (item) =>
      '<div class="legend-item"><img src="' +
      escapeBrowserHtml(radiusDeployBadgeSvg(item.kind)) +
      '" width="14" height="14" style="vertical-align:middle;" alt="" />' +
      escapeBrowserHtml(item.label) +
      "</div>"
  ).join("");
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
    categories.push({
      name: category,
      icon: radiusResolveIcon(resource)
    });
  };
  for (const resource of resources) {
    note(resource);
    for (const output of resource.outputResources || []) note(output);
  }
  return categories;
}

export function buildCategoryLegendHtml(
  categories: readonly LegendCategory[]
): string {
  return categories
    .map((category) => {
      const image =
        category.icon ?
          '<img src="' +
          escapeBrowserHtml(category.icon) +
          '" width="14" height="14" style="vertical-align:middle;" alt="" />'
        : '<span style="display:inline-block;width:14px;height:14px;vertical-align:middle;"></span>';
      return (
        '<div class="legend-item">' +
        image +
        escapeBrowserHtml(category.name) +
        "</div>"
      );
    })
    .join("");
}
