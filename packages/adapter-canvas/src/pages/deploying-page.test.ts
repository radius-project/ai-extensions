import { describe, expect, it } from "vitest";
import { DEPLOYING_PAGE_STATE_ID } from "../browser/deploying/page.js";
import { browserEntryMarker, browserScript } from "../browser/scripts.js";
import {
  HOSTILE_STATE,
  expectSafeInlineScripts
} from "../../test/support/pages/hostile-state.js";
import { readBrowserPageState } from "../../test/support/pages/browser-state.js";
import { deployingPage } from "./deploying-page.js";

describe("deployingPage", () => {
  it("renders the stable deployment controls and destructive dialog", () => {
    const html = deployingPage({
      contextRepo: "octo/app",
      contextBranch: "feature/x"
    });

    expect(html).toContain("<title>Deployments — Radius</title>");
    expect(html).toContain('id="deploy-app-select"');
    expect(html).toContain('id="deploy-env-select"');
    expect(html).toContain('id="deploy-branch-select"');
    expect(html).toContain('<option value="feature/x">feature/x</option>');
    expect(html).toContain('id="deploy-now-btn"');
    expect(html).toContain('id="deploy-table-body"');
    expect(html).toContain('id="deploy-progress-modal"');
    expect(html).toContain('id="deploy-delete-modal"');
  });

  it("serializes page state and injects the deploying entry exactly once", () => {
    const html = deployingPage({
      contextRepo: "octo/app",
      contextBranch: "feature/x"
    });

    expect(readBrowserPageState(html, DEPLOYING_PAGE_STATE_ID)).toEqual({
      repo: "octo/app",
      branch: "feature/x",
      mutationNonce: ""
    });
    expect(html).toContain(browserEntryMarker("deploying-page"));
    expect(html.split(browserScript("deploying-page"))).toHaveLength(2);
    expectSafeInlineScripts(html);
  });

  it("preserves repository and branch fallback precedence", () => {
    expect(
      readBrowserPageState(
        deployingPage({
          plannedRepo: "octo/planned",
          plannedBranch: "planned"
        }),
        DEPLOYING_PAGE_STATE_ID
      )
    ).toEqual({
      repo: "octo/planned",
      branch: "planned",
      mutationNonce: ""
    });
    expect(
      readBrowserPageState(
        deployingPage({
          graphTargetRepo: "octo/graph",
          graphBranch: "graph"
        }),
        DEPLOYING_PAGE_STATE_ID
      )
    ).toEqual({ repo: "octo/graph", branch: "graph", mutationNonce: "" });
    expect(
      readBrowserPageState(
        deployingPage({ deployingRepo: "octo/deploying" }),
        DEPLOYING_PAGE_STATE_ID
      )
    ).toEqual({
      repo: "octo/deploying",
      branch: "main",
      mutationNonce: ""
    });
  });

  it("carries the browser mutation nonce into the serialized state", () => {
    const html = deployingPage({
      contextRepo: "octo/app",
      browserMutationNonce: "nonce-1"
    });

    expect(readBrowserPageState(html, DEPLOYING_PAGE_STATE_ID)).toEqual({
      repo: "octo/app",
      branch: "main",
      mutationNonce: "nonce-1"
    });
  });

  it("keeps hostile state inert in markup and serialized state", () => {
    const html = deployingPage({
      contextRepo: HOSTILE_STATE,
      contextBranch: HOSTILE_STATE
    });

    expect(readBrowserPageState(html, DEPLOYING_PAGE_STATE_ID)).toEqual({
      repo: HOSTILE_STATE,
      branch: HOSTILE_STATE,
      mutationNonce: ""
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expectSafeInlineScripts(html);
  });
});
