import { describe, expect, it } from "vitest";
import {
    getSourceRefResources,
    prepareSourceRefResources,
    setSourceRefResources,
    updateSourceRefs,
} from "./source-refs.mjs";

function entry(page = "graph") {
    return { page, state: {} };
}

describe("source-code reference state", () => {
    it("uses the active graph view instead of a stale modeled graph", () => {
        const state = entry("planned");
        setSourceRefResources(state, "graph", [{ id: "old", type: "Radius.Compute/containers" }], {
            repo: "acme/old",
            branch: "main",
        });
        setSourceRefResources(state, "planned", [{ id: "current", type: "Radius.Compute/containers" }], {
            repo: "acme/current",
            branch: "feature",
        });
        state.state.activeGraphView = "planned";

        const result = getSourceRefResources(state);

        expect(result.context.repo).toBe("acme/current");
        expect(result.resources.map((resource) => resource.id)).toEqual(["current"]);
    });

    it("rejects stale context tokens and discards pending refs after a branch change", () => {
        const state = entry();
        setSourceRefResources(state, "graph", [], { repo: "acme/app", branch: "old" });
        const oldToken = getSourceRefResources(state, "graph").context.token;
        expect(updateSourceRefs(state, oldToken, [{ id: "db", codeReference: "src/old-db.js" }]).queued).toBe(1);

        setSourceRefResources(state, "graph", [], { repo: "acme/app", branch: "new" });

        expect(state.state.pendingSourceRefs).toEqual([]);
        expect(updateSourceRefs(state, oldToken, [{ id: "db", codeReference: "src/old-db.js" }]).error).toContain("stale");
    });

    it("invalidates stale resources while a replacement graph is building", () => {
        const state = entry();
        setSourceRefResources(state, "graph", [{ id: "old" }], { repo: "acme/app", branch: "old" });

        prepareSourceRefResources(state, "graph", { repo: "acme/app", branch: "new" });

        expect(getSourceRefResources(state, "graph")).toMatchObject({ ready: false, resources: [] });
    });

    it("rejects results from a stale asynchronous build", () => {
        const state = entry();
        const oldBuild = prepareSourceRefResources(state, "graph", { repo: "acme/app", branch: "old" });
        prepareSourceRefResources(state, "graph", { repo: "acme/app", branch: "new" });

        const committed = setSourceRefResources(
            state,
            "graph",
            [{ id: "old" }],
            { repo: "acme/app", branch: "old" },
            oldBuild.token,
        );

        expect(committed).toBe(false);
        expect(getSourceRefResources(state, "graph")).toMatchObject({ ready: false, resources: [] });
    });

    it("matches by stable resource ID when names and types collide", () => {
        const state = entry();
        const resources = [
            { id: "apps/a/db", name: "db", type: "Radius.Data/sqlDatabases" },
            { id: "apps/b/db", name: "db", type: "Radius.Data/sqlDatabases" },
        ];
        setSourceRefResources(state, "graph", resources, { repo: "acme/app", branch: "main" });
        const token = getSourceRefResources(state, "graph").context.token;

        const result = updateSourceRefs(state, token, [
            { id: "apps/b/db", codeReference: "services/b/db.ts#L10" },
        ]);

        expect(result).toMatchObject({ updated: 1, queued: 0, skipped: 0 });
        expect(resources[0].codeReference).toBeUndefined();
        expect(resources[1].codeReference).toBe("services/b/db.ts#L10");
    });

    it("counts each submitted ref once and applies queued refs on rebuild", () => {
        const state = entry();
        const context = { repo: "acme/app", branch: "main" };
        setSourceRefResources(state, "graph", [
            { id: "existing", codeReference: "src/existing.ts" },
            { id: "ready" },
        ], context);
        const token = getSourceRefResources(state, "graph").context.token;

        const result = updateSourceRefs(state, token, [
            { id: "existing", codeReference: "src/replacement.ts" },
            { id: "ready", codeReference: "src/ready.ts" },
            { id: "later", codeReference: "src/later.ts" },
        ]);

        expect(result).toMatchObject({ updated: 1, queued: 1, skipped: 1 });

        const rebuilt = [{ id: "later" }];
        setSourceRefResources(state, "graph", rebuilt, context);
        expect(rebuilt[0].codeReference).toBe("src/later.ts");
        expect(state.state.pendingSourceRefs).toEqual([]);
    });
});
