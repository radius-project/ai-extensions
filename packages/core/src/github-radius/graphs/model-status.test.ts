import { describe, expect, it } from "vitest";
import { serializeAppOrigin } from "../../modeling/index.js";
import { createAppModelStatusReader } from "./model-status.js";
import type { AppModelStatusPorts } from "./model-status.js";
import type { GraphSource } from "./pipeline.js";

const local: GraphSource = {
  kind: "workspace",
  repo: "owner/app",
  branch: "feature",
  workspacePath: "workspace"
};
const remote: GraphSource = {
  kind: "committed",
  repo: "owner/app",
  ref: "base"
};
const origin = serializeAppOrigin({
  generatedAt: "2026-09-18",
  sourceCommit: "commit",
  skillVersion: "1",
  appBicepHash: "hash"
});

function harness() {
  const files: string[] = [];
  const calls: string[] = [];
  const ports: AppModelStatusPorts = {
    readDefinition: async () => ({
      content: "model",
      bicepPath: ".radius/app.bicep"
    }),
    readFile: async (_source, path) => {
      files.push(path);
      return origin;
    },
    listPaths: async () => ["Dockerfile"],
    workspaceHeadCommit: async (path) => {
      calls.push(`head:${path}`);
      return "commit";
    },
    workspaceSourceChangedSince: async (path, commit) => {
      calls.push(`changed:${path}:${commit}`);
      return false;
    },
    workspaceModelRecoverable: async (path) => {
      calls.push(`recoverable:${path}`);
      return false;
    },
    generatorVersion: () => "1",
    hashAppBicep: () => "hash"
  };
  return { ports, files, calls, reader: createAppModelStatusReader(ports) };
}

describe("shared model evidence reader", () => {
  it("distinguishes a confirmed empty tree from unavailable source evidence", async () => {
    const h = harness();
    h.ports.listPaths = async () => [];
    expect(await h.reader.evaluateSource(remote)).toEqual({
      status: "none",
      dockerfiles: []
    });
    h.ports.listPaths = async () => null;
    expect(await h.reader.evaluateSource(remote)).toEqual({
      status: "unknown",
      dockerfiles: []
    });
  });

  it("judges an uncommitted workspace definition using only workspace evidence", async () => {
    const h = harness();
    expect(await h.reader.resolveStatus(local)).toMatchObject({
      repo: "owner/app",
      branch: "feature",
      refreshable: true,
      freshness: { status: "up-to-date" }
    });
    expect(h.calls).toEqual(["head:workspace", "changed:workspace:commit"]);
    expect(await h.reader.evaluateSource(local)).toEqual({
      status: "single",
      dockerfiles: ["Dockerfile"]
    });
  });

  it("does not probe workspace commits or recoverability for a committed revision", async () => {
    const h = harness();
    expect(await h.reader.resolveStatus(remote)).toMatchObject({
      branch: "base",
      refreshable: false
    });
    expect(h.calls).toEqual([]);
  });

  it("finds legacy origins and requires confirmation for an unrecoverable unrecorded model", async () => {
    const h = harness();
    h.ports.readFile = async (_source, path) =>
      path === "app.origin.json" ? origin : null;
    expect((await h.reader.resolveStatus(local)).freshness.status).toBe(
      "up-to-date"
    );
    h.ports.readFile = async () => null;
    expect(
      (await h.reader.resolveStatus(local)).freshness.requiresConfirmation
    ).toBe(true);
    expect(h.calls).toContain("recoverable:workspace");
  });

  it("classifies absent models without making them refreshable", async () => {
    const h = harness();
    h.ports.readDefinition = async () => ({ content: null, bicepPath: "" });
    expect(await h.reader.resolveStatus(local)).toMatchObject({
      refreshable: false,
      freshness: { status: "missing" }
    });
  });

  it.each(["definition", "origin", "listing"] as const)(
    "propagates unreadable %s evidence",
    async (stage) => {
      const h = harness();
      const fail = async (): Promise<never> => {
        throw new Error("permission denied");
      };
      if (stage === "definition") h.ports.readDefinition = fail;
      if (stage === "origin") h.ports.readFile = fail;
      if (stage === "listing") h.ports.listPaths = fail;
      await expect(
        stage === "listing" ?
          h.reader.evaluateSource(remote)
        : h.reader.resolveStatus(remote)
      ).rejects.toThrow("permission denied");
    }
  );

  it("uses conservative freshness evidence when optional git probes fail", async () => {
    const h = harness();
    h.ports.workspaceHeadCommit = async () => {
      throw new Error("git unavailable");
    };
    h.ports.workspaceSourceChangedSince = async () => {
      throw new Error("git unavailable");
    };
    expect((await h.reader.resolveStatus(local)).freshness.status).toBe(
      "up-to-date"
    );
    h.ports.readFile = async () => null;
    h.ports.workspaceModelRecoverable = async () => {
      throw new Error("git unavailable");
    };
    expect(
      (await h.reader.resolveStatus(local)).freshness.requiresConfirmation
    ).toBe(true);
  });
});
