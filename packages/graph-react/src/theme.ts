import type { CSSProperties } from "react";
import type { GraphEdge } from "./build.js";

export interface GraphTheme {
  background?: string;
  text?: string;
  mutedText?: string;
  accent?: string;
  fontFamily?: string;
  colorScheme?: "light" | "dark";
}

/** CSS inputs can also reference tokens supplied by a host stylesheet. */
export type GraphStyle = CSSProperties &
  Partial<Record<`--radius-graph-${string}`, string>>;

const THEME_PROPERTIES = {
  background: "--radius-graph-background",
  text: "--radius-graph-text",
  mutedText: "--radius-graph-muted",
  accent: "--radius-graph-accent",
  fontFamily: "--radius-graph-font"
} as const;

export function graphStyle(style?: GraphStyle, theme?: GraphTheme): GraphStyle {
  const result = { ...style };
  for (const key of Object.keys(THEME_PROPERTIES) as Array<
    keyof typeof THEME_PROPERTIES
  >) {
    const value = theme?.[key];
    if (value !== undefined) result[THEME_PROPERTIES[key]] = value;
  }
  if (theme?.colorScheme !== undefined) result.colorScheme = theme.colorScheme;
  return result;
}

export interface StyledEdge extends Omit<GraphEdge, "style"> {
  className: string;
  style: CSSProperties;
}

/** Keep semantic defaults as inputs, not inline paint that beats host CSS. */
export function styledEdges(edges: GraphEdge[]): StyledEdge[] {
  return edges.map((edge) => {
    const style: CSSProperties &
      Record<`--rad-edge-default-${string}`, string> = {
      "--rad-edge-default-stroke": edge.style.stroke,
      "--rad-edge-default-width": String(edge.style.strokeWidth),
      "--rad-edge-default-dash": edge.style.strokeDasharray ?? "none"
    };
    return { ...edge, className: "radius-graph__edge", style };
  });
}
