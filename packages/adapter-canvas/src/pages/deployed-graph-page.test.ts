import { describe, it, expect } from "vitest";
import { deployedGraphPage } from "./deployed-graph-page.js";
import {
  HOSTILE_STATE,
  expectSafeInlineScripts,
  readEmittedValue
} from "../../test/support/pages/hostile-state.js";

describe("deployedGraphPage", () => {
  it("mounts the graph in deploy mode with the status legend", () => {
    const html = deployedGraphPage({ contextRepo: "octo/app" });
    const renderGraph = html.match(
      /function renderGraph\(resources, branch\) \{([\s\S]*?)\n    \}/
    )?.[1];
    expect(renderGraph).toContain("deployMode: true");
    expect(renderGraph).toContain("showLegend: true");
  });

  it("updates through the controller so the viewport survives a refresh", () => {
    const html = deployedGraphPage({ contextRepo: "octo/app" });
    expect(html).toContain("controller.update(resources)");
  });

  it("uses the branch the server returns rather than hardcoding main", () => {
    // Source links on a session worktree branch resolve only when the page
    // honors the branch the graph was built from.
    const html = deployedGraphPage({
      contextRepo: "octo/app",
      contextBranch: "feature-branch"
    });
    expect(html).toContain('var GRAPH_BRANCH = "feature-branch"');
    expect(html).toContain("branch: branch || GRAPH_BRANCH || 'main'");
  });

  it("requests the deployed graph scoped to the selected app and environment", () => {
    const html = deployedGraphPage({ contextRepo: "octo/app" });
    expect(html).toContain(
      "'&application=' + encodeURIComponent(appSelect.value)"
    );
    expect(html).toContain(
      "'&environment=' + encodeURIComponent(envSelect.value)"
    );
  });

  it("only shows the empty state when there is nothing at all to draw", () => {
    // A modeled application with no deployment still renders, greyed — the
    // empty state is reserved for having no resources whatsoever.
    const html = deployedGraphPage({ contextRepo: "octo/app" });
    const loadGraph = html.match(
      /function loadGraph\(\) \{([\s\S]*?)\n    \}/
    )?.[1];
    expect(loadGraph).toContain("if (!resources.length) {");
    expect(loadGraph).toContain("mode === 'live'");
  });

  it("states the refresh cadence rather than looking frozen", () => {
    const html = deployedGraphPage({ contextRepo: "octo/app" });
    expect(html).toContain("var POLL_MS = 15000");
    expect(html).toContain("refreshes every ");
  });

  it("keeps polling through a transient failure instead of freezing", () => {
    // Dropping the timer in the catch would freeze the graph mid-deploy for the
    // life of the page while the note still promised a refresh.
    const html = deployedGraphPage({ contextRepo: "octo/app" });
    expect(html).toContain(
      "if (LAST_MODE === 'live' && document.visibilityState !== 'hidden') { pollTimer = setTimeout(loadGraph, POLL_MS); }"
    );
  });

  it("reports the age of the data, not the age of the last fetch", () => {
    const html = deployedGraphPage({ contextRepo: "octo/app" });
    expect(html).toContain(
      "setModeNote(describeMode(mode, d && d.updatedAt, d && d.application))"
    );
    expect(html).toContain("var at = updatedAt ? Date.parse(updatedAt) : 0;");
  });

  it("names the resolved application when it differs from the selection", () => {
    // The server falls back to an env-only match when the selected app has no
    // artifact yet; the note must say which app is actually on screen.
    const html = deployedGraphPage({ contextRepo: "octo/app" });
    expect(html).toContain("' \u00b7 showing ' + shownApp");
  });

  it("pauses polling while the panel is hidden and only resumes for a live deploy", () => {
    const html = deployedGraphPage({ contextRepo: "octo/app" });
    expect(html).toContain("document.visibilityState === 'hidden'");
    // Resume only when a deploy is live; a terminal/greyed view never polled.
    expect(html).toContain("else if (LAST_MODE === 'live' && !pollTimer)");
    // A slow in-flight fetch is aborted on hide so it cannot land after pause.
    expect(html).toContain("graphFetchController.abort()");
    expect(html).toContain("if (err && err.name === 'AbortError') { return; }");
  });

  it("renders the subtitle and wires the adaptive primary button", () => {
    const html = deployedGraphPage({
      contextRepo: "octo/app",
      contextBranch: "feature-x"
    });
    expect(html).toContain('id="deployed-subtitle"');
    expect(html).toContain(
      "The deployed application graph depicts the selected application"
    );
    expect(html).toContain('id="deployed-subtitle-hint"');
    expect(html).toContain("radiusApplyDeployedEnvState(HAS_ENVS,");
    expect(html).toContain("radiusDeployDeployedApp(");
    expect(html).toContain("/api/list-deployments?repo=");
    expect(html).toContain('var CONTEXT_BRANCH = "feature-x"');
  });

  // The disabled-while-deleting guard only works if the page actually feeds the
  // selected environment's status into the adaptive state function, and then
  // keeps polling so the button re-enables once the delete resolves.
  it("passes the deployment status through and polls while a delete runs", () => {
    const html = deployedGraphPage({ contextRepo: "octo/app" });
    expect(html).toContain("deploymentStatus(app, env)");
    expect(html).toContain("function deploymentStatus(");
    expect(html).toContain("scheduleStatePoll(");
    expect(html).toContain(
      "status === 'pending' || status === 'deleting' || DEPLOYMENT_STATES_STALE"
    );
  });

  // A transient GitHub failure comes back as HTTP 200 with
  // { deployments: [], error }. Clearing the map on that response would make an
  // environment with an in-flight deploy/delete look empty, flipping the button
  // back to "Deploy Application" and letting the user start a conflicting
  // operation. This runs the emitted function for real, because the behavior
  // only exists as a string in the page and a substring assertion would not
  // prove the error path preserves anything.
  describe("deployment-state loading survives a transient listing failure", () => {
    // Pull the emitted loadDeploymentStates out of the page and run it against
    // fake state, returning what it left behind.
    async function runLoad(
      response: unknown,
      previous: Record<string, string>
    ) {
      const html = deployedGraphPage({ contextRepo: "octo/app" });
      const start = html.indexOf("function loadDeploymentStates()");
      expect(start).toBeGreaterThan(-1);
      // Brace-match to the end of the function so the harness gets exactly it.
      let depth = 0;
      let end = -1;
      for (let i = html.indexOf("{", start); i < html.length; i++) {
        if (html[i] === "{") depth++;
        else if (html[i] === "}") {
          depth--;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
      expect(end).toBeGreaterThan(start);
      const source = html.slice(start, end);

      const state = {
        DEPLOYMENTS_BY_TARGET: { ...previous },
        DEPLOYMENT_STATES_STALE: false
      };
      const fetchFake = () =>
        response instanceof Error ?
          Promise.reject(response)
        : Promise.resolve({ json: () => Promise.resolve(response) });
      const harness = new Function(
        "CONTEXT_REPO",
        "fetch",
        "state",
        `var DEPLOYMENTS_BY_TARGET = state.DEPLOYMENTS_BY_TARGET;
         function deploymentKey(app, env) {
          return encodeURIComponent(app) + '|' + encodeURIComponent(env);
         }
         var DEPLOYMENT_STATES_STALE = state.DEPLOYMENT_STATES_STALE;
         ${source}
         return loadDeploymentStates().then(function () {
           return { map: DEPLOYMENTS_BY_TARGET, stale: DEPLOYMENT_STATES_STALE };
         });`
      );
      return (await harness("octo/app", fetchFake, state)) as {
        map: Record<string, string>;
        stale: boolean;
      };
    }

    it("keeps the last-known deployments and flags them stale on an error payload", async () => {
      const result = await runLoad(
        { deployments: [], error: "GitHub API rate limit exceeded" },
        { "web-app|prod": "deleting" }
      );
      expect(result.map).toEqual({ "web-app|prod": "deleting" });
      expect(result.stale).toBe(true);
    });

    it("keeps the last-known deployments when the request itself fails", async () => {
      const result = await runLoad(new Error("network down"), {
        "web-app|prod": "success"
      });
      expect(result.map).toEqual({ "web-app|prod": "success" });
      expect(result.stale).toBe(true);
    });

    it("replaces the map and clears the stale flag on a good response", async () => {
      const result = await runLoad(
        {
          deployments: [
            { app: "web-app", environment: "staging", status: "success" }
          ]
        },
        { "web-app|prod": "deleting" }
      );
      expect(result.map).toEqual({ "web-app|staging": "success" });
      expect(result.stale).toBe(false);
    });

    it("keeps deployments for different applications in the same environment distinct", async () => {
      const result = await runLoad(
        {
          deployments: [
            { app: "frontend", environment: "prod", status: "success" },
            { app: "worker", environment: "prod", status: "failed" }
          ]
        },
        {}
      );
      expect(result.map).toEqual({
        "frontend|prod": "success",
        "worker|prod": "failed"
      });
    });

    // An empty list is a real answer, unlike an error, so it must clear.
    it("clears the map when the listing is genuinely empty", async () => {
      const result = await runLoad(
        { deployments: [] },
        { "web-app|prod": "success" }
      );
      expect(result.map).toEqual({});
      expect(result.stale).toBe(false);
    });
  });

  // The button must be held disabled while the listing is unreadable, and the
  // page must keep polling so it recovers without a manual reload.
  it("feeds the stale flag into the button state and polls until it clears", () => {
    const html = deployedGraphPage({ contextRepo: "octo/app" });
    expect(html).toContain("DEPLOYMENT_STATES_STALE");
    expect(html).toContain(
      "deploymentStatus(app, env), DEPLOYMENT_STATES_STALE"
    );
    expect(html).toContain(
      "status === 'pending' || status === 'deleting' || DEPLOYMENT_STATES_STALE"
    );
  });

  it("places the primary button inline with the selectors", () => {
    const html = deployedGraphPage({ contextRepo: "octo/app" });
    const controls = html.match(
      /<div class="rad-deployed-controls">([\s\S]*?)<\/div>\n/
    )?.[0];
    // The button must live INSIDE the controls row so it sits on the same
    // line as the Application/Environment dropdowns.
    expect(html).toMatch(
      /<div class="rad-deployed-controls">[\s\S]*id="deployed-delete-btn"[\s\S]*?<\/div>/
    );
    expect(controls).toBeTruthy();
  });

  it("treats a failed deployment as deployed so it can be cleaned up", () => {
    const html = deployedGraphPage({ contextRepo: "octo/app" });
    expect(html).toContain(
      "return !!DEPLOYMENTS_BY_TARGET[deploymentKey(app, env)];"
    );
    expect(html).toContain("dep.status || 'unknown'");
  });
});

describe("deployedGraphPage — deployment state, progress and context", () => {
  const html = deployedGraphPage({
    contextRepo: "octo/app",
    contextBranch: "feature/x",
    deployProvider: "aws"
  });

  it("starts from a loading state with both selectors and a disabled delete action", () => {
    expect(html).toContain(
      '<div id="deployed-status" class="status info">Loading deployed application graph…</div>'
    );
    expect(html).toContain('id="deployed-app-select"');
    expect(html).toContain('id="deployed-env-select"');
    expect(html).toContain(
      '<button id="deployed-delete-btn" class="rad-btn rad-btn--danger-outline" style="margin:0;" disabled>Delete Deployment</button>'
    );
  });

  it("streams deployment logs while a run is in flight and stops on a terminal status", () => {
    expect(html).toContain('id="deployed-log-section"');
    expect(html).toContain('id="deployed-log-output"');
    expect(html).toContain(
      "if (d.status === 'complete' || d.status === 'success' || d.status === 'failed') { stopLogStream(); }"
    );
    expect(html).toContain("logTimer = setInterval(pollLogs, 1500);");
  });

  it("keeps the pending and deleting states polling and the action disabled", () => {
    expect(html).toContain(
      "scheduleStatePoll(status === 'pending' || status === 'deleting' || DEPLOYMENT_STATES_STALE);"
    );
    expect(html).toContain('id="deployed-deleting-modal"');
    expect(html).toContain("Deleting Deployment…");
  });

  it("reports a failed delete inline instead of claiming success", () => {
    expect(html).toContain(
      "showInline('error', (res.d && res.d.error) || 'Could not start the delete workflow.')"
    );
    expect(html).toContain(
      "showInline('error', 'Could not delete the deployment. Please try again.')"
    );
  });

  it("serializes the repository, branches and fallback provider as JSON literals", () => {
    expect(html).toContain('var CONTEXT_REPO = "octo/app";');
    expect(html).toContain('var CONTEXT_BRANCH = "feature/x";');
    expect(html).toContain('var GRAPH_BRANCH = "feature/x";');
    expect(html).toContain('var FALLBACK_PROVIDER = "aws";');
  });

  it("falls back through the deploying and planned context before defaulting", () => {
    const fallback = deployedGraphPage({
      deployingRepo: "octo/deploying",
      deployingBranch: "deploying-branch"
    });
    expect(fallback).toContain('var CONTEXT_REPO = "octo/deploying";');
    expect(fallback).toContain('var CONTEXT_BRANCH = "main";');
    expect(fallback).toContain('var GRAPH_BRANCH = "deploying-branch";');
    expect(fallback).toContain('var FALLBACK_PROVIDER = "azure";');
  });

  it("keeps a hostile repository inside its JSON string literal", () => {
    const rendered = deployedGraphPage({
      contextRepo: HOSTILE_STATE,
      contextBranch: HOSTILE_STATE,
      deployProvider: HOSTILE_STATE
    });
    expectSafeInlineScripts(rendered);
    expect(readEmittedValue(rendered, "CONTEXT_REPO")).toBe(HOSTILE_STATE);
    expect(readEmittedValue(rendered, "CONTEXT_BRANCH")).toBe(HOSTILE_STATE);
    expect(readEmittedValue(rendered, "GRAPH_BRANCH")).toBe(HOSTILE_STATE);
    expect(readEmittedValue(rendered, "FALLBACK_PROVIDER")).toBe(HOSTILE_STATE);
    expect(rendered).not.toContain("<img src=x>");
  });
});
