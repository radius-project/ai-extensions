// Narrow browser capabilities used by importable client behavior. The package
// intentionally compiles without the DOM library, so browser globals can only be
// reached through these explicit ports.

export interface ElementStyle {
  display: string;
  left?: string;
  top?: string;
  marginTop?: string;
  position?: string;
  minHeight?: string;
  fontSize?: string;
  background?: string;
  color?: string;
  border?: string;
  width?: string;
}

export interface DomClassList {
  add(...tokens: string[]): void;
  remove(...tokens: string[]): void;
  toggle(token: string, force?: boolean): boolean;
  contains(token: string): boolean;
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

export interface DomParentNode {
  replaceChild(next: DomElement, previous: DomElement): unknown;
}

export interface DomParentElement extends DomParentNode {
  querySelectorAll(selectors: string): ArrayLike<DomElement>;
  insertBefore(node: DomElement, before: DomElement): unknown;
}

export interface DomElement extends DomEventTarget {
  id: string;
  className: string;
  innerHTML: string;
  textContent: string | null;
  hidden: boolean;
  readonly style: ElementStyle;
  readonly classList: DomClassList;
  readonly dataset: Record<string, string | undefined>;
  readonly parentNode: DomParentNode | null;
  offsetParent: unknown;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  focus(): void;
  scrollIntoView(options?: ScrollOptions): void;
  querySelector(selectors: string): DomElement | null;
  querySelectorAll(selectors: string): ArrayLike<DomElement>;
  closest(selectors: string): DomElement | null;
  appendChild(child: DomElement): DomElement;
  removeChild(child: DomElement): void;
  replaceChildren(...children: DomElement[]): void;
  remove(): void;
}

export interface ScrollOptions {
  behavior?: string;
  block?: string;
}

export interface DomInputElement extends DomElement {
  value: string;
  disabled: boolean;
  checked?: boolean;
}

export interface DomOption {
  value: string;
  textContent: string | null;
  selected: boolean;
}

export interface DomOptionElement extends DomElement {
  value: string;
  selected: boolean;
}

export interface DomSelectElement extends DomInputElement {
  readonly options: ArrayLike<DomOption>;
  selectedIndex: number;
}

export interface DomDocument extends DomEventTarget {
  visibilityState: string;
  readonly activeElement: unknown;
  readonly body: unknown;
  getElementById(elementId: string): unknown;
  querySelector(selectors: string): unknown;
  querySelectorAll(selectors: string): ArrayLike<unknown>;
  createElement(tagName: string): unknown;
}

export interface OptionSpec {
  value: string;
  label: string;
  selected?: boolean;
}

export interface DomPort {
  readonly document: DomDocument;
  byId(elementId: string): DomElement | null;
  inputById(elementId: string): DomInputElement | null;
  selectById(elementId: string): DomSelectElement | null;
  setOptions(select: DomSelectElement, options: readonly OptionSpec[]): void;
  createOption(option: OptionSpec): DomOptionElement;
  createElement(tagName: string): DomElement;
  all(
    root: DomElement | DomDocument | null,
    selectors: string
  ): readonly DomElement[];
  dispatch(target: DomElement, type: string): void;
  scrollToEnd(element: DomElement): boolean;
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
  parseDocument(html: string): DomDocument;
}

export type TimerHandle = number;

export interface ClockPort {
  setTimeout(handler: () => void, timeoutMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(handler: () => void, intervalMs: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
  now(): number;
}

export interface StoragePort {
  readonly available: boolean;
  get(key: string): string | null;
  set(key: string, value: string): boolean;
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

export interface DialogPort {
  confirm(message: string): boolean;
  notify(message: string): void;
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
  readonly dialogs: DialogPort;
  readonly logger: LoggerPort;
  readonly bindings: BindingRegistry;
}
