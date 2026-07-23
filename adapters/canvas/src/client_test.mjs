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
} from "./client.mjs";

describe("client.mjs exports", () => {
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

    it("has no reference to the removed defGenerated node flag", () => {
        expect(CLIENT_GRAPH_JS).not.toContain("defGenerated");
    });

    it("has no reference to the removed bicepGenerated / generatedWarning state", () => {
        expect(CLIENT_GRAPH_JS).not.toContain("bicepGenerated");
        expect(CLIENT_GRAPH_JS).not.toContain("generatedWarning");
    });
});

describe("CLIENT_GRAPH_JS — View app definition link (recipe-pack model)", () => {
    it("defaults each node's definition file to the committed .radius/app.bicep", () => {
        expect(CLIENT_GRAPH_JS).toContain("r.definitionFile || '.radius/app.bicep'");
    });

    it("builds the app definition link from a GitHub /blob/ URL", () => {
        expect(CLIENT_GRAPH_JS).toContain("repoUrl + '/blob/' + branch + '/' + d.defFile");
        expect(CLIENT_GRAPH_JS).toContain("View app definition");
    });

    it("gates the app definition link on a repo URL and a defFile only", () => {
        expect(CLIENT_GRAPH_JS).toContain("if (repoUrl && d.defFile)");
    });
});

describe("CLIENT_GRAPH_JS — source links (worktree-aware: local editor canvas vs GitHub)", () => {
    it("reads a localSource option and derives the repo-relative path/line", () => {
        expect(CLIENT_GRAPH_JS).toContain("var localSource = !!options.localSource;");
        expect(CLIENT_GRAPH_JS).toContain("srcPath: srcPathFromRef(r.codeReference || '')");
        expect(CLIENT_GRAPH_JS).toContain("srcLine: srcLineFromRef(r.codeReference || '')");
    });

    describe("CLIENT_GRAPH_JS — React Flow node rendering", () => {
        it("renders the figma .rad-node card as native React elements (no cytoscape, no HTML-string overlay)", () => {
            expect(CLIENT_GRAPH_JS).toContain("className: 'rad-node'");
            expect(CLIENT_GRAPH_JS).toContain("'data-node-id': d.id");
            expect(CLIENT_GRAPH_JS).not.toContain("cytoscape");
            expect(CLIENT_GRAPH_JS).not.toContain("dangerouslySetInnerHTML");
            expect(CLIENT_GRAPH_JS).not.toContain("cardHtml");
        });
    });

    it("renders the in-card source link two ways: local editor-canvas open in a worktree, native GitHub anchor on a remote branch", () => {
        // A local-workspace graph (localSource) opens the on-disk worktree file in the
        // Copilot editor canvas (side pane) via radiusOpenLocalSource; a remote-branch
        // graph uses a plain target=_blank GitHub anchor the host opens in the browser.
        expect(CLIENT_GRAPH_JS).toContain("if (localSource && d.srcPath) {");
        expect(CLIENT_GRAPH_JS).toContain("radiusOpenLocalSource(d.srcPath, d.srcLine)");
        expect(CLIENT_GRAPH_JS).toContain("} else if (!localSource && d.sourceUrl) {");
        expect(CLIENT_GRAPH_JS).toContain("href: d.sourceUrl, target: '_blank', rel: 'noopener noreferrer'");
        // The superseded single-branch guard is gone.
        expect(CLIENT_GRAPH_JS).not.toContain("var canLinkSrc = d.sourceUrl && (!localSource || d.srcPath);");
        // Navigation is still never done via window.open (blocked in the webview).
        expect(CLIENT_GRAPH_JS).not.toContain("window.open(");
    });

    it("opens local worktree files by POSTing the repo-relative path to /api/open-source (same-origin, not blocked in the webview)", () => {
        expect(CLIENT_GRAPH_JS).toContain("function radiusOpenLocalSource(relPath, line)");
        expect(CLIENT_GRAPH_JS).toContain("fetch('/api/open-source'");
        expect(CLIENT_GRAPH_JS).toContain("JSON.stringify({ path: relPath, line: line || 0 })");
    });

    it("marks interactive card children nodrag/nopan so React Flow's drag layer never swallows their clicks", () => {
        // The old cytoscape build bolted an HTML DOM overlay onto its canvas nodes
        // to make links clickable; React Flow renders the card as real elements, so
        // the source link and details button just carry nodrag/nopan instead.
        expect(CLIENT_GRAPH_JS).toContain("rad-node__source nodrag nopan");
        expect(CLIENT_GRAPH_JS).toContain("rad-node__dots nodrag nopan");
    });

    it("renders a disabled source row for a local node with no code reference", () => {
        expect(CLIENT_GRAPH_JS).toContain("'aria-disabled': 'true'");
        expect(CLIENT_GRAPH_JS).toContain("No source reference found");
    });

    it("routes the popup source-code and app-definition rows to the editor canvas locally, GitHub anchors remotely", () => {
        // Remote branch: native GitHub anchors.
        expect(CLIENT_GRAPH_JS).toContain("linkRow(ICON_SRC, 'View source code', d.sourceUrl, true)");
        expect(CLIENT_GRAPH_JS).toContain("linkRow(ICON_DEF, 'View app definition', defUrl, true)");
        // Local workspace: editor-canvas rows carrying the repo-relative path/line.
        expect(CLIENT_GRAPH_JS).toContain("localLinkRow(ICON_SRC, 'View source code', d.srcPath, d.srcLine)");
        expect(CLIENT_GRAPH_JS).toContain("localLinkRow(ICON_DEF, 'View app definition', d.defFile, d.defLine)");
        expect(CLIENT_GRAPH_JS).toContain("data-local-src=");
    });

    it("delegates clicks on a data-local-src row to the local editor-canvas open", () => {
        expect(CLIENT_GRAPH_JS).toContain("e.target.closest('[data-local-src]')");
        expect(CLIENT_GRAPH_JS).toContain("localEl.getAttribute('data-local-src')");
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
        expect(CLIENT_GRAPH_JS).toContain("container.removeEventListener('click', container._radiusClickHandler)");
        expect(CLIENT_GRAPH_JS).toContain("container._radiusClickHandler = function(e)");
    });
});
