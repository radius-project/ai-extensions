// @ts-nocheck
// Tests for the embedded webview client JS strings. These validate that the
// dead singleton-recipe / on-demand-bicep UI was removed and that the graph's
// source-code and "View app definition" links are worktree-aware: a local
// workspace graph opens the on-disk file in the editor canvas (side pane) while
// a remote-branch graph links to the committed file on GitHub (recipe-pack
// model — no server-generated bicep endpoint).

import { describe, it, expect } from "vitest";
import {
  CLIENT_REPO_BRANCH_JS,
  CLIENT_GRAPH_JS,
  CLIENT_HEARTBEAT_JS,
  CLIENT_OPCHIP_JS
} from "./client.js";

describe("client.ts exports", () => {
  it("exports the three client script strings", () => {
    expect(typeof CLIENT_REPO_BRANCH_JS).toBe("string");
    expect(typeof CLIENT_GRAPH_JS).toBe("string");
    expect(typeof CLIENT_HEARTBEAT_JS).toBe("string");
    expect(CLIENT_REPO_BRANCH_JS.length).toBeGreaterThan(0);
    expect(CLIENT_GRAPH_JS.length).toBeGreaterThan(0);
    expect(CLIENT_HEARTBEAT_JS.length).toBeGreaterThan(0);
  });

  it("emits syntactically valid browser scripts", () => {
    expect(() => new Function(CLIENT_REPO_BRANCH_JS)).not.toThrow();
    expect(() => new Function(CLIENT_GRAPH_JS)).not.toThrow();
    expect(() => new Function(CLIENT_HEARTBEAT_JS)).not.toThrow();
  });
});

describe("CLIENT_GRAPH_JS — removed singleton/on-demand bicep UI", () => {
  it("has no reference to the removed /generated-bicep server route", () => {
    expect(CLIENT_GRAPH_JS).not.toContain("/generated-bicep");
  });

  describe("CLIENT_GRAPH_JS — render exception recovery", () => {
    it("catches synchronous renderer failures and offers a reload action", () => {
      expect(CLIENT_GRAPH_JS).toContain("function radiusRenderGraphUnsafe");
      expect(CLIENT_GRAPH_JS).toContain("radiusShowGraphRenderError(container");
      expect(CLIENT_GRAPH_JS).toContain("window.location.reload()");
    });

    describe("CLIENT_GRAPH_JS — graph refresh state", () => {
      it("keeps a populated diff error visible while refreshing selectors without auto-comparing", () => {
        expect(CLIENT_REPO_BRANCH_JS).toContain(
          "var preserveError = autoCompare === false"
        );
        expect(CLIENT_REPO_BRANCH_JS).toContain("statusEl && !preserveError");
      });

      it("returns the active controller from empty and populated graph updates", () => {
        expect(CLIENT_GRAPH_JS).toContain(
          "return radiusRenderGraph(containerId, nr, options) || emptyController"
        );
        expect(CLIENT_GRAPH_JS).toContain("return controller;");
      });

      it("does not overwrite a populated diff error while refreshing branch selectors", async () => {
        interface FakeOption {
          value: string;
          textContent: string;
          selected: boolean;
        }
        interface FakeSelect {
          value: string;
          options: FakeOption[];
          innerHTML: string;
          appendChild(option: FakeOption): void;
          dispatchEvent(): void;
        }
        const status = {
          textContent: "Unable to compile head graph",
          className: "status error",
          classList: { contains: (name: string) => name === "error" }
        };
        const makeSelect = (): FakeSelect => ({
          value: "",
          options: [],
          set innerHTML(_value: string) {
            this.options = [];
            this.value = "";
          },
          get innerHTML() {
            return "";
          },
          appendChild(option: FakeOption) {
            this.options.push(option);
            if (option.selected || !this.value) this.value = option.value;
          },
          dispatchEvent() {
            throw new Error("auto-compare should not run");
          }
        });
        const base = makeSelect();
        const head = makeSelect();
        const elements: Record<string, FakeSelect | typeof status> = {
          "base-branch": base,
          "head-branch": head,
          "diff-status": status
        };
        const document = {
          getElementById: (id: string) => elements[id] || null,
          createElement: (): FakeOption => ({
            value: "",
            textContent: "",
            selected: false
          }),
          addEventListener() {}
        };
        const fetch = () =>
          Promise.resolve({
            json: () =>
              Promise.resolve({
                branches: [
                  { name: "main", sha: "abcdef1" },
                  { name: "feature", sha: "abcdef2" }
                ]
              })
          });
        const populate = new Function(
          "window",
          "document",
          "fetch",
          "Event",
          `${CLIENT_REPO_BRANCH_JS}; return radiusPopulateDiffBranches;`
        )({ addEventListener() {} }, document, fetch, class Event {});

        populate("octo/app", "main", "feature", false);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(status.textContent).toBe("Unable to compile head graph");
        expect(status.className).toBe("status error");
      });
    });

    it("uses a React error boundary for failures during component rendering", () => {
      expect(CLIENT_GRAPH_JS).toContain(
        "class RadGraphErrorBoundary extends React.Component"
      );
      expect(CLIENT_GRAPH_JS).toContain("static getDerivedStateFromError()");
      expect(CLIENT_GRAPH_JS).toContain("h(RadGraphErrorBoundary");
    });
  });

  it("has no reference to the removed defGenerated node flag", () => {
    expect(CLIENT_GRAPH_JS).not.toContain("defGenerated");
  });

  it("has no reference to the removed bicepGenerated / generatedWarning state", () => {
    expect(CLIENT_GRAPH_JS).not.toContain("bicepGenerated");
    expect(CLIENT_GRAPH_JS).not.toContain("generatedWarning");
  });
});

describe("CLIENT_REPO_BRANCH_JS — Modeled graph adaptive primary action", () => {
  interface FakeBtn {
    dataset: { mode?: string; planLabel?: string };
    textContent: string;
    disabled: boolean;
  }

  function runApply(hasEnv: boolean) {
    const btn: FakeBtn = { dataset: {}, textContent: "", disabled: true };
    const hint = { textContent: "" };
    const elements: Record<string, unknown> = {
      "deploy-app-btn": btn,
      "modeled-subtitle-hint": hint
    };
    const document = { getElementById: (id: string) => elements[id] || null };
    const apply = new Function(
      "document",
      `${CLIENT_REPO_BRANCH_JS}; return radiusApplyModeledEnvState;`
    )(document);
    apply(hasEnv);
    return { btn, hint };
  }

  it("offers Create Environment when the repo has no environment", () => {
    const { btn, hint } = runApply(false);
    expect(btn.textContent).toBe("Create Environment");
    expect(btn.dataset.mode).toBe("create-env");
    expect(btn.disabled).toBe(false);
    expect(hint.textContent).toContain("must first create an environment");
  });

  it("offers Plan Deployment when the repo has an environment", () => {
    const { btn, hint } = runApply(true);
    expect(btn.textContent).toBe("Plan Deployment");
    expect(btn.dataset.mode).toBe("plan");
    expect(hint.textContent).toContain("Plan Deployment");
  });

  it("routes the primary button to the environment form or the planned graph", () => {
    function navigate(mode: string) {
      const location = { href: "" };
      const elements: Record<string, unknown> = {
        "graph-app": { value: "demo" }
      };
      const document = { getElementById: (id: string) => elements[id] || null };
      const act = new Function(
        "document",
        "window",
        `${CLIENT_REPO_BRANCH_JS}; return radiusModeledPrimaryAction;`
      )(document, { location });
      act({ dataset: { mode }, disabled: false });
      return location.href;
    }
    expect(navigate("create-env")).toBe("/?page=environment&new=1");
    expect(navigate("plan")).toBe("/?page=planned&app=demo");
  });
});

describe("CLIENT_REPO_BRANCH_JS — Planned graph adaptive primary action", () => {
  interface FakeBtn {
    dataset: { mode?: string };
    textContent: string;
    disabled: boolean;
  }
  interface FakeSelect {
    value: string;
  }

  function runApply(
    hasEnv: boolean,
    appValue = "web-app",
    envValue = "prod"
  ) {
    const btn: FakeBtn = { dataset: {}, textContent: "", disabled: true };
    const hint = { textContent: "" };
    const appSel: FakeSelect = { value: appValue };
    const envSel: FakeSelect = { value: envValue };
    const elements: Record<string, unknown> = {
      "plan-btn": btn,
      "planned-subtitle-hint": hint,
      "planned-app": appSel,
      "planned-env": envSel
    };
    const document = { getElementById: (id: string) => elements[id] || null };
    const apply = new Function(
      "document",
      `${CLIENT_REPO_BRANCH_JS}; return radiusApplyPlanEnvState;`
    )(document);
    apply(hasEnv);
    return { btn, hint };
  }

  it("offers Create Environment when the repo has no environment", () => {
    const { btn, hint } = runApply(false);
    expect(btn.textContent).toBe("Create Environment");
    expect(btn.dataset.mode).toBe("create-env");
    expect(btn.disabled).toBe(false);
    expect(hint.textContent).toContain("must first create an environment");
  });

  it("offers Deploy Application and names the app/environment when one exists", () => {
    const { btn, hint } = runApply(true, "web-app", "prod");
    expect(btn.textContent).toBe("Deploy Application");
    expect(btn.dataset.mode).toBe("deploy");
    expect(btn.disabled).toBe(false);
    expect(hint.textContent).toContain("web-app");
    expect(hint.textContent).toContain("prod");
    expect(hint.textContent).toContain("Deploy Application");
  });

  it("triggers a deployment and redirects to the Deployments tab", async () => {
    const btn: FakeBtn & { textContent: string } = {
      dataset: {},
      textContent: "Deploy Application",
      disabled: false
    };
    const branchSel: FakeSelect = { value: "main" };
    const envSel: FakeSelect = { value: "prod" };
    const elements: Record<string, unknown> = {
      "planned-branch": branchSel,
      "planned-env": envSel
    };
    const document = { getElementById: (id: string) => elements[id] || null };
    const location = { href: "" };
    let requestedUrl = "";
    let requestedBody: Record<string, unknown> = {};
    const fetch = (url: string, init: { body: string }) => {
      requestedUrl = url;
      requestedBody = JSON.parse(init.body);
      return Promise.resolve({ json: () => Promise.resolve({}) });
    };
    const deploy = new Function(
      "document",
      "window",
      "fetch",
      `${CLIENT_REPO_BRANCH_JS}; return radiusDeployPlannedApp;`
    )(document, { location }, fetch);

    deploy(btn, "octo/app", { prod: "azure" }, "azure");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requestedUrl).toBe("/api/deploy");
    expect(requestedBody).toMatchObject({
      environment: "prod",
      provider: "azure",
      targetRepo: "octo/app",
      branch: "main",
      appFile: ".radius/app.bicep"
    });
    expect(btn.disabled).toBe(true);
    expect(location.href).toBe("/?page=deploying");
  });

  it("does nothing when there is no selected environment", () => {
    const btn: FakeBtn = { dataset: {}, textContent: "", disabled: false };
    const envSel: FakeSelect = { value: "" };
    const elements: Record<string, unknown> = {
      "planned-branch": { value: "main" },
      "planned-env": envSel
    };
    const document = { getElementById: (id: string) => elements[id] || null };
    let fetchCalled = false;
    const fetch = () => {
      fetchCalled = true;
      return Promise.resolve({ json: () => Promise.resolve({}) });
    };
    const deploy = new Function(
      "document",
      "window",
      "fetch",
      `${CLIENT_REPO_BRANCH_JS}; return radiusDeployPlannedApp;`
    )(document, { location: { href: "" } }, fetch);

    deploy(btn, "octo/app", {}, "azure");

    expect(fetchCalled).toBe(false);
  });
});

describe("CLIENT_GRAPH_JS — View app definition link (recipe-pack model)", () => {
  it("defaults each node's definition file to the committed .radius/app.bicep", () => {
    expect(CLIENT_GRAPH_JS).toContain(
      "r.definitionFile || '.radius/app.bicep'"
    );
  });

  it("builds the app definition link from a GitHub /blob/ URL", () => {
    expect(CLIENT_GRAPH_JS).toContain(
      "repoUrl + '/blob/' + (d.sourceBranch || branch) + '/' + d.defFile"
    );
    expect(CLIENT_GRAPH_JS).toContain("View app definition");
  });

  it("gates the app definition link on a repo URL and a defFile only", () => {
    expect(CLIENT_GRAPH_JS).toContain("if (repoUrl && d.defFile)");
  });
});

describe("CLIENT_GRAPH_JS — source links (worktree-aware: local editor canvas vs GitHub)", () => {
  it("reads a localSource option and derives the repo-relative path/line", () => {
    expect(CLIENT_GRAPH_JS).toContain(
      "var localSource = !!options.localSource;"
    );
    expect(CLIENT_GRAPH_JS).toContain(
      "srcPath: srcPathFromRef(r.codeReference || '')"
    );
    expect(CLIENT_GRAPH_JS).toContain(
      "srcLine: srcLineFromRef(r.codeReference || '')"
    );
  });

  it("normalizes single Windows backslashes to '/' in both the GitHub blob path and the repo-relative open path", () => {
    // Behavioral guard (not a source-spelling check): a codeReference generated
    // on Windows carries SINGLE backslashes at runtime. The /\\\\/g written in
    // the .ts source sits inside a template literal, so it is halved to /\\/g
    // in the browser — a regex that matches ONE backslash. Extract the two
    // helpers from the runtime script and prove they actually convert a Windows
    // path. (This is why the source must keep /\\\\/g: /\\/g in source would
    // become the invalid regex /\/g in the browser.)
    const srcMatch = CLIENT_GRAPH_JS.match(
      /function srcPathFromRef\(codeRef\) \{[\s\S]*?return p;\s*\}/
    );
    expect(srcMatch).toBeTruthy();
    if (!srcMatch) throw new Error("srcPathFromRef was not found");
    const srcPathFromRef = new Function(
      srcMatch[0] + "; return srcPathFromRef;"
    )();
    expect(srcPathFromRef("src\\graph\\diff.ts#L14")).toBe("src/graph/diff.ts");
    expect(srcPathFromRef("a\\b\\c.bicep")).toBe("a/b/c.bicep");
    expect(srcPathFromRef("already/posix/path.ts")).toBe(
      "already/posix/path.ts"
    );

    const urlMatch = CLIENT_GRAPH_JS.match(
      /function buildSourceUrl\(codeRef, branchOverride\) \{[\s\S]*?return repoUrl \+ '\/tree\/' \+ br;\s*\}/
    );
    expect(urlMatch).toBeTruthy();
    if (!urlMatch) throw new Error("buildSourceUrl was not found");
    const buildSourceUrl = new Function(
      "repoUrl",
      "branch",
      urlMatch[0] + "; return buildSourceUrl;"
    )("https://github.com/o/r", "main");
    expect(buildSourceUrl("src\\graph\\diff.ts#L14")).toBe(
      "https://github.com/o/r/blob/main/src/graph/diff.ts#L14"
    );
  });

  describe("CLIENT_GRAPH_JS — React Flow node rendering", () => {
    it("renders the figma .rad-node card as native React elements (no cytoscape, no HTML-string overlay)", () => {
      expect(CLIENT_GRAPH_JS).toContain("className: 'rad-node'");
      expect(CLIENT_GRAPH_JS).toContain("'data-node-id': d.id");
      expect(CLIENT_GRAPH_JS).not.toContain("cytoscape");
      expect(CLIENT_GRAPH_JS).not.toContain("dangerouslySetInnerHTML");
      expect(CLIENT_GRAPH_JS).not.toContain("cardHtml");
    });

    it("never passes a var() color into React Flow's Background SVG attribute", () => {
      // Background forwards `color` to an SVG <circle fill> presentation
      // attribute, where Chromium does NOT substitute var() — the value is
      // dropped and the dots render black. The grid is themed from CSS instead
      // (see the .react-flow__background rules in pages.ts).
      expect(CLIENT_GRAPH_JS).toContain("h(Background, { gap: 16, size: 1 })");
      expect(CLIENT_GRAPH_JS).not.toMatch(
        /h\(Background,[^)]*color:[^)]*var\(/
      );
    });

    it("scales long concrete resource type labels to the node width", () => {
      expect(CLIENT_GRAPH_JS).toContain("var typeRef = React.useRef(null)");
      expect(CLIENT_GRAPH_JS).toContain(
        "while (el.scrollWidth > el.clientWidth && size > 7)"
      );
      expect(CLIENT_GRAPH_JS).toContain("ref: typeRef, title: d.typeLabel");
    });
  });

  it("renders the in-card source link two ways: local editor-canvas open in a worktree, native GitHub anchor on a remote branch", () => {
    // A local-workspace graph (localSource) opens the on-disk worktree file in the
    // Copilot editor canvas (side pane) via radiusOpenLocalSource, passing the
    // node's GitHub URL as the fallback; a remote-branch graph uses a plain
    // target=_blank GitHub anchor the host opens in the browser.
    expect(CLIENT_GRAPH_JS).toContain("if (localSource && d.srcPath) {");
    expect(CLIENT_GRAPH_JS).toContain(
      "radiusOpenLocalSource(d.srcPath, d.srcLine, d.sourceUrl)"
    );
    expect(CLIENT_GRAPH_JS).toContain("href: d.sourceUrl || '#'");
    expect(CLIENT_GRAPH_JS).toContain("} else if (d.sourceUrl) {");
    expect(CLIENT_GRAPH_JS).toContain(
      "href: d.sourceUrl, target: '_blank', rel: 'noopener noreferrer'"
    );
    // The superseded single-branch guard is gone.
    expect(CLIENT_GRAPH_JS).not.toContain(
      "var canLinkSrc = d.sourceUrl && (!localSource || d.srcPath);"
    );
  });

  it("opens local worktree files by POSTing the repo-relative path to /api/open-source (same-origin, not blocked in the webview)", () => {
    expect(CLIENT_GRAPH_JS).toContain(
      "function radiusOpenLocalSource(relPath, line, fallbackUrl)"
    );
    expect(CLIENT_GRAPH_JS).toContain("fetch('/api/open-source'");
    expect(CLIENT_GRAPH_JS).toContain(
      "JSON.stringify({ path: relPath, line: line || 0 })"
    );
  });

  it("falls back to opening the GitHub URL when the local open fails (non-2xx / too-coarse localSource)", () => {
    // radiusOpenExternal opens the fallback via a synthetic target=_blank anchor
    // click (the host opens it in the system browser); window.open is only a
    // nested last resort. Wired to the fetch's non-ok and error paths so a
    // remote graph mislabeled localSource still resolves to a real GitHub page.
    expect(CLIENT_GRAPH_JS).toContain("function radiusOpenExternal(url)");
    expect(CLIENT_GRAPH_JS).toContain(
      "if (!r || !r.ok) radiusOpenExternal(fallbackUrl);"
    );
    expect(CLIENT_GRAPH_JS).toContain(
      ".catch(function() { radiusOpenExternal(fallbackUrl); })"
    );
  });

  it("marks interactive card children nodrag/nopan so React Flow's drag layer never swallows their clicks", () => {
    // The old cytoscape build bolted an HTML DOM overlay onto its canvas nodes
    // to make links clickable; React Flow renders the card as real elements, so
    // the source link and details button just carry nodrag/nopan instead.
    expect(CLIENT_GRAPH_JS).toContain("rad-node__source nodrag nopan");
    expect(CLIENT_GRAPH_JS).toContain("rad-node__dots nodrag nopan");
  });

  it('toggles the details popup from the node\'s "..." button — a second click on the same node closes it', () => {
    // The dots button calls the toggle (not open) so re-clicking it dismisses an
    // already-open popup; toggle closes only when the popup is open for this same
    // card, and otherwise (re)opens against it.
    expect(CLIENT_GRAPH_JS).toContain(
      "popupCtl.toggle(d, e.currentTarget.closest('.rad-node'))"
    );
    expect(CLIENT_GRAPH_JS).toContain(
      "if (popup.style.display !== 'none' && openCardEl === cardEl)"
    );
  });

  it("renders a disabled source row for a local node with no code reference", () => {
    expect(CLIENT_GRAPH_JS).toContain("'aria-disabled': 'true'");
    expect(CLIENT_GRAPH_JS).toContain("No source reference found");
  });

  it("routes the popup source-code and app-definition rows to the editor canvas locally, GitHub anchors remotely", () => {
    // Remote branch: native GitHub anchors.
    expect(CLIENT_GRAPH_JS).toContain(
      "linkRow(ICON_SRC, 'View source code', d.sourceUrl, true)"
    );
    expect(CLIENT_GRAPH_JS).toContain(
      "linkRow(ICON_DEF, 'View app definition', defUrl, true)"
    );
    // Local workspace: editor-canvas rows carrying the repo-relative path/line and
    // a GitHub fallback URL used when the file is not on this checkout.
    expect(CLIENT_GRAPH_JS).toContain(
      "localLinkRow(ICON_SRC, 'View source code', d.srcPath, d.srcLine, d.sourceUrl)"
    );
    expect(CLIENT_GRAPH_JS).toContain(
      "localLinkRow(ICON_DEF, 'View app definition', d.defFile, d.defLine, defUrlLocal)"
    );
    expect(CLIENT_GRAPH_JS).toContain("data-local-src=");
    expect(CLIENT_GRAPH_JS).toContain("data-fallback-url=");
  });

  it("delegates clicks on a data-local-src row to the local editor-canvas open, threading the GitHub fallback URL", () => {
    expect(CLIENT_GRAPH_JS).toContain("e.target.closest('[data-local-src]')");
    expect(CLIENT_GRAPH_JS).toContain("localEl.getAttribute('data-local-src')");
    expect(CLIENT_GRAPH_JS).toContain(
      "localEl.getAttribute('data-fallback-url')"
    );
  });

  it("renders nodes through a custom React Flow node type built from native elements", () => {
    expect(CLIENT_GRAPH_JS).toContain("nodeTypes = { rad: RadNode }");
    expect(CLIENT_GRAPH_JS).toContain("function RadNode(props)");
    expect(CLIENT_GRAPH_JS).toContain("ReactDOM.createRoot(flowHost)");
  });

  it("draws plain figma edges with no React Flow arrowheads", () => {
    expect(CLIENT_GRAPH_JS).not.toContain("MarkerType");
    expect(CLIENT_GRAPH_JS).not.toContain("markerEnd");
    expect(CLIENT_GRAPH_JS).not.toContain("ArrowClosed");
  });

  it("hides the React Flow attribution watermark and omits the minimap", () => {
    expect(CLIENT_GRAPH_JS).toContain("hideAttribution: true");
    expect(CLIENT_GRAPH_JS).not.toContain("MiniMap");
  });

  it("binds the card click handler once per container to avoid duplicate opens", () => {
    expect(CLIENT_GRAPH_JS).toContain(
      "container.removeEventListener('click', container._radiusClickHandler)"
    );
    expect(CLIENT_GRAPH_JS).toContain(
      "container._radiusClickHandler = function(e)"
    );
  });
});

describe("CLIENT_GRAPH_JS — Graph Diff visual design", () => {
  it("keeps diff node backgrounds on the host surface and colors only the border by diff status", () => {
    expect(CLIENT_GRAPH_JS).toContain(
      "case 'added': return { bg: 'var(--rad-node-bg)', border: 'var(--rad-success)' };"
    );
    expect(CLIENT_GRAPH_JS).toContain(
      "case 'removed': return { bg: 'var(--rad-node-bg)', border: 'var(--rad-danger)' };"
    );
    expect(CLIENT_GRAPH_JS).toContain(
      "case 'modified': return { bg: 'var(--rad-node-bg)', border: 'var(--rad-warning)' };"
    );
    expect(CLIENT_GRAPH_JS).toContain(
      "default: return { bg: 'var(--rad-node-bg)', border: 'var(--rad-node-border)' };"
    );
    // No tinted diff backgrounds remain.
    expect(CLIENT_GRAPH_JS).not.toContain("#dcfce7");
    expect(CLIENT_GRAPH_JS).not.toContain("#fee2e2");
    expect(CLIENT_GRAPH_JS).not.toContain("#fef9c3");
    expect(CLIENT_GRAPH_JS).not.toContain("#f3f4f6");
  });

  it("colors diff edges by the connection's own diff status (added/removed/unchanged), not just its endpoints", () => {
    // The primary signal is the per-connection diffStatus that computeGraphDiff
    // tags onto each rendered connection, so an edge added/removed between two
    // still-present nodes colors correctly (and a removed edge, carried as a
    // synthetic connection, is drawn at all).
    expect(CLIENT_GRAPH_JS).toContain(
      "function pushEdge(source, target, dashed, connStatus)"
    );
    expect(CLIENT_GRAPH_JS).toContain("var cs = connStatus || '';");
    expect(CLIENT_GRAPH_JS).toContain(
      "if (cs === 'removed') stroke = 'var(--rad-danger)';"
    );
    expect(CLIENT_GRAPH_JS).toContain(
      "else if (cs === 'added') stroke = 'var(--rad-success)';"
    );
    expect(CLIENT_GRAPH_JS).toContain(
      "else if (cs === 'unchanged') stroke = 'var(--rad-edge-muted)';"
    );
    // The connection loop threads each connection's diff status into pushEdge.
    expect(CLIENT_GRAPH_JS).toContain(
      "if (targetExists) pushEdge(r.id || r.name, connTarget, false, conn.diffStatus || '');"
    );
  });

  it("falls back to endpoint diff statuses only for edges with no connection-level status (e.g. output edges)", () => {
    expect(CLIENT_GRAPH_JS).toContain(
      "var sStatus = diffStatusById[source] || '';"
    );
    expect(CLIENT_GRAPH_JS).toContain(
      "var tStatus = diffStatusById[target] || '';"
    );
    expect(CLIENT_GRAPH_JS).toContain(
      "if (sStatus === 'removed' || tStatus === 'removed') stroke = 'var(--rad-danger)';"
    );
    expect(CLIENT_GRAPH_JS).toContain(
      "else if (sStatus === 'added' || tStatus === 'added') stroke = 'var(--rad-success)';"
    );
    expect(CLIENT_GRAPH_JS).toContain("else stroke = 'var(--rad-edge-muted)';");
  });

  it("builds a diffStatusById lookup from the resource list for edge coloring", () => {
    expect(CLIENT_GRAPH_JS).toContain(
      "diffStatusById[oid] = orr.diffStatus || '';"
    );
  });

  it("has no diff Status line in the node popup (popup is identical to Planned/Modeled)", () => {
    expect(CLIENT_GRAPH_JS).not.toContain("Status: <strong");
    expect(CLIENT_GRAPH_JS).not.toContain(
      "d.diffStatus.charAt(0).toUpperCase()"
    );
  });

  it("shows no diff legend (Added/Removed/Modified/Unchanged dots removed entirely)", () => {
    expect(CLIENT_GRAPH_JS).not.toContain(
      'legend-dot" style="background:#16a34a;"></span>Added'
    );
    expect(CLIENT_GRAPH_JS).not.toContain(
      'legend-dot" style="background:#dc2626;"></span>Removed'
    );
    expect(CLIENT_GRAPH_JS).not.toContain(
      'legend-dot" style="background:#ca8a04;"></span>Modified'
    );
    expect(CLIENT_GRAPH_JS).not.toContain(
      'legend-dot" style="background:#9ca3af;"></span>Unchanged'
    );
    expect(CLIENT_GRAPH_JS).toContain("if (options.showLegend && !diffMode) {");
  });

  it("points a removed resource's source link at the base branch (its file may not exist on head) while other statuses use the page branch", () => {
    expect(CLIENT_GRAPH_JS).toContain(
      "var diffBaseBranch = options.baseBranch || branch;"
    );
    expect(CLIENT_GRAPH_JS).toContain(
      "var srcBranch = (diffMode && r.diffStatus === 'removed') ? diffBaseBranch : branch;"
    );
    expect(CLIENT_GRAPH_JS).toContain(
      "sourceUrl: buildSourceUrl(r.codeReference || '', srcBranch)"
    );
    expect(CLIENT_GRAPH_JS).toContain("sourceBranch: srcBranch");
    expect(CLIENT_GRAPH_JS).toContain(
      "function buildSourceUrl(codeRef, branchOverride)"
    );
  });

  it("uses the same per-node branch for a removed resource's app-definition link", () => {
    expect(CLIENT_GRAPH_JS).toContain(
      "repoUrl + '/blob/' + (d.sourceBranch || branch) + '/' + d.defFile"
    );
  });
});

describe("CLIENT_GRAPH_JS — Planned graph visual design", () => {
  it("keeps modeled topology instead of rendering recipe outputs as child nodes", () => {
    expect(CLIENT_GRAPH_JS).toContain(
      "var resolvedMode = plannedMode || deployMode || deployedMode"
    );
    expect(CLIENT_GRAPH_JS).toContain(
      "if (!resolvedMode && r.outputResources && r.outputResources.length > 0)"
    );
  });

  it("relabels the modeled node with the recipe-resolved concrete type", () => {
    expect(CLIENT_GRAPH_JS).toContain(
      "var resolvedResource = resolvedMode ? radiusSelectResolvedResource(r, ownedOutputIds, r.id || r.name) : null;"
    );
    expect(CLIENT_GRAPH_JS).toContain(
      "radiusFormatResolvedTypeLabel(resolvedResource.type || resolvedResource.displayType)"
    );
  });

  it("keeps the modeled resource's own icon rather than the resolved output's glyph", () => {
    // Planned mode changes ONLY the type label; the icon stays the modeled
    // resource's (pack-supplied r.icon, or its type glyph). Resolving the icon
    // from the concrete output would swap e.g. a MySQL barrel for a generic
    // apps/Deployment box.
    expect(CLIENT_GRAPH_JS).toContain("icon: radiusResolveIcon(r)");
    expect(CLIENT_GRAPH_JS).not.toContain(
      "radiusResolveIcon(renderedResource)"
    );
  });

  it("preserves the full provider namespace and prefers a top-level concrete resource", () => {
    const helpers = new Function(
      "window",
      `${CLIENT_GRAPH_JS}; return {
            formatResolvedType: radiusFormatResolvedTypeLabel,
            selectResolvedResource: radiusSelectResolvedResource
        };`
    )({ addEventListener() {} });
    expect(
      helpers.formatResolvedType(
        "Microsoft.DBforMySQL/flexibleServers@2023-12-30"
      )
    ).toBe("Microsoft.DBforMySQL/flexibleServers");
    expect(
      helpers.selectResolvedResource({
        name: "mysql",
        outputResources: [
          {
            name: "firewall",
            type: "Microsoft.DBforMySQL/flexibleServers/firewallRules@2023-12-30"
          },
          {
            name: "server",
            type: "Microsoft.DBforMySQL/flexibleServers@2023-12-30"
          }
        ]
      })?.name
    ).toBe("server");
  });

  it("prefers the primary workload over supporting recipe outputs regardless of order", () => {
    const helpers = new Function(
      "window",
      `${CLIENT_GRAPH_JS}; return {
            selectResolvedResource: radiusSelectResolvedResource
        };`
    )({ addEventListener() {} });
    // The real Kubernetes MySQL recipe emits a credentials Secret first, then
    // the Deployment, then a Service. The Deployment is the primary resource;
    // the Secret/Service must not be projected onto the planned node.
    expect(
      helpers.selectResolvedResource({
        name: "db",
        outputResources: [
          { name: "dbSecret", type: "core/Secret@v1" },
          { name: "mySql", type: "apps/Deployment@v1" },
          { name: "svc", type: "core/Service@v1" }
        ]
      })?.type
    ).toBe("apps/Deployment@v1");
  });

  it("uses dashed node borders and connectors for planned resources", () => {
    expect(CLIENT_GRAPH_JS).toContain(
      "borderStyle: plannedMode ? 'dashed' : 'solid'"
    );
    expect(CLIENT_GRAPH_JS).toContain("dashed = dashed || plannedMode;");
    expect(CLIENT_GRAPH_JS).toContain(
      "style.strokeDasharray = plannedMode ? '4 4' : '6 4'"
    );
    expect(CLIENT_GRAPH_JS).toContain("borderStyle: d.borderStyle || 'solid'");
  });
});

describe("CLIENT_GRAPH_JS — deployment status colors", () => {
  it("renders deployed graph cards gray except for failed resources", () => {
    expect(CLIENT_GRAPH_JS).toContain("if (deployedMode) {");
    expect(CLIENT_GRAPH_JS).toContain("? RADIUS_DEPLOY_STATUS_COLORS.failed");
    expect(CLIENT_GRAPH_JS).toContain(": RADIUS_DEPLOY_STATUS_COLORS.pending");
  });

  it("keeps managed-cluster nodes gray unless they fail and colors ordinary compute nodes by deploy status", () => {
    expect(CLIENT_GRAPH_JS).toContain("if (deployMode) {");
    expect(CLIENT_GRAPH_JS).toContain(
      "if (r.deployStatus === 'failed') return RADIUS_DEPLOY_STATUS_COLORS.failed;"
    );
    expect(CLIENT_GRAPH_JS).toContain(
      "if (radiusIsManagedClusterResource(r)) return RADIUS_DEPLOY_STATUS_COLORS.pending;"
    );
    expect(CLIENT_GRAPH_JS).toContain(
      "RADIUS_DEPLOY_STATUS_COLORS[r.deployStatus || 'pending']"
    );
    expect(CLIENT_GRAPH_JS).not.toContain(
      "if (deployMode && r.deployStatus) {"
    );
  });

  it("recognizes a managed cluster from either the node type or its resolved output", () => {
    const isManagedCluster = new Function(
      "window",
      `${CLIENT_GRAPH_JS}; return radiusIsManagedClusterResource;`
    )({ addEventListener() {} });
    expect(
      isManagedCluster({
        type: "Microsoft.ContainerService/managedClusters@2024-02-01"
      })
    ).toBe(true);
    expect(
      isManagedCluster({
        type: "Radius.Compute/containers",
        outputResources: [
          { type: "Microsoft.ContainerService/managedClusters" }
        ]
      })
    ).toBe(true);
    expect(
      isManagedCluster({
        type: "Radius.Compute/containers",
        outputResources: [{ type: "apps/Deployment@v1" }]
      })
    ).toBe(false);
  });

  it("uses host-backed surfaces for in-flight, completed, and failed resources", () => {
    const colors = new Function(
      "window",
      `${CLIENT_GRAPH_JS}; return RADIUS_DEPLOY_STATUS_COLORS;`
    )({ addEventListener() {} });
    expect(colors.in_progress).toEqual({
      bg: "var(--rad-node-bg)",
      border: "var(--rad-edge)"
    });
    expect(colors.success).toEqual({
      bg: "var(--rad-info-bg)",
      border: "var(--rad-info)"
    });
    expect(colors.failed).toEqual({
      bg: "var(--rad-danger-bg)",
      border: "var(--rad-danger)"
    });
  });

  it("uses semantic tokens for graph chrome instead of light-only literals", () => {
    expect(CLIENT_GRAPH_JS).toContain(
      "background: d.bgColor || 'var(--rad-node-bg)'"
    );
    expect(CLIENT_GRAPH_JS).not.toContain("bg: '#ffffff'");
    expect(CLIENT_GRAPH_JS).not.toContain("color: '#e1e4e8'");
  });

  it("maps each deploy status to a corner badge (spinner / check / x)", () => {
    const badgeKind = new Function(
      "window",
      `${CLIENT_GRAPH_JS}; return radiusDeployBadgeKind;`
    )({ addEventListener() {} });
    expect(badgeKind("pending")).toBe("progress");
    expect(badgeKind("in_progress")).toBe("progress");
    expect(badgeKind("success")).toBe("success");
    expect(badgeKind("failed")).toBe("failed");
    // Every node in deployMode carries a rendered status badge.
    expect(CLIENT_GRAPH_JS).toContain(
      "deployBadge: deployMode ? radiusDeployBadgeSvg(radiusDeployBadgeKind(r.deployStatus)) : ''"
    );
    expect(CLIENT_GRAPH_JS).toContain("rad-node__badge--progress");
    expect(CLIENT_GRAPH_JS).toContain("Circular progress indicator");
    expect(CLIENT_GRAPH_JS).toContain("rad-node__badge");
  });

  it("shares the planned graph's shape but keeps solid (regular) borders while deploying", () => {
    // The deploying graph matches the planned graph's one-node-per-resource
    // shape and resolved type labels, but its borders/lines stay solid.
    expect(CLIENT_GRAPH_JS).toContain(
      "borderStyle: plannedMode ? 'dashed' : 'solid'"
    );
    expect(CLIENT_GRAPH_JS).toContain(
      "var shortType = resolvedMode && resolvedResource"
    );
  });
});

// The chip is the only part of the progress work that renders on every page, so
// it is also the only part a user can be looking at when they have forgotten the
// operation exists. These drive the real client source through a hand-rolled DOM
// so the assertions are about behaviour, not about the presence of a substring.
describe("CLIENT_OPCHIP_JS — the ambient operation chip", () => {
  function makeEl() {
    return {
      hidden: true,
      className: "",
      textContent: "",
      style: {},
      dataset: {},
      attrs: {},
      offsetParent: {},
      listeners: {},
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
      addEventListener(type, fn) {
        this.listeners[type] = fn;
      }
    };
  }

  // Runs the chip script against a fake page and returns the handles a test
  // needs: the chip element, and a way to feed it the next server response.
  function mount({
    operation = null,
    panelVisible = false,
    stored = null
  } = {}) {
    const chip = makeEl();
    const label = makeEl();
    const panel = makeEl();
    panel.style.display = panelVisible ? "" : "none";
    if (!panelVisible) panel.offsetParent = null;
    let current = operation;
    const store = { value: stored };
    const doc = {
      getElementById(id) {
        if (id === "rad-opchip") return chip;
        if (id === "rad-opchip-label") return label;
        if (id === "env-progress-panel") return panel;
        return null;
      },
      addEventListener() {},
      visibilityState: "visible"
    };
    const win = {
      sessionStorage: {
        getItem: () => store.value,
        setItem: (_k, v) => {
          store.value = v;
        }
      }
    };
    const fetchStub = () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ operation: current })
      });
    // Capturing the interval callback lets a test advance the poll loop
    // deliberately instead of waiting on a real timer.
    let tick = () => {};
    new Function(
      "document",
      "window",
      "fetch",
      "setInterval",
      CLIENT_OPCHIP_JS
    )(doc, win, fetchStub, (fn) => {
      tick = fn;
      return 0;
    });
    async function settle() {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    }
    return {
      chip,
      label,
      store,
      settle,
      async feed(next) {
        current = next;
        tick();
        await settle();
      }
    };
  }

  const running = {
    operationId: "op_1",
    state: "running",
    environment: "dev",
    summary: "Creating dev — configure environment…"
  };

  it("stays out of the way until there is something to say", async () => {
    const h = mount({ operation: null });
    await h.feed(null);
    expect(h.chip.hidden).toBe(true);
  });

  it("announces a running setup in a few words, with the full sentence available", async () => {
    const h = mount({ operation: running });
    await h.feed(running);
    expect(h.chip.hidden).toBe(false);
    expect(h.label.textContent).toBe("Setting up dev…");
    expect(h.chip.className).toContain("rad-opchip--running");
    // The three-word chip is never the only thing on offer.
    expect(h.chip.attrs["aria-label"]).toBe(running.summary);
    expect(h.chip.attrs.title).toBe(running.summary);
  });

  it("keeps quiet while the panel is on screen, because two narrations is noise", async () => {
    const h = mount({ operation: running, panelVisible: true });
    await h.feed(running);
    expect(h.chip.hidden).toBe(true);
  });

  it("distinguishes ready, needs-you, and failed rather than flattening them", async () => {
    const cases = [
      ["succeeded", "dev ready", "rad-opchip--done"],
      ["succeeded_with_warnings", "dev ready · warnings", "rad-opchip--warn"],
      ["action_required", "dev needs you", "rad-opchip--warn"],
      ["failed", "dev setup failed", "rad-opchip--failed"],
      ["failed_partial", "dev setup failed", "rad-opchip--failed"],
      ["cancelled", "dev setup stopped", ""]
    ];
    for (const [state, text, tone] of cases) {
      const h = mount({
        operation: { operationId: "op_" + state, state, environment: "dev" }
      });
      await h.feed({ operationId: "op_" + state, state, environment: "dev" });
      expect(h.chip.hidden).toBe(false);
      expect(h.label.textContent).toBe(text);
      if (tone) expect(h.chip.className).toContain(tone);
    }
  });

  it("stops nagging once the user has clicked through to the result", async () => {
    const done = {
      operationId: "op_1",
      state: "succeeded",
      environment: "dev"
    };
    const h = mount({ operation: done });
    await h.feed(done);
    expect(h.chip.hidden).toBe(false);
    h.chip.listeners.click();
    expect(h.store.value).toBe("op_1");
    await h.feed(done);
    expect(h.chip.hidden).toBe(true);
  });

  it("still speaks up for a new operation after an earlier one was dismissed", async () => {
    const first = {
      operationId: "op_1",
      state: "succeeded",
      environment: "dev"
    };
    const second = {
      operationId: "op_2",
      state: "failed",
      environment: "stage"
    };
    const h = mount({ operation: first, stored: "op_1" });
    await h.feed(first);
    expect(h.chip.hidden).toBe(true);
    await h.feed(second);
    expect(h.chip.hidden).toBe(false);
    expect(h.label.textContent).toBe("stage setup failed");
  });

  it("never dismisses a running operation, however long it runs", async () => {
    const h = mount({ operation: running, stored: "op_1" });
    await h.feed(running);
    expect(h.chip.hidden).toBe(false);
  });
});
