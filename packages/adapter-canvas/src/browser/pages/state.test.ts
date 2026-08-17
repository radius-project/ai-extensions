import { describe, expect, it } from "vitest";
import {
  createFakeBrowser,
  createFakeElement
} from "../../../test/support/browser/fakes.js";
import { readPageState } from "./state.js";

describe("readPageState", () => {
  it("parses a JSON object stored in the page state element", () => {
    const browser = createFakeBrowser();
    const element = createFakeElement("state-id");
    element.textContent = JSON.stringify({ repo: "octo/app" });
    browser.document.add(element);

    expect(readPageState(browser.context, "state-id")).toEqual({
      repo: "octo/app"
    });
  });

  it("throws when the state element is missing from the page", () => {
    const browser = createFakeBrowser();

    expect(() => readPageState(browser.context, "missing-id")).toThrow(
      'Radius browser page state "missing-id" is missing.'
    );
  });

  it("throws when the element content is not valid JSON", () => {
    const browser = createFakeBrowser();
    const element = createFakeElement("state-id");
    element.textContent = "{not json";
    browser.document.add(element);

    expect(() => readPageState(browser.context, "state-id")).toThrow(
      'Radius browser page state "state-id" is invalid.'
    );
  });

  it("treats a missing textContent as empty and reports invalid JSON", () => {
    const browser = createFakeBrowser();
    const element = createFakeElement("state-id");
    element.textContent = null;
    browser.document.add(element);

    expect(() => readPageState(browser.context, "state-id")).toThrow(
      'Radius browser page state "state-id" is invalid.'
    );
  });

  it("throws when the parsed JSON is an array rather than an object", () => {
    const browser = createFakeBrowser();
    const element = createFakeElement("state-id");
    element.textContent = JSON.stringify([1, 2, 3]);
    browser.document.add(element);

    expect(() => readPageState(browser.context, "state-id")).toThrow(
      'Radius browser page state "state-id" is not an object.'
    );
  });

  it("throws when the parsed JSON is null", () => {
    const browser = createFakeBrowser();
    const element = createFakeElement("state-id");
    element.textContent = "null";
    browser.document.add(element);

    expect(() => readPageState(browser.context, "state-id")).toThrow(
      'Radius browser page state "state-id" is not an object.'
    );
  });
});
