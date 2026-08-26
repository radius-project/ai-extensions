// A real browser scope for the component layer, with only its outward edges
// controlled.
//
// `resolveBrowserContext` is the production factory the page entries use, so a
// component test should hand it a real window rather than a hand-built context
// of fakes. Two edges cannot be left real in a test runner: the network, which
// would leave the machine, and the clipboard, which headless Chromium refuses
// without a permission grant. Both are replaced here and nothing else is, so
// the DOM, timers, focus and event dispatch under test are the browser's own.
//
// The scope is a flat object of bound members rather than a proxy because the
// context factory invokes each member with the scope as `this`, and a real
// `window` method rejects a foreign receiver.
//
// Test-support only: production modules never import this.

import { resolveBrowserContext } from "../../../src/browser/context.js";
import type { BrowserContext } from "../../../src/browser/ports.js";

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export type RouteHandler = (
  request: RecordedRequest
) => Response | Promise<Response>;

export interface RealScope {
  readonly context: BrowserContext;
  readonly host: HTMLElement;
  /** Every request the callout made, in order. */
  readonly requests: RecordedRequest[];
  /** Every value the callout wrote to the clipboard, in order. */
  readonly copied: string[];
  dispose(): void;
}

export function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of new Headers(init?.headers).entries()) {
    headers[name] = value;
  }
  return headers;
}

function bodyOf(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") return null;
  return JSON.parse(init.body) as unknown;
}

export interface RealScopeOptions {
  /** Answers `POST /api/run-remediation`. Throwing models a transport failure. */
  readonly route?: RouteHandler;
  /** `false` models a clipboard the browser refused to write to. */
  readonly clipboardWorks?: boolean;
}

export function createRealScope(options: RealScopeOptions = {}): RealScope {
  const requests: RecordedRequest[] = [];
  const copied: string[] = [];
  const route =
    options.route ?? (() => jsonResponse(200, { status: "handed-off" }));

  const scope = {
    document: window.document,
    window,
    Event: window.Event,
    Date: window.Date,
    AbortController: window.AbortController,
    DOMParser: window.DOMParser,
    location: window.location,
    history: window.history,
    console: window.console,
    localStorage: window.localStorage,
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    open: window.open.bind(window),
    confirm: () => false,
    alert: () => undefined,
    navigator: {
      clipboard: {
        writeText: (text: string): Promise<void> => {
          if (options.clipboardWorks === false) {
            return Promise.reject(new Error("clipboard blocked"));
          }
          copied.push(text);
          return Promise.resolve();
        }
      }
    },
    fetch: (url: string, init?: RequestInit): Promise<Response> => {
      const request: RecordedRequest = {
        url,
        method: init?.method ?? "GET",
        headers: headersOf(init),
        body: bodyOf(init)
      };
      requests.push(request);
      return Promise.resolve(route(request));
    }
  };

  const host = window.document.createElement("div");
  window.document.body.appendChild(host);

  return {
    context: resolveBrowserContext(scope),
    host,
    requests,
    copied,
    dispose() {
      host.remove();
    }
  };
}
