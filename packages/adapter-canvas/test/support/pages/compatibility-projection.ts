// Deterministic semantic projection of a rendered canvas page, shared by the
// one-time legacy-oracle generator and the current-renderer compatibility test.
//
// The projection deliberately keeps only reviewable semantics — titles, active
// navigation, ordered element identity, roles, disabled and status semantics,
// request paths, selected ordering-sensitive markers, serialized initial state,
// and digests of inline script payloads — so a fixture can pin behaviour across
// the Phase 3 extraction without committing whole pages or snapshots.
//
// Test-support only: production modules never import this.
import { createHash } from "node:crypto";
import type {
  CanvasDeployResult,
  CanvasGraphConnection,
  CanvasGraphResource,
  CanvasState
} from "../../../src/shared.js";

export interface StateAttributeEntry {
  id: string;
  value: string;
}

export interface PaneVisibilityEntry {
  id: string;
  visibility: "visible" | "hidden";
}

export interface PageProjection {
  title: string;
  activeNav: string;
  navLinks: string[];
  contentIds: string[];
  names: string[];
  roles: string[];
  disabled: string[];
  // Values of the allowlisted elements the server uses to hand initial state to
  // the browser, in document order.
  stateValues: StateAttributeEntry[];
  // Active secondary navigation targets (graph sub-tabs, environment sub-tabs),
  // in document order.
  activeSubtabs: string[];
  // Normalized visibility of the allowlisted panes, in document order.
  panes: PaneVisibilityEntry[];
  statuses: Array<{ id: string; className: string; text: string }>;
  apiPaths: string[];
  // Indices into the case's marker list, in document order, so a reordering
  // fails without storing the marker text a second time.
  markerOrder: number[];
  missingMarkers: string[];
  initialState: Record<string, string>;
  removedTokens: string[];
  scriptDigests: Record<string, string>;
}

export interface ProjectionOptions {
  // Ordering-sensitive markers chosen for the state under test.
  markers: readonly string[];
  // Inline script payloads whose bytes must not drift, by payload name.
  hashedScripts: readonly string[];
  // Page bodies project their main content; the bare shell projects the
  // whole document.
  scope?: "content" | "document";
}

// Tokens the recipe-pack refactor removed. A page that reintroduces one fails
// the oracle rather than silently regaining generated-bicep behaviour.
const REMOVED_TOKENS = [
  "bicepGenerated",
  "generatedWarning",
  "defGenerated",
  "/generated-bicep",
  "/api/generate-bicep",
  "/api/generate-recipe"
] as const;

// Serialized server state the browser reads on load.
const INITIAL_STATE_NAMES = [
  "CONTEXT_REPO",
  "CONTEXT_BRANCH",
  "CONTEXT_ENV",
  "CURRENT_BRANCH",
  "STATE_BASE",
  "STATE_HEAD",
  "DIFF_BASE",
  "DIFF_HEAD",
  "CTX_REPO",
  "CTX_BRANCH",
  "GRAPH_BRANCH",
  "FALLBACK_PROVIDER",
  "resources"
] as const;

// Elements that carry initial server state to the browser through an HTML
// attribute rather than a script literal. Only these ids are projected, so the
// oracle records state hand-off semantics without storing every attribute.
const STATE_ATTRIBUTE_IDS = [
  "graph-repo",
  "diff-repo-select",
  "target-repo",
  "env-name-input",
  "deploy-branch-select",
  "az-app-name-input"
] as const;

// Panes whose visibility is the rendered sub-tab selection.
const PANE_IDS = ["pane-environments", "pane-credentials"] as const;
const PAGE_STATE_IDS = [
  "radius-graph-page-state",
  "radius-planned-graph-state",
  "radius-graph-diff-state",
  "radius-deployed-graph-state"
] as const;

// Inline payloads are named by a stable anchor rather than by position, so the
// name survives block reordering and empty vendor slots. Phase 4 blocks name
// themselves with a marker comment the renderer emits, so a compiled entry is
// never confused with a page's own script.
const SCRIPT_ANCHORS: ReadonlyArray<readonly [string, string]> = [
  ["repoBranch", "function radiusSetupRepoBranch("],
  ["graph", "function radiusRenderGraph("],
  ["deleteDialog", "function radiusCreateDeleteDeploymentDialog("],
  ["heartbeat", "/api/ping"],
  ["opchip", "radiusOpChipAck"],
  ["feedback", "rad-feedback-btn"]
];

const ENTRY_MARKER = /^\s*\/\/ radius:browser-entry ([a-z-]+)/;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function scriptSources(html: string): string[] {
  return (html.match(/<script>[\s\S]*?<\/script>/g) ?? []).map((block) =>
    block.slice("<script>".length, -"</script>".length)
  );
}

function nameScript(source: string): string {
  if (source.trim() === "") return "vendor";
  const entry = source.match(ENTRY_MARKER)?.[1];
  if (entry !== undefined) return `entry:${entry}`;
  for (const [name, anchor] of SCRIPT_ANCHORS) {
    if (source.includes(anchor)) return name;
  }
  return "page";
}

function stripBlocks(html: string): string {
  return html
    .replace(/<script>[\s\S]*?<\/script>/g, "")
    .replace(/<style>[\s\S]*?<\/style>/g, "");
}

function contentScope(html: string, scope: "content" | "document"): string {
  if (scope === "document") return html;
  const start = html.indexOf('<div class="main-content">');
  const end = html.indexOf('<div id="rad-feedback"');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("page shell content region not found");
  }
  return html.slice(start, end);
}

function plainText(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function hiddenPageState(
  markup: string
): { id: string; value: Record<string, unknown> } | null {
  for (const id of PAGE_STATE_IDS) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = markup.match(
      new RegExp(`<div hidden id="${escaped}">([\\s\\S]*?)</div>`)
    );
    if (!match) continue;
    const parsed: unknown = JSON.parse(decodeHtmlText(match[1]));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return { id, value: parsed as Record<string, unknown> };
    }
  }
  return null;
}

function stateString(state: Record<string, unknown>, name: string): string {
  const value = state[name];
  return typeof value === "string" ? value : "";
}

function stateBoolean(state: Record<string, unknown>, name: string): boolean {
  return state[name] === true;
}

function stateArray(state: Record<string, unknown>, name: string): unknown[] {
  const value = state[name];
  return Array.isArray(value) ? value : [];
}

function singleQuoted(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function projectHiddenInitialState(
  pageState: { id: string; value: Record<string, unknown> } | null
): Record<string, string> | null {
  if (!pageState) return null;
  const state = pageState.value;
  const repo = stateString(state, "repo");
  const branch = stateString(state, "branch");
  const resources = stateArray(state, "resources");
  switch (pageState.id) {
    case "radius-graph-page-state":
      return stateBoolean(state, "loaded") ?
          {
            CONTEXT_REPO: "document.getElementById('graph-repo').value",
            CURRENT_BRANCH: singleQuoted(branch),
            resources: JSON.stringify(resources)
          }
        : {
            CONTEXT_REPO: singleQuoted(repo),
            CONTEXT_BRANCH: singleQuoted(branch)
          };
    case "radius-planned-graph-state": {
      const projected: Record<string, string> = {
        CONTEXT_REPO: singleQuoted(repo),
        CONTEXT_BRANCH: singleQuoted(branch),
        CONTEXT_ENV: singleQuoted(stateString(state, "environment"))
      };
      if (resources.length > 0) projected.resources = JSON.stringify(resources);
      return projected;
    }
    case "radius-graph-diff-state":
      return resources.length > 0 ?
          {
            DIFF_BASE: singleQuoted(stateString(state, "base")),
            DIFF_HEAD: singleQuoted(stateString(state, "head")),
            resources: JSON.stringify(resources)
          }
        : {
            CONTEXT_REPO: "document.getElementById('diff-repo-select').value",
            STATE_BASE: singleQuoted(stateString(state, "base")),
            STATE_HEAD: singleQuoted(stateString(state, "head"))
          };
    case "radius-deployed-graph-state":
      return {
        CONTEXT_REPO: JSON.stringify(repo),
        CONTEXT_BRANCH: JSON.stringify(branch),
        GRAPH_BRANCH: JSON.stringify(stateString(state, "graphBranch")),
        FALLBACK_PROVIDER: JSON.stringify(stateString(state, "provider"))
      };
    default:
      return null;
  }
}

function expectedHiddenApiPaths(
  pageState: { id: string; value: Record<string, unknown> } | null
): string[] | null {
  if (!pageState) return null;
  switch (pageState.id) {
    case "radius-graph-page-state":
      return stateBoolean(pageState.value, "loaded") ?
          [
            "/api/list-applications",
            "/api/discover-branches",
            "/api/load-graph"
          ]
        : [
            "/api/list-applications",
            "/api/discover-branches",
            "/api/load-graph",
            "/api/progress"
          ];
    case "radius-planned-graph-state":
      return stateArray(pageState.value, "resources").length > 0 ?
          ["/api/plan-graph"]
        : ["/api/progress", "/api/plan-graph"];
    case "radius-graph-diff-state":
      return ["/api/diff-branches"];
    case "radius-deployed-graph-state":
      return [
        "/api/deploy-status",
        "/api/deployed-graph",
        "/api/list-applications",
        "/api/list-environments",
        "/api/list-deployments",
        "/api/delete-deployment"
      ];
    default:
      return null;
  }
}

function projectVerifiedApiPaths(
  scoped: string,
  pageState: { id: string; value: Record<string, unknown> } | null
): string[] {
  const observed = uniqueInOrder(
    matchAllGroups(scoped, /['"`(](\/api\/[a-z0-9-]+)/g)
  );
  const expected = expectedHiddenApiPaths(pageState);
  if (!expected) return observed;
  for (const path of expected) {
    if (!observed.includes(path)) {
      throw new Error(
        `compiled browser entry no longer contains expected path "${path}"`
      );
    }
  }
  return expected;
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)];
}

// Read the state an element hands to the browser: the element's own `value`, or
// for a <select> the value of its first option (how the deploying page seeds
// the branch selector).
function stateValueOf(markup: string, id: string): string | undefined {
  const tagStart = markup.search(new RegExp(`<[a-z]+[^>]*\\sid="${id}"`));
  if (tagStart < 0) return undefined;
  const tagEnd = markup.indexOf(">", tagStart);
  if (tagEnd < 0) return undefined;
  const tag = markup.slice(tagStart, tagEnd + 1);
  const value = tag.match(/\svalue="([^"]*)"/)?.[1];
  if (value !== undefined) return value;
  if (!tag.startsWith("<select")) return undefined;
  const closing = markup.indexOf("</select>", tagEnd);
  const options = markup.slice(tagEnd, closing < 0 ? undefined : closing);
  return options.match(/<option value="([^"]*)"/)?.[1];
}

function projectStateValues(markup: string): StateAttributeEntry[] {
  const found: Array<{ id: string; value: string; at: number }> = [];
  for (const id of STATE_ATTRIBUTE_IDS) {
    const value = stateValueOf(markup, id);
    if (value === undefined) continue;
    found.push({
      id,
      value,
      at: markup.search(new RegExp(`<[a-z]+[^>]*\\sid="${id}"`))
    });
  }
  return found
    .sort((left, right) => left.at - right.at)
    .map(({ id, value }) => ({ id, value }));
}

function projectPanes(markup: string): PaneVisibilityEntry[] {
  const found: Array<{ id: string; tag: string; at: number }> = [];
  for (const id of PANE_IDS) {
    const tag = markup.match(
      new RegExp(`<[a-z]+[^>]*\\sid="${id}"[^>]*>`)
    )?.[0];
    if (tag === undefined) continue;
    found.push({
      id,
      tag,
      at: markup.search(new RegExp(`<[a-z]+[^>]*\\sid="${id}"`))
    });
  }
  return found
    .sort((left, right) => left.at - right.at)
    .map(({ id, tag }) => ({
      id,
      visibility: /display\s*:\s*none/.test(tag) ? "hidden" : "visible"
    }));
}

// Active secondary navigation: graph sub-tabs identify themselves with
// data-page, environment sub-tabs with data-subtab, and anything else falls
// back to its href.
function projectActiveSubtabs(markup: string): string[] {
  return [...markup.matchAll(/<a\s[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => /\sclass="[^"]*\brad-subtab--active\b[^"]*"/.test(tag))
    .map(
      (tag) =>
        tag.match(/\sdata-page="([^"]*)"/)?.[1] ??
        tag.match(/\sdata-subtab="([^"]*)"/)?.[1] ??
        tag.match(/\shref="([^"]*)"/)?.[1] ??
        ""
    );
}

function matchAllGroups(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

export function projectPage(
  html: string,
  options: ProjectionOptions
): PageProjection {
  const scope = options.scope ?? "content";
  const scoped = contentScope(html, scope);
  const markup = stripBlocks(scoped);
  const pageState = hiddenPageState(markup);

  const activeNav =
    html.match(
      /<a href="\/\?page=([a-z-]+)" class="rad-topnav__tab rad-topnav__tab--active"/
    )?.[1] ?? "";

  const statuses = [
    ...markup.matchAll(
      /<div id="([^"]+)"[^>]*class="(status[^"]*|rad-status[^"]*)"[^>]*>([\s\S]*?)<\/div>/g
    )
  ].map((match) => ({
    id: match[1],
    className: match[2],
    text: plainText(match[3])
  }));

  const disabled = [...markup.matchAll(/<[a-z]+\s[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => /\sdisabled(\s|>|=)/.test(tag))
    .map((tag) => tag.match(/\sid="([^"]+)"/)?.[1] ?? "")
    .filter((id) => id !== "");

  const initialState: Record<string, string> = {};
  for (const name of INITIAL_STATE_NAMES) {
    const literal = scoped.match(
      new RegExp(`(?:^|\\n)var ${name} = (.*);(?:\\n|$)`)
    )?.[1];
    if (literal !== undefined) initialState[name] = literal;
  }
  const attemptId = scoped.match(/attemptId: (.*)\}\)/)?.[1];
  if (attemptId !== undefined) initialState.attemptId = attemptId;
  const hiddenInitialState = projectHiddenInitialState(pageState);
  if (hiddenInitialState) {
    for (const name of Object.keys(initialState)) delete initialState[name];
    Object.assign(initialState, hiddenInitialState);
  }

  const markerIndex = options.markers.map(
    (marker, position) => [position, html.indexOf(marker)] as const
  );
  const markerOrder = markerIndex
    .filter(([, index]) => index >= 0)
    .sort((left, right) => left[1] - right[1])
    .map(([position]) => position);
  const missingMarkers = markerIndex
    .filter(([, index]) => index < 0)
    .map(([position]) => options.markers[position]);

  const digests: Record<string, string> = {};
  const payloads = new Map<string, string[]>();
  for (const source of scriptSources(html)) {
    const name = nameScript(source);
    payloads.set(name, [...(payloads.get(name) ?? []), source]);
  }
  for (const name of options.hashedScripts) {
    const parts = payloads.get(name);
    if (!parts) throw new Error(`no inline script payload named "${name}"`);
    digests[name] = sha256(parts.join("\n"));
  }

  return {
    title: html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "",
    activeNav,
    navLinks: uniqueInOrder(
      matchAllGroups(markup, /href="\/?\?page=([^"]+)"/g)
    ),
    contentIds: matchAllGroups(markup, /\sid="([^"]+)"/g).filter(
      (id) => !PAGE_STATE_IDS.includes(id as (typeof PAGE_STATE_IDS)[number])
    ),
    names: matchAllGroups(markup, /\sname="([^"]+)"/g),
    roles: matchAllGroups(markup, /\srole="([^"]+)"/g),
    disabled,
    stateValues: projectStateValues(markup),
    activeSubtabs: projectActiveSubtabs(markup),
    panes: projectPanes(markup),
    statuses,
    apiPaths: projectVerifiedApiPaths(scoped, pageState),
    markerOrder,
    missingMarkers,
    initialState,
    removedTokens: REMOVED_TOKENS.filter((token) => html.includes(token)),
    scriptDigests: digests
  };
}

export interface CompatibilityCase {
  id: string;
  page: string;
  description: string;
  state: CanvasState;
  markers: string[];
  hashedScripts: string[];
  scope?: "content" | "document";
  shellTitle?: string;
  shellBody?: string;
  shellActiveNav?: string;
  expected: PageProjection;
}

export interface PageCompatibilityFixture {
  schemaVersion: number;
  source: {
    commit: string;
    shortCommit: string;
    path: string;
    description: string;
    generator: string;
    projection: string;
    hostileInputs: string;
    excludedScriptPayloads: string[];
    updatePolicy: string;
  };
  exports: string[];
  // Inline payloads the shell composes into every page. Recorded once and
  // asserted on every case, rather than repeated per case.
  sharedScriptDigests: Record<string, string>;
  cases: CompatibilityCase[];
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => asString(entry, `${field}[${index}]`));
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number") throw new Error(`${field} must be a number`);
  return value;
}

function asNumberArray(value: unknown, field: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => asNumber(entry, `${field}[${index}]`));
}

function asDigestRecord(value: unknown, field: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(asRecord(value, field)).map(([key, entry]) => [
      key,
      asString(entry, `${field}.${key}`)
    ])
  );
}

// The state hand-off and pane fields are required: a fixture that omits them
// would silently stop covering initial-state attributes or sub-tab selection.
function asStateValues(value: unknown, field: string): StateAttributeEntry[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => {
    const record = asRecord(entry, `${field}[${index}]`);
    const id = asString(record.id, `${field}[${index}].id`);
    if (
      !STATE_ATTRIBUTE_IDS.includes(id as (typeof STATE_ATTRIBUTE_IDS)[number])
    ) {
      throw new Error(`${field}[${index}].id is not an allowlisted state id`);
    }
    return { id, value: asString(record.value, `${field}[${index}].value`) };
  });
}

function asPanes(value: unknown, field: string): PaneVisibilityEntry[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => {
    const record = asRecord(entry, `${field}[${index}]`);
    const id = asString(record.id, `${field}[${index}].id`);
    if (!PANE_IDS.includes(id as (typeof PANE_IDS)[number])) {
      throw new Error(`${field}[${index}].id is not an allowlisted pane id`);
    }
    const visibility = record.visibility;
    if (visibility !== "visible" && visibility !== "hidden") {
      throw new Error(`${field}[${index}].visibility is invalid`);
    }
    return { id, visibility };
  });
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

const CONNECTION_PARSERS: Record<
  string,
  (value: unknown, field: string) => unknown
> = {
  id: asString,
  name: asString,
  direction: asString,
  diffStatus: asString
};

// Keys are copied in the fixture's own order: the renderers serialize state
// with JSON.stringify, so reordering here would change the emitted literal and
// make the oracle compare against a value the legacy commit never produced.
function asConnection(value: unknown, field: string): CanvasGraphConnection {
  const record = asRecord(value, field);
  const connection: CanvasGraphConnection = {};
  for (const [key, entry] of Object.entries(record)) {
    const parse = CONNECTION_PARSERS[key];
    if (!parse) {
      throw new Error(`${field}.${key} is not an oracle connection key`);
    }
    connection[key] = parse(entry, `${field}.${key}`);
  }
  return connection;
}

function asConnections(value: unknown, field: string): CanvasGraphConnection[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => asConnection(entry, `${field}[${index}]`));
}

const RESOURCE_PARSERS: Record<
  string,
  (value: unknown, field: string) => unknown
> = {
  id: asString,
  name: asString,
  type: asString,
  diffStatus: asString,
  codeReference: asString,
  deployStatus: asString,
  deployMessage: asString,
  portalUrl: asString,
  connections: asConnections
};

function asResource(value: unknown, field: string): CanvasGraphResource {
  const record = asRecord(value, field);
  const resource: CanvasGraphResource = {};
  for (const [key, entry] of Object.entries(record)) {
    const parse = RESOURCE_PARSERS[key];
    if (!parse)
      throw new Error(`${field}.${key} is not an oracle resource key`);
    resource[key] = parse(entry, `${field}.${key}`);
  }
  return resource;
}

function asResources(value: unknown, field: string): CanvasGraphResource[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => asResource(entry, `${field}[${index}]`));
}

function asDeployResult(value: unknown, field: string): CanvasDeployResult {
  const record = asRecord(value, field);
  const result: CanvasDeployResult = {};
  for (const [key, entry] of Object.entries(record)) {
    if (!["error", "message", "workflowUrl", "workflow"].includes(key)) {
      throw new Error(`${field}.${key} is not an oracle deploy-result key`);
    }
    result[key as keyof CanvasDeployResult] = asString(
      entry,
      `${field}.${key}`
    );
  }
  return result;
}

// Every state key the oracle is allowed to exercise. Parsing rather than
// casting keeps the fixture honest: an unlisted or mistyped key fails loudly
// instead of silently rendering a different page than the legacy commit did.
const STATE_PARSERS: Record<
  string,
  (value: unknown, field: string) => unknown
> = {
  contextRepo: asString,
  contextBranch: asString,
  targetRepo: asString,
  envName: asString,
  activeSubtab: asString,
  graphResources: asResources,
  graphTargetRepo: asString,
  graphBranch: asString,
  graphFromWorkspace: asBoolean,
  graphLoaded: asBoolean,
  plannedResources: asResources,
  plannedRepo: asString,
  plannedBranch: asString,
  plannedEnvironment: asString,
  plannedProvider: asString,
  plannedFromWorkspace: asBoolean,
  deployProvider: asString,
  deployingRepo: asString,
  deployingBranch: asString,
  diffResources: asResources,
  diffBase: asString,
  diffHead: asString,
  diffTargetRepo: asString,
  diffError: asString,
  branches: asStringArray,
  branchShas: asDigestRecord,
  workspacePath: asString,
  workspaceRepo: asString,
  workspaceBranch: asString,
  deployResult: asDeployResult,
  deployAttempt: (value, field) => {
    const record = asRecord(value, field);
    return { id: asString(record.id, `${field}.id`) };
  }
};

export function parseCanvasState(value: unknown, field: string): CanvasState {
  const record = asRecord(value, field);
  const state: CanvasState = {};
  for (const [key, entry] of Object.entries(record)) {
    const parse = STATE_PARSERS[key];
    if (!parse) throw new Error(`${field}.${key} is not an oracle state key`);
    state[key] = parse(entry, `${field}.${key}`);
  }
  return state;
}

function asProjection(value: unknown, field: string): PageProjection {
  const record = asRecord(value, field);
  const statuses = record.statuses;
  if (!Array.isArray(statuses)) {
    throw new Error(`${field}.statuses must be an array`);
  }
  const initialState = asRecord(record.initialState, `${field}.initialState`);
  return {
    title: asString(record.title, `${field}.title`),
    activeNav: asString(record.activeNav, `${field}.activeNav`),
    navLinks: asStringArray(record.navLinks, `${field}.navLinks`),
    contentIds: asStringArray(record.contentIds, `${field}.contentIds`),
    names: asStringArray(record.names, `${field}.names`),
    roles: asStringArray(record.roles, `${field}.roles`),
    disabled: asStringArray(record.disabled, `${field}.disabled`),
    stateValues: asStateValues(record.stateValues, `${field}.stateValues`),
    activeSubtabs: asStringArray(
      record.activeSubtabs,
      `${field}.activeSubtabs`
    ),
    panes: asPanes(record.panes, `${field}.panes`),
    statuses: statuses.map((entry, index) => {
      const status = asRecord(entry, `${field}.statuses[${index}]`);
      return {
        id: asString(status.id, `${field}.statuses[${index}].id`),
        className: asString(
          status.className,
          `${field}.statuses[${index}].className`
        ),
        text: asString(status.text, `${field}.statuses[${index}].text`)
      };
    }),
    apiPaths: asStringArray(record.apiPaths, `${field}.apiPaths`),
    markerOrder: asNumberArray(record.markerOrder, `${field}.markerOrder`),
    missingMarkers: asStringArray(
      record.missingMarkers,
      `${field}.missingMarkers`
    ),
    initialState: Object.fromEntries(
      Object.entries(initialState).map(([key, entry]) => [
        key,
        asString(entry, `${field}.initialState.${key}`)
      ])
    ),
    removedTokens: asStringArray(
      record.removedTokens,
      `${field}.removedTokens`
    ),
    scriptDigests: asDigestRecord(
      record.scriptDigests,
      `${field}.scriptDigests`
    )
  };
}

// Typed validation rather than a cast, so a malformed or truncated fixture
// fails loudly instead of silently weakening the oracle.
export function parsePageCompatibilityFixture(
  value: unknown
): PageCompatibilityFixture {
  const root = asRecord(value, "fixture");
  const source = asRecord(root.source, "fixture.source");
  const cases = root.cases;
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error("fixture.cases must be a non-empty array");
  }
  if (typeof root.schemaVersion !== "number") {
    throw new Error("fixture.schemaVersion must be a number");
  }
  return {
    schemaVersion: root.schemaVersion,
    source: {
      commit: asString(source.commit, "fixture.source.commit"),
      shortCommit: asString(source.shortCommit, "fixture.source.shortCommit"),
      path: asString(source.path, "fixture.source.path"),
      description: asString(source.description, "fixture.source.description"),
      generator: asString(source.generator, "fixture.source.generator"),
      projection: asString(source.projection, "fixture.source.projection"),
      hostileInputs: asString(
        source.hostileInputs,
        "fixture.source.hostileInputs"
      ),
      excludedScriptPayloads: asStringArray(
        source.excludedScriptPayloads,
        "fixture.source.excludedScriptPayloads"
      ),
      updatePolicy: asString(source.updatePolicy, "fixture.source.updatePolicy")
    },
    exports: asStringArray(root.exports, "fixture.exports"),
    sharedScriptDigests: asDigestRecord(
      root.sharedScriptDigests,
      "fixture.sharedScriptDigests"
    ),
    cases: cases.map((entry, index) => {
      const testCase = asRecord(entry, `fixture.cases[${index}]`);
      const scope = testCase.scope;
      if (scope !== undefined && scope !== "content" && scope !== "document") {
        throw new Error(`fixture.cases[${index}].scope is invalid`);
      }
      return {
        id: asString(testCase.id, `fixture.cases[${index}].id`),
        page: asString(testCase.page, `fixture.cases[${index}].page`),
        description: asString(
          testCase.description,
          `fixture.cases[${index}].description`
        ),
        state: parseCanvasState(
          testCase.state,
          `fixture.cases[${index}].state`
        ),
        markers: asStringArray(
          testCase.markers,
          `fixture.cases[${index}].markers`
        ),
        hashedScripts: asStringArray(
          testCase.hashedScripts,
          `fixture.cases[${index}].hashedScripts`
        ),
        scope,
        shellTitle:
          testCase.shellTitle === undefined ?
            undefined
          : asString(testCase.shellTitle, `fixture.cases[${index}].shellTitle`),
        shellBody:
          testCase.shellBody === undefined ?
            undefined
          : asString(testCase.shellBody, `fixture.cases[${index}].shellBody`),
        shellActiveNav:
          testCase.shellActiveNav === undefined ?
            undefined
          : asString(
              testCase.shellActiveNav,
              `fixture.cases[${index}].shellActiveNav`
            ),
        expected: asProjection(
          testCase.expected,
          `fixture.cases[${index}].expected`
        )
      };
    })
  };
}
