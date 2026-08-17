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

// A scope-owned timer identity. Cancellation is keyed on this object rather
// than on the host's numeric handle, because browsers allocate timeout and
// interval handles from one pool and reuse them once a timer has fired.
export interface ScopeTimer {
  readonly kind: "interval" | "timeout";
  readonly handle: TimerHandle;
}

export interface EntryScope {
  readonly key: string;
  readonly active: boolean;
  on(target: DomEventTarget, type: string, listener: DomEventListener): void;
  every(intervalMs: number, handler: () => void): ScopeTimer;
  after(timeoutMs: number, handler: () => void): ScopeTimer;
  cancel(timer: ScopeTimer): void;
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
  const timers = new Set<ScopeTimer>();
  const cleanups: BrowserTeardown[] = [];
  let active = true;

  function requireActive(action: string): void {
    if (!active) {
      throw new Error(
        `Cannot ${action} after browser entry "${key}" teardown.`
      );
    }
  }

  function clearTimer(timer: ScopeTimer): void {
    if (timer.kind === "interval") {
      clock.clearInterval(timer.handle);
      return;
    }
    clock.clearTimeout(timer.handle);
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
      const timer: ScopeTimer = {
        kind: "interval",
        handle: clock.setInterval(handler, intervalMs)
      };
      timers.add(timer);
      return timer;
    },
    after(timeoutMs, handler) {
      requireActive("start a timeout");
      const timer = { kind: "timeout" as const, handle: -1 };
      timer.handle = clock.setTimeout(() => {
        timers.delete(timer);
        if (active) handler();
      }, timeoutMs);
      timers.add(timer);
      return timer;
    },
    cancel(timer) {
      if (!timers.delete(timer)) return;
      clearTimer(timer);
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
      for (const timer of timers) {
        attempt(() => clearTimer(timer));
      }
      timers.clear();
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
