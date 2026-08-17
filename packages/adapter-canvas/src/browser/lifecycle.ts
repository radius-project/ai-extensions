import type {
  BindingRegistry,
  BrowserContext,
  ClockPort,
  DomEventListener,
  DomEventTarget,
  TimerHandle
} from "./ports.js";

export type BrowserTeardown = () => void;

export function createBindingRegistry(): BindingRegistry {
  const claimed = new Set<string>();
  return {
    claim(key) {
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
    release(key) {
      claimed.delete(key);
    },
    has(key) {
      return claimed.has(key);
    }
  };
}

export interface EntryScope {
  readonly key: string;
  readonly active: boolean;
  on(target: DomEventTarget, type: string, listener: DomEventListener): void;
  every(intervalMs: number, handler: () => void): TimerHandle;
  after(timeoutMs: number, handler: () => void): TimerHandle;
  cancel(handle: TimerHandle): void;
  onTeardown(cleanup: BrowserTeardown): void;
  teardown(): void;
}

interface ListenerRegistration {
  target: DomEventTarget;
  type: string;
  listener: DomEventListener;
}

function errorDetail(error: unknown): string {
  return String(error).replace(/^[A-Za-z]*Error:\s*/, "");
}

function createScope(
  key: string,
  clock: ClockPort,
  release: BrowserTeardown
): EntryScope {
  const listeners: ListenerRegistration[] = [];
  const intervals = new Set<TimerHandle>();
  const timeouts = new Set<TimerHandle>();
  const cleanups: BrowserTeardown[] = [];
  let active = true;

  function requireActive(action: string): void {
    if (!active) {
      throw new Error(
        `Cannot ${action} after browser entry "${key}" teardown.`
      );
    }
  }

  const scope: EntryScope = {
    key,
    get active() {
      return active;
    },
    on(target, type, listener) {
      requireActive("bind a listener");
      target.addEventListener(type, listener);
      listeners.push({ target, type, listener });
    },
    every(intervalMs, handler) {
      requireActive("start an interval");
      const handle = clock.setInterval(handler, intervalMs);
      intervals.add(handle);
      return handle;
    },
    after(timeoutMs, handler) {
      requireActive("start a timeout");
      let handle = -1;
      handle = clock.setTimeout(() => {
        timeouts.delete(handle);
        if (active) handler();
      }, timeoutMs);
      timeouts.add(handle);
      return handle;
    },
    cancel(handle) {
      if (timeouts.delete(handle)) {
        clock.clearTimeout(handle);
      } else if (intervals.delete(handle)) {
        clock.clearInterval(handle);
      }
    },
    onTeardown(cleanup) {
      requireActive("register cleanup");
      cleanups.push(cleanup);
    },
    teardown() {
      if (!active) return;
      active = false;
      const failures: unknown[] = [];
      const attempt = (cleanup: BrowserTeardown): void => {
        try {
          cleanup();
        } catch (error) {
          failures.push(error);
        }
      };

      for (const registration of listeners.splice(0).reverse()) {
        attempt(() =>
          registration.target.removeEventListener(
            registration.type,
            registration.listener
          )
        );
      }
      for (const handle of intervals) {
        attempt(() => clock.clearInterval(handle));
      }
      intervals.clear();
      for (const handle of timeouts) {
        attempt(() => clock.clearTimeout(handle));
      }
      timeouts.clear();
      for (const cleanup of cleanups.splice(0).reverse()) {
        attempt(cleanup);
      }
      attempt(release);

      if (failures.length > 0) {
        throw new Error(
          `Browser entry "${key}" teardown failed: ${failures
            .map(errorDetail)
            .join("; ")}`
        );
      }
    }
  };
  return scope;
}

export function beginEntry(
  context: BrowserContext,
  key: string
): EntryScope | null {
  if (!context.bindings.claim(key)) return null;
  return createScope(key, context.clock, () => context.bindings.release(key));
}

export const NOOP_TEARDOWN: BrowserTeardown = () => {};
