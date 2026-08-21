// Declarative element construction for browser behavior.
//
// Every value a page receives from an API response is attacker-influenced, so
// modules that render responses build real nodes here instead of assembling
// markup: text always lands in `textContent` and attributes always go through
// `setAttribute`, which removes the HTML-injection sink entirely rather than
// relying on an escape being remembered at each call site.

import type { BrowserContext, DomElement, DomPort } from "./ports.js";

export interface ElementSpec {
  readonly tag: string;
  readonly id?: string;
  readonly className?: string;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly children?: readonly ElementSpec[];
}

export function buildElement(dom: DomPort, spec: ElementSpec): DomElement {
  const element = dom.createElement(spec.tag);
  if (spec.id !== undefined) element.id = spec.id;
  if (spec.className !== undefined) element.className = spec.className;
  if (spec.attrs !== undefined) {
    for (const name of Object.keys(spec.attrs)) {
      element.setAttribute(name, spec.attrs[name]);
    }
  }
  if (spec.text !== undefined) element.textContent = spec.text;
  for (const child of spec.children ?? []) {
    element.appendChild(buildElement(dom, child));
  }
  return element;
}

export function setChildren(
  dom: DomPort,
  host: DomElement,
  specs: readonly ElementSpec[]
): void {
  host.replaceChildren(...specs.map((spec) => buildElement(dom, spec)));
}

export function clearChildren(host: DomElement): void {
  host.replaceChildren();
}

// Server-rendered page fragments are trusted extension output. Replacing each
// parsed script node is required because scripts assigned through innerHTML do
// not execute. Every attribute is carried over, so a `type` that marks a block
// as inert data keeps it inert instead of turning it into a classic script.
export function activateInlineScripts(
  context: BrowserContext,
  root: DomElement
): void {
  for (const stale of context.dom.all(root, "script")) {
    const parent = stale.parentNode;
    if (parent === null) continue;
    const next = context.dom.createElement("script");
    for (const name of stale.getAttributeNames()) {
      const value = stale.getAttribute(name);
      if (value !== null) next.setAttribute(name, value);
    }
    const src = stale.getAttribute("src");
    if (src === null || src === "") next.textContent = stale.textContent;
    parent.replaceChild(next, stale);
  }
}

export function text(value: string, className?: string): ElementSpec {
  return className === undefined ?
      { tag: "span", text: value }
    : { tag: "span", className, text: value };
}

export function strong(value: string): ElementSpec {
  return { tag: "strong", text: value };
}
