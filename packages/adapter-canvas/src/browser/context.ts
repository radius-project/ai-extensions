import { createBindingRegistry } from "./lifecycle.js";
import { isCallable, isRecord } from "./json.js";
import type {
  AbortHandle,
  BindingRegistry,
  BrowserContext,
  ClipboardPort,
  ClockPort,
  DialogPort,
  DomDocument,
  DomElement,
  DomEventTarget,
  DomInputElement,
  DomOptionElement,
  DomPort,
  DomSelectElement,
  ExternalOpenPort,
  FocusPort,
  HttpResponse,
  LoggerPort,
  NavigationPort,
  NetworkPort,
  OptionSpec,
  StoragePort
} from "./ports.js";

function readMember(value: unknown, name: string): unknown {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    return undefined;
  }
  return Reflect.get(value, name);
}

function isDomEventTargetLike(value: unknown): boolean {
  return (
    isCallable(readMember(value, "addEventListener")) &&
    isCallable(readMember(value, "removeEventListener"))
  );
}

export function isDomElement(value: unknown): value is DomElement {
  const style = readMember(value, "style");
  const classList = readMember(value, "classList");
  const dataset = readMember(value, "dataset");
  const textContent = readMember(value, "textContent");
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.className === "string" &&
    typeof value.innerHTML === "string" &&
    (typeof textContent === "string" || textContent === null) &&
    typeof value.hidden === "boolean" &&
    isRecord(style) &&
    typeof style.display === "string" &&
    isRecord(classList) &&
    isCallable(classList.add) &&
    isCallable(classList.remove) &&
    isCallable(classList.toggle) &&
    isCallable(classList.contains) &&
    isRecord(dataset) &&
    isDomEventTargetLike(value) &&
    isCallable(value.setAttribute) &&
    isCallable(value.getAttribute) &&
    isCallable(value.removeAttribute) &&
    isCallable(value.focus) &&
    isCallable(value.scrollIntoView) &&
    isCallable(value.querySelector) &&
    isCallable(value.querySelectorAll) &&
    isCallable(value.closest) &&
    isCallable(value.appendChild) &&
    isCallable(value.removeChild) &&
    isCallable(value.replaceChildren) &&
    isCallable(value.remove)
  );
}

export function isDomOptionElement(value: unknown): value is DomOptionElement {
  return (
    isDomElement(value) &&
    typeof readMember(value, "value") === "string" &&
    typeof readMember(value, "selected") === "boolean"
  );
}

export function isDomInputElement(value: unknown): value is DomInputElement {
  return (
    isDomElement(value) &&
    typeof readMember(value, "value") === "string" &&
    typeof readMember(value, "disabled") === "boolean"
  );
}

export function isDomSelectElement(value: unknown): value is DomSelectElement {
  const options = readMember(value, "options");
  return (
    isDomInputElement(value) &&
    (isRecord(options) || Array.isArray(options)) &&
    typeof readMember(value, "selectedIndex") === "number"
  );
}

function isClickableElement(
  value: unknown
): value is DomElement & { click(): void } {
  return isDomElement(value) && isCallable(readMember(value, "click"));
}

function isContainerElement(value: unknown): value is DomElement & {
  appendChild(child: DomElement): unknown;
  removeChild(child: DomElement): unknown;
} {
  return (
    isDomElement(value) &&
    isCallable(readMember(value, "appendChild")) &&
    isCallable(readMember(value, "removeChild"))
  );
}

export function isDomDocument(value: unknown): value is DomDocument {
  return (
    isRecord(value) &&
    typeof value.visibilityState === "string" &&
    isDomEventTargetLike(value) &&
    isCallable(value.getElementById) &&
    isCallable(value.querySelector) &&
    isCallable(value.querySelectorAll) &&
    isCallable(value.createElement)
  );
}

export function isDomEventTarget(value: unknown): value is DomEventTarget {
  return isRecord(value) && isDomEventTargetLike(value);
}

export function isHttpResponse(value: unknown): value is HttpResponse {
  return (
    isRecord(value) &&
    typeof value.ok === "boolean" &&
    typeof value.status === "number" &&
    isCallable(value.text) &&
    isCallable(value.json)
  );
}

function optionElement(
  document: DomDocument,
  option: OptionSpec
): DomOptionElement {
  const element = document.createElement("option");
  if (!isDomOptionElement(element)) {
    throw new Error("Radius browser context cannot create an option.");
  }
  element.value = option.value;
  element.textContent = option.label;
  element.selected = option.selected === true;
  return element;
}

export function createDomPort(
  document: DomDocument,
  eventConstructor?: unknown
): DomPort {
  return {
    document,
    byId(elementId) {
      const element = document.getElementById(elementId);
      return isDomElement(element) ? element : null;
    },
    inputById(elementId) {
      const element = document.getElementById(elementId);
      return isDomInputElement(element) ? element : null;
    },
    selectById(elementId) {
      const element = document.getElementById(elementId);
      return isDomSelectElement(element) ? element : null;
    },
    setOptions(select, options) {
      select.replaceChildren();
      for (const option of options) {
        select.appendChild(optionElement(document, option));
      }
      const selectedIndex = options.findIndex(
        (option) => option.selected === true
      );
      const effectiveIndex =
        selectedIndex >= 0 ? selectedIndex
        : options.length > 0 ? 0
        : -1;
      select.selectedIndex = effectiveIndex;
      select.value = effectiveIndex >= 0 ? options[effectiveIndex].value : "";
    },
    createOption(option) {
      return optionElement(document, option);
    },
    createElement(tagName) {
      const element = document.createElement(tagName);
      if (!isDomElement(element)) {
        throw new Error(
          `Radius browser context cannot create a <${tagName}> element.`
        );
      }
      return element;
    },
    all(root, selectors) {
      if (root === null) return [];
      return Array.from(root.querySelectorAll(selectors)).filter(isDomElement);
    },
    dispatch(target, type) {
      const dispatchEvent = readMember(target, "dispatchEvent");
      if (!isCallable(dispatchEvent) || !isCallable(eventConstructor)) {
        throw new Error(
          `Radius browser context cannot dispatch the "${type}" event.`
        );
      }
      dispatchEvent.call(target, Reflect.construct(eventConstructor, [type]));
    },
    scrollToEnd(element) {
      const height = readMember(element, "scrollHeight");
      return (
        typeof height === "number" &&
        Number.isFinite(height) &&
        Reflect.set(element, "scrollTop", height)
      );
    }
  };
}

function createNetworkPort(scope: unknown): NetworkPort {
  const fetchImpl = readMember(scope, "fetch");
  if (!isCallable(fetchImpl)) {
    throw new Error("Radius browser context is missing fetch.");
  }
  const abortConstructor = readMember(scope, "AbortController");
  return {
    async fetch(url, init) {
      const response: unknown = await fetchImpl.call(scope, url, init);
      if (!isHttpResponse(response)) {
        throw new Error(`Radius browser fetch returned no response: ${url}`);
      }
      return response;
    },
    createAbort(): AbortHandle | null {
      if (!isCallable(abortConstructor)) return null;
      const controller: unknown = Reflect.construct(abortConstructor, []);
      const abort = readMember(controller, "abort");
      if (!isRecord(controller) || !isCallable(abort)) return null;
      return {
        signal: controller.signal,
        abort() {
          abort.call(controller);
        }
      };
    }
  };
}

function createNavigationPort(scope: unknown): NavigationPort {
  const location = readMember(scope, "location");
  const reload = readMember(location, "reload");
  if (
    !isRecord(location) ||
    typeof location.href !== "string" ||
    !isCallable(reload)
  ) {
    throw new Error("Radius browser context is missing location.");
  }
  const history = readMember(scope, "history");
  const parserConstructor = readMember(scope, "DOMParser");

  function writeHistory(method: "pushState" | "replaceState", url: string) {
    const write = readMember(history, method);
    if (!isCallable(write)) {
      throw new Error(`Radius browser context is missing history.${method}.`);
    }
    write.call(history, null, "", url);
  }

  return {
    get href() {
      return typeof location.href === "string" ? location.href : "";
    },
    get search() {
      return typeof location.search === "string" ? location.search : "";
    },
    assign(url) {
      location.href = url;
    },
    reload() {
      reload.call(location);
    },
    pushState(url) {
      writeHistory("pushState", url);
    },
    replaceState(url) {
      writeHistory("replaceState", url);
    },
    parseDocument(html) {
      if (!isCallable(parserConstructor)) {
        throw new Error("Radius browser context is missing DOMParser.");
      }
      const parser: unknown = Reflect.construct(parserConstructor, []);
      const parse = readMember(parser, "parseFromString");
      if (!isCallable(parse)) {
        throw new Error("Radius browser context is missing DOMParser.");
      }
      const parsed: unknown = parse.call(parser, html, "text/html");
      if (!isDomDocument(parsed)) {
        throw new Error("Radius browser context could not parse a document.");
      }
      return parsed;
    }
  };
}

function createClockPort(scope: unknown): ClockPort {
  const setTimeoutImpl = readMember(scope, "setTimeout");
  const clearTimeoutImpl = readMember(scope, "clearTimeout");
  const setIntervalImpl = readMember(scope, "setInterval");
  const clearIntervalImpl = readMember(scope, "clearInterval");
  const date = readMember(scope, "Date");
  const nowImpl = readMember(date, "now");
  if (
    !isCallable(setTimeoutImpl) ||
    !isCallable(clearTimeoutImpl) ||
    !isCallable(setIntervalImpl) ||
    !isCallable(clearIntervalImpl) ||
    !isCallable(nowImpl)
  ) {
    throw new Error("Radius browser context is missing timers.");
  }

  function timerHandle(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("Radius browser timer returned a non-numeric handle.");
    }
    return value;
  }

  return {
    setTimeout(handler, timeoutMs) {
      return timerHandle(setTimeoutImpl.call(scope, handler, timeoutMs));
    },
    clearTimeout(handle) {
      clearTimeoutImpl.call(scope, handle);
    },
    setInterval(handler, intervalMs) {
      return timerHandle(setIntervalImpl.call(scope, handler, intervalMs));
    },
    clearInterval(handle) {
      clearIntervalImpl.call(scope, handle);
    },
    now() {
      const value = nowImpl.call(date);
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error("Radius browser clock returned an invalid time.");
      }
      return value;
    }
  };
}

function errorDetail(error: unknown): string {
  return String(error).replace(/^[A-Za-z]*Error:\s*/, "");
}

function unavailableStorage(action: string, key: string): Error {
  return new Error(
    `Radius browser storage is unavailable; cannot ${action} "${key}".`
  );
}

function createStoragePort(scope: unknown): StoragePort {
  const storage = readMember(scope, "sessionStorage");
  const getItem = readMember(storage, "getItem");
  const setItem = readMember(storage, "setItem");
  if (!isCallable(getItem) || !isCallable(setItem)) {
    return {
      available: false,
      get(key) {
        throw unavailableStorage("read", key);
      },
      set(key) {
        throw unavailableStorage("write", key);
      }
    };
  }
  return {
    available: true,
    get(key) {
      try {
        const value: unknown = getItem.call(storage, key);
        if (value === null || typeof value === "string") return value;
        throw new Error("storage returned a non-string value");
      } catch (error) {
        throw new Error(
          `Radius browser storage could not read "${key}": ${errorDetail(error)}`,
          { cause: error }
        );
      }
    },
    set(key, value) {
      try {
        setItem.call(storage, key, value);
      } catch (error) {
        throw new Error(
          `Radius browser storage could not write "${key}": ${errorDetail(error)}`,
          { cause: error }
        );
      }
    }
  };
}

function createFocusPort(document: DomDocument): FocusPort {
  return {
    active() {
      return isDomElement(document.activeElement) ?
          document.activeElement
        : null;
    },
    focus(element) {
      if (element === null) return false;
      element.focus();
      return true;
    }
  };
}

function createExternalOpenPort(
  scope: unknown,
  document: DomDocument
): ExternalOpenPort {
  const open = readMember(scope, "open");
  return {
    open(url) {
      if (url === "") return false;
      const anchor = document.createElement("a");
      const body = document.body;
      if (isClickableElement(anchor) && isContainerElement(body)) {
        anchor.setAttribute("href", url);
        anchor.setAttribute("target", "_blank");
        anchor.setAttribute("rel", "noopener noreferrer");
        body.appendChild(anchor);
        try {
          anchor.click();
        } finally {
          body.removeChild(anchor);
        }
        return true;
      }
      if (!isCallable(open)) return false;
      const opened: unknown = open.call(scope, url, "_blank", "noopener");
      return opened !== null && opened !== undefined && opened !== false;
    }
  };
}

function createClipboardPort(scope: unknown): ClipboardPort {
  const navigator = readMember(scope, "navigator");
  const clipboard = readMember(navigator, "clipboard");
  const writeText = readMember(clipboard, "writeText");
  return {
    write(text) {
      if (!isCallable(writeText)) return Promise.resolve(false);
      return Promise.resolve()
        .then(() => writeText.call(clipboard, text))
        .then(
          () => true,
          () => false
        );
    }
  };
}

// Native dialogs are resolved per call rather than when the context is built.
// Only the credentials and deployments pages ever open one, so resolving
// eagerly made every page — including the graph pages — fail to start over a
// capability they never use.
//
// A host that sandboxes the canvas without `allow-modals` suppresses these.
// `confirm` then fails closed, because a destructive action must never proceed
// on consent that was never obtained, and `notify` falls back to the logger so
// a message the user was meant to see cannot vanish silently. Real modal
// support is a Phase 6 concern; this only keeps the failure honest.
function createDialogPort(scope: unknown, logger: LoggerPort): DialogPort {
  return {
    confirm(message) {
      const confirm = readMember(scope, "confirm");
      if (!isCallable(confirm)) {
        logger.error("Radius could not confirm an action.", message);
        return false;
      }
      return confirm.call(scope, message) === true;
    },
    notify(message) {
      const alert = readMember(scope, "alert");
      if (!isCallable(alert)) {
        logger.error("Radius could not display a notification.", message);
        return;
      }
      alert.call(scope, message);
    }
  };
}

function createLoggerPort(scope: unknown): LoggerPort {
  const runtimeConsole = readMember(scope, "console");
  const report = readMember(runtimeConsole, "error");
  if (!isCallable(report)) {
    throw new Error("Radius browser context is missing console.error.");
  }
  return {
    error(message, detail) {
      report.call(runtimeConsole, message, detail);
    }
  };
}

export function resolveBrowserContext(
  scope: unknown,
  bindings: BindingRegistry = createBindingRegistry()
): BrowserContext {
  const document = readMember(scope, "document");
  if (!isDomDocument(document)) {
    throw new Error("Radius browser context is missing document.");
  }
  const page = readMember(scope, "window") ?? scope;
  if (!isDomEventTarget(page)) {
    throw new Error("Radius browser context is missing window.");
  }
  const logger = createLoggerPort(scope);
  return {
    dom: createDomPort(document, readMember(scope, "Event")),
    page,
    net: createNetworkPort(scope),
    nav: createNavigationPort(scope),
    clock: createClockPort(scope),
    storage: createStoragePort(scope),
    focus: createFocusPort(document),
    external: createExternalOpenPort(scope, document),
    clipboard: createClipboardPort(scope),
    dialogs: createDialogPort(scope, logger),
    logger,
    bindings
  };
}
