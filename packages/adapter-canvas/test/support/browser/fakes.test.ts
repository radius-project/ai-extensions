import { describe, expect, it } from "vitest";
import { FakeElement, FakeEventTarget } from "./fakes.js";
import type { DomEvent } from "../../../src/browser/ports.js";

describe("FakeEventTarget.dispatchEvent", () => {
  it("delivers the dispatched event's own fields to listeners", () => {
    const target = new FakeEventTarget();
    const seen: DomEvent[] = [];
    target.addEventListener("keydown", (event) => seen.push(event));

    target.dispatchEvent({ type: "keydown", key: "Enter", shiftKey: true });

    expect(seen).toHaveLength(1);
    expect(seen[0].key).toBe("Enter");
    expect(seen[0].shiftKey).toBe(true);
    expect(typeof seen[0].preventDefault).toBe("function");
  });

  it("leaves unspecified fields undefined rather than inventing them", () => {
    const target = new FakeEventTarget();
    const seen: DomEvent[] = [];
    target.addEventListener("change", (event) => seen.push(event));

    target.dispatchEvent({ type: "change" });

    expect(seen[0].key).toBeUndefined();
    expect(seen[0].target).toBeUndefined();
  });

  it("rejects an event without a string type instead of dispatching nothing", () => {
    const target = new FakeEventTarget();

    expect(() => target.dispatchEvent({})).toThrow(
      "Fake events require a string type."
    );
  });

  it("applies the same dispatch semantics to elements", () => {
    const element = new FakeElement("button");
    const keys: (string | undefined)[] = [];
    element.addEventListener("keydown", (event) => keys.push(event.key));

    element.dispatchEvent({ type: "keydown", key: " " });

    expect(keys).toEqual([" "]);
    expect(() => element.dispatchEvent({ type: 7 })).toThrow(
      "Fake events require a string type."
    );
  });
});
