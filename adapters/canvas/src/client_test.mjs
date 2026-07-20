// Tests for the embedded webview client JS strings. These validate that the
// dead singleton-recipe / on-demand-bicep UI was removed and that the graph's
// "View app definition" link always points at the committed .radius/app.bicep
// on GitHub (recipe-pack model — no server-generated bicep endpoint).

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

describe("CLIENT_GRAPH_JS — local-workspace source links (editor canvas)", () => {
    it("reads a localSource option and derives the repo-relative path/line", () => {
        expect(CLIENT_GRAPH_JS).toContain("var localSource = !!options.localSource;");
        expect(CLIENT_GRAPH_JS).toContain("srcPath: srcPathFromRef(r.codeReference || '')");
        expect(CLIENT_GRAPH_JS).toContain("srcLine: srcLineFromRef(r.codeReference || '')");
    });

    it("defines a window helper that POSTs the file to /api/open-source", () => {
        expect(CLIENT_GRAPH_JS).toContain("window.radiusOpenLocalSource");
        expect(CLIENT_GRAPH_JS).toContain("/api/open-source");
    });

    it("renders the in-card source link as a local-open anchor when a local ref exists", () => {
        expect(CLIENT_GRAPH_JS).toContain("if (localSource) {");
        expect(CLIENT_GRAPH_JS).toContain('data-local-src="1"');
    });

    it("renders a disabled source row for a local node with no reference (no GitHub fallback)", () => {
        expect(CLIENT_GRAPH_JS).toContain('aria-disabled="true" title="No source reference found"');
    });

    it("opens the app definition locally for a workspace graph before falling back to GitHub", () => {
        expect(CLIENT_GRAPH_JS).toContain("if (localSource && d.defFile)");
        expect(CLIENT_GRAPH_JS).toContain("localLinkRow(ICON_DEF, 'View app definition', d.defFile, d.defLine)");
    });

    it("intercepts local links in the card click delegation instead of navigating", () => {
        expect(CLIENT_GRAPH_JS).toContain("'[data-local-src], .rad-local-link'");
        expect(CLIENT_GRAPH_JS).toContain("window.radiusOpenLocalSource(localEl.getAttribute('data-src-path')");
    });

    it("surfaces a banner when a local open fails instead of dead-clicking", () => {
        expect(CLIENT_GRAPH_JS).toContain("window.radiusFlash");
        expect(CLIENT_GRAPH_JS).toContain("if (json && json.ok === false) fail();");
        expect(CLIENT_GRAPH_JS).toContain("Couldn't open this file. It may have moved or been deleted.");
    });

    it("binds the card click handler once per container to avoid duplicate opens", () => {
        expect(CLIENT_GRAPH_JS).toContain("container.removeEventListener('click', container._radiusClickHandler)");
        expect(CLIENT_GRAPH_JS).toContain("container._radiusClickHandler = function(e)");
    });
});
