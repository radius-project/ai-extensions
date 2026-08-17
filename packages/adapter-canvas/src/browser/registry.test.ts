import { describe, expect, it } from "vitest";
import { PAGE_REGISTRY_GLOBAL } from "./globals.js";
import { NOOP_TEARDOWN } from "./lifecycle.js";
import {
  resolvePageContext,
  resolvePageRegistry,
  runBrowserEntry
} from "./registry.js";
import { createFakeBrowserScope } from "../../test/support/browser/fakes.js";

describe("page-scoped browser registry", () => {
  it("creates one registry on the page global and reuses its binding view", () => {
    const { scope } = createFakeBrowserScope();
    const first = resolvePageRegistry(scope);
    const second = resolvePageRegistry(scope);
    expect(first).toBe(second);
    expect(scope[PAGE_REGISTRY_GLOBAL]).toBe(first);
    expect(resolvePageContext(scope).bindings).toBe(first.bindings);
    expect(resolvePageContext(scope).bindings).toBe(first.bindings);
  });

  it("rejects invalid scopes and a clobbered intended global", () => {
    expect(() => resolvePageRegistry(null)).toThrow(
      "Radius browser entries need a global object."
    );
    const { scope } = createFakeBrowserScope();
    scope[PAGE_REGISTRY_GLOBAL] = { bindings: {} };
    expect(() => resolvePageRegistry(scope)).toThrow(
      `Radius browser global "${PAGE_REGISTRY_GLOBAL}" is invalid.`
    );
  });

  it("runs registered teardowns newest first exactly once", () => {
    const { scope } = createFakeBrowserScope();
    const registry = resolvePageRegistry(scope);
    const order: string[] = [];
    registry.register(() => {
      order.push("first");
    });
    registry.register(() => {
      order.push("second");
    });

    registry.teardownAll();
    registry.teardownAll();

    expect(order).toEqual(["second", "first"]);
  });

  it("continues page cleanup after an entry teardown fails", () => {
    const { scope } = createFakeBrowserScope();
    const registry = resolvePageRegistry(scope);
    const order: string[] = [];
    registry.register(() => {
      order.push("first");
    });
    registry.register(() => {
      order.push("second");
      throw new Error("entry failed");
    });
    registry.register(() => {
      order.push("third");
    });

    expect(() => registry.teardownAll()).toThrow(
      "Radius page teardown failed: entry failed"
    );
    expect(order).toEqual(["third", "second", "first"]);
    expect(() => registry.teardownAll()).not.toThrow();
  });

  it("reports a non-Error page cleanup failure", () => {
    const { scope } = createFakeBrowserScope();
    const registry = resolvePageRegistry(scope);
    registry.register(() => {
      throw "string failure";
    });
    expect(() => registry.teardownAll()).toThrow(
      "Radius page teardown failed: string failure"
    );
  });

  it("registers installed behavior but omits an inert duplicate teardown", () => {
    const { scope } = createFakeBrowserScope();
    let tornDown = 0;
    const teardown = runBrowserEntry(scope, () => () => {
      tornDown += 1;
    });
    expect(teardown).toBeTypeOf("function");
    expect(runBrowserEntry(scope, () => NOOP_TEARDOWN)).toBe(NOOP_TEARDOWN);

    resolvePageRegistry(scope).teardownAll();

    expect(tornDown).toBe(1);
  });
});
