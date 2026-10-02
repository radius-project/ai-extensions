import { afterEach, describe, expect, it } from "vitest";
import { waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { mountRadiusGraph } from "@radius-project/graph-react";
import "@radius-project/graph-react/styles.css";
import { installGraphEntry } from "../../src/browser/entries/graph.js";
import {
  asGraphController,
  createGraphSurface
} from "../../src/browser/graph/surface.js";
import { SHELL_STYLE_CSS } from "../../src/pages/shell-styles.js";
import { createRealScope, jsonResponse } from "./support/real-scope.js";

const dispose: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of dispose.splice(0).reverse()) cleanup();
});

describe("Canvas entry with the canonical renderer in Chromium", () => {
  it("repopulates an empty Canvas controller and removes its real host and details on destroy", async () => {
    const real = createRealScope();
    real.host.id = "graph-render-recovery";
    real.host.style.width = "850px";
    real.host.style.height = "650px";
    const surface = createGraphSurface(real.context, () => mountRadiusGraph);
    dispose.push(() => {
      surface.destroyAll();
      real.dispose();
    });
    const controller = surface.render(real.host.id, []);
    await within(real.host).findByText("No resources in this application.");

    expect(controller?.update([{ id: "web", name: "web" }])).toBe(controller);
    await within(real.host).findByRole("group", { name: "web" });
    expect(real.host.querySelector("[data-radius-details]")).not.toBeNull();
    controller?.destroy();
    expect(real.host.childElementCount).toBe(0);
    expect(real.host.querySelector("[data-radius-details]")).toBeNull();
    controller?.destroy();
  });

  it.each([
    ["feature", null],
    ["", "_blank"]
  ] as const)(
    "threads a workspace branch of %j through the mounted source link",
    async (workspaceBranch, target) => {
      const real = createRealScope({
        route: () => {
          throw new Error("Rendering the graph must not make network requests");
        }
      });
      real.host.id = "graph-entry-source-target";
      real.host.style.width = "850px";
      real.host.style.height = "650px";
      const teardown = installGraphEntry(real.scope, mountRadiusGraph);
      dispose.push(() => {
        teardown();
        real.dispose();
      });
      const render: unknown = Reflect.get(real.scope, "radiusRenderGraph");
      if (typeof render !== "function")
        throw new Error("Canvas did not publish radiusRenderGraph");
      const controller = render(
        real.host.id,
        [{ id: "app/web", name: "web", codeReference: "web.bicep#L3" }],
        {
          diffMode: true,
          localSource: false,
          repoUrl: "https://github.com/octo/app",
          branch: "feature",
          baseBranch: "main",
          workspaceBranch
        }
      );
      expect(asGraphController(controller)).not.toBeNull();
      const card = await within(real.host).findByRole("group", { name: "web" });
      const source = within(card).getByRole("link", {
        name: /View source code/
      });
      expect(source.getAttribute("href")).toBe(
        "https://github.com/octo/app/blob/feature/web.bicep#L3"
      );
      expect(source.getAttribute("target")).toBe(target);
      if (target === "_blank") {
        expect(source.getAttribute("rel")).toBe("noopener noreferrer");
      }
      expect(real.requests).toEqual([]);
    }
  );

  it.each([360, 900])(
    "preserves legend spacing and a 450px drawing area in a %ipx host",
    async (width) => {
      const real = createRealScope();
      const style = document.createElement("style");
      style.textContent = SHELL_STYLE_CSS;
      document.head.appendChild(style);
      const card = document.createElement("div");
      card.className = "rad-card";
      card.style.width = `${width}px`;
      const note = document.createElement("div");
      note.textContent = "Last deployment.";
      note.style.cssText = "font-size:12px;margin-bottom:12px;";
      real.host.id = "graph-container";
      card.append(note, real.host);
      document.body.appendChild(card);
      const teardown = installGraphEntry(real.scope, mountRadiusGraph);
      dispose.push(() => {
        teardown();
        real.dispose();
        card.remove();
        style.remove();
      });
      const render: unknown = Reflect.get(real.scope, "radiusRenderGraph");
      if (typeof render !== "function")
        throw new Error("Canvas did not publish radiusRenderGraph");
      render(
        real.host.id,
        [{ id: "web", name: "web", type: "Radius.Compute/containers" }],
        { deployMode: true, showLegend: true }
      );
      const legend = await within(real.host).findByText("Pending / deploying");
      const legendBox = legend.getBoundingClientRect();
      // Geometry derived by subtracting two rects is fractional, so compare the
      // incumbent spacing to within a twentieth of a pixel rather than exactly.
      expect(legendBox.top - note.getBoundingClientRect().bottom).toBeCloseTo(
        12,
        1
      );
      expect(getComputedStyle(legend).fontSize).toBe("12px");
      expect(legendBox.height).toBeCloseTo(20, 1);
      const spinner = legend.querySelector("img")?.getBoundingClientRect();
      expect(spinner?.width).toBeCloseTo(14, 1);
      expect(spinner?.height).toBeCloseTo(14, 1);
      expect((spinner?.top ?? 0) - legendBox.top).toBeCloseTo(3, 1);
      const viewport = real.host.querySelector(".radius-graph__viewport");
      if (!(viewport instanceof HTMLElement))
        throw new Error("Canvas did not render the shared drawing area");
      expect(
        viewport.getBoundingClientRect().top - legendBox.bottom
      ).toBeCloseTo(8, 1);
      expect(viewport.getBoundingClientRect().height).toBeCloseTo(450, 1);
      expect(getComputedStyle(viewport).borderRadius).toBe("10px");
      expect(getComputedStyle(real.host).backgroundColor).toBe(
        "rgba(0, 0, 0, 0)"
      );
      const control = await within(real.host).findByRole("button", {
        name: "Zoom In"
      });
      expect(getComputedStyle(control).boxSizing).toBe("content-box");
      const controlBox = control.getBoundingClientRect();
      expect(controlBox.width).toBeCloseTo(36, 1);
      expect(controlBox.height).toBeCloseTo(37, 1);
    }
  );

  it("mounts through native host ports, opens local source over HTTP, updates and tears down", async () => {
    const real = createRealScope({
      route: () => jsonResponse(200, { opened: true })
    });
    real.host.id = "graph-component-host";
    real.host.style.width = "850px";
    real.host.style.height = "650px";
    const teardown = installGraphEntry(real.scope, mountRadiusGraph);
    dispose.push(() => {
      teardown();
      real.dispose();
    });
    const render: unknown = Reflect.get(real.scope, "radiusRenderGraph");
    if (typeof render !== "function")
      throw new Error("Canvas did not publish radiusRenderGraph");
    const resources = [
      {
        id: "app/web",
        name: "web",
        type: "Radius.Compute/containers",
        codeReference: "src/web.ts#L7"
      }
    ];
    const controller = asGraphController(
      render(real.host.id, resources, {
        localSource: true,
        repoUrl: "https://github.com/example/app",
        branch: "feature"
      })
    );
    const card = await within(real.host).findByRole("group", { name: "web" });
    await userEvent.click(
      within(card).getByRole("link", { name: /View source code/ })
    );
    await waitFor(() => expect(real.requests).toHaveLength(1));
    expect(real.requests[0]).toMatchObject({
      url: "/api/open-source",
      method: "POST",
      body: { path: "src/web.ts", line: 7 }
    });
    expect(
      real.host.querySelector("[data-radius-details]")?.getAttribute("style")
    ).toMatch(/display:\s*none/);
    controller?.update([{ ...resources[0], name: "renamed" }]);
    await within(real.host).findByRole("group", { name: "renamed" });
    teardown();
    await waitFor(() =>
      expect(real.host.querySelector(".react-flow")).toBeNull()
    );
    controller?.update(resources);
    expect(real.host.querySelector(".react-flow")).toBeNull();
  });
});
