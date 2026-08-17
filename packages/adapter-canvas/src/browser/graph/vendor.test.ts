// BU-04: the vendored graph libraries are resolved from the page, or reported
// as unavailable. A page whose inlined vendor bundle did not run must get a
// recoverable answer rather than an exception from deeper in the renderer.

import { describe, it, expect } from "vitest";
import { resolveGraphVendor } from "./vendor.js";
import {
  createFakeDagre,
  createFakeReact,
  createFakeReactDom,
  createFakeReactFlow
} from "../../../test/support/browser/graph-fakes.js";

function scope(overrides: Record<string, unknown> = {}) {
  return {
    React: createFakeReact(),
    ReactDOM: createFakeReactDom(),
    ReactFlow: createFakeReactFlow(),
    dagre: createFakeDagre(),
    ...overrides
  };
}

describe("resolveGraphVendor", () => {
  it("resolves every library the renderer needs", () => {
    const vendor = resolveGraphVendor(scope());
    expect(vendor).not.toBeNull();
    expect(vendor?.reactFlow.Position.Top).toBe("top");
    expect(vendor?.dagre).not.toBeNull();
  });

  it.each([
    ["no React", { React: undefined }],
    ["an incomplete React", { React: { createElement: () => null } }],
    ["no ReactDOM", { ReactDOM: undefined }],
    ["an incomplete ReactDOM", { ReactDOM: {} }],
    ["no React Flow", { ReactFlow: undefined }],
    ["an incomplete React Flow", { ReactFlow: { default: "x" } }],
    [
      "a React Flow without a default export",
      {
        ReactFlow: { ...createFakeReactFlow(), default: undefined }
      }
    ],
    ["no global object at all", null]
  ])("reports %s as unavailable", (_label, overrides) => {
    const value =
      overrides === null ? null : scope(overrides as Record<string, unknown>);
    expect(resolveGraphVendor(value)).toBeNull();
  });

  it("treats a missing or unusable dagre as no layout engine, not a failure", () => {
    expect(resolveGraphVendor(scope({ dagre: undefined }))?.dagre).toBeNull();
    expect(resolveGraphVendor(scope({ dagre: {} }))?.dagre).toBeNull();
    expect(
      resolveGraphVendor(scope({ dagre: { layout: () => undefined } }))?.dagre
    ).toBeNull();
    expect(
      resolveGraphVendor(
        scope({ dagre: { layout: () => undefined, graphlib: {} } })
      )?.dagre
    ).toBeNull();
  });
});
