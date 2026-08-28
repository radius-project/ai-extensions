import { describe, expect, it, vi } from "vitest";
import {
  createFakeBrowser,
  createFakeElement
} from "../../../test/support/browser/fakes.js";
import {
  type GraphErrorRenderer,
  showGraphModelingFailure,
  unsupportedGraphModelMessage,
  UNSUPPORTED_GRAPH_MODEL_MESSAGE
} from "./graph-modeling-failure.js";

describe("unsupportedGraphModelMessage", () => {
  it("returns the server error for an unsupported model response", () => {
    expect(
      unsupportedGraphModelMessage({
        appBicepUnsupported: true,
        error: "No application Dockerfile was found."
      })
    ).toBe("No application Dockerfile was found.");
  });

  it("uses a shared fallback when the server omits the error", () => {
    expect(unsupportedGraphModelMessage({ appBicepUnsupported: true })).toBe(
      UNSUPPORTED_GRAPH_MODEL_MESSAGE
    );
  });

  it("ignores ordinary responses", () => {
    expect(
      unsupportedGraphModelMessage({ error: "compile failed" })
    ).toBeNull();
  });
});

describe("showGraphModelingFailure", () => {
  it.each([
    ["modeled", "graph-status", "graph-guidance"],
    ["diff", "diff-status", "graph-diff-summary"]
  ])(
    "renders the %s error and clears its real status and stale content elements",
    (_page, statusId, staleContentId) => {
      const browser = createFakeBrowser();
      const status = createFakeElement(statusId);
      status.textContent = "still loading";
      const staleContent = createFakeElement(staleContentId);
      staleContent.textContent = "stale context";
      browser.document.add(status);
      browser.document.add(staleContent);
      const setError: GraphErrorRenderer = vi.fn(
        (_containerId: string, _message: string): unknown => undefined
      );

      showGraphModelingFailure(
        browser.context,
        setError,
        "No application Dockerfile was found.",
        {
          containerId: "graph-container",
          statusIds: [statusId],
          staleContentIds: [staleContentId]
        }
      );

      expect(setError).toHaveBeenCalledWith(
        "graph-container",
        "No application Dockerfile was found."
      );
      expect(status.style.display).toBe("none");
      expect(status.textContent).toBe("");
      expect(staleContent.style.display).toBe("none");
    }
  );

  it("does not fail when optional page elements are absent", () => {
    const browser = createFakeBrowser();
    const setError: GraphErrorRenderer = vi.fn(
      (_containerId: string, _message: string): unknown => undefined
    );

    showGraphModelingFailure(
      browser.context,
      setError,
      "No application Dockerfile was found.",
      {
        containerId: "graph-container",
        statusIds: ["missing-status"],
        staleContentIds: ["missing-summary"]
      }
    );

    expect(setError).toHaveBeenCalledTimes(1);
  });
});
