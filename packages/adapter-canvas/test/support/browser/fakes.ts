import { createBindingRegistry } from "../../../src/browser/lifecycle.js";
import type {
  BrowserContext,
  ClipboardPort,
  ClockPort,
  DomDocument,
  DomElement,
  DomEvent,
  DomEventListener,
  DomEventTarget,
  ExternalOpenPort,
  FocusPort,
  HttpRequestInit,
  HttpResponse,
  LoggerPort,
  NavigationPort,
  NetworkPort,
  StoragePort,
  TimerHandle
} from "../../../src/browser/ports.js";

function fakeEvent(): DomEvent {
  return {
    preventDefault() {},
    stopPropagation() {}
  };
}

export class FakeEventTarget implements DomEventTarget {
  private readonly listeners = new Map<string, Set<DomEventListener>>();

  addEventListener(type: string, listener: DomEventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<DomEventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: DomEventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(fakeEvent());
    }
  }

  listenerCount(type?: string): number {
    if (type !== undefined) return this.listeners.get(type)?.size ?? 0;
    return [...this.listeners.values()].reduce(
      (total, listeners) => total + listeners.size,
      0
    );
  }
}

export class FakeElement extends FakeEventTarget implements DomElement {
  readonly style = { display: "" };
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  focusCount = 0;
  clickCount = 0;

  constructor(readonly id: string) {
    super();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  focus(): void {
    this.focusCount += 1;
  }

  click(): void {
    this.clickCount += 1;
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeElement): void {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
  }
}

export class FakeDocument extends FakeEventTarget implements DomDocument {
  visibilityState = "visible";
  activeElement: unknown = null;
  body: unknown = new FakeElement("body");
  readonly created: FakeElement[] = [];
  private readonly elements = new Map<string, FakeElement>();

  add(element: FakeElement): void {
    this.elements.set(element.id, element);
  }

  getElementById(elementId: string): unknown {
    return this.elements.get(elementId) ?? null;
  }

  createElement(tagName: string): unknown {
    const element = new FakeElement(tagName);
    this.created.push(element);
    return element;
  }
}

interface ClockTask {
  readonly handle: TimerHandle;
  readonly kind: "timeout" | "interval";
  readonly handler: () => void;
  readonly intervalMs: number;
  dueAt: number;
}

export class FakeClock implements ClockPort {
  private readonly tasks = new Map<TimerHandle, ClockTask>();
  private nextHandle = 1;
  private currentTime = 0;

  get pending(): number {
    return this.tasks.size;
  }

  get intervals(): number {
    return [...this.tasks.values()].filter((task) => task.kind === "interval")
      .length;
  }

  get timeouts(): number {
    return [...this.tasks.values()].filter((task) => task.kind === "timeout")
      .length;
  }

  setTimeout(handler: () => void, timeoutMs: number): TimerHandle {
    return this.addTask("timeout", handler, timeoutMs);
  }

  clearTimeout(handle: TimerHandle): void {
    this.tasks.delete(handle);
  }

  setInterval(handler: () => void, intervalMs: number): TimerHandle {
    return this.addTask("interval", handler, intervalMs);
  }

  clearInterval(handle: TimerHandle): void {
    this.tasks.delete(handle);
  }

  now(): number {
    return this.currentTime;
  }

  tick(elapsedMs: number): void {
    const target = this.currentTime + elapsedMs;
    while (true) {
      const next = [...this.tasks.values()]
        .filter((task) => task.dueAt <= target)
        .sort(
          (left, right) =>
            left.dueAt - right.dueAt || left.handle - right.handle
        )[0];
      if (next === undefined) break;
      this.currentTime = next.dueAt;
      if (next.kind === "timeout") {
        this.tasks.delete(next.handle);
      } else {
        next.dueAt += next.intervalMs;
      }
      next.handler();
    }
    this.currentTime = target;
  }

  private addTask(
    kind: ClockTask["kind"],
    handler: () => void,
    delayMs: number
  ): TimerHandle {
    const handle = this.nextHandle++;
    this.tasks.set(handle, {
      handle,
      kind,
      handler,
      intervalMs: delayMs,
      dueAt: this.currentTime + delayMs
    });
    return handle;
  }
}

type NetworkHandler = (
  init?: HttpRequestInit
) => HttpResponse | Promise<HttpResponse>;

export class FakeNetwork implements NetworkPort {
  readonly calls: Array<{ url: string; init?: HttpRequestInit }> = [];
  readonly handlers = new Map<string, NetworkHandler>();
  supportsAbort = true;
  aborted = 0;

  handle(url: string, handler: NetworkHandler): void {
    this.handlers.set(url, handler);
  }

  async fetch(url: string, init?: HttpRequestInit): Promise<HttpResponse> {
    this.calls.push({ url, init });
    const handler = this.handlers.get(url);
    if (handler === undefined) {
      throw new Error(`Unexpected browser request: ${url}`);
    }
    return handler(init);
  }

  createAbort() {
    if (!this.supportsAbort) return null;
    const signal = { id: this.calls.length + 1 };
    return {
      signal,
      abort: () => {
        this.aborted += 1;
      }
    };
  }
}

export class FakeNavigation implements NavigationPort {
  href = "http://localhost/?page=graph";
  search = "?page=graph";
  reloads = 0;
  readonly pushed: string[] = [];
  readonly replaced: string[] = [];

  assign(url: string): void {
    this.href = url;
  }

  reload(): void {
    this.reloads += 1;
  }

  pushState(url: string): void {
    this.pushed.push(url);
  }

  replaceState(url: string): void {
    this.replaced.push(url);
  }
}

class FakeStorage implements StoragePort {
  readonly available = true;
  private readonly values = new Map<string, string>();

  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class FakeFocus implements FocusPort {
  active(): DomElement | null {
    return null;
  }

  focus(element: DomElement | null): boolean {
    if (element === null) return false;
    element.focus();
    return true;
  }
}

class FakeExternal implements ExternalOpenPort {
  readonly urls: string[] = [];

  open(url: string): boolean {
    this.urls.push(url);
    return true;
  }
}

class FakeClipboard implements ClipboardPort {
  readonly writes: string[] = [];

  write(text: string): Promise<boolean> {
    this.writes.push(text);
    return Promise.resolve(true);
  }
}

export class FakeLogger implements LoggerPort {
  readonly errors: Array<{ message: string; detail: unknown }> = [];

  error(message: string, detail: unknown): void {
    this.errors.push({ message, detail });
  }
}

export function createFakeBrowser() {
  const document = new FakeDocument();
  const page = new FakeEventTarget();
  const clock = new FakeClock();
  const net = new FakeNetwork();
  const nav = new FakeNavigation();
  const storage = new FakeStorage();
  const focus = new FakeFocus();
  const external = new FakeExternal();
  const clipboard = new FakeClipboard();
  const logger = new FakeLogger();
  const context: BrowserContext = {
    dom: {
      document,
      byId(elementId) {
        const element = document.getElementById(elementId);
        return element instanceof FakeElement ? element : null;
      },
      createElement(tagName) {
        const element = document.createElement(tagName);
        if (!(element instanceof FakeElement)) {
          throw new Error(`Unexpected fake element: ${tagName}`);
        }
        return element;
      }
    },
    page,
    net,
    nav,
    clock,
    storage,
    focus,
    external,
    clipboard,
    logger,
    bindings: createBindingRegistry()
  };
  return {
    context,
    document,
    page,
    clock,
    net,
    nav,
    storage,
    focus,
    external,
    clipboard,
    logger
  };
}

export function createFakeBrowserScope() {
  const browser = createFakeBrowser();
  const storage = new Map<string, string>();
  const location = {
    href: browser.nav.href,
    search: browser.nav.search,
    reload: () => browser.nav.reload()
  };
  const scope: Record<string, unknown> = {
    document: browser.document,
    window: browser.page,
    fetch: (url: string, init?: HttpRequestInit) =>
      browser.net.fetch(url, init),
    AbortController: class {
      readonly signal = { fake: true };
      abort(): void {
        browser.net.aborted += 1;
      }
    },
    location,
    history: {
      pushState: (_state: unknown, _title: string, url: string) =>
        browser.nav.pushState(url),
      replaceState: (_state: unknown, _title: string, url: string) =>
        browser.nav.replaceState(url)
    },
    setTimeout: (handler: () => void, timeoutMs: number) =>
      browser.clock.setTimeout(handler, timeoutMs),
    clearTimeout: (handle: number) => browser.clock.clearTimeout(handle),
    setInterval: (handler: () => void, intervalMs: number) =>
      browser.clock.setInterval(handler, intervalMs),
    clearInterval: (handle: number) => browser.clock.clearInterval(handle),
    Date: { now: () => browser.clock.now() },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value)
    },
    navigator: {
      clipboard: { writeText: (text: string) => browser.clipboard.write(text) }
    },
    console: {
      error: (message: string, detail: unknown) =>
        browser.logger.error(message, detail)
    },
    open: (url: string) => ({ url })
  };
  return { ...browser, scope, location };
}

export function jsonResponse(
  value: unknown,
  ok = true,
  status = ok ? 200 : 500
): HttpResponse {
  return {
    ok,
    status,
    text: () => Promise.resolve(JSON.stringify(value)),
    json: () => Promise.resolve(value)
  };
}

export function createDeferred<T>() {
  let resolvePromise: (value: T) => void = () => {};
  let rejectPromise: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise
  };
}

export async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
