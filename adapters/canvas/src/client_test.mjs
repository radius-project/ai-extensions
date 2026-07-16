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
