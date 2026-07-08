// @radius-project/shared — Node-runtime helpers shared across Radius adapters.
//
// This package holds impure, Node-only product logic that the pure
// `@radius-project/core` package intentionally excludes (it declares "No SDK /
// HTTP / DOM dependencies"). Adapters (canvas, and any future adapter) import
// from here instead of duplicating process-spawning / download / filesystem
// code.

export {
  RADIUS_BICEP_CONFIG,
  RADIUS_BICEP_CONFIG_JSON,
  resolveExistingRadBinary,
  ensureRadBinary,
  runRadAppGraph,
  buildGraphViaRad,
} from "./rad.mjs";
