// Narrow browser capabilities used by importable client behavior. The package
// intentionally compiles without the DOM library, so browser globals can only be
// reached through these explicit ports.

export interface ElementStyle {
  display: string;
}

export interface DomEvent {
  readonly target?: unknown;
  readonly currentTarget?: unknown;
  readonly key?: string;
  preventDefault(): void;
  stopPropagation(): void;
}

export type DomEventListener = (event: DomEvent) => void;

export interface DomEventTarget {
  addEventListener(type: string, listener: DomEventListener): void;
  removeEventListener(type: string, listener: DomEventListener): void;
}

export interface DomElement extends DomEventTarget {
  readonly id: string;
  readonly style: ElementStyle;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  focus(): void;
}

export interface DomDocument extends DomEventTarget {
  visibilityState: string;
  readonly activeElement: unknown;
  readonly body: unknown;
  getElementById(elementId: string): unknown;
  createElement(tagName: string): unknown;
}

export interface DomPort {
  readonly document: DomDocument;
  byId(elementId: string): DomElement | null;
  createElement(tagName: string): DomElement;
}

export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface HttpRequestInit {
  method?: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  cache?: string;
  signal?: unknown;
}

export interface AbortHandle {
  readonly signal: unknown;
  abort(): void;
}

export interface NetworkPort {
  fetch(url: string, init?: HttpRequestInit): Promise<HttpResponse>;
  createAbort(): AbortHandle | null;
}

export interface NavigationPort {
  readonly href: string;
  readonly search: string;
  assign(url: string): void;
  reload(): void;
  pushState(url: string): void;
  replaceState(url: string): void;
}

export type TimerHandle = number;

export interface ClockPort {
  setTimeout(handler: () => void, timeoutMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(handler: () => void, intervalMs: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
  now(): number;
}

// Storage is optional in a webview, so `available` is the single precondition
// for both accessors: when it is false every call throws, and when it is true a
// call throws only if the underlying storage rejects it. Neither accessor
// reports failure through its return value.
export interface StoragePort {
  readonly available: boolean;
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface FocusPort {
  active(): DomElement | null;
  focus(element: DomElement | null): boolean;
}

export interface ExternalOpenPort {
  open(url: string): boolean;
}

export interface ClipboardPort {
  write(text: string): Promise<boolean>;
}

export interface LoggerPort {
  error(message: string, detail: unknown): void;
}

export interface BindingRegistry {
  claim(key: string): boolean;
  release(key: string): void;
  has(key: string): boolean;
}

export interface BrowserContext {
  readonly dom: DomPort;
  readonly page: DomEventTarget;
  readonly net: NetworkPort;
  readonly nav: NavigationPort;
  readonly clock: ClockPort;
  readonly storage: StoragePort;
  readonly focus: FocusPort;
  readonly external: ExternalOpenPort;
  readonly clipboard: ClipboardPort;
  readonly logger: LoggerPort;
  readonly bindings: BindingRegistry;
}
