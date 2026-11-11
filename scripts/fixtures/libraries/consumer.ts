import { createElement } from "react";
import { RadiusGraph, mountRadiusGraph } from "@radius-project/graph-react";
import { AppGraph } from "@radius-project/graph-react/compat";
import type { AppGraphData } from "@radius-project/graph-react/compat";
import { ResourceNode } from "@radius-project/graph-react/compat/reactflow11";
import type { GraphStyle, RadiusGraphProps } from "@radius-project/graph-react";

import {
  RADIUS_BRAND_MARK,
  radiusBrandMarkSvg
} from "@radius-project/graph-react/brand";
import type { RadiusBrandMark } from "@radius-project/graph-react/brand";
import {
  graphContextKey,
  normalizeLiveGraph
} from "@radius-project/core/graph";
import type { GraphContext, RadiusGraphData } from "@radius-project/core/graph";
import {
  parseResourceId,
  parseLegacyResourceId,
  isApplicationType,
  isEnvironmentType,
  createRadiusQueryClient,
  aggregateRecipes
} from "@radius-project/core/domain";
import type { ResourceId, LegacyResourceId } from "@radius-project/core/domain";
import type {
  RadiusQueryPort,
  RadiusQueryRequest,
  Resource,
  ResourceList,
  ApplicationProperties,
  EnvironmentProperties,
  RecipePackProperties,
  QueryResult
} from "@radius-project/core/domain";

function queries(port: RadiusQueryPort, request: RadiusQueryRequest) {
  const withBody: RadiusQueryRequest = {
    ...request,
    body: { includeIcons: true }
  };
  void withBody;
  const client = createRadiusQueryClient(port, request);
  const applications: Promise<QueryResult<ApplicationProperties>> =
    client.listApplications();
  const environments: Promise<ResourceList<EnvironmentProperties>> =
    client.listEnvironments();
  const resource: Promise<Resource<ApplicationProperties>> =
    client.getResourceById<ApplicationProperties>({ id: request.path });
  const packs: Record<string, Resource<RecipePackProperties>> = {};
  const rows = aggregateRecipes({ recipes: {} }, packs);
  return [
    applications,
    environments,
    resource,
    rows,
    client.getApplicationGraph
  ];
}
void queries;

const context: GraphContext = {
  connectionId: "packed-consumer",
  plane: { type: "radius", name: "local" },
  applicationId:
    "/planes/radius/local/resourceGroups/demo/providers/Radius.Core/applications/demo"
};
const graph: RadiusGraphData = normalizeLiveGraph({ resources: [] }, context);
const icon: string | undefined = graph.resources[0]?.icon;
void icon;
const identity: ResourceId | undefined = parseResourceId(context.applicationId);
const legacyIdentity: LegacyResourceId | undefined = parseLegacyResourceId(
  context.applicationId
);
void [legacyIdentity, isApplicationType(), isEnvironmentType(undefined)];
const props: RadiusGraphProps = { graph };
const legacyData: AppGraphData = {
  name: "context-free",
  resources: [
    {
      id: context.applicationId,
      name: "demo",
      type: "Applications.Core/applications",
      provider: "Applications.Core",
      provisioningState: "RawPending"
    }
  ]
};
void [
  createElement(AppGraph, { graph: legacyData }),
  createElement(ResourceNode, { data: legacyData.resources[0] })
];
const element = createElement(RadiusGraph, props);
const style: GraphStyle = {
  height: 320,
  fontFamily: "monospace",
  "--radius-graph-node-background": "var(--host-surface)",
  "--radius-graph-host-extension": "8px"
};
const custom = createElement(RadiusGraph, {
  graph,
  appearance: "custom",
  className: "host-graph",
  style
});
const themed = createElement(RadiusGraph, { graph, appearance: "default" });
const mark: RadiusBrandMark = RADIUS_BRAND_MARK;
void [
  identity,
  element,
  custom,
  themed,
  mark,
  radiusBrandMarkSvg({ size: 26, title: "Radius" }),
  graphContextKey(context),
  mountRadiusGraph
];

// The narrow npm package must not expose the internal Node-facing root.
// @ts-expect-error Internal core APIs are intentionally not public exports.
import "@radius-project/core/modeling";
// @ts-expect-error Presentation helpers are workspace-only, not a packed export.
import "@radius-project/graph-react/presentation";
// @ts-expect-error Layout/build internals are not public compatibility APIs.
import "@radius-project/graph-react/build";
// @ts-expect-error Details internals remain private.
import "@radius-project/graph-react/details";

// The published mark is a readonly contract, so one host cannot mutate the
// shared definition out from under another.
// @ts-expect-error The brand mark body is readonly.
RADIUS_BRAND_MARK.body = "";

const invalid: RadiusGraphProps = {
  // @ts-expect-error Renderer inputs must satisfy the public discriminated contract.
  graph: { kind: "not-a-graph", resources: [] }
};
void invalid;

const invalidAppearance: RadiusGraphProps = {
  graph,
  // @ts-expect-error Appearance is a closed choice, not an arbitrary skin name.
  appearance: "host"
};
const invalidToken: GraphStyle = {
  // @ts-expect-error Host graph custom properties accept CSS strings only.
  "--radius-graph-node-background": 12
};
const invalidProperty: GraphStyle = {
  // @ts-expect-error GraphStyle retains CSSProperties validation.
  color: 12
};
const invalidNamespace: GraphStyle = {
  // @ts-expect-error Only the public graph custom-property namespace is open.
  "--unrelated-token": "red"
};
void [invalidAppearance, invalidToken, invalidProperty, invalidNamespace];
