import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./extension.mjs", import.meta.url), "utf8");

describe("render_graph action", () => {
    it("marks successful empty graphs as loaded", () => {
        const handler = source.match(/name: "render_graph",[\s\S]*?name: "render_graph_diff"/)?.[0];
        expect(handler).toContain("entry.state.graphLoaded = true");
        expect(handler).toContain("filterGraphVisualizationResources(ctx.input.resources)");
    });
});

describe("automatic graph diff", () => {
    it("only records errors for the current diff request", () => {
        expect(source).toContain('isCurrentSourceRefToken(entry.state, "diff", sourceRefContext.token)');
    });
});
