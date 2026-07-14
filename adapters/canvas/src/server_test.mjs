// Tests for the /api/generate-bicep route after the recipe-pack refactor. The
// route is now fetch-only: it surfaces a committed .radius/app.bicep (authored
// by the Radius app-bicep skill) for preview, and returns needsAppBicep when
// none exists. It must never persist, commit, or fabricate bicep. We drive a
// real ephemeral loopback server and mock only the I/O leaves that reach
// GitHub so the route's branching is exercised deterministically.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const io = vi.hoisted(() => ({ bicep: null, file: null }));

vi.mock("@radius-project/core", async (importActual) => ({
    ...(await importActual()),
    fetchBicepFromRepo: vi.fn(async () => io.bicep),
}));

vi.mock("./gh.mjs", async (importActual) => ({
    ...(await importActual()),
    fetchFileFromRepo: vi.fn(async () => io.file),
}));

const { servers, getOrCreateServer } = await import("./server.mjs");

const instanceId = "generate-bicep-test";
let entry;

beforeAll(async () => {
    entry = await getOrCreateServer(instanceId, "generate");
});

afterAll(() => {
    try { entry?.server?.close(); } catch { /* already closed */ }
    servers.delete(instanceId);
});

beforeEach(() => {
    io.bicep = null;
    io.file = null;
    entry.state = {};
});

async function postGenerate(body, { raw = false } = {}) {
    const res = await fetch(`${entry.baseUrl}/api/generate-bicep`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: raw ? body : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
}

describe("/api/generate-bicep — no committed app.bicep", () => {
    it("returns needsAppBicep and points at the app-bicep skill", async () => {
        const { status, json } = await postGenerate({ repo: "octo/app", branch: "main" });
        expect(status).toBe(200);
        expect(json.needsAppBicep).toBe(true);
        expect(json.repo).toBe("octo/app");
        expect(json.branch).toBe("main");
        expect(json.error).toContain("app-bicep skill");
        expect(json.reload).toBeUndefined();
    });

    it("does not persist any generated bicep into server state", async () => {
        await postGenerate({ repo: "octo/app", branch: "main" });
        expect(entry.state.generatedContent).toBeUndefined();
        expect(entry.state.bicepGenerated).toBeUndefined();
        expect(entry.state.generatedWarning).toBeUndefined();
    });
});

describe("/api/generate-bicep — committed app.bicep exists", () => {
    const content = "resource app 'Applications.Core/applications@2023-10-01-preview' = {}";

    it("reloads and caches the fetched content for preview only", async () => {
        io.bicep = content;
        const { status, json } = await postGenerate({ repo: "octo/app", branch: "main" });
        expect(status).toBe(200);
        expect(json.reload).toBe(true);
        expect(entry.state.generatedContent).toBe(content);
        expect(entry.state.generateTargetRepo).toBe("octo/app");
        expect(entry.state.generateBranch).toBe("main");
        expect(entry.state.bicepGenerated).toBeUndefined();
    });

    it("returns the content inline (committed) in preview mode without reloading", async () => {
        io.bicep = content;
        const { status, json } = await postGenerate({ repo: "octo/app", branch: "main", preview: true });
        expect(status).toBe(200);
        expect(json.content).toBe(content);
        expect(json.committed).toBe(true);
        expect(json.reload).toBeUndefined();
    });

    it("falls back to the .radius/app.bicep file when the bicep fetch is empty", async () => {
        io.bicep = null;
        io.file = content;
        const { status, json } = await postGenerate({ repo: "octo/app", branch: "main" });
        expect(status).toBe(200);
        expect(json.reload).toBe(true);
        expect(entry.state.generatedContent).toBe(content);
    });
});

describe("/api/generate-bicep — malformed request", () => {
    it("returns a 400 with an error message on invalid JSON", async () => {
        const { status, json } = await postGenerate("not-json", { raw: true });
        expect(status).toBe(400);
        expect(typeof json.error).toBe("string");
    });
});
