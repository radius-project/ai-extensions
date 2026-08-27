import { describe, expect, it, vi } from "vitest";
import {
  type GraphErrorRenderer,
  showGraphModelingFailure,
  unsupportedGraphModelMessage,
  UNSUPPORTED_GRAPH_MODEL_MESSAGE
} from "./graph-modeling-failure.js";
function context(): {
  browser: {
    dom: {
      byId: (
        id: string
      ) => { style: { display: string }; textContent: string } | null;
    };
  };
  status: { style: { display: string }; textContent: string };
  staleContent: { style: { display: string }; textContent: string };
  setError: GraphErrorRenderer;
} {
  const status = {
    style: { display: "" },
    textContent: "still loading"
  };
  const staleContent = {
    style: { display: "" },
    textContent: "No application graph changes."
  };
  const setError: GraphErrorRenderer = vi.fn(
    (_containerId: string, _message: string): unknown => undefined
  );
  const browser = {
    dom: {
      byId: (id: string) =>
        id === "graph-status" ? status
        : id === "graph-summary" ? staleContent
        : null
    }
  };
  return { browser, status, staleContent, setError };
}

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
  it("renders the error and clears the graph status", () => {
    const { browser, status, staleContent, setError } = context();

    showGraphModelingFailure(
      browser,
      setError,
      "No application Dockerfile was found.",
      {
        statusIds: "graph-status",
        staleContentIds: ["graph-summary"]
      }
    );

    expect(setError).toHaveBeenCalledWith(
      "graph-container",
      "No application Dockerfile was found."
    );
    expect(status.style.display).toBe("none");
    expect(status.textContent).toBe("");
    expect(staleContent.style.display).toBe("none");
  });

  it("does not fail when the page status element is absent", () => {
    const { browser, setError } = context();

    showGraphModelingFailure(
      {
        ...browser,
        dom: { byId: () => null }
      },
      setError,
      "No application Dockerfile was found.",
      {
        statusIds: "missing-status",
        staleContentIds: ["missing-summary"]
      }
    );

    expect(setError).toHaveBeenCalledTimes(1);
  });
});
