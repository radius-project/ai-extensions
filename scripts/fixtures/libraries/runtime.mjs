import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createElement, version } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RadiusGraph, mountRadiusGraph } from "@radius-project/graph-react";

import {
  RADIUS_BRAND_MARK,
  radiusBrandMarkSvg
} from "@radius-project/graph-react/brand";
import {
  normalizeLiveGraph,
  graphContextKey
} from "@radius-project/core/graph";
import { parseResourceId } from "@radius-project/core/domain";

const require = createRequire(import.meta.url);
const context = {
  connectionId: "packed-consumer",
  plane: { type: "radius", name: "local" },
  applicationId:
    "/planes/radius/local/resourceGroups/demo/providers/Radius.Core/applications/demo"
};
const graph = normalizeLiveGraph({ resources: [] }, context);
assert.equal(graph.kind, "live");
assert.deepEqual(graph.resources, []);
assert.equal(parseResourceId(context.applicationId).name, "demo");
assert.equal(typeof graphContextKey(context), "string");
assert.throws(() => normalizeLiveGraph({}, context), /resources/);
assert.equal(typeof mountRadiusGraph, "function");
// The brand mark ships without the renderer so a host can register it as a
// navigation icon: geometry for an icon registry, markup for inline use.
assert.equal(RADIUS_BRAND_MARK.width, 128);
assert.equal(RADIUS_BRAND_MARK.height, 128);
assert.doesNotMatch(RADIUS_BRAND_MARK.body, /<svg/);
assert.match(
  radiusBrandMarkSvg({ size: 26 }),
  /^<svg [^>]*width="26" height="26" aria-hidden="true">/
);
assert.match(
  radiusBrandMarkSvg({ title: "Radius" }),
  /role="img" aria-label="Radius"/
);
assert.match(
  renderToStaticMarkup(createElement(RadiusGraph, { graph })),
  /radius-graph/
);
assert.equal(version, process.argv[2]);
for (const hidden of [
  "@radius-project/core",
  "@radius-project/core/modeling",
  "@radius-project/core/src/graph/index.ts",
  "@radius-project/graph-react/presentation",
  "@radius-project/graph-react/theme.css",
  "@radius-project/graph-react/src/index.ts"
]) {
  assert.throws(() => require.resolve(hidden), {
    code: "ERR_PACKAGE_PATH_NOT_EXPORTED"
  });
}
