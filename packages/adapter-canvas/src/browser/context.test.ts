import { describe, expect, it } from "vitest";
import {
  createDomPort,
  isDomDocument,
  isDomElement,
  isDomEventTarget,
  isHttpResponse,
  resolveBrowserContext
} from "./context.js";
import {
  FakeDocument,
  FakeElement,
  FakeEventTarget,
  createFakeInput,
  createFakeSelect,
  jsonResponse
} from "../../test/support/browser/fakes.js";

function createScope(
  overrides: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
  const document = new FakeDocument();
  const storage = new Map<string, string>();
  return {
    document,
    window: new FakeEventTarget(),
    fetch: () => Promise.resolve(jsonResponse({})),
    AbortController: class {
      readonly signal = { id: 1 };
      abort(): void {}
    },
    location: {
      href: "http://localhost/?page=graph",
      search: "?page=graph",
      reload: () => undefined
    },
    history: {
      pushState: () => undefined,
      replaceState: () => undefined
    },
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    setInterval: () => 2,
    clearInterval: () => undefined,
    Date: { now: () => 123 },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value)
    },
    navigator: {
      clipboard: { writeText: () => Promise.resolve() }
    },
    confirm: () => false,
    alert: () => undefined,
    console: { error: () => undefined },
    open: () => null,
    ...overrides
  };
}

describe("browser value guards", () => {
  it("accepts only the browser shapes required by the ports", () => {
    expect(isDomElement(new FakeElement("element"))).toBe(true);
    const emptyText = new FakeElement("empty-text");
    emptyText.textContent = null;
    expect(isDomElement(emptyText)).toBe(true);
    expect(isDomElement({})).toBe(false);
    expect(isDomDocument(new FakeDocument())).toBe(true);
    expect(isDomDocument(new FakeElement("element"))).toBe(false);
    expect(isDomEventTarget(new FakeEventTarget())).toBe(true);
    expect(isDomEventTarget({})).toBe(false);
    expect(isHttpResponse(jsonResponse({}))).toBe(true);
    expect(isHttpResponse({ ok: true, status: 200 })).toBe(false);
  });
});

describe("DOM and focus ports", () => {
  it("reads and creates validated elements without exposing an HTML sink", () => {
    const document = new FakeDocument();
    const element = new FakeElement("known");
    document.add(element);
    const dom = createDomPort(document);

    expect(dom.byId("known")).toBe(element);
    expect(dom.byId("missing")).toBeNull();
    expect(dom.createElement("button")).toBeInstanceOf(FakeElement);
    expect("innerHTML" in dom).toBe(false);
  });

  it("rejects malformed elements returned by the document", () => {
    const document = new FakeDocument();
    document.createElement = () => ({});
    expect(() => createDomPort(document).createElement("div")).toThrow(
      "Radius browser context cannot create a <div> element."
    );
  });

  it("reads typed inputs and selects, writes safe options, and dispatches events", () => {
    const document = new FakeDocument();
    const input = createFakeInput("input", "value");
    const select = createFakeSelect("select");
    const plain = new FakeElement("plain");
    document.add(input);
    document.add(select);
    document.add(plain);
    class Event {
      constructor(readonly type: string) {}
    }
    const dom = createDomPort(document, Event);
    let changes = 0;
    select.addEventListener("change", () => changes++);

    expect(dom.inputById("input")).toBe(input);
    expect(dom.inputById("plain")).toBeNull();
    expect(dom.selectById("select")).toBe(select);
    expect(dom.selectById("input")).toBeNull();
    dom.setOptions(select, [
      { value: "<first>", label: "<First>" },
      { value: "second", label: "Second", selected: true }
    ]);
    expect(select.value).toBe("second");
    expect(select.selectedIndex).toBe(1);
    expect(select.innerHTML).toContain("&lt;First&gt;");
    expect(dom.createOption({ value: "x", label: "X" }).value).toBe("x");
    dom.dispatch(select, "change");
    expect(changes).toBe(1);

    dom.setOptions(select, []);
    expect(select.value).toBe("");
    expect(select.selectedIndex).toBe(-1);
    expect(dom.all(null, "*")).toEqual([]);
    document.querySelectorAll = () => [plain, {}];
    expect(dom.all(document, "*")).toEqual([plain]);
    expect(() => createDomPort(document).dispatch(select, "change")).toThrow(
      'Radius browser context cannot dispatch the "change" event.'
    );
    plain.scrollHeight = 120;
    expect(dom.scrollToEnd(plain)).toBe(true);
    expect(plain.scrollTop).toBe(120);
    plain.clientHeight = 40;
    plain.scrollTop = 76;
    expect(dom.isScrolledToEnd(plain)).toBe(true);
    plain.scrollTop = 75;
    expect(dom.isScrolledToEnd(plain)).toBe(false);
    Object.assign(plain, { scrollTop: Number.NaN });
    expect(dom.isScrolledToEnd(plain)).toBe(false);
    Object.assign(plain, { scrollTop: 80, scrollHeight: Number.NaN });
    expect(dom.isScrolledToEnd(plain)).toBe(false);
    Object.assign(plain, { scrollHeight: 120, clientHeight: Number.NaN });
    expect(dom.isScrolledToEnd(plain)).toBe(false);
    Object.assign(plain, { scrollHeight: Number.NaN });
    expect(dom.scrollToEnd(plain)).toBe(false);
  });

  it("rejects a malformed option element", () => {
    const document = new FakeDocument();
    document.createElement = () => new FakeElement("not-option");
    expect(() =>
      createDomPort(document).createOption({ value: "x", label: "X" })
    ).toThrow("Radius browser context cannot create an option.");
  });

  it("reports and restores focus through a typed element", () => {
    const document = new FakeDocument();
    const element = new FakeElement("focus");
    document.activeElement = element;
    const context = resolveBrowserContext(createScope({ document }));

    expect(context.focus.active()).toBe(element);
    expect(context.focus.focus(element)).toBe(true);
    expect(element.focusCount).toBe(1);
    document.activeElement = {};
    expect(context.focus.active()).toBeNull();
    expect(context.focus.focus(null)).toBe(false);
  });
});

describe("resolveBrowserContext", () => {
  it.each([
    [{}, "Radius browser context is missing document."],
    [
      { document: new FakeDocument(), window: {} },
      "Radius browser context is missing window."
    ],
    [
      createScope({ fetch: undefined }),
      "Radius browser context is missing fetch."
    ],
    [
      createScope({ location: undefined }),
      "Radius browser context is missing location."
    ],
    [
      createScope({ setTimeout: undefined }),
      "Radius browser context is missing timers."
    ],
    [
      createScope({ console: undefined }),
      "Radius browser context is missing console.error."
    ]
  ])("names a missing browser capability", (scope, message) => {
    expect(() => resolveBrowserContext(scope)).toThrow(message);
  });

  it("uses the global scope itself when window is not separately exposed", () => {
    const scope = Object.assign(new FakeEventTarget(), createScope(), {
      window: undefined
    });
    expect(resolveBrowserContext(scope).page).toBe(scope);
  });

  it("fails closed on confirmation and reports notifications through browser dialogs", () => {
    const confirmations: string[] = [];
    const notifications: string[] = [];
    const context = resolveBrowserContext(
      createScope({
        confirm: (message: string) => {
          confirmations.push(message);
          return "yes";
        },
        alert: (message: string) => {
          notifications.push(message);
        }
      })
    );

    expect(context.dialogs.confirm("Delete?")).toBe(false);
    context.dialogs.notify("Could not delete.");
    expect(confirmations).toEqual(["Delete?"]);
    expect(notifications).toEqual(["Could not delete."]);

    const approved = resolveBrowserContext(
      createScope({ confirm: () => true })
    );
    expect(approved.dialogs.confirm("Delete?")).toBe(true);
  });

  it("starts pages that never open a dialog on a host without modals", () => {
    const logged: unknown[][] = [];
    const context = resolveBrowserContext(
      createScope({
        confirm: undefined,
        alert: undefined,
        console: { error: (...args: unknown[]) => logged.push(args) }
      })
    );

    expect(context.dialogs.confirm("Delete?")).toBe(false);
    context.dialogs.notify("Could not delete.");
    expect(logged).toEqual([
      ["Radius could not confirm an action.", "Delete?"],
      ["Radius could not display a notification.", "Could not delete."]
    ]);
  });

  it("validates fetch responses and creates an optional abort handle", async () => {
    let aborted = 0;
    const response = jsonResponse({ value: 1 });
    const context = resolveBrowserContext(
      createScope({
        fetch: () => Promise.resolve(response),
        AbortController: class {
          readonly signal = { id: "abort" };
          abort(): void {
            aborted += 1;
          }
        }
      })
    );

    await expect(context.net.fetch("/api/value")).resolves.toBe(response);
    const abort = context.net.createAbort();
    expect(abort?.signal).toEqual({ id: "abort" });
    abort?.abort();
    expect(aborted).toBe(1);

    await expect(
      resolveBrowserContext(
        createScope({ fetch: () => Promise.resolve("not a response") })
      ).net.fetch("/api/value")
    ).rejects.toThrow("Radius browser fetch returned no response: /api/value");
    expect(
      resolveBrowserContext(
        createScope({ AbortController: undefined })
      ).net.createAbort()
    ).toBeNull();
    expect(
      resolveBrowserContext(
        createScope({ AbortController: class {} })
      ).net.createAbort()
    ).toBeNull();
  });

  it("adapts location and history while surfacing missing history methods", () => {
    const pushed: unknown[][] = [];
    const replaced: unknown[][] = [];
    let reloads = 0;
    const location: Record<string, unknown> = {
      href: "http://localhost/?page=graph",
      search: "?page=graph",
      reload: () => {
        reloads += 1;
      }
    };
    const context = resolveBrowserContext(
      createScope({
        location,
        history: {
          pushState: (...args: unknown[]) => pushed.push(args),
          replaceState: (...args: unknown[]) => replaced.push(args)
        }
      })
    );

    expect(context.nav.href).toBe("http://localhost/?page=graph");
    expect(context.nav.search).toBe("?page=graph");
    context.nav.assign("/?page=planned");
    expect(location.href).toBe("/?page=planned");
    context.nav.reload();
    context.nav.pushState("?page=deployed");
    context.nav.replaceState("?page=graph");
    expect(reloads).toBe(1);
    expect(pushed).toEqual([[null, "", "?page=deployed"]]);
    expect(replaced).toEqual([[null, "", "?page=graph"]]);

    location.href = 5;
    location.search = null;
    expect(context.nav.href).toBe("");
    expect(context.nav.search).toBe("");

    const withoutHistory = resolveBrowserContext(
      createScope({ history: undefined })
    );
    expect(() => withoutHistory.nav.pushState("/x")).toThrow(
      "Radius browser context is missing history.pushState."
    );
    expect(() => withoutHistory.nav.replaceState("/x")).toThrow(
      "Radius browser context is missing history.replaceState."
    );
  });

  it("parses navigation documents and rejects each malformed parser shape", () => {
    const parsed = new FakeDocument();
    const context = resolveBrowserContext(
      createScope({
        DOMParser: class {
          parseFromString(html: string, type: string) {
            expect(html).toBe("<html></html>");
            expect(type).toBe("text/html");
            return parsed;
          }
        }
      })
    );
    expect(context.nav.parseDocument("<html></html>")).toBe(parsed);

    expect(() =>
      resolveBrowserContext(createScope()).nav.parseDocument("<html/>")
    ).toThrow("Radius browser context is missing DOMParser.");
    expect(() =>
      resolveBrowserContext(
        createScope({ DOMParser: class {} })
      ).nav.parseDocument("<html/>")
    ).toThrow("Radius browser context is missing DOMParser.");
    expect(() =>
      resolveBrowserContext(
        createScope({
          DOMParser: class {
            parseFromString() {
              return {};
            }
          }
        })
      ).nav.parseDocument("<html/>")
    ).toThrow("Radius browser context could not parse a document.");
  });

  it("uses the supplied timers and rejects invalid timer or clock values", () => {
    const calls: string[] = [];
    const context = resolveBrowserContext(
      createScope({
        setTimeout: () => {
          calls.push("setTimeout");
          return 10;
        },
        clearTimeout: () => calls.push("clearTimeout"),
        setInterval: () => {
          calls.push("setInterval");
          return 11;
        },
        clearInterval: () => calls.push("clearInterval"),
        Date: { now: () => 99 }
      })
    );

    expect(context.clock.setTimeout(() => undefined, 1)).toBe(10);
    context.clock.clearTimeout(10);
    expect(context.clock.setInterval(() => undefined, 1)).toBe(11);
    context.clock.clearInterval(11);
    expect(context.clock.now()).toBe(99);
    expect(calls).toEqual([
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval"
    ]);

    expect(() =>
      resolveBrowserContext(
        createScope({ setTimeout: () => "not a handle" })
      ).clock.setTimeout(() => undefined, 1)
    ).toThrow("Radius browser timer returned a non-numeric handle.");
    expect(() =>
      resolveBrowserContext(
        createScope({ Date: { now: () => Number.NaN } })
      ).clock.now()
    ).toThrow("Radius browser clock returned an invalid time.");
  });

  it("makes storage availability explicit and surfaces storage failures", () => {
    const unavailable = resolveBrowserContext(
      createScope({ sessionStorage: undefined })
    ).storage;
    expect(unavailable.available).toBe(false);
    expect(() => unavailable.get("key")).toThrow(
      'Radius browser storage is unavailable; cannot read "key".'
    );
    expect(() => unavailable.set("key", "value")).toThrow(
      'Radius browser storage is unavailable; cannot write "key".'
    );

    const readOnly = resolveBrowserContext(
      createScope({ sessionStorage: { getItem: () => null } })
    ).storage;
    expect(readOnly.available).toBe(false);
    expect(() => readOnly.get("key")).toThrow(
      'Radius browser storage is unavailable; cannot read "key".'
    );

    const values = new Map<string, unknown>();
    const storage = resolveBrowserContext(
      createScope({
        sessionStorage: {
          getItem: (key: string) => values.get(key) ?? null,
          setItem: (key: string, value: string) => values.set(key, value)
        }
      })
    ).storage;
    expect(storage.available).toBe(true);
    expect(storage.get("key")).toBeNull();
    expect(storage.set("key", "value")).toBeUndefined();
    expect(storage.get("key")).toBe("value");
    values.set("key", 4);
    expect(() => storage.get("key")).toThrow(
      'Radius browser storage could not read "key": storage returned a non-string value'
    );

    const refusing = resolveBrowserContext(
      createScope({
        sessionStorage: {
          getItem: () => {
            throw new Error("read denied");
          },
          setItem: () => {
            throw new Error("write denied");
          }
        }
      })
    ).storage;
    expect(refusing.available).toBe(true);
    expect(() => refusing.get("key")).toThrow("read denied");
    expect(() => refusing.set("key", "value")).toThrow("write denied");

    const stringFailure = resolveBrowserContext(
      createScope({
        sessionStorage: {
          getItem: () => {
            throw "string failure";
          },
          setItem: () => undefined
        }
      })
    ).storage;
    expect(() => stringFailure.get("key")).toThrow("string failure");
  });

  it("opens external links with a temporary native anchor and always removes it", () => {
    const document = new FakeDocument();
    const body = document.body;
    if (!(body instanceof FakeElement)) throw new Error("expected fake body");
    const context = resolveBrowserContext(createScope({ document }));

    expect(context.external.open("https://example.test/path")).toBe(true);
    const anchor = document.created.at(-1);
    expect(anchor?.attributes.get("href")).toBe("https://example.test/path");
    expect(anchor?.attributes.get("target")).toBe("_blank");
    expect(anchor?.attributes.get("rel")).toBe("noopener noreferrer");
    expect(anchor?.clickCount).toBe(1);
    expect(body.children).toEqual([]);

    const brokenAnchor = new FakeElement("a");
    brokenAnchor.click = () => {
      throw new Error("click failed");
    };
    document.createElement = () => brokenAnchor;
    expect(() => context.external.open("https://example.test/fail")).toThrow(
      "click failed"
    );
    expect(body.children).toEqual([]);
  });

  it("downloads generated text through a temporary object URL and cleans it up", () => {
    const document = new FakeDocument();
    const body = document.body;
    if (!(body instanceof FakeElement)) throw new Error("expected fake body");
    const blobs: unknown[] = [];
    const revoked: string[] = [];
    class FakeBlob {
      constructor(
        readonly parts: unknown[],
        readonly options: Record<string, unknown>
      ) {
        blobs.push(this);
      }
    }
    const revokeHandlers: Array<() => void> = [];
    const context = resolveBrowserContext(
      createScope({
        document,
        setTimeout: (handler: () => void) => {
          revokeHandlers.push(handler);
          return 1;
        },
        Blob: FakeBlob,
        URL: {
          createObjectURL: () => "blob:diagnostic",
          revokeObjectURL: (url: string) => revoked.push(url)
        }
      })
    );

    expect(
      context.download.save(
        '{"state":"failed"}',
        "application/json",
        "diagnostic.json"
      )
    ).toBe(true);
    const anchor = document.created.at(-1);
    expect(anchor?.attributes.get("href")).toBe("blob:diagnostic");
    expect(anchor?.attributes.get("download")).toBe("diagnostic.json");
    expect(anchor?.clickCount).toBe(1);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]).toMatchObject({
      parts: ['{"state":"failed"}'],
      options: { type: "application/json" }
    });
    expect(revoked).toEqual([]);
    revokeHandlers[0]?.();
    expect(revoked).toEqual(["blob:diagnostic"]);
    expect(body.children).toEqual([]);
  });

  it("refuses generated downloads without every required browser capability", () => {
    const document = new FakeDocument();
    const valid = {
      document,
      Blob: class {},
      URL: {
        createObjectURL: () => "blob:diagnostic",
        revokeObjectURL: () => undefined
      }
    };
    for (const overrides of [
      { ...valid, Blob: undefined },
      { ...valid, URL: undefined },
      { ...valid, URL: { revokeObjectURL: () => undefined } },
      { ...valid, URL: { createObjectURL: () => "blob:diagnostic" } }
    ]) {
      expect(
        resolveBrowserContext(createScope(overrides)).download.save(
          "{}",
          "application/json",
          "diagnostic.json"
        )
      ).toBe(false);
    }

    document.body = null;
    expect(
      resolveBrowserContext(createScope(valid)).download.save(
        "{}",
        "application/json",
        "diagnostic.json"
      )
    ).toBe(false);
  });

  it("refuses an invalid object URL and cleans up after a download click failure", () => {
    const invalidUrl = resolveBrowserContext(
      createScope({
        Blob: class {},
        URL: {
          createObjectURL: () => null,
          revokeObjectURL: () => undefined
        }
      })
    );
    expect(
      invalidUrl.download.save("{}", "application/json", "diagnostic.json")
    ).toBe(false);

    const document = new FakeDocument();
    const body = document.body;
    if (!(body instanceof FakeElement)) throw new Error("expected fake body");
    const brokenAnchor = new FakeElement("broken", "a");
    brokenAnchor.click = () => {
      throw new Error("click failed");
    };
    document.createElement = () => brokenAnchor;
    const revoked: string[] = [];
    const context = resolveBrowserContext(
      createScope({
        document,
        Blob: class {},
        URL: {
          createObjectURL: () => "blob:diagnostic",
          revokeObjectURL: (url: string) => revoked.push(url)
        }
      })
    );
    expect(() =>
      context.download.save("{}", "application/json", "diagnostic.json")
    ).toThrow("click failed");
    expect(body.children).toEqual([]);
    expect(revoked).toEqual(["blob:diagnostic"]);
  });

  it("falls back to window.open and reports blocked or empty requests", () => {
    const document = new FakeDocument();
    document.body = null;
    const calls: unknown[][] = [];
    const context = resolveBrowserContext(
      createScope({
        document,
        open: (...args: unknown[]) => {
          calls.push(args);
          return {};
        }
      })
    );
    expect(context.external.open("https://example.test/path")).toBe(true);
    expect(calls).toEqual([
      ["https://example.test/path", "_blank", "noopener"]
    ]);
    expect(context.external.open("")).toBe(false);

    expect(
      resolveBrowserContext(
        createScope({ document, open: () => null })
      ).external.open("https://example.test")
    ).toBe(false);
    expect(
      resolveBrowserContext(
        createScope({ document, open: undefined })
      ).external.open("https://example.test")
    ).toBe(false);
  });

  it("reports clipboard permission and logger outcomes through narrow ports", async () => {
    const written: string[] = [];
    const reports: unknown[][] = [];
    const context = resolveBrowserContext(
      createScope({
        navigator: {
          clipboard: {
            writeText: (text: string) => {
              written.push(text);
              return Promise.resolve();
            }
          }
        },
        console: {
          error: (...args: unknown[]) => reports.push(args)
        }
      })
    );
    await expect(context.clipboard.write("rad deploy")).resolves.toBe(true);
    expect(written).toEqual(["rad deploy"]);
    context.logger.error("failed", { id: 1 });
    expect(reports).toEqual([["failed", { id: 1 }]]);

    await expect(
      resolveBrowserContext(
        createScope({
          navigator: {
            clipboard: {
              writeText: () => Promise.reject(new Error("denied"))
            }
          }
        })
      ).clipboard.write("value")
    ).resolves.toBe(false);
    await expect(
      resolveBrowserContext(
        createScope({ navigator: undefined })
      ).clipboard.write("value")
    ).resolves.toBe(false);
  });
});
