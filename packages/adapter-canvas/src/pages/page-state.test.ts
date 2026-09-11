import { describe, expect, it } from "vitest";
import { readBrowserPageState } from "../../test/support/pages/browser-state.js";
import type { CanvasGraphResource } from "../shared.js";
import * as stateIds from "./browser-state-ids.js";
import type { PageStateById } from "./browser-state-ids.js";
import { renderPageState } from "./page-state.js";

const states = {
  [stateIds.GRAPH_PAGE_STATE_ID]: {
    repo: "octo/app",
    branch: "feature/x",
    resources: [{ id: "app/web", name: "web", connections: [] }],
    loaded: true,
    localSource: true,
    followWorkspaceBranch: false
  },
  [stateIds.PLANNED_GRAPH_STATE_ID]: {
    repo: "octo/app",
    branch: "feature/x",
    environment: "prod-1",
    provider: "azure",
    resources: [],
    localSource: false,
    followWorkspaceBranch: true
  },
  [stateIds.GRAPH_DIFF_STATE_ID]: {
    repo: "octo/app",
    base: "main",
    head: "feature/x",
    workspaceBranch: "feature/x",
    resources: [],
    modelingError: ""
  },
  [stateIds.DEPLOYED_GRAPH_STATE_ID]: {
    repo: "octo/app",
    branch: "feature/x",
    graphBranch: "feature/x",
    provider: "azure",
    mutationNonce: "fixture-nonce"
  },
  [stateIds.DEPLOY_RESULT_STATE_ID]: {
    attemptId: "attempt-1"
  },
  [stateIds.DEPLOYING_PAGE_STATE_ID]: {
    repo: "octo/app",
    branch: "feature/x",
    mutationNonce: "fixture-nonce"
  },
  [stateIds.ENVIRONMENT_PAGE_STATE_ID]: {
    repo: "octo/app",
    branch: "feature/x",
    activeSubtab: "environments",
    mutationNonce: "fixture-nonce"
  }
} satisfies PageStateById;

describe("renderPageState", () => {
  it.each(Object.values(stateIds))(
    "preserves the state fields and hidden element for %s",
    (id) => {
      const state = states[id];
      const html = renderPageState(id, state);

      expect(html).toMatch(new RegExp(`^<div hidden id="${id}">`));
      expect(html).toMatch(/<\/div>$/);
      expect(readBrowserPageState(html, id)).toEqual(state);
    }
  );

  it("retains the existing hidden-element markup and HTML encoding", () => {
    expect(
      renderPageState(stateIds.DEPLOY_RESULT_STATE_ID, {
        attemptId: "attempt-1"
      })
    ).toBe(
      '<div hidden id="radius-deploy-result-state">{&quot;attemptId&quot;:&quot;attempt-1&quot;}</div>'
    );
  });

  it.each([
    ["empty", ""],
    ["ordinary branch", "feature/x"],
    ["valid closing-script ref", "topic</script><script>sentinel()</script>"],
    ["mixed-case closing tag", "</ScRiPt><svg/onload=sentinel()>"],
    ["closing data element", "</div><img src=x onerror=sentinel()>"],
    ["HTML comment", "<!--<script>"],
    ["entity-looking text", "&lt;/script&gt;&amp;&#39;&quot;"],
    ["quotes", "'\""],
    ["backslashes", "a\\b\\n\\"],
    ["line endings", "line1\r\nline2"],
    ["controls", "\u0000\u0001\t\b\f\u001f"],
    ["line separators", "a\u2028b\u2029c"],
    ["emoji", "\ud83d\ude80"],
    ["lone high surrogate", "\ud800"],
    ["lone low surrogate", "\udfff"]
  ])("round-trips %s without emitting data as markup", (_name, attemptId) => {
    const html = renderPageState(stateIds.DEPLOY_RESULT_STATE_ID, {
      attemptId
    });

    expect(html.match(/</g)).toHaveLength(2);
    expect(html).not.toMatch(/[\u2028\u2029]/);
    expect(readBrowserPageState(html, stateIds.DEPLOY_RESULT_STATE_ID)).toEqual(
      { attemptId }
    );
  });

  it("preserves nested JSON values and standard omission/number semantics", () => {
    const resource: CanvasGraphResource = {
      id: "</script>",
      properties: {
        omitted: undefined,
        empty: null,
        flag: true,
        count: 2,
        values: [undefined, NaN, Infinity, -Infinity, -0],
        date: new Date("2026-01-01T00:00:00.000Z")
      }
    };
    const html = renderPageState(stateIds.GRAPH_PAGE_STATE_ID, {
      ...states[stateIds.GRAPH_PAGE_STATE_ID],
      resources: [resource]
    });

    expect(
      readBrowserPageState(html, stateIds.GRAPH_PAGE_STATE_ID).resources
    ).toEqual([
      {
        id: "</script>",
        properties: {
          empty: null,
          flag: true,
          count: 2,
          values: [null, null, null, null, 0],
          date: "2026-01-01T00:00:00.000Z"
        }
      }
    ]);
  });

  it("preserves an own __proto__ key as JSON data, not a prototype setter", () => {
    const state = Object.defineProperty(
      { attemptId: "attempt-1" },
      "__proto__",
      { value: { marker: "data" }, enumerable: true }
    );
    const parsed = readBrowserPageState(
      renderPageState(stateIds.DEPLOY_RESULT_STATE_ID, state),
      stateIds.DEPLOY_RESULT_STATE_ID
    );

    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(parsed["__proto__"]).toEqual({ marker: "data" });
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(parsed.marker).toBeUndefined();
  });

  it("propagates BigInt serialization errors", () => {
    expect(() =>
      renderPageState(stateIds.GRAPH_PAGE_STATE_ID, {
        ...states[stateIds.GRAPH_PAGE_STATE_ID],
        resources: [{ properties: { count: 1n } }]
      })
    ).toThrow(TypeError);
  });

  it("propagates cyclic resource serialization errors", () => {
    const resource: CanvasGraphResource = { id: "app/web" };
    resource.self = resource;

    expect(() =>
      renderPageState(stateIds.GRAPH_PAGE_STATE_ID, {
        ...states[stateIds.GRAPH_PAGE_STATE_ID],
        resources: [resource]
      })
    ).toThrow(TypeError);
  });

  it("propagates a custom serializer failure unchanged", () => {
    const failure = new Error("fixture serialization failed");
    const state = {
      attemptId: "attempt-1",
      toJSON() {
        throw failure;
      }
    };

    expect(() =>
      renderPageState(stateIds.DEPLOY_RESULT_STATE_ID, state)
    ).toThrow(failure);
  });

  it("rejects a custom serializer that emits no JSON rather than returning null", () => {
    const state = {
      attemptId: "attempt-1",
      toJSON() {
        return undefined;
      }
    };

    expect(() =>
      renderPageState(stateIds.DEPLOY_RESULT_STATE_ID, state)
    ).toThrow(
      'Radius page state "radius-deploy-result-state" cannot be serialized.'
    );
  });
});
