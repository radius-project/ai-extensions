import { createBindingRegistry } from "../../../src/browser/lifecycle.js";
import { createDomPort } from "../../../src/browser/context.js";
import type {
  BrowserContext,
  ClipboardPort,
  ClockPort,
  DialogPort,
  DomClassList,
  DomDocument,
  DomElement,
  DomEvent,
  DomEventListener,
  DomEventTarget,
  DomInputElement,
  DomOption,
  DomOptionElement,
  DomParentNode,
  DomSelectElement,
  ElementStyle,
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

function fakeEvent(overrides: Partial<DomEvent> = {}): DomEvent {
  return {
    preventDefault() {},
    stopPropagation() {},
    ...overrides
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

  dispatch(type: string, event: Partial<DomEvent> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(fakeEvent(event));
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
  readonly style: ElementStyle = { display: "" };
  className = "";
  innerHTML = "";
  textContent: string | null = "";
  hidden = false;
  readonly dataset: Record<string, string | undefined> = {};
  parentNode: DomParentNode | null = null;
  offsetParent: unknown = {};
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly matches = new Map<string, FakeElement[]>();
  readonly ancestors = new Map<string, DomElement>();
  focusCount = 0;
  clickCount = 0;
  scrollCount = 0;
  scrollTop = 0;
  scrollHeight = 0;
  removed = false;
  readonly classList: DomClassList;

  constructor(
    public id: string,
    readonly tagName = "div"
  ) {
    super();
    this.classList = {
      add: (...tokens) => {
        const current = this.classTokens();
        for (const token of tokens) current.add(token);
        this.className = [...current].join(" ");
      },
      remove: (...tokens) => {
        const current = this.classTokens();
        for (const token of tokens) current.delete(token);
        this.className = [...current].join(" ");
      },
      toggle: (token, force) => {
        const current = this.classTokens();
        const enabled = force ?? !current.has(token);
        if (enabled) current.add(token);
        else current.delete(token);
        this.className = [...current].join(" ");
        return enabled;
      },
      contains: (token) => this.classTokens().has(token)
    };
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  getAttributeNames(): readonly string[] {
    return [...this.attributes.keys()];
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

  scrollIntoView(): void {
    this.scrollCount += 1;
  }

  querySelector(selectors: string): FakeElement | null {
    return this.querySelectorAll(selectors)[0] ?? null;
  }

  querySelectorAll(selectors: string): FakeElement[] {
    const explicit = this.matches.get(selectors);
    if (explicit !== undefined) return explicit;
    return this.children.filter((child) => child.matchesSelector(selectors));
  }

  closest(selectors: string): DomElement | null {
    if (this.matchesSelector(selectors)) return this;
    return this.ancestors.get(selectors) ?? null;
  }

  appendChild(child: DomElement): DomElement {
    if (!(child instanceof FakeElement)) {
      throw new Error(`Unexpected fake child: ${child.id}`);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: DomElement): void {
    const index =
      child instanceof FakeElement ? this.children.indexOf(child) : -1;
    if (index >= 0) {
      this.children.splice(index, 1);
      if (child instanceof FakeElement) child.parentNode = null;
    }
  }

  replaceChildren(...children: DomElement[]): void {
    for (const child of [...this.children]) this.removeChild(child);
    for (const child of children) this.appendChild(child);
  }

  replaceChild(next: DomElement, previous: DomElement): unknown {
    const index =
      previous instanceof FakeElement ? this.children.indexOf(previous) : -1;
    if (index < 0 || !(next instanceof FakeElement)) return previous;
    if (previous instanceof FakeElement) previous.parentNode = null;
    next.parentNode = this;
    this.children[index] = next;
    return previous;
  }

  remove(): void {
    this.removed = true;
    const parent = this.parentNode;
    if (parent instanceof FakeElement) parent.removeChild(this);
  }

  dispatchEvent(event: unknown): boolean {
    const type =
      (
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        typeof event.type === "string"
      ) ?
        event.type
      : "";
    this.dispatch(type);
    return true;
  }

  get appended(): readonly FakeElement[] {
    return this.children;
  }

  private classTokens(): Set<string> {
    return new Set(this.className.split(/\s+/).filter(Boolean));
  }

  private matchesSelector(selectors: string): boolean {
    if (selectors.startsWith("#")) return this.id === selectors.slice(1);
    if (selectors.startsWith(".")) {
      const token = selectors.slice(1).split("[")[0];
      return this.classList.contains(token);
    }
    return this.tagName.toLowerCase() === selectors.toLowerCase();
  }
}

export class FakeOptionElement extends FakeElement implements DomOptionElement {
  value = "";
  selected = false;

  constructor() {
    super("", "option");
  }
}

export class FakeSelectElement extends FakeElement implements DomSelectElement {
  value = "";
  disabled = false;
  readonly options: DomOption[] = [];
  selectedIndex = -1;

  constructor(id = "") {
    super(id, "select");
  }

  override appendChild(child: DomElement): DomElement {
    const appended = super.appendChild(child);
    if (child instanceof FakeOptionElement) {
      this.options.push(child);
      if (child.selected || this.selectedIndex < 0) {
        this.selectedIndex = this.options.length - 1;
        this.value = child.value;
      }
      this.innerHTML = this.options
        .map(
          (option) =>
            `<option value="${escapeFakeHtml(option.value)}"${
              option.selected ? " selected" : ""
            }>${escapeFakeHtml(option.textContent ?? "")}</option>`
        )
        .join("");
    }
    return appended;
  }

  override replaceChildren(...children: DomElement[]): void {
    this.options.splice(0);
    this.selectedIndex = -1;
    this.value = "";
    this.innerHTML = "";
    super.replaceChildren(...children);
  }

  setOptions(values: Array<{ value: string; label?: string }>): void {
    this.replaceChildren();
    for (const value of values) {
      const option = new FakeOptionElement();
      option.value = value.value;
      option.textContent = value.label ?? value.value;
      this.appendChild(option);
    }
  }
}

function escapeFakeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type FakeInputElement = FakeElement & DomInputElement;

export function createFakeElement(id = "", tagName = "div"): FakeElement {
  return new FakeElement(id, tagName);
}

export function createFakeInput(id = "", value = ""): FakeInputElement {
  return Object.assign(new FakeElement(id, "input"), {
    value,
    disabled: false,
    checked: false
  });
}

export function createFakeSelect(id = ""): FakeSelectElement {
  return new FakeSelectElement(id);
}

const VALUE_TAGS = new Set(["input", "button", "textarea"]);

export class FakeDocument extends FakeEventTarget implements DomDocument {
  visibilityState = "visible";
  activeElement: unknown = null;
  body: unknown = new FakeElement("body");
  readonly created: FakeElement[] = [];
  private readonly elements = new Map<string, FakeElement>();
  private readonly selectors = new Map<string, FakeElement>();
  private readonly selectorLists = new Map<string, FakeElement[]>();

  add(element: FakeElement): FakeElement {
    this.elements.set(element.id, element);
    return element;
  }

  /** Drop an element from the document, as a host page re-render would. */
  remove(elementId: string): void {
    this.elements.delete(elementId);
  }

  getElementById(elementId: string): unknown {
    return this.elements.get(elementId) ?? null;
  }

  querySelector(selectors: string): unknown {
    return this.selectors.get(selectors) ?? null;
  }

  querySelectorAll(selectors: string): ArrayLike<unknown> {
    return this.selectorLists.get(selectors) ?? [];
  }

  createElement(tagName: string): unknown {
    const element =
      tagName === "option" ? new FakeOptionElement()
      : tagName === "select" ? new FakeSelectElement()
      : new FakeElement("", tagName);
    if (VALUE_TAGS.has(tagName)) {
      Object.assign(element, { value: "", disabled: false, checked: false });
    }
    this.created.push(element);
    return element;
  }

  addSelector(selector: string, element: FakeElement): void {
    this.selectors.set(selector, element);
  }

  addSelectorAll(selector: string, elements: FakeElement[]): void {
    this.selectorLists.set(selector, elements);
  }
}

export function createFakeDocument(): FakeDocument {
  return new FakeDocument();
}

export function fakeTree(element: FakeElement): FakeElement[] {
  return [element, ...element.children.flatMap(fakeTree)];
}

export function fakeText(element: FakeElement): string {
  return (element.textContent ?? "") + element.children.map(fakeText).join("");
}

export function fakeById(root: FakeElement, id: string): FakeElement {
  const found = fakeTree(root).find((element) => element.id === id);
  if (found === undefined) {
    throw new Error(`No rendered element with id "${id}".`);
  }
  return found;
}

export function fakeInputById(root: FakeElement, id: string): FakeInputElement {
  const found = fakeById(root, id);
  if (!("value" in found) || !("disabled" in found)) {
    throw new Error(`Rendered element "${id}" is not an input.`);
  }
  return found as FakeInputElement;
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

export function createFakeClock(startMs = 0): FakeClock {
  const clock = new FakeClock();
  if (startMs > 0) clock.tick(startMs);
  return clock;
}

type NetworkHandler = (
  init?: HttpRequestInit
) => HttpResponse | Promise<HttpResponse>;

interface FakeAbortSignal {
  aborted: boolean;
  listeners: Set<() => void>;
}

function isFakeAbortSignal(value: unknown): value is FakeAbortSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    "aborted" in value &&
    typeof value.aborted === "boolean" &&
    "listeners" in value &&
    value.listeners instanceof Set
  );
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

export class FakeNetwork implements NetworkPort {
  readonly calls: Array<{ url: string; init?: HttpRequestInit }> = [];
  readonly handlers = new Map<string, NetworkHandler>();
  supportsAbort = true;
  aborted = 0;

  handle(url: string, handler: NetworkHandler): void {
    this.handlers.set(url, handler);
  }

  fetch(url: string, init?: HttpRequestInit): Promise<HttpResponse> {
    this.calls.push({ url, init });
    const handler = this.handlers.get(url);
    if (handler === undefined) {
      return Promise.reject(new Error(`Unexpected browser request: ${url}`));
    }
    const response = Promise.resolve().then(() => handler(init));
    const signal = init?.signal;
    if (!isFakeAbortSignal(signal)) return response;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<HttpResponse>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        reject(abortError());
      };
      signal.listeners.add(onAbort);
      response.then(
        (value) => {
          if (settled) return;
          settled = true;
          signal.listeners.delete(onAbort);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          signal.listeners.delete(onAbort);
          reject(error);
        }
      );
    });
  }

  createAbort() {
    if (!this.supportsAbort) return null;
    const signal: FakeAbortSignal = {
      aborted: false,
      listeners: new Set()
    };
    return {
      signal,
      abort: () => {
        if (signal.aborted) return;
        signal.aborted = true;
        this.aborted += 1;
        for (const listener of [...signal.listeners]) listener();
        signal.listeners.clear();
      }
    };
  }
}

export class FakeNavigation implements NavigationPort {
  href = "http://localhost/?page=graph";
  search = "?page=graph";
  reloads = 0;
  readonly assigned: string[] = [];
  readonly pushed: string[] = [];
  readonly replaced: string[] = [];
  parsed: (html: string) => DomDocument = () => {
    throw new Error("Unexpected fake document parse.");
  };

  assign(url: string): void {
    this.assigned.push(url);
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

  parseDocument(html: string): DomDocument {
    return this.parsed(html);
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
  constructor(private readonly document: FakeDocument) {}

  active(): DomElement | null {
    return this.document.activeElement instanceof FakeElement ?
        this.document.activeElement
      : null;
  }

  focus(element: DomElement | null): boolean {
    if (element === null) return false;
    element.focus();
    return true;
  }
}

class FakeExternal implements ExternalOpenPort {
  readonly urls: string[] = [];

  get opened(): readonly string[] {
    return this.urls;
  }

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

export class FakeDialogs implements DialogPort {
  readonly confirmations: string[] = [];
  readonly notifications: string[] = [];
  nextConfirmation = false;

  confirm(message: string): boolean {
    this.confirmations.push(message);
    return this.nextConfirmation;
  }

  notify(message: string): void {
    this.notifications.push(message);
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
  const focus = new FakeFocus(document);
  const external = new FakeExternal();
  const clipboard = new FakeClipboard();
  const dialogs = new FakeDialogs();
  const logger = new FakeLogger();
  class FakeBrowserEvent {
    constructor(readonly type: string) {}
  }

  const context: BrowserContext = {
    dom: createDomPort(document, FakeBrowserEvent),
    page,
    net,
    nav,
    clock,
    storage,
    focus,
    external,
    clipboard,
    dialogs,
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
    dialogs,
    logger,
    bindings: context.bindings
  };
}

export type FakeBrowser = ReturnType<typeof createFakeBrowser>;

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
    Event: class {
      constructor(readonly type: string) {}
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
    confirm: (message: string) => browser.dialogs.confirm(message),
    alert: (message: string) => browser.dialogs.notify(message),
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

export function textResponse(
  value: string,
  ok = true,
  status = ok ? 200 : 500
): HttpResponse {
  return {
    ok,
    status,
    text: () => Promise.resolve(value),
    json: () => Promise.reject(new Error("Response is not JSON."))
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
