// Canvas adapter — application-graph nodes and edges (BU-04, BU-05).
//
// The pure builder the renderer runs before React ever mounts: it turns the
// server's resource list into React Flow nodes and edges, resolving each node's
// identity, label, icon, colours, source links and deploy badge, and colouring
// every edge by the diff status of the connection or of its endpoints.
//
// Nothing here touches the DOM, so the whole node/edge contract — including the
// diff and deploy rules a screenshot would otherwise be the only witness for —
// is unit tested directly.

import {
  buildSourceUrl,
  radiusDeployBadgeKind,
  radiusDeployBadgeSvg,
  radiusFormatResolvedTypeLabel,
  radiusFormatTypeLabel,
  radiusIsManagedClusterResource,
  radiusResolveIcon,
  radiusSelectResolvedResource,
  srcLineFromRef,
  srcPathFromRef
} from "./model.js";
import { filterGraphVisualizationResources } from "@radius-project/core/graph";
import { parseGraphResources } from "./model.js";
import type { GraphResource, ResourceOutput } from "./model.js";

export interface NodeColors {
  bg: string;
  border: string;
}

// Deploy-status → card colours, applied when the graph runs in deployMode (the
// live "Deploying" page). In-flight/queued resources read gray, a completed
// resource turns blue, and a failed one turns red. Managed-cluster resources
// stay gray throughout (see nodeColors); their overall status is conveyed by
// the corner status badge instead of the fill.
export const RADIUS_DEPLOY_STATUS_COLORS: Readonly<Record<string, NodeColors>> =
  {
    pending: { bg: "var(--rad-node-bg)", border: "var(--rad-edge)" },
    in_progress: { bg: "var(--rad-node-bg)", border: "var(--rad-edge)" },
    postponed: { bg: "var(--rad-node-bg)", border: "var(--rad-edge)" },
    waiting: { bg: "var(--rad-node-bg)", border: "var(--rad-edge)" },
    success: { bg: "var(--rad-info-bg)", border: "var(--rad-info)" },
    failed: { bg: "var(--rad-danger-bg)", border: "var(--rad-danger)" }
  };

// What a page asks for when it renders a graph. Every field is optional: the
// modeled, planned, diff and deployed pages each set a different subset.
export interface GraphOptions {
  diffMode?: boolean;
  deployMode?: boolean;
  plannedMode?: boolean;
  repoUrl?: string;
  branch?: string;
  baseBranch?: string;
  localSource?: boolean;
  lineType?: string;
  curveStyle?: string;
  showLegend?: boolean;
  enablePopup?: boolean;
}

// The same options with every default already applied, so no downstream module
// re-derives "planned or deployed means resolved" or "no branch means main".
export interface GraphSettings {
  readonly diffMode: boolean;
  readonly deployMode: boolean;
  readonly plannedMode: boolean;
  readonly resolvedMode: boolean;
  readonly repoUrl: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly localSource: boolean;
  readonly edgeType: string;
  readonly showLegend: boolean;
  readonly enablePopup: boolean;
}

export interface GraphNodeData {
  id: string;
  borderColor: string;
  borderWidth: number;
  borderStyle?: string;
  bgColor: string;
  icon: string;
  nodeName: string;
  typeLabel: string;
  codeRef: string;
  sourceUrl: string;
  sourceBranch?: string;
  srcPath: string;
  srcLine: number;
  defFile: string;
  defLine: number;
  resourceType: string;
  diffStatus: string;
  deployStatus: string;
  deployMessage?: string;
  deployBadgeKind?: string;
  deployBadge?: string;
  portalUrl: string;
  cloudId?: string;
  cloudResources: string;
}

export interface GraphNodePosition {
  x: number;
  y: number;
}

export interface GraphNode {
  id: string;
  type: "rad";
  data: GraphNodeData;
  position: GraphNodePosition;
  draggable: boolean;
}

export interface GraphEdgeStyle {
  stroke: string;
  strokeWidth: number;
  strokeDasharray?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  style: GraphEdgeStyle;
}

export interface BuiltGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  dataById: Record<string, GraphNodeData>;
  resources: GraphResource[];
}

// Map an (optional) line-type hint to a React Flow edge type. Bezier
// ("default") is the figma default; a few elbow-ish aliases map to smoothstep.
export function radiusMapLineType(lineType?: string): string {
  switch (String(lineType || "").toLowerCase()) {
    case "straight":
      return "straight";
    case "step":
      return "step";
    case "smoothstep":
    case "taxi":
    case "segments":
      return "smoothstep";
    default:
      return "default";
  }
}

export function resolveGraphSettings(
  options: GraphOptions = {}
): GraphSettings {
  const plannedMode = options.plannedMode || false;
  const deployMode = options.deployMode || false;
  const branch = options.branch || "main";
  return {
    diffMode: options.diffMode || false,
    deployMode,
    plannedMode,
    resolvedMode: plannedMode || deployMode,
    repoUrl: options.repoUrl || "",
    branch,
    // In diff mode a "removed" resource's source file lived on the base branch
    // (it may no longer exist on head at all), so its source link must point at
    // baseBranch while everything else points at the page's normal branch.
    baseBranch: options.baseBranch || branch,
    localSource: options.localSource === true,
    edgeType: radiusMapLineType(options.lineType || options.curveStyle),
    showLegend: options.showLegend === true,
    enablePopup: options.enablePopup !== false
  };
}

export function nodeColors(
  settings: GraphSettings,
  resource: GraphResource
): NodeColors {
  // Diff mode keeps the same theme-aware card surface as the modeled graph.
  // Only the border colour encodes diff status.
  if (settings.diffMode && resource.diffStatus) {
    switch (resource.diffStatus) {
      case "added":
        return { bg: "var(--rad-node-bg)", border: "var(--rad-success)" };
      case "removed":
        return { bg: "var(--rad-node-bg)", border: "var(--rad-danger)" };
      case "modified":
        return { bg: "var(--rad-node-bg)", border: "var(--rad-warning)" };
      default:
        return { bg: "var(--rad-node-bg)", border: "var(--rad-node-border)" };
    }
  }
  // A managed-cluster node always stays gray — its overall status is conveyed
  // by the corner status badge, not the fill. Other resources take the live
  // deploy-status colours.
  if (settings.deployMode) {
    if (resource.deployStatus === "failed") {
      return RADIUS_DEPLOY_STATUS_COLORS.failed;
    }
    if (radiusIsManagedClusterResource(resource)) {
      return RADIUS_DEPLOY_STATUS_COLORS.pending;
    }
    const status =
      RADIUS_DEPLOY_STATUS_COLORS[resource.deployStatus || "pending"] ||
      RADIUS_DEPLOY_STATUS_COLORS.pending;
    return { bg: status.bg, border: status.border };
  }
  // Non-diff nodes use the clean modeled-graph card style: the host surface
  // with a thin neutral border. Category is conveyed by the icon (owned by the
  // type/recipe pack), not by node fill or shape.
  return { bg: "var(--rad-node-bg)", border: "var(--rad-node-border)" };
}

function resourceId(resource: GraphResource, index: number): string {
  return resource.id || resource.name || `resource-${index}`;
}

function cloudOutputsOf(resource: GraphResource): ResourceOutput[] {
  const outputs = resource.outputResources || [];
  const cloud: ResourceOutput[] = [];
  for (const output of outputs) {
    if (output && output.id && output.id.indexOf("/subscriptions/") === 0) {
      cloud.push({
        name: output.name || "",
        type: output.type || "",
        id: output.id
      });
    }
  }
  return cloud;
}

// Map a concrete outputResource id → the top-level resource that "owns" it (its
// name matches the output's name). Used to skip rendering that same concrete
// resource as a duplicate output child under OTHER resources, which otherwise
// produces two nodes for one secret.
function ownedOutputsOf(resources: readonly GraphResource[]): {
  ownedOutputIds: Record<string, string>;
  diffStatusById: Record<string, string>;
} {
  const ownedOutputIds: Record<string, string> = {};
  const diffStatusById: Record<string, string> = {};
  for (const [index, resource] of resources.entries()) {
    const id = resourceId(resource, index);
    diffStatusById[id] = resource.diffStatus || "";
    for (const output of resource.outputResources || []) {
      if (output && output.id && output.name === resource.name) {
        ownedOutputIds[output.id] = id;
      }
    }
  }
  return { ownedOutputIds, diffStatusById };
}

export function buildGraph(
  settings: GraphSettings,
  resources: readonly GraphResource[]
): BuiltGraph {
  const visibleResources = parseGraphResources(
    filterGraphVisualizationResources([...resources])
  );
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const dataById: Record<string, GraphNodeData> = {};
  const edgeSeen = new Set<string>();
  const { ownedOutputIds, diffStatusById } = ownedOutputsOf(visibleResources);

  // Diff mode colours the edge by whether the CONNECTION itself changed between
  // base and head (computeGraphDiff tags each rendered connection). A removed
  // edge between two still-present nodes is carried as a synthetic removed
  // connection, so it is drawn here too. Only edges with no connection-level
  // status (e.g. output-resource edges) fall back to the endpoints' own
  // statuses.
  function diffStroke(source: string, target: string, status: string): string {
    if (status === "removed") return "var(--rad-danger)";
    if (status === "added") return "var(--rad-success)";
    if (status === "unchanged") return "var(--rad-edge-muted)";
    const sourceStatus = diffStatusById[source] || "";
    const targetStatus = diffStatusById[target] || "";
    if (sourceStatus === "removed" || targetStatus === "removed") {
      return "var(--rad-danger)";
    }
    if (sourceStatus === "added" || targetStatus === "added") {
      return "var(--rad-success)";
    }
    return "var(--rad-edge-muted)";
  }

  function pushEdge(
    source: string,
    target: string,
    dashedInput: boolean,
    connectionStatus = ""
  ): void {
    const id = source + "-->" + target;
    if (edgeSeen.has(id)) return;
    edgeSeen.add(id);
    const dashed = dashedInput || settings.plannedMode;
    let stroke = dashed ? "var(--rad-edge)" : "var(--rad-edge-muted)";
    if (settings.diffMode)
      stroke = diffStroke(source, target, connectionStatus);
    const style: GraphEdgeStyle = { stroke, strokeWidth: 2.5 };
    // Planned edges use a finer dotted pattern; other modes' dashed output
    // connectors keep their original wider gap.
    if (dashed) style.strokeDasharray = settings.plannedMode ? "4 4" : "6 4";
    edges.push({ id, source, target, type: settings.edgeType, style });
  }

  function pushNode(id: string, data: Omit<GraphNodeData, "id">): void {
    const withId: GraphNodeData = { ...data, id };
    dataById[id] = withId;
    nodes.push({
      id,
      type: "rad",
      data: withId,
      position: { x: 0, y: 0 },
      draggable: true
    });
  }

  for (const [resourceIndex, resource] of visibleResources.entries()) {
    const id = resourceId(resource, resourceIndex);
    const colors = nodeColors(settings, resource);
    // Planned and deploying graphs share the same shape: the modeled resource
    // keeps its identity (name, icon) and only the type label changes to the
    // concrete type the recipe pack resolves to.
    const resolved =
      settings.resolvedMode ?
        radiusSelectResolvedResource(resource, ownedOutputIds, id)
      : null;
    const shortType =
      resolved ?
        radiusFormatResolvedTypeLabel(resolved.type || resolved.displayType)
      : radiusFormatTypeLabel(resource.type);
    const sourceBranch =
      settings.diffMode && resource.diffStatus === "removed" ?
        settings.baseBranch
      : settings.branch;
    const badgeKind = radiusDeployBadgeKind(resource.deployStatus);
    pushNode(id, {
      borderColor: colors.border,
      borderWidth: 2.5,
      borderStyle: settings.plannedMode ? "dashed" : "solid",
      bgColor: colors.bg,
      icon: radiusResolveIcon(resource),
      nodeName: resource.name || id,
      typeLabel: shortType,
      codeRef: resource.codeReference || "",
      sourceUrl: buildSourceUrl(
        settings.repoUrl,
        settings.branch,
        resource.codeReference || "",
        sourceBranch
      ),
      sourceBranch,
      srcPath: srcPathFromRef(resource.codeReference || ""),
      srcLine: srcLineFromRef(resource.codeReference || ""),
      defFile: resource.definitionFile || ".radius/app.bicep",
      defLine: resource.definitionLine || 0,
      resourceType: resource.type || "",
      diffStatus: resource.diffStatus || "",
      deployStatus: resource.deployStatus || "",
      deployMessage: resource.deployMessage || "",
      deployBadgeKind: settings.deployMode ? badgeKind : "",
      deployBadge: settings.deployMode ? radiusDeployBadgeSvg(badgeKind) : "",
      portalUrl: resource.portalUrl || "",
      cloudResources: JSON.stringify(cloudOutputsOf(resource))
    });

    for (const connection of resource.connections || []) {
      if (!connection) continue;
      const direction = connection.direction || "Outbound";
      if (direction !== "Outbound") continue;
      const target = connection.id || connection.name || "";
      if (!target) continue;
      const exists = visibleResources.some(
        (entry, index) => resourceId(entry, index) === target
      );
      if (exists) pushEdge(id, target, false, connection.diffStatus || "");
    }

    // The modeled and diff graphs expand concrete recipe outputs as child nodes
    // for detail. Planned and deploying graphs deliberately keep the modeled
    // graph's one-node-per-resource topology.
    if (settings.resolvedMode) continue;
    const outputs = resource.outputResources || [];
    for (let index = 0; index < outputs.length; index++) {
      const output = outputs[index];
      if (!output) continue;
      // Skip a concrete resource another top-level resource owns.
      if (
        output.id &&
        ownedOutputIds[output.id] &&
        ownedOutputIds[output.id] !== id
      ) {
        continue;
      }
      const outputId =
        id + "/output/" + index + "/" + (output.name || `resource-${index}`);
      const outputLabel =
        output.displayType || output.type || output.name || "Resource";
      pushNode(outputId, {
        // Output child nodes only appear in the modeled/diff graphs, so they
        // always render as neutral grey.
        borderColor: "var(--rad-edge-muted)",
        borderWidth: 2.5,
        bgColor: "var(--rad-bg-subtle)",
        icon: radiusResolveIcon(output),
        nodeName: output.name || outputLabel,
        typeLabel: outputLabel,
        codeRef: "",
        sourceUrl: "",
        srcPath: "",
        srcLine: 0,
        defFile: "",
        defLine: 0,
        resourceType: output.type || "",
        diffStatus: "",
        deployStatus: output.deployStatus || "",
        portalUrl: output.portalUrl || "",
        cloudId:
          output.id && output.id.indexOf("/subscriptions/") === 0 ?
            output.id
          : "",
        cloudResources: "[]"
      });
      pushEdge(id, outputId, true);
    }
  }

  return { nodes, edges, dataById, resources: visibleResources };
}
