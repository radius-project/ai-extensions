import { describe, expect, it } from "vitest";
import {
  asGraphController,
  createGraphSurface,
  GRAPH_LIBRARY_ERROR,
  GRAPH_LOADING_HTML,
  GRAPH_RENDER_ERROR,
  OPEN_SOURCE_PATH
} from "./surface.js";
import {
  createFakeBrowser,
  createFakeElement,
  flushPromises,
  jsonResponse
} from "../../../test/support/browser/fakes.js";
import { createRecordingMount } from "../../../test/support/browser/graph-mount.js";

function setup() {
  const browser = createFakeBrowser();
  const container = createFakeElement("graph-container");
  browser.document.add(container);
  const renderer = createRecordingMount();
  const surface = createGraphSurface(browser.context, () => renderer.mount);
  return { browser, container, renderer, surface };
}

describe("Canvas graph mounting boundary", () => {
  it("recognizes only complete controllers", () => {
    expect(asGraphController(null)).toBeNull();
    expect(asGraphController({ update() {} })).toBeNull();
    expect(asGraphController({ destroy() {} })).toBeNull();
    let destroyed = 0;
    const next = {
      update: () => null,
      destroy: () => {
        destroyed++;
      }
    };
    const controller = asGraphController({
      update: () => next,
      destroy: () => {
        destroyed++;
      }
    });
    expect(controller?.update([])?.update([])).toBeNull();
    controller?.destroy();
    expect(destroyed).toBe(1);
  });
  it.each([
    [{}, "modeled"],
    [{ plannedMode: true }, "planned"],
    [{ deployMode: true }, "deployed-projection"],
    [{ diffMode: true }, "diff"]
  ] as const)(
    "mounts mode %# through the shared component, updates and tears down once",
    (options, kind) => {
      const { surface, renderer } = setup();
      const resources = [{ id: "web", name: "web" }];
      const controller = surface.render("graph-container", resources, options);
      expect(renderer.roots[0].props.graph).toEqual({ kind, resources });
      expect(renderer.roots[0].props.options).toBe(options);
      expect(controller?.update(null)).toBe(controller);
      expect(renderer.roots[0].updates).toEqual([]);
      controller?.update([]);
      expect(renderer.roots[0].updates[0].graph.resources).toEqual([]);
      controller?.destroy();
      controller?.destroy();
      controller?.update(resources);
      expect(renderer.roots[0].unmounts).toBe(1);
      expect(renderer.roots[0].host).toMatchObject({ removed: true });
      expect(renderer.roots[0].updates).toHaveLength(1);
    }
  );
  it.each([
    { state: "empty", resources: [] },
    { state: "populated", resources: [{ id: "web", name: "web" }] }
  ])(
    "isolates replacement and simultaneous roots from stale $state controllers",
    ({ resources }) => {
      const { surface, renderer, browser } = setup();
      browser.document.add(createFakeElement("other"));
      const first = surface.render("graph-container", resources);
      surface.render("graph-container", []);
      surface.render("other", null);
      expect(renderer.roots[2].props.graph.resources).toEqual([]);
      first?.destroy();
      expect(first?.update([{ id: "stale" }])).toBe(first);
      expect(renderer.roots.map((root) => root.unmounts)).toEqual([1, 0, 0]);
      expect(renderer.roots.flatMap((root) => root.updates)).toEqual([]);
      surface.destroyAll();
      surface.destroyAll();
      expect(renderer.roots.map((root) => root.unmounts)).toEqual([1, 1, 1]);
    }
  );
  it("leaves absent page containers alone", () => {
    const { surface, renderer } = setup();
    expect(surface.render("absent", [])).toBeNull();
    surface.setLoading("absent");
    surface.setError("absent", "error");
    expect(renderer.roots).toEqual([]);
  });
  it("unmounts before showing loading or escaped error state", () => {
    const { surface, renderer, container } = setup();
    surface.render("graph-container", []);
    surface.setLoading("graph-container");
    expect(container.innerHTML).toBe(GRAPH_LOADING_HTML);
    expect(container.innerHTML).toContain('id="progress-steps"');
    expect(renderer.roots[0].unmounts).toBe(1);
    surface.render("graph-container", []);
    surface.setError("graph-container", "<script>bad</script>");
    expect(container.querySelector(".error")?.textContent).toBe(
      "<script>bad</script>"
    );
    expect(container.querySelector(".error")?.getAttribute("role")).toBe(
      "alert"
    );
    expect(container.querySelector(".error")?.className).toBe("status error");
    expect(container.innerHTML).toBe("");
    expect(renderer.roots[1].unmounts).toBe(1);
  });
  it.each([false, true])(
    "surfaces missing and failed mounting with reload recovery: %s",
    (throws) => {
      const { browser, container } = setup();
      const surface = createGraphSurface(browser.context, () =>
        throws ?
          () => {
            throw new Error("mount failed");
          }
        : null
      );
      expect(surface.render("graph-container", [])).toBeNull();
      expect(container.querySelector(".error")?.textContent).toBe(
        throws ? GRAPH_RENDER_ERROR : GRAPH_LIBRARY_ERROR
      );
      expect(container.querySelector(".error")?.className).toBe("status error");
      expect(container.querySelector("button")?.textContent).toBe(
        "Reload graph"
      );
      expect(container.querySelector("button")?.getAttribute("type")).toBe(
        "button"
      );
      container.querySelector("button")?.dispatchEvent?.({ type: "click" });
      expect(browser.nav.reloads).toBe(1);
      expect(browser.logger.errors).toEqual(
        throws ?
          [
            {
              message: "Rendering the application graph failed.",
              detail: expect.any(Error)
            }
          ]
        : []
      );
    }
  );
  it("cleans an incomplete render record before retrying a DOM failure", () => {
    const { surface, browser, renderer, container } = setup();
    const createElement = browser.context.dom.createElement;
    let fail = true;
    browser.context.dom.createElement = (tagName) => {
      if (fail) {
        fail = false;
        throw new Error("DOM unavailable");
      }
      return createElement(tagName);
    };

    expect(surface.render("graph-container", [{ id: "web" }])).toBeNull();
    expect(container.querySelector(".error")?.textContent).toBe(
      GRAPH_RENDER_ERROR
    );
    expect(surface.render("graph-container", [{ id: "web" }])).not.toBeNull();
    expect(renderer.roots).toHaveLength(1);
    surface.destroyAll();
    expect(renderer.roots[0].unmounts).toBe(1);
  });
  it("threads callbacks without introducing networking into graph-react", async () => {
    const { surface, renderer, browser } = setup();
    surface.render("graph-container", []);
    const callbacks = renderer.roots[0].props.callbacks;
    callbacks?.onRetry?.();
    callbacks?.onOpenExternal?.("javascript:bad");
    callbacks?.onOpenExternal?.("https://example.test/path");
    browser.net.handle(OPEN_SOURCE_PATH, () => jsonResponse({}));
    callbacks?.onOpenSource?.({
      path: "src/web.ts",
      line: 3,
      fallbackUrl: "https://example.test/fallback"
    });
    await flushPromises();
    expect(browser.net.calls[0]).toMatchObject({
      url: OPEN_SOURCE_PATH,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "src/web.ts", line: 3 })
      }
    });
    expect(browser.nav.reloads).toBe(1);
    expect(browser.external.opened).toEqual(["https://example.test/path"]);
  });

  it.each([0, 4, 31])(
    "posts source line %s with the complete local request contract",
    async (line) => {
      const { surface, browser } = setup();
      browser.net.handle(OPEN_SOURCE_PATH, () => jsonResponse({ ok: true }));

      surface.openLocalSource("src/web.ts", line, "https://github.test/x");
      await flushPromises();

      expect(browser.net.calls).toHaveLength(1);
      expect(browser.net.calls[0]).toMatchObject({
        url: OPEN_SOURCE_PATH,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: "src/web.ts", line })
        }
      });
      expect(browser.external.opened).toEqual([]);
    }
  );

  it.each(["http", "not-on-worktree", "network"] as const)(
    "falls back to safe remote source on a %s failure",
    async (failure) => {
      const { surface, browser } = setup();
      browser.net.handle(OPEN_SOURCE_PATH, () => {
        if (failure === "network") throw new Error("offline");
        if (failure === "not-on-worktree")
          return jsonResponse({ error: "NOT_ON_WORKTREE" }, false, 409);
        return jsonResponse({}, false, 404);
      });
      surface.openLocalSource("src/web.ts", 0, "https://example.test/fallback");
      await flushPromises();
      expect(browser.external.opened).toEqual([
        "https://example.test/fallback"
      ]);
      surface.openLocalSource("", 0, "https://example.test/no-local-source");
      expect(browser.net.calls).toHaveLength(1);
      expect(browser.external.opened).toEqual([
        "https://example.test/fallback",
        "https://example.test/no-local-source"
      ]);
    }
  );

  it("ignores empty and unsafe external URLs without making a request", () => {
    const { surface, browser } = setup();
    surface.openExternal("");
    surface.openExternal("javascript:alert(1)");
    surface.openLocalSource("", 0, "");
    expect(browser.external.opened).toEqual([]);
    expect(browser.net.calls).toEqual([]);
  });

  it("does not act on callbacks from a replaced root or a late failed source request", async () => {
    const { surface, browser, renderer } = setup();
    let reject: (error: Error) => void = () => {
      throw new Error("request not started");
    };
    browser.net.handle(
      OPEN_SOURCE_PATH,
      () =>
        new Promise((_resolve, rejectRequest) => {
          reject = rejectRequest;
        })
    );
    surface.render("graph-container", []);
    const callbacks = renderer.roots[0].props.callbacks;
    callbacks?.onOpenSource?.({
      path: "src/web.ts",
      line: 0,
      fallbackUrl: "https://example.test/fallback"
    });
    await flushPromises();
    surface.destroyAll();
    reject(new Error("late request failed"));
    await flushPromises();
    callbacks?.onOpenExternal?.("https://example.test/stale");
    callbacks?.onRetry?.();
    callbacks?.onOpenSource?.({ path: "stale", line: 0, fallbackUrl: "" });
    expect(browser.external.opened).toEqual([]);
    expect(browser.nav.reloads).toBe(0);
    expect(browser.net.calls).toHaveLength(1);
  });

  it("cleans every host and reports unmount failures without abandoning later roots", () => {
    const { browser, renderer } = setup();
    browser.document.add(createFakeElement("other"));
    const surface = createGraphSurface(browser.context, () => (host, props) => {
      const root = renderer.mount(host, props);
      return {
        ...root,
        unmount() {
          root.unmount();
          throw new Error("unmount failed");
        }
      };
    });
    surface.render("graph-container", []);
    surface.render("other", []);
    expect(() => surface.destroyAll()).toThrow(AggregateError);
    expect(renderer.roots.map((root) => root.unmounts)).toEqual([1, 1]);
    for (const root of renderer.roots)
      expect(root.host).toMatchObject({ removed: true });
    expect(() => surface.destroyAll()).not.toThrow();
  });
});
