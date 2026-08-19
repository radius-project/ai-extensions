import { describe, expect, it } from "vitest";
import {
  buildElement,
  clearChildren,
  setChildren,
  strong,
  text
} from "./dom.js";
import {
  createFakeBrowser,
  createFakeElement,
  fakeText
} from "../../test/support/browser/fakes.js";

describe("buildElement", () => {
  it("creates the requested tag with identity, class, and attributes", () => {
    const browser = createFakeBrowser();
    const element = buildElement(browser.context.dom, {
      tag: "button",
      id: "go",
      className: "rad-btn",
      attrs: { type: "button", "aria-label": "Go" },
      text: "Go"
    });

    expect(element.id).toBe("go");
    expect(element.className).toBe("rad-btn");
    expect(element.getAttribute("type")).toBe("button");
    expect(element.getAttribute("aria-label")).toBe("Go");
    expect(element.textContent).toBe("Go");
  });

  it("omits identity, class, attributes, and text when unspecified", () => {
    const browser = createFakeBrowser();
    const element = buildElement(browser.context.dom, { tag: "div" });

    expect(element.id).toBe("");
    expect(element.className).toBe("");
    expect(element.textContent).toBe("");
    expect(element.innerHTML).toBe("");
  });

  it("nests children in order beneath their parent", () => {
    const browser = createFakeBrowser();
    const host = createFakeElement("host");
    setChildren(browser.context.dom, host, [
      {
        tag: "div",
        children: [
          text("Deleting "),
          strong("store"),
          { tag: "span", text: " now", children: [{ tag: "em", text: "!" }] }
        ]
      }
    ]);

    expect(fakeText(host)).toBe("Deleting store now!");
    expect(host.children[0].children.map((child) => child.tagName)).toEqual([
      "span",
      "strong",
      "span"
    ]);
  });

  it("never renders a value as markup", () => {
    const browser = createFakeBrowser();
    const element = buildElement(browser.context.dom, {
      tag: "div",
      text: "<img src=x onerror=alert(1)>",
      attrs: { title: '"><script>alert(1)</script>' }
    });

    expect(element.innerHTML).toBe("");
    expect(element.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(element.getAttribute("title")).toBe('"><script>alert(1)</script>');
  });

  it("propagates a host that cannot create the element", () => {
    const browser = createFakeBrowser();
    browser.document.createElement = () => null;

    expect(() => buildElement(browser.context.dom, { tag: "div" })).toThrow(
      /cannot create a <div> element/
    );
  });
});

describe("setChildren", () => {
  it("replaces the previous content with the new specs", () => {
    const browser = createFakeBrowser();
    const host = createFakeElement("host");
    host.appendChild(createFakeElement("stale"));

    setChildren(browser.context.dom, host, [
      { tag: "p", text: "first" },
      { tag: "p", text: "second" }
    ]);

    expect(host.children.map((child) => child.textContent)).toEqual([
      "first",
      "second"
    ]);
  });

  it("clears the host when given no specs", () => {
    const browser = createFakeBrowser();
    const host = createFakeElement("host");
    host.appendChild(createFakeElement("stale"));

    setChildren(browser.context.dom, host, []);

    expect(host.children).toHaveLength(0);
  });
});

describe("clearChildren", () => {
  it("removes every child without touching the host itself", () => {
    const host = createFakeElement("host");
    host.className = "kept";
    host.appendChild(createFakeElement("stale"));

    clearChildren(host);

    expect(host.children).toHaveLength(0);
    expect(host.className).toBe("kept");
  });
});

describe("text and strong helpers", () => {
  it("build inline spans with an optional class", () => {
    expect(text("plain")).toEqual({ tag: "span", text: "plain" });
    expect(text("styled", "rad-note")).toEqual({
      tag: "span",
      className: "rad-note",
      text: "styled"
    });
    expect(strong("bold")).toEqual({ tag: "strong", text: "bold" });
  });
});
