import assert from "node:assert/strict";
import { expect } from "@playwright/test";

const part = (name) => `[data-radius-part="${name}"]`;
const edge = ".radius-graph__edge .react-flow__edge-path";
const control = ".react-flow__controls-button";

async function assertGeometry(graph) {
  await expect(graph.locator(part("node"))).toHaveCount(2);
  await expect(graph.locator(edge)).toHaveCount(1);
  const boxes = await graph.locator(part("node")).evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
        managedWidth: globalThis.getComputedStyle(node).width
      };
    })
  );
  for (const { managedWidth, ...box } of boxes) {
    assert.equal(managedWidth, "220px");
    assert.ok(Object.values(box).every(Number.isFinite));
    assert.ok(box.width > 100 && box.height > 50);
  }
  const [first, second] = boxes;
  assert.ok(
    first.right <= second.left ||
      second.right <= first.left ||
      first.bottom <= second.top ||
      second.bottom <= first.top,
    "Real packed graph cards must not overlap"
  );
  const paths = await graph.locator(edge).evaluateAll((elements) =>
    elements.map((path) => ({
      d: path.getAttribute("d"),
      length: path.getTotalLength(),
      start: { x: path.getPointAtLength(0).x, y: path.getPointAtLength(0).y },
      end: {
        x: path.getPointAtLength(path.getTotalLength()).x,
        y: path.getPointAtLength(path.getTotalLength()).y
      }
    }))
  );
  for (const path of paths) {
    assert.ok(path.d && !/NaN|Infinity/.test(path.d));
    assert.ok(
      [path.length, path.start.x, path.start.y, path.end.x, path.end.y].every(
        Number.isFinite
      )
    );
    assert.ok(path.length > 0);
    assert.notDeepEqual(path.start, path.end);
  }
}

async function paintSnapshot(graph) {
  return graph.evaluate((root) => {
    const selectors = [
      null,
      '[data-radius-part="node"]',
      '[data-radius-part="node-title"]',
      '[data-radius-part="node-type"]',
      '[data-radius-part="details"]',
      '[data-radius-part="legend"]',
      ".react-flow__controls-button",
      ".radius-graph__edge .react-flow__edge-path"
    ];
    return selectors.map((selector) => {
      const element = selector ? root.querySelector(selector) : root;
      const css = globalThis.getComputedStyle(element);
      return {
        color: css.color,
        background: css.backgroundColor,
        border: css.border,
        radius: css.borderRadius,
        font: css.font,
        stroke: css.stroke,
        strokeWidth: css.strokeWidth
      };
    });
  });
}

async function openDetails(page, graph) {
  const button = graph
    .getByRole("group", { name: "web", exact: true })
    .getByRole("button", { name: "Show details" });
  await button.focus();
  await expect(button).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(graph.locator(part("details"))).toBeVisible();
  return button;
}

async function closeDetails(page, graph, button) {
  await page.keyboard.press("Escape");
  await expect(graph.locator(part("details"))).toBeHidden();
  await expect(button).toBeFocused();
}

export async function exerciseHostStyling(page, baseOnly) {
  const custom = page.getByRole("region", { name: "Custom styled graph" });
  const defaults = page.getByRole("region", { name: "Default styled graph" });
  await expect(custom).toHaveAttribute("data-radius-appearance", "custom");
  const node = custom.getByRole("group", { name: "web", exact: true });
  const panel = custom.locator(part("details"));
  const type = node.locator(part("node-type"));
  const legend = custom.locator(part("legend"));
  await expect(node).toHaveAttribute("data-radius-diff", "modified");
  await expect(node).toHaveAttribute("data-radius-deploy", "running");
  await expect(node).toHaveAttribute(
    "data-radius-provisioning",
    "CandidatePending"
  );
  await expect(custom).toHaveCSS("height", "360px");
  await expect(custom).toHaveCSS("min-height", "0px");
  await expect(custom).toHaveCSS("font-family", "monospace");
  await expect(node).toHaveCSS("background-color", "rgb(233, 244, 255)");
  await expect(node).toHaveCSS("color", "rgb(20, 42, 66)");
  await expect(node).toHaveCSS("border", "3px dashed rgb(30, 90, 150)");
  await expect(node).toHaveCSS("border-radius", "3px");
  await expect(node.locator(part("node-title"))).toHaveCSS("font-size", "22px");
  await expect(type).toHaveCSS("font-size", "18px");
  assert.equal(await type.evaluate((element) => element.style.fontSize), "");
  await expect(legend).toHaveCSS("font-size", "19px");
  await expect(legend).toHaveCSS("background-color", "rgb(237, 233, 254)");
  await expect(legend).toHaveCSS("color", "rgb(76, 29, 149)");
  await expect(custom.locator(control).first()).toHaveCSS(
    "background-color",
    "rgb(91, 33, 182)"
  );
  await expect(custom.locator(control).first()).toHaveCSS(
    "color",
    "rgb(250, 245, 255)"
  );
  await expect(custom.locator(edge)).toHaveCSS("stroke", "rgb(13, 148, 136)");
  await expect(custom.locator(edge)).toHaveCSS("stroke-width", "4px");
  await expect(
    custom.locator(".react-flow__background circle").first()
  ).toHaveCSS("fill", "rgb(30, 90, 150)");
  await assertGeometry(custom);

  let defaultPaint;
  if (baseOnly) {
    await expect(defaults).toHaveCount(0);
  } else {
    await expect(defaults).toHaveAttribute("data-radius-appearance", "default");
    await expect(defaults).toHaveCSS("min-height", "450px");
    await expect(defaults).toHaveCSS("height", "450px");
    await expect(defaults).toHaveCSS("font-size", "14px");
    const defaultNode = defaults.getByRole("group", {
      name: "web",
      exact: true
    });
    await expect(defaultNode).toHaveCSS("border-radius", "16px");
    await expect(defaultNode).toHaveCSS("border-top-style", "solid");
    await expect(defaultNode.locator(part("node-title"))).toHaveCSS(
      "font-size",
      "16px"
    );
    await expect(defaultNode.locator(part("node-type"))).toHaveCSS(
      "font-size",
      "13px"
    );
    await assertGeometry(defaults);
    const defaultButton = await openDetails(page, defaults);
    await expect(defaults.locator(part("details"))).toHaveCSS(
      "border-radius",
      "8px"
    );
    await expect(defaults.locator(part("details"))).toHaveCSS(
      "font-size",
      "13px"
    );
    await expect(defaults.locator(part("details-link")).first()).toHaveCSS(
      "color",
      "rgb(9, 105, 218)"
    );
    await closeDetails(page, defaults, defaultButton);
    defaultPaint = await paintSnapshot(defaults);
  }

  const button = await openDetails(page, custom);
  await expect(panel).toHaveCSS("background-color", "rgb(233, 244, 255)");
  await expect(panel).toHaveCSS("border", "4px dotted rgb(30, 90, 150)");
  await expect(panel).toHaveCSS("border-radius", "2px");
  await expect(panel).toHaveCSS("font-family", "monospace");
  await expect(panel).toHaveCSS("font-size", "17px");
  const source = panel.getByRole("link", { name: "View source code" });
  await expect(source).toHaveCSS("color", "rgb(124, 45, 18)");
  await expect(source).toHaveCSS("font-size", "17px");
  await expect(source).toHaveAttribute(
    "href",
    "https://github.com/radius-project/packed-fixture/blob/main/src/web.ts"
  );
  await source.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#opened-link")).toHaveText(
    "https://github.com/radius-project/packed-fixture/blob/main/src/web.ts"
  );
  await closeDetails(page, custom, button);

  await page.getByRole("button", { name: "Change host stylesheet" }).click();
  await expect(node).toHaveCSS("background-color", "rgb(255, 247, 214)");
  await expect(node).toHaveCSS("color", "rgb(78, 42, 12)");
  await expect(node).toHaveCSS("border-radius", "11px");
  await expect(node).toHaveCSS("border-top-color", "rgb(150, 85, 30)");
  await expect(type).toHaveCSS("font-size", "20px");
  await expect(legend).toHaveCSS("background-color", "rgb(255, 237, 213)");
  await expect(custom.locator(control).first()).toHaveCSS(
    "background-color",
    "rgb(120, 53, 15)"
  );
  await expect(custom.locator(edge)).toHaveCSS("stroke", "rgb(180, 83, 9)");
  await expect(custom.locator(edge)).toHaveCSS("stroke-width", "5px");
  await assertGeometry(custom);
  const changedButton = await openDetails(page, custom);
  await expect(panel).toHaveCSS("background-color", "rgb(255, 247, 214)");
  await expect(panel).toHaveCSS("border-radius", "9px");
  await expect(source).toHaveCSS("color", "rgb(21, 94, 117)");
  await closeDetails(page, custom, changedButton);
  if (!baseOnly) assert.deepEqual(await paintSnapshot(defaults), defaultPaint);
}
