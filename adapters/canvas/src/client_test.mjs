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
        expect(CLIENT_GRAPH_JS).toContain("repoUrl + '/blob/' + (d.sourceBranch || branch) + '/' + d.defFile");
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

    it("normalizes single Windows backslashes to '/' in both the GitHub blob path and the repo-relative open path", () => {
        // Behavioral guard (not a source-spelling check): a codeReference generated
        // on Windows carries SINGLE backslashes at runtime. The /\\\\/g written in
        // the .mjs source sits inside a template literal, so it is halved to /\\/g
        // in the browser — a regex that matches ONE backslash. Extract the two
        // helpers from the runtime script and prove they actually convert a Windows
        // path. (This is why the source must keep /\\\\/g: /\\/g in source would
        // become the invalid regex /\/g in the browser.)
        const srcMatch = CLIENT_GRAPH_JS.match(/function srcPathFromRef\(codeRef\) \{[\s\S]*?return p;\s*\}/);
        expect(srcMatch).toBeTruthy();
        const srcPathFromRef = new Function(srcMatch[0] + "; return srcPathFromRef;")();
        expect(srcPathFromRef("src\\graph\\diff.ts#L14")).toBe("src/graph/diff.ts");
        expect(srcPathFromRef("a\\b\\c.bicep")).toBe("a/b/c.bicep");
        expect(srcPathFromRef("already/posix/path.ts")).toBe("already/posix/path.ts");

        const urlMatch = CLIENT_GRAPH_JS.match(/function buildSourceUrl\(codeRef, branchOverride\) \{[\s\S]*?return repoUrl \+ '\/tree\/' \+ br;\s*\}/);
        expect(urlMatch).toBeTruthy();
        const buildSourceUrl = new Function("repoUrl", "branch", urlMatch[0] + "; return buildSourceUrl;")(
            "https://github.com/o/r",
            "main",
        );
        expect(buildSourceUrl("src\\graph\\diff.ts#L14")).toBe("https://github.com/o/r/blob/main/src/graph/diff.ts#L14");
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
        // Copilot editor canvas (side pane) via radiusOpenLocalSource, passing the
        // node's GitHub URL as the fallback; a remote-branch graph uses a plain
        // target=_blank GitHub anchor the host opens in the browser.
        expect(CLIENT_GRAPH_JS).toContain("if (localSource && d.srcPath) {");
        expect(CLIENT_GRAPH_JS).toContain("radiusOpenLocalSource(d.srcPath, d.srcLine, d.sourceUrl)");
        expect(CLIENT_GRAPH_JS).toContain("href: d.sourceUrl || '#'");
        expect(CLIENT_GRAPH_JS).toContain("} else if (d.sourceUrl) {");
        expect(CLIENT_GRAPH_JS).toContain("href: d.sourceUrl, target: '_blank', rel: 'noopener noreferrer'");
        // The superseded single-branch guard is gone.
        expect(CLIENT_GRAPH_JS).not.toContain("var canLinkSrc = d.sourceUrl && (!localSource || d.srcPath);");
    });

    it("opens local worktree files by POSTing the repo-relative path to /api/open-source (same-origin, not blocked in the webview)", () => {
        expect(CLIENT_GRAPH_JS).toContain("function radiusOpenLocalSource(relPath, line, fallbackUrl)");
        expect(CLIENT_GRAPH_JS).toContain("fetch('/api/open-source'");
        expect(CLIENT_GRAPH_JS).toContain("JSON.stringify({ path: relPath, line: line || 0 })");
    });

    it("falls back to opening the GitHub URL when the local open fails (non-2xx / too-coarse localSource)", () => {
        // radiusOpenExternal opens the fallback via a synthetic target=_blank anchor
        // click (the host opens it in the system browser); window.open is only a
        // nested last resort. Wired to the fetch's non-ok and error paths so a
        // remote graph mislabeled localSource still resolves to a real GitHub page.
        expect(CLIENT_GRAPH_JS).toContain("function radiusOpenExternal(url)");
        expect(CLIENT_GRAPH_JS).toContain("if (!r || !r.ok) radiusOpenExternal(fallbackUrl);");
        expect(CLIENT_GRAPH_JS).toContain(".catch(function() { radiusOpenExternal(fallbackUrl); })");
    });

    it("marks interactive card children nodrag/nopan so React Flow's drag layer never swallows their clicks", () => {
        // The old cytoscape build bolted an HTML DOM overlay onto its canvas nodes
        // to make links clickable; React Flow renders the card as real elements, so
        // the source link and details button just carry nodrag/nopan instead.
        expect(CLIENT_GRAPH_JS).toContain("rad-node__source nodrag nopan");
        expect(CLIENT_GRAPH_JS).toContain("rad-node__dots nodrag nopan");
    });

    it("toggles the details popup from the node's \"...\" button — a second click on the same node closes it", () => {
        // The dots button calls the toggle (not open) so re-clicking it dismisses an
        // already-open popup; toggle closes only when the popup is open for this same
        // card, and otherwise (re)opens against it.
        expect(CLIENT_GRAPH_JS).toContain("popupCtl.toggle(d, e.currentTarget.closest('.rad-node'))");
        expect(CLIENT_GRAPH_JS).toContain("if (popup.style.display !== 'none' && openCardEl === cardEl)");
    });

    it("renders a disabled source row for a local node with no code reference", () => {
        expect(CLIENT_GRAPH_JS).toContain("'aria-disabled': 'true'");
        expect(CLIENT_GRAPH_JS).toContain("No source reference found");
    });

    it("routes the popup source-code and app-definition rows to the editor canvas locally, GitHub anchors remotely", () => {
        // Remote branch: native GitHub anchors.
        expect(CLIENT_GRAPH_JS).toContain("linkRow(ICON_SRC, 'View source code', d.sourceUrl, true)");
        expect(CLIENT_GRAPH_JS).toContain("linkRow(ICON_DEF, 'View app definition', defUrl, true)");
        // Local workspace: editor-canvas rows carrying the repo-relative path/line and
        // a GitHub fallback URL used when the file is not on this checkout.
        expect(CLIENT_GRAPH_JS).toContain("localLinkRow(ICON_SRC, 'View source code', d.srcPath, d.srcLine, d.sourceUrl)");
        expect(CLIENT_GRAPH_JS).toContain("localLinkRow(ICON_DEF, 'View app definition', d.defFile, d.defLine, defUrlLocal)");
        expect(CLIENT_GRAPH_JS).toContain("data-local-src=");
        expect(CLIENT_GRAPH_JS).toContain("data-fallback-url=");
    });

    it("delegates clicks on a data-local-src row to the local editor-canvas open, threading the GitHub fallback URL", () => {
        expect(CLIENT_GRAPH_JS).toContain("e.target.closest('[data-local-src]')");
        expect(CLIENT_GRAPH_JS).toContain("localEl.getAttribute('data-local-src')");
        expect(CLIENT_GRAPH_JS).toContain("localEl.getAttribute('data-fallback-url')");
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

describe("CLIENT_GRAPH_JS — Deploy view status legend (Commit 2)", () => {
    it("renders the three lifecycle badges as the legend when deployMode + showLegend are on", () => {
        expect(CLIENT_GRAPH_JS).toContain("if (options.showLegend && !diffMode)");
        expect(CLIENT_GRAPH_JS).toContain("if (deployMode) {");
        expect(CLIENT_GRAPH_JS).toContain("'Pending / In progress'");
        expect(CLIENT_GRAPH_JS).toContain("'Success'");
        expect(CLIENT_GRAPH_JS).toContain("'Failed'");
    });

    it("uses radiusDeployBadgeSvg for the legend icons so they match the node corner badges 1:1", () => {
        expect(CLIENT_GRAPH_JS).toContain("radiusDeployBadgeSvg(items[di].kind)");
        expect(CLIENT_GRAPH_JS).toContain("{ kind: 'progress'");
        expect(CLIENT_GRAPH_JS).toContain("{ kind: 'success'");
        expect(CLIENT_GRAPH_JS).toContain("{ kind: 'failed'");
    });

    it("does not fall through to the resource-category legend when deployMode is on", () => {
        // The category branch calls radiusGetTypeStyle to derive category names.
        // deployMode must not reach it — the two branches are exclusive.
        const legendBlock = CLIENT_GRAPH_JS.match(/if \(options\.showLegend && !diffMode\) \{[\s\S]*?^\s{4}\}\s*$/m);
        expect(legendBlock).toBeTruthy();
        const [block] = legendBlock;
        const deployIdx = block.indexOf("if (deployMode) {");
        const elseIdx = block.indexOf("} else {", deployIdx);
        const categoryIdx = block.indexOf("radiusGetTypeStyle");
        expect(deployIdx).toBeGreaterThan(-1);
        expect(elseIdx).toBeGreaterThan(deployIdx);
        expect(categoryIdx).toBeGreaterThan(elseIdx); // category branch lives inside `else`
    });
});

describe("CLIENT_GRAPH_JS — Graph Diff visual design", () => {
    it("keeps diff node backgrounds white and colors only the border by diff status", () => {
        expect(CLIENT_GRAPH_JS).toContain("case 'added': return { bg: '#ffffff', border: '#16a34a' };");
        expect(CLIENT_GRAPH_JS).toContain("case 'removed': return { bg: '#ffffff', border: '#dc2626' };");
        expect(CLIENT_GRAPH_JS).toContain("case 'modified': return { bg: '#ffffff', border: '#ca8a04' };");
        // Unchanged / unknown status falls back to the modeled card's neutral gray.
        expect(CLIENT_GRAPH_JS).toContain("default: return { bg: '#ffffff', border: '#d0d7de' };");
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
        expect(CLIENT_GRAPH_JS).toContain("function pushEdge(source, target, dashed, connStatus)");
        expect(CLIENT_GRAPH_JS).toContain("var cs = connStatus || '';");
        expect(CLIENT_GRAPH_JS).toContain("if (cs === 'removed') stroke = '#dc2626';");
        expect(CLIENT_GRAPH_JS).toContain("else if (cs === 'added') stroke = '#16a34a';");
        expect(CLIENT_GRAPH_JS).toContain("else if (cs === 'unchanged') stroke = '#8c959f';");
        // The connection loop threads each connection's diff status into pushEdge.
        expect(CLIENT_GRAPH_JS).toContain("if (targetExists) pushEdge(r.id || r.name, connTarget, false, conn.diffStatus || '');");
    });

    it("falls back to endpoint diff statuses only for edges with no connection-level status (e.g. output edges)", () => {
        expect(CLIENT_GRAPH_JS).toContain("var sStatus = diffStatusById[source] || '';");
        expect(CLIENT_GRAPH_JS).toContain("var tStatus = diffStatusById[target] || '';");
        expect(CLIENT_GRAPH_JS).toContain("if (sStatus === 'removed' || tStatus === 'removed') stroke = '#dc2626';");
        expect(CLIENT_GRAPH_JS).toContain("else if (sStatus === 'added' || tStatus === 'added') stroke = '#16a34a';");
        expect(CLIENT_GRAPH_JS).toContain("else stroke = '#8c959f';");
    });

    it("builds a diffStatusById lookup from the resource list for edge coloring", () => {
        expect(CLIENT_GRAPH_JS).toContain("diffStatusById[oid] = orr.diffStatus || '';");
    });

    it("has no diff Status line in the node popup (popup is identical to Planned/Modeled)", () => {
        expect(CLIENT_GRAPH_JS).not.toContain("Status: <strong");
        expect(CLIENT_GRAPH_JS).not.toContain("d.diffStatus.charAt(0).toUpperCase()");
    });

    it("shows no diff legend (Added/Removed/Modified/Unchanged dots removed entirely)", () => {
        expect(CLIENT_GRAPH_JS).not.toContain("legend-dot\" style=\"background:#16a34a;\"></span>Added");
        expect(CLIENT_GRAPH_JS).not.toContain("legend-dot\" style=\"background:#dc2626;\"></span>Removed");
        expect(CLIENT_GRAPH_JS).not.toContain("legend-dot\" style=\"background:#ca8a04;\"></span>Modified");
        expect(CLIENT_GRAPH_JS).not.toContain("legend-dot\" style=\"background:#9ca3af;\"></span>Unchanged");
        expect(CLIENT_GRAPH_JS).toContain("if (options.showLegend && !diffMode) {");
    });

    it("points a removed resource's source link at the base branch (its file may not exist on head) while other statuses use the page branch", () => {
        expect(CLIENT_GRAPH_JS).toContain("var diffBaseBranch = options.baseBranch || branch;");
        expect(CLIENT_GRAPH_JS).toContain("var srcBranch = (diffMode && r.diffStatus === 'removed') ? diffBaseBranch : branch;");
        expect(CLIENT_GRAPH_JS).toContain("sourceUrl: buildSourceUrl(r.codeReference || '', srcBranch)");
        expect(CLIENT_GRAPH_JS).toContain("sourceBranch: srcBranch");
        expect(CLIENT_GRAPH_JS).toContain("function buildSourceUrl(codeRef, branchOverride)");
    });

    it("uses the same per-node branch for a removed resource's app-definition link", () => {
        expect(CLIENT_GRAPH_JS).toContain("repoUrl + '/blob/' + (d.sourceBranch || branch) + '/' + d.defFile");
    });
});

describe("CLIENT_GRAPH_JS — Planned graph visual design", () => {
    it("keeps modeled topology instead of rendering recipe outputs as child nodes", () => {
        expect(CLIENT_GRAPH_JS).toContain("if (!plannedMode && !deployMode && r.outputResources && r.outputResources.length > 0)");
    });

    it("relabels the modeled node with the recipe-resolved concrete type", () => {
        expect(CLIENT_GRAPH_JS).toContain("var resolvedResource = (plannedMode || deployMode) ? radiusSelectResolvedResource(r, ownedOutputIds, r.id || r.name) : null;");
        expect(CLIENT_GRAPH_JS).toContain("radiusFormatResolvedTypeLabel(resolvedResource.type || resolvedResource.displayType)");
    });

    it("keeps the modeled resource's own icon rather than the resolved output's glyph", () => {
        // Planned mode changes ONLY the type label; the icon stays the modeled
        // resource's (pack-supplied r.icon, or its type glyph). Resolving the icon
        // from the concrete output would swap e.g. a MySQL barrel for a generic
        // apps/Deployment box.
        expect(CLIENT_GRAPH_JS).toContain("icon: radiusResolveIcon(r)");
        expect(CLIENT_GRAPH_JS).not.toContain("radiusResolveIcon(renderedResource)");
    });

    it("preserves the full provider namespace and prefers a top-level concrete resource", () => {
        const helpers = new Function("window", `${CLIENT_GRAPH_JS}; return {
            formatResolvedType: radiusFormatResolvedTypeLabel,
            selectResolvedResource: radiusSelectResolvedResource
        };`)({ addEventListener() {} });
        expect(helpers.formatResolvedType("Microsoft.DBforMySQL/flexibleServers@2023-12-30")).toBe(
            "Microsoft.DBforMySQL/flexibleServers",
        );
        expect(helpers.selectResolvedResource({
            name: "mysql",
            outputResources: [
                {
                    name: "firewall",
                    type: "Microsoft.DBforMySQL/flexibleServers/firewallRules@2023-12-30",
                },
                {
                    name: "server",
                    type: "Microsoft.DBforMySQL/flexibleServers@2023-12-30",
                },
            ],
        })?.name).toBe("server");
    });

    it("prefers the primary workload over supporting recipe outputs regardless of order", () => {
        const helpers = new Function("window", `${CLIENT_GRAPH_JS}; return {
            selectResolvedResource: radiusSelectResolvedResource
        };`)({ addEventListener() {} });
        // The real Kubernetes MySQL recipe emits a credentials Secret first, then
        // the Deployment, then a Service. The Deployment is the primary resource;
        // the Secret/Service must not be projected onto the planned node.
        expect(helpers.selectResolvedResource({
            name: "db",
            outputResources: [
                { name: "dbSecret", type: "core/Secret@v1" },
                { name: "mySql", type: "apps/Deployment@v1" },
                { name: "svc", type: "core/Service@v1" },
            ],
        })?.type).toBe("apps/Deployment@v1");
    });

    it("uses dashed node borders and connectors for planned resources", () => {
        expect(CLIENT_GRAPH_JS).toContain("borderStyle: plannedMode ? 'dashed' : 'solid'");
        expect(CLIENT_GRAPH_JS).toContain("dashed = dashed || plannedMode;");
        expect(CLIENT_GRAPH_JS).toContain("style.strokeDasharray = plannedMode ? '4 4' : '6 4'");
        expect(CLIENT_GRAPH_JS).toContain("borderStyle: d.borderStyle || 'solid'");
    });
});

describe("CLIENT_GRAPH_JS — deployment status colors", () => {
    it("keeps only managed-cluster nodes gray and colors ordinary compute nodes by deploy status", () => {
        expect(CLIENT_GRAPH_JS).toContain("if (deployMode) {");
        expect(CLIENT_GRAPH_JS).toContain("if (radiusIsManagedClusterResource(r)) return RADIUS_DEPLOY_STATUS_COLORS.pending;");
        expect(CLIENT_GRAPH_JS).toContain("RADIUS_DEPLOY_STATUS_COLORS[r.deployStatus || 'pending']");
        expect(CLIENT_GRAPH_JS).not.toContain("if (deployMode && r.deployStatus) {");
    });

    it("recognizes a managed cluster from either the node type or its resolved output", () => {
        const isManagedCluster = new Function("window", `${CLIENT_GRAPH_JS}; return radiusIsManagedClusterResource;`)({ addEventListener() {} });
        expect(isManagedCluster({
            type: "Microsoft.ContainerService/managedClusters@2024-02-01",
        })).toBe(true);
        expect(isManagedCluster({
            type: "Radius.Compute/containers",
            outputResources: [{ type: "Microsoft.ContainerService/managedClusters" }],
        })).toBe(true);
        expect(isManagedCluster({
            type: "Radius.Compute/containers",
            outputResources: [{ type: "apps/Deployment@v1" }],
        })).toBe(false);
    });

    it("uses gray for in-flight, blue for completed, and red for failed resources", () => {
        const colors = new Function("window", `${CLIENT_GRAPH_JS}; return RADIUS_DEPLOY_STATUS_COLORS;`)({ addEventListener() {} });
        expect(colors.in_progress).toEqual({ bg: "#f6f8fa", border: "#8b949e" });
        expect(colors.success).toEqual({ bg: "#ddf4ff", border: "#0969da" });
        expect(colors.failed).toEqual({ bg: "#ffebe9", border: "#cf222e" });
    });

    it("maps each deploy status to a corner badge (hourglass / check / x)", () => {
        const badgeKind = new Function("window", `${CLIENT_GRAPH_JS}; return radiusDeployBadgeKind;`)({ addEventListener() {} });
        expect(badgeKind("pending")).toBe("progress");
        expect(badgeKind("in_progress")).toBe("progress");
        expect(badgeKind("success")).toBe("success");
        expect(badgeKind("failed")).toBe("failed");
        // Every node in deployMode carries a rendered status badge.
        expect(CLIENT_GRAPH_JS).toContain("deployBadge: deployMode ? radiusDeployBadgeSvg(radiusDeployBadgeKind(r.deployStatus)) : ''");
        expect(CLIENT_GRAPH_JS).toContain("rad-node__badge");
    });

    it("shares the planned graph's shape but keeps solid (regular) borders while deploying", () => {
        // The deploying graph matches the planned graph's one-node-per-resource
        // shape and resolved type labels, but its borders/lines stay solid.
        expect(CLIENT_GRAPH_JS).toContain("borderStyle: plannedMode ? 'dashed' : 'solid'");
        expect(CLIENT_GRAPH_JS).toContain("var shortType = (plannedMode || deployMode) && resolvedResource");
    });
});
