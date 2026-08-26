// Canvas adapter — application-graph model (BU-04).
//
// The pure normalization the React Flow renderer runs before it ever touches the
// DOM: resolving a resource's id, label and icon, formatting raw and recipe
// resolved type labels, ranking recipe outputs to choose a planned node's
// representative type, detecting managed clusters, mapping a deploy status to a
// badge, and turning a code reference into a GitHub URL or a repo-relative path.
//
// Every function here is a pure function of its inputs, so the whole model is
// unit tested without a browser. The string literals (SVG markup, colours,
// labels) are reproduced verbatim from the legacy renderer so the compiled
// bundle keeps the same text.

import { isRecord } from "../json.js";

// The resource fields the model reads. Server-serialized graph data satisfies
// this shape structurally; every field is optional because a modeled, planned,
// diff or deployed graph each populate a different subset.
export interface ResourceOutput {
  id?: string;
  name?: string;
  type?: string;
  displayType?: string;
  deployStatus?: string;
  portalUrl?: string;
}

export interface ResourceConnection {
  id?: string;
  name?: string;
  direction?: string;
  diffStatus?: string;
}

export interface GraphResource {
  id?: string;
  name?: string;
  type?: string;
  displayType?: string;
  icon?: string;
  codeReference?: string;
  definitionFile?: string;
  definitionLine?: number;
  diffStatus?: string;
  deployStatus?: string;
  deployMessage?: string;
  portalUrl?: string;
  outputResources?: Array<ResourceOutput | null>;
  connections?: Array<ResourceConnection | null>;
}

export function parseGraphResources(value: unknown): GraphResource[] {
  return Array.isArray(value) ?
      value.filter((entry): entry is GraphResource => isRecord(entry))
    : [];
}

export type DeployBadgeKind = "success" | "failed" | "progress";

export interface TypeStyle {
  bg: string;
  border: string;
  shape: string;
  category: string;
}

const MANAGED_CLUSTER_TYPE = "microsoft.containerservice/managedclusters";

// Maps a deploy status to the corner status badge shown on each node while a
// deployment is in flight: a resource that is queued or deploying shows a
// progress spinner, a completed one a green check, and a failed one a red X.
export function radiusDeployBadgeKind(status?: string): DeployBadgeKind {
  const s = status || "pending";
  if (s === "success") return "success";
  if (s === "failed") return "failed";
  return "progress";
}

// The accessible name for the corner badge, the same three states the badge
// glyph draws.
export function radiusDeployBadgeAlt(kind: DeployBadgeKind): string {
  if (kind === "failed") return "Failed";
  if (kind === "success") return "Deployed";
  return "In progress";
}

export function radiusIsManagedClusterType(type?: string): boolean {
  return (
    String(type || "")
      .split("@")[0]
      .toLowerCase() === MANAGED_CLUSTER_TYPE
  );
}

export function radiusIsManagedClusterResource(
  resource: GraphResource | null | undefined
): boolean {
  if (!resource) return false;
  if (radiusIsManagedClusterType(resource.type)) return true;
  const outputs = resource.outputResources || [];
  for (let i = 0; i < outputs.length; i++) {
    const output = outputs[i];
    if (output && radiusIsManagedClusterType(output.type)) return true;
  }
  return false;
}

// Inline SVG (as a data URI, mirroring radiusGetIconSvg) for a status badge.
// Memoized because the markup and encoding are a pure function of the kind.
const deployBadgeSvgCache = new Map<string, string>();

export function radiusDeployBadgeSvg(kind?: string): string {
  const k = kind || "progress";
  const cached = deployBadgeSvgCache.get(k);
  if (cached !== undefined) return cached;
  let svg: string;
  if (k === "success") {
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#1a7f37"/><path d="M4.3 8.2l2.3 2.3 4.8-5" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  } else if (k === "failed") {
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#cf222e" stroke-width="2.4" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  } else {
    // Circular progress indicator (queued / in progress). The animation belongs
    // to the shared asset so every consumer (node and legend) has the same
    // indefinite lifecycle; terminal states replace this asset entirely.
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none"><style>@keyframes spin{to{transform:rotate(360deg)}}.spinner{animation:spin 1s linear infinite;transform-origin:8px 8px}@media (prefers-reduced-motion:reduce){.spinner{animation:none}}</style><circle cx="8" cy="8" r="5.5" stroke="#8c959f" stroke-width="2" opacity=".35"/><g class="spinner"><path d="M8 2.5a5.5 5.5 0 015.5 5.5" stroke="#0969da" stroke-width="2" stroke-linecap="round"/></g></svg>';
  }
  svg = svg.replace("<svg ", '<svg width="40" height="40" ');
  const uri = "data:image/svg+xml," + encodeURIComponent(svg);
  deployBadgeSvgCache.set(k, uri);
  return uri;
}

export function radiusGetIconSvg(type?: string): string {
  if (!type) return "";
  const t = type.toLowerCase();
  let svg: string;
  if (
    t.includes("container") &&
    !t.includes("image") &&
    !t.includes("registry")
  ) {
    // Container / K8s Deployment
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#326ce5"><path d="M10.204 14.35l.007.01-.999 2.413a5.171 5.171 0 01-2.075-2.597l2.578-.437.489.611zm4.159.613l-.502.504-.467-.467 2.528.46a5.18 5.18 0 01-2.12 2.63l-.95-2.326.511-.801zm-2.246 1.807l.006-.007 1.06 2.594a5.275 5.275 0 01-3.381.015l1.074-2.59.627-.019.614.007zm3.63-5.017l-.564.396-.6-.395 2.68.124a5.18 5.18 0 01-.694 3.304l-1.822-2.028v-1.401zm-7.88-.598l-.598.396 .002 1.396-1.822 2.03a5.18 5.18 0 01-.694-3.305l2.548-.121.564.404v-.8zm4.318-2.834l.6.393-.006 1.393.564.397-2.55.122a5.18 5.18 0 01.694-3.305l.698 1zm-1.64.027l.696-.998a5.18 5.18 0 01.694 3.304l-2.55-.122.564-.396-.005-1.394.601-.394zm-.948-.652l-.627.019-.614-.007.006.007-1.06-2.594a5.275 5.275 0 013.381-.015l-1.074 2.59h-.012zM12 6.042a5.97 5.97 0 015.958 5.958A5.97 5.97 0 0112 17.958 5.97 5.97 0 016.042 12 5.97 5.97 0 0112 6.042M12 4a8 8 0 100 16 8 8 0 000-16z"/></svg>';
  } else if (
    t.includes("image") ||
    t.includes("registry") ||
    /(^|[^a-z])ecr([^a-z]|$)/.test(t)
  ) {
    // Container Registry (ACR / ECR). 'ecr' matched as a delimited token so
    // it does not match words like "secrets".
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="var(--rad-brand, #da4c2a)"><path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 010-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1h-6a1 1 0 00-1 1v6.708A2.486 2.486 0 017.5 9h5V1.5zM5 12.25v3.25a.25.25 0 00.4.2l1.45-1.087a.25.25 0 01.3 0L8.6 15.7a.25.25 0 00.4-.2v-3.25a.25.25 0 00-.25-.25h-3.5a.25.25 0 00-.25.25z"/></svg>';
  } else if (t.includes("gateway") || t.includes("applicationgateway")) {
    // Gateway / App Gateway
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#8250df"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zM2.07 7.5h3.46c.05-1.2.24-2.3.56-3.18.15-.43.34-.8.56-1.1A5.96 5.96 0 002.07 7.5zm4.47 0h2.92c-.05-1.07-.22-2.03-.49-2.78-.27-.75-.6-1.22-.89-1.47-.29.25-.62.72-.89 1.47-.27.75-.44 1.71-.49 2.78H6.54zm2.92 1H6.54c.05 1.07.22 2.03.49 2.78.27.75.6 1.22.89 1.47.29-.25.62-.72.89-1.47.27-.75.44-1.71.49-2.78zm.91 0c-.05 1.2-.24 2.3-.56 3.18-.15.43-.34.8-.56 1.1a5.96 5.96 0 004.58-4.28h-3.46zm3.46-1h-3.46c-.05-1.2-.24-2.3-.56-3.18a3.9 3.9 0 00-.56-1.1 5.96 5.96 0 014.58 4.28zM6.65 3.22c-.22.3-.41.67-.56 1.1-.32.88-.51 1.98-.56 3.18H2.07a5.96 5.96 0 014.58-4.28zm-3.58 5.28h3.46c.05 1.2.24 2.3.56 3.18.15.43.34.8.56 1.1a5.96 5.96 0 01-4.58-4.28z"/></svg>';
  } else if (
    t.includes("route") ||
    t.includes("ingress") ||
    t.includes("lb") ||
    t.includes("loadbalancer")
  ) {
    // Route / Ingress / Load Balancer
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#8250df"><path d="M4 2a2 2 0 100 4 2 2 0 000-4zm-1 2a1 1 0 112 0 1 1 0 01-2 0zm9 6a2 2 0 100 4 2 2 0 000-4zm-1 2a1 1 0 112 0 1 1 0 01-2 0zM6 4h4.5a2.5 2.5 0 010 5H5.5a1.5 1.5 0 000 3H10v-1l2.5 1.5L10 14v-1H5.5a2.5 2.5 0 010-5h5a1.5 1.5 0 000-3H6V4z"/></svg>';
  } else if (t.includes("mysql") || t.includes("dbformysql")) {
    // MySQL
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#00758f"><ellipse cx="8" cy="3.5" rx="5.5" ry="2.2"/><path d="M2.5 3.5v3.2c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V3.5c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/><path d="M2.5 6.7v3.2c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V6.7c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/><path d="M2.5 9.9v2.6c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V9.9c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/></svg>';
  } else if (t.includes("postgres") || t.includes("dbforpostgresql")) {
    // PostgreSQL
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#336791"><ellipse cx="8" cy="3.5" rx="5.5" ry="2.2"/><path d="M2.5 3.5v3.2c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V3.5c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/><path d="M2.5 6.7v3.2c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V6.7c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/><path d="M2.5 9.9v2.6c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V9.9c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/></svg>';
  } else if (
    t.includes("redis") ||
    t.includes("cache") ||
    t.includes("elasticache") ||
    t.includes("memorydb")
  ) {
    // Redis / Cache — stacked diamond shape
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#d82c20"><path d="M8 2L14 5.5 8 9 2 5.5 8 2z"/><path d="M2 7.5L8 11l6-3.5L8 4 2 7.5z" opacity="0.7"/><path d="M2 10L8 13.5 14 10 8 6.5 2 10z" opacity="0.5"/></svg>';
  } else if (
    t.includes("sql") ||
    t.includes("rds") ||
    t.includes("db_instance")
  ) {
    // SQL / RDS generic
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#e48400"><ellipse cx="8" cy="3.5" rx="5.5" ry="2.2"/><path d="M2.5 3.5v3.2c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V3.5c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/><path d="M2.5 6.7v3.2c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V6.7c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/><path d="M2.5 9.9v2.6c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V9.9c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/></svg>';
  } else if (
    t.includes("mongo") ||
    t.includes("cosmos") ||
    t.includes("documentdb") ||
    t.includes("docdb")
  ) {
    // MongoDB / CosmosDB / DocumentDB
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#13aa52"><path d="M8.5 1.2c-.2-.3-.5-.3-.7 0C6.5 3 5 5 5 7.5c0 1.4.7 2.6 1.7 3.3l-.2 3.5c0 .4.3.7.7.7h1.6c.4 0 .7-.3.7-.7l-.2-3.5c1-.7 1.7-1.9 1.7-3.3 0-2.5-1.5-4.5-2.5-6.3zM8 9.5c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg>';
  } else if (t.includes("neo4j")) {
    // Neo4j graph database
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#018bff"><circle cx="5" cy="4" r="2"/><circle cx="11" cy="4" r="2"/><circle cx="8" cy="11" r="2"/><line x1="5" y1="4" x2="11" y2="4" stroke="#018bff" stroke-width="1.2"/><line x1="5" y1="4" x2="8" y2="11" stroke="#018bff" stroke-width="1.2"/><line x1="11" y1="4" x2="8" y2="11" stroke="#018bff" stroke-width="1.2"/></svg>';
  } else if (
    t.includes("rabbit") ||
    t.includes("amqp") ||
    t.includes("servicebus") ||
    t.includes("sqs")
  ) {
    // Messaging (RabbitMQ / Service Bus / SQS)
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#ff6600"><path d="M14 4H2a1 1 0 00-1 1v6a1 1 0 001 1h12a1 1 0 001-1V5a1 1 0 00-1-1zM5 10H3V6h2v4zm4 0H7V6h2v4zm4 0h-2V6h2v4z"/></svg>';
  } else if (
    t.includes("secret") ||
    t.includes("keyvault") ||
    t.includes("secretsmanager")
  ) {
    // Secrets / Key Vault / Secrets Manager
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#1a7f37"><path d="M8 1a4 4 0 00-4 4v2H3a1 1 0 00-1 1v6a1 1 0 001 1h10a1 1 0 001-1V8a1 1 0 00-1-1h-1V5a4 4 0 00-4-4zm-3 6V5a3 3 0 116 0v2H5zm3 3a1.5 1.5 0 01.5 2.91V13.5a.5.5 0 01-1 0v-.59A1.5 1.5 0 018 10z"/></svg>';
  } else if (
    t.includes("volume") ||
    t.includes("persistent") ||
    t.includes("disk") ||
    t.includes("ebs")
  ) {
    // Storage / Volumes / Disks
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#8764b8"><path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v2A1.5 1.5 0 0112.5 7h-9A1.5 1.5 0 012 5.5v-2zm1.5-.5a.5.5 0 00-.5.5v2a.5.5 0 00.5.5h9a.5.5 0 00.5-.5v-2a.5.5 0 00-.5-.5h-9zM2 9.5A1.5 1.5 0 013.5 8h9A1.5 1.5 0 0114 9.5v2a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-2zm1.5-.5a.5.5 0 00-.5.5v2a.5.5 0 00.5.5h9a.5.5 0 00.5-.5v-2a.5.5 0 00-.5-.5h-9zM11 4.5a.5.5 0 11-1 0 .5.5 0 011 0zm1 0a.5.5 0 11-1 0 .5.5 0 011 0zm-1 6a.5.5 0 11-1 0 .5.5 0 011 0zm1 0a.5.5 0 11-1 0 .5.5 0 011 0z"/></svg>';
  } else if (
    t.includes("subnet") ||
    t.includes("security_group") ||
    t.includes("securitygroup") ||
    t.includes("vpc") ||
    t.includes("network")
  ) {
    // Networking / Security Groups / Subnets
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#0078d4"><path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8z"/><path d="M8 4a.75.75 0 01.75.75v2.5h2.5a.75.75 0 010 1.5h-2.5v2.5a.75.75 0 01-1.5 0v-2.5h-2.5a.75.75 0 010-1.5h2.5v-2.5A.75.75 0 018 4z"/></svg>';
  } else if (t.includes("service") && !t.includes("servicebus")) {
    // K8s Service
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#326ce5"><path d="M1 8a7 7 0 1114 0A7 7 0 011 8zm7-6a6 6 0 100 12A6 6 0 008 2zm0 2a1 1 0 110 2 1 1 0 010-2zm0 3.5a1 1 0 110 2 1 1 0 010-2zm0 3.5a1 1 0 110 2 1 1 0 010-2z"/></svg>';
  } else if (t.includes("deployment")) {
    // K8s Deployment
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#326ce5"><path d="M8 1l6.5 3.75v7.5L8 16l-6.5-3.75v-7.5L8 1zm0 1.15L2.5 5.25v6.5L8 14.85l5.5-3.1v-6.5L8 2.15z"/><path d="M8 5l3.5 2v3.5L8 12.5 4.5 10.5V7L8 5z"/></svg>';
  } else {
    // Generic/fallback — cloud resource cube
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#6639ba"><path d="M8 1.5l5.5 3v7L8 14.5l-5.5-3v-7L8 1.5zm0 1.2L3.5 5.5v5.4L8 13.3l4.5-2.4V5.5L8 2.7z"/><path d="M8 5.8L5.5 7.2v2.6L8 11.2l2.5-1.4V7.2L8 5.8z"/></svg>';
  }
  // Inject explicit width/height so the SVG rasterizes crisply as an <img>.
  svg = svg.replace("<svg ", '<svg width="64" height="64" ');
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

// Maps a resource type to a legend category (and a nominal fill/border/shape
// retained for the type legend). Color encodes the category and matches the
// graph legend. Substring matching mirrors radiusGetIconSvg so icon + category
// always agree.
export function radiusGetTypeStyle(type?: string): TypeStyle {
  const t = (type || "").toLowerCase();
  // Compute / workloads
  if (
    (t.includes("container") &&
      !t.includes("image") &&
      !t.includes("registry")) ||
    t.includes("deployment") ||
    (t.includes("service") && !t.includes("servicebus"))
  ) {
    return {
      bg: "#e8f0fe",
      border: "#326ce5",
      shape: "roundrectangle",
      category: "Compute"
    };
  }
  // Container registry (ACR / ECR). The 'ecr' token is matched only as a
  // delimited segment so it does not trip on words like "secrets" (s-ecr-ets).
  if (
    t.includes("image") ||
    t.includes("registry") ||
    /(^|[^a-z])ecr([^a-z]|$)/.test(t)
  ) {
    return {
      bg: "var(--rad-info-bg)",
      border: "var(--rad-info)",
      shape: "roundrectangle",
      category: "Registry"
    };
  }
  // Cache (Redis / ElastiCache / MemoryDB)
  if (
    t.includes("redis") ||
    t.includes("cache") ||
    t.includes("elasticache") ||
    t.includes("memorydb")
  ) {
    return {
      bg: "#fdeceb",
      border: "#d82c20",
      shape: "hexagon",
      category: "Cache"
    };
  }
  // Databases / data stores (relational, document, graph)
  if (
    t.includes("mysql") ||
    t.includes("dbformysql") ||
    t.includes("postgres") ||
    t.includes("dbforpostgresql") ||
    t.includes("sql") ||
    t.includes("rds") ||
    t.includes("db_instance") ||
    t.includes("mongo") ||
    t.includes("cosmos") ||
    t.includes("documentdb") ||
    t.includes("docdb") ||
    t.includes("neo4j")
  ) {
    return {
      bg: "#fdf0e3",
      border: "#e48400",
      shape: "barrel",
      category: "Data Store"
    };
  }
  // Secrets / Key Vault / Secrets Manager
  if (
    t.includes("secret") ||
    t.includes("keyvault") ||
    t.includes("secretsmanager")
  ) {
    return {
      bg: "#e9f5ee",
      border: "#1a7f37",
      shape: "cut-rectangle",
      category: "Secrets"
    };
  }
  // Networking (gateways, routes, ingress, load balancers, VPC/subnets)
  if (
    t.includes("gateway") ||
    t.includes("applicationgateway") ||
    t.includes("route") ||
    t.includes("ingress") ||
    t.includes("lb") ||
    t.includes("loadbalancer") ||
    t.includes("subnet") ||
    t.includes("security_group") ||
    t.includes("securitygroup") ||
    t.includes("vpc") ||
    t.includes("network")
  ) {
    return {
      bg: "#f2ecfb",
      border: "#8250df",
      shape: "tag",
      category: "Networking"
    };
  }
  // Messaging (RabbitMQ / Service Bus / SQS)
  if (
    t.includes("rabbit") ||
    t.includes("amqp") ||
    t.includes("servicebus") ||
    t.includes("sqs")
  ) {
    return {
      bg: "#fff1e6",
      border: "#ff6600",
      shape: "tag",
      category: "Messaging"
    };
  }
  // Storage / volumes / disks
  if (
    t.includes("volume") ||
    t.includes("persistent") ||
    t.includes("disk") ||
    t.includes("ebs")
  ) {
    return {
      bg: "#f0ebf9",
      border: "#8764b8",
      shape: "barrel",
      category: "Storage"
    };
  }
  // Fallback / other cloud resource
  return {
    bg: "#ede9f7",
    border: "#6639ba",
    shape: "roundrectangle",
    category: "Other"
  };
}

// Normalizes an icon supplied by a type/recipe pack into a usable image source
// for the node card <img>. Packs may express an icon as a ready data URI, an
// http(s) URL, or a raw <svg> markup string; anything unrecognized returns ''
// so the caller falls back to the built-in glyph map.
export function radiusNormalizeIcon(icon: unknown): string {
  if (!icon || typeof icon !== "string") return "";
  let s = icon.trim();
  if (!s) return "";
  if (
    s.indexOf("data:") === 0 ||
    s.indexOf("http://") === 0 ||
    s.indexOf("https://") === 0
  ) {
    return s;
  }
  if (s.indexOf("<svg") === 0) {
    if (s.indexOf("width=") === -1) {
      s = s.replace("<svg ", '<svg width="64" height="64" ');
    }
    return "data:image/svg+xml," + encodeURIComponent(s);
  }
  return "";
}

// The minimal resource shape needed to resolve an icon: a pack-supplied icon
// wins, then the built-in type glyph.
export interface IconResource {
  icon?: string;
  type?: string;
  displayType?: string;
}

// Resolves the icon for a resource. The artwork is owned by the resource's
// type/recipe pack, so a pack-supplied icon (r.icon) wins; the built-in
// type->glyph map is only a fallback for types whose pack omits an icon.
export function radiusResolveIcon(
  resource: IconResource | null | undefined
): string {
  const r = resource || {};
  const packIcon = radiusNormalizeIcon(r.icon);
  if (packIcon) return packIcon;
  return radiusGetIconSvg(r.type || r.displayType || "");
}

// Formats a resource type into the "Namespace/typeName" label shown under the
// node name, e.g. "Radius.Compute/containers@2023-10-01-preview" becomes
// "Compute/containers". Strips the vendor prefix and API version.
export function radiusFormatTypeLabel(type?: string): string {
  if (!type) return "";
  const t = String(type).split("@")[0];
  const slash = t.indexOf("/");
  if (slash === -1) return t;
  let ns = t.substring(0, slash);
  const name = t.substring(slash + 1);
  const dot = ns.lastIndexOf(".");
  if (dot !== -1) ns = ns.substring(dot + 1);
  return ns + "/" + name;
}

// Planned and deployed nodes keep the modeled graph's names and topology, but
// show a concrete resource type selected from explicit recipe/deployment
// outputs. Preserve the provider namespace so users can see the exact target.
export function radiusFormatResolvedTypeLabel(type?: string): string {
  return type ? String(type).split("@")[0] : "";
}

// Recipes emit the primary workload or managed service alongside supporting
// resources: a Kubernetes MySQL recipe deploys a credentials Secret and a
// Service next to the Deployment; an Azure one deploys firewall rules and role
// assignments next to the flexibleServer. Rank those supporting kinds below the
// primary so a planned node shows the representative concrete type rather than a
// Secret or a nested firewall rule. Output names are recipe symbol names (not
// the modeled resource name), so the type — not the name — is the reliable
// signal.
const RADIUS_SUPPORTING_OUTPUT_KINDS: Record<string, boolean> = {
  secret: true,
  service: true,
  configmap: true,
  serviceaccount: true,
  role: true,
  rolebinding: true,
  clusterrole: true,
  clusterrolebinding: true,
  ingress: true,
  networkpolicy: true,
  persistentvolumeclaim: true,
  endpoints: true,
  locks: true,
  roleassignments: true,
  privateendpoints: true,
  privatednszones: true,
  userassignedidentities: true
};

export function radiusResolvedOutputRank(out: ResourceOutput): number {
  const type = radiusFormatResolvedTypeLabel(out.type || out.displayType);
  const segments = type.split("/");
  // Nested child resources such as flexibleServers/firewallRules are supporting.
  if (segments.length >= 3) return 0;
  const leaf = segments[segments.length - 1].toLowerCase();
  if (RADIUS_SUPPORTING_OUTPUT_KINDS[leaf]) return 1;
  return 2;
}

export function radiusSelectResolvedResource(
  resource: GraphResource | null | undefined,
  ownedOutputIds?: Record<string, string>,
  ownerId?: string
): ResourceOutput | null {
  const outputs =
    resource && resource.outputResources ? resource.outputResources : [];
  const typedOutputs = outputs.filter((out): out is ResourceOutput => {
    if (!out || !(out.type || out.displayType)) return false;
    // Exclude concrete outputs that are owned by a different top-level resource.
    if (
      ownedOutputIds &&
      ownerId &&
      out.id &&
      ownedOutputIds[out.id] &&
      ownedOutputIds[out.id] !== ownerId
    ) {
      return false;
    }
    return true;
  });
  if (typedOutputs.length === 0) return null;

  // Pick the highest-ranked output; ties keep recipe declaration order so a
  // deterministic primary is chosen when several equal candidates exist.
  let best: ResourceOutput | null = null;
  let bestRank = -1;
  for (let i = 0; i < typedOutputs.length; i++) {
    const rank = radiusResolvedOutputRank(typedOutputs[i]);
    if (rank > bestRank) {
      bestRank = rank;
      best = typedOutputs[i];
    }
  }
  return best;
}

function codeReferenceParts(codeRef: string): {
  path: string;
  line: number;
} {
  if (
    codeRef !== codeRef.trim() ||
    /[\u0000-\u001f\u007f]/.test(codeRef) ||
    // Compiled ARM expressions are not paths. They must be resolved by model
    // validation before graph rendering rather than becoming dead source links.
    codeRef.startsWith("[")
  ) {
    return { path: "", line: 0 };
  }
  const lineMatch = /#L([1-9][0-9]*)$/.exec(codeRef);
  if (codeRef.includes("#") && lineMatch === null) {
    return { path: "", line: 0 };
  }
  const rawPath = codeRef.replace(/#L[1-9][0-9]*$/, "").replace(/\\/g, "/");
  const segments = rawPath.split("/").filter((segment) => segment !== "");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment === "." || segment === ".." || segment.includes(":")
    )
  ) {
    return { path: "", line: 0 };
  }
  return {
    path: segments.join("/"),
    line: lineMatch ? Number(lineMatch[1]) : 0
  };
}

function encodePath(value: string): string {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function githubRepositoryUrl(repo: string): string {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ?
      `https://github.com/${repo}`
    : "";
}

export function githubSourceReferenceUrl(codeRef: string): string {
  if (codeRef !== codeRef.trim() || /[\u0000-\u001f\u007f]/.test(codeRef)) {
    return "";
  }
  try {
    const parsed = new URL(codeRef);
    const segments = parsed.pathname
      .split("/")
      .filter((segment) => segment !== "");
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.toLowerCase() !== "github.com" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.search ||
      segments.length < 5 ||
      segments[2] !== "blob" ||
      (parsed.hash !== "" && !/^#L[1-9][0-9]*$/.test(parsed.hash))
    ) {
      return "";
    }
    return parsed.href;
  } catch {
    return "";
  }
}

// Build the "View source code" URL for a node. When a precise code reference
// is already an exact GitHub branch/file URL, preserve it. A repo-relative
// reference is resolved against this graph's repository and branch. Otherwise
// fall back to the repo tree so the link resolves to a real page instead of a
// dead affordance. Empty only when neither an exact URL nor repo context exists.
//
// Validation requires newly authored metadata to use repo-relative POSIX paths.
// Normalize legacy Windows references here so older stored graphs remain
// navigable; unlike the legacy template-literal source (which had to
// double-escape as /\\\\/g), this regex directly matches one backslash.
export function buildSourceUrl(
  repoUrl: string,
  branch: string,
  codeRef: string,
  branchOverride?: string
): string {
  const exactUrl = githubSourceReferenceUrl(codeRef);
  if (exactUrl) return exactUrl;
  if (!repoUrl) return "";
  const br = branchOverride || branch;
  const reference = codeReferenceParts(codeRef);
  if (reference.path) {
    const fragment = reference.line ? `#L${reference.line}` : "";
    return `${repoUrl.replace(/\/+$/, "")}/blob/${encodePath(br)}/${encodePath(reference.path)}${fragment}`;
  }
  return `${repoUrl.replace(/\/+$/, "")}/tree/${encodePath(br)}`;
}

// Split a codeReference ("path#L31") into its repo-relative path. Used when
// localSource is set to open the on-disk file in the editor canvas. Backslashes
// are normalized so a Windows-generated codeReference is consistent in the DOM,
// in transport, and with the POSIX server contract.
export function srcPathFromRef(codeRef: string): string {
  return codeRef ? codeReferenceParts(codeRef).path : "";
}

export function srcLineFromRef(codeRef: string): number {
  return codeRef ? codeReferenceParts(codeRef).line : 0;
}
