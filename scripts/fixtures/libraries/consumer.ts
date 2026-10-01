import { createElement } from "react";
import { RadiusGraph, mountRadiusGraph } from "@radius-project/graph-react";
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
import { parseResourceId } from "@radius-project/core/domain";
import type { ResourceId } from "@radius-project/core/domain";

const context: GraphContext = {
  connectionId: "packed-consumer",
  plane: { type: "radius", name: "local" },
  applicationId:
    "/planes/radius/local/resourceGroups/demo/providers/Radius.Core/applications/demo"
};
const graph: RadiusGraphData = normalizeLiveGraph({ resources: [] }, context);
const identity: ResourceId | undefined = parseResourceId(context.applicationId);
const props: RadiusGraphProps = { graph };
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
