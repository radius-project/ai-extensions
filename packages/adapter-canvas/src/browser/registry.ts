import { resolveBrowserContext } from "./context.js";
import {
  PAGE_REGISTRY_GLOBAL,
  publishBrowserGlobals,
  readBrowserGlobal
} from "./globals.js";
import { createBindingRegistry, NOOP_TEARDOWN } from "./lifecycle.js";
import { isCallable, isRecord } from "./json.js";
import type { BrowserTeardown } from "./lifecycle.js";
import type { BindingRegistry, BrowserContext } from "./ports.js";

export interface PageRegistry {
  readonly bindings: BindingRegistry;
  register(teardown: BrowserTeardown, lifetime: BrowserLifetime): void;
  // Same-document navigators are document-lifetime, so `teardownPage` cannot
  // cancel each other's in-flight requests. Claiming here keeps at most one
  // navigation live so a superseded response can never swap content or push
  // history for the pane the user already left.
  beginNavigation(cancel: BrowserTeardown): void;
  teardownPage(): void;
  teardownAll(): void;
}

export type BrowserLifetime = "page" | "document";

function errorDetail(error: unknown): string {
  return String(error).replace(/^[A-Za-z]*Error:\s*/, "");
}

function createPageRegistry(): PageRegistry {
  const bindings = createBindingRegistry();
  const teardowns: Array<{
    teardown: BrowserTeardown;
    lifetime: BrowserLifetime;
  }> = [];
  let cancelActiveNavigation: BrowserTeardown | null = null;

  function teardownWhere(
    shouldRun: (lifetime: BrowserLifetime) => boolean
  ): void {
    const failures: unknown[] = [];
    for (let index = teardowns.length - 1; index >= 0; index--) {
      const registered = teardowns[index];
      if (!shouldRun(registered.lifetime)) continue;
      teardowns.splice(index, 1);
      try {
        registered.teardown();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `Radius page teardown failed: ${failures.map(errorDetail).join("; ")}`
      );
    }
  }

  return {
    bindings,
    register(teardown, lifetime) {
      teardowns.push({ teardown, lifetime });
    },
    beginNavigation(cancel) {
      const previous = cancelActiveNavigation;
      cancelActiveNavigation = cancel;
      if (previous !== null && previous !== cancel) previous();
    },
    teardownPage() {
      teardownWhere((lifetime) => lifetime === "page");
    },
    teardownAll() {
      teardownWhere(() => true);
    }
  };
}

function isBindingRegistry(value: unknown): value is BindingRegistry {
  return (
    isRecord(value) &&
    isCallable(value.claim) &&
    isCallable(value.release) &&
    isCallable(value.has)
  );
}

function isPageRegistry(value: unknown): value is PageRegistry {
  return (
    isRecord(value) &&
    isBindingRegistry(value.bindings) &&
    isCallable(value.register) &&
    isCallable(value.beginNavigation) &&
    isCallable(value.teardownPage) &&
    isCallable(value.teardownAll)
  );
}

export function resolvePageRegistry(scope: unknown): PageRegistry {
  if (!isRecord(scope)) {
    throw new Error("Radius browser entries need a global object.");
  }
  const existing = readBrowserGlobal(scope, PAGE_REGISTRY_GLOBAL);
  if (existing !== undefined) {
    if (!isPageRegistry(existing)) {
      throw new Error(
        `Radius browser global "${PAGE_REGISTRY_GLOBAL}" is invalid.`
      );
    }
    return existing;
  }
  const registry = createPageRegistry();
  publishBrowserGlobals(scope, { [PAGE_REGISTRY_GLOBAL]: registry }, [
    PAGE_REGISTRY_GLOBAL
  ]);
  return registry;
}

export type BrowserInstaller = (
  context: BrowserContext,
  scope: unknown
) => BrowserTeardown;

export function resolvePageContext(scope: unknown): BrowserContext {
  const registry = resolvePageRegistry(scope);
  return resolveBrowserContext(scope, registry.bindings);
}

export function runBrowserEntry(
  scope: unknown,
  install: BrowserInstaller,
  lifetime: BrowserLifetime = "page"
): BrowserTeardown {
  const registry = resolvePageRegistry(scope);
  const context = resolveBrowserContext(scope, registry.bindings);
  const teardown = install(context, scope);
  if (teardown !== NOOP_TEARDOWN) registry.register(teardown, lifetime);
  return teardown;
}
