import { describe, expect, it, vi } from "vitest";
import {
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
  setError: ReturnType<typeof vi.fn>;
} {
  const status = {
    style: { display: "" },
    textContent: "still loading"
  };
  const setError = vi.fn();
  const browser = {
    dom: {
      byId: (id: string) => (id === "graph-status" ? status : null)
    }
  };
  return { browser, status, setError };
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
    const { browser, status, setError } = context();

    showGraphModelingFailure(
      browser,
      { radiusSetGraphError: setError },
      "No application Dockerfile was found.",
      "graph-status"
    );

    expect(setError).toHaveBeenCalledWith(
      "graph-container",
      "No application Dockerfile was found."
    );
    expect(status.style.display).toBe("none");
    expect(status.textContent).toBe("");
  });

  it("does not fail when the page status element is absent", () => {
    const { browser, setError } = context();

    showGraphModelingFailure(
      {
        ...browser,
        dom: { byId: () => null }
      },
      { radiusSetGraphError: setError },
      "No application Dockerfile was found.",
      "missing-status"
    );

    expect(setError).toHaveBeenCalledTimes(1);
  });
});
