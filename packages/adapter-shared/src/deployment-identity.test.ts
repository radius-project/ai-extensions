import { describe, expect, it, vi } from "vitest";
import {
  DEPLOY_STATUS_FILES,
  type ArtifactFiles,
  type WorkflowArtifact
} from "@radius-project/core";
import { createDeploymentIdentityReader } from "./deployment-identity.js";

function fixture() {
  const artifact: WorkflowArtifact = {
    id: 1,
    name: "radius-deploy-status-dev-custom",
    workflow_run: { id: 42 }
  };
  const progress = {
    schemaVersion: 1,
    environment: "dev",
    application: "custom",
    runId: 42,
    sequence: 1,
    resources: []
  };
  const files: ArtifactFiles = {
    [DEPLOY_STATUS_FILES.progress]: JSON.stringify(progress)
  };
  const listWorkflowArtifacts = vi.fn(async () => [artifact]);
  const downloadWorkflowArtifact = vi.fn(
    async (): Promise<ArtifactFiles | null> => files
  );
  const read = createDeploymentIdentityReader({
    listWorkflowArtifacts,
    downloadWorkflowArtifact,
    redactDiagnostic: (message) => message.replaceAll("private", "[redacted]")
  });
  return {
    artifact,
    progress,
    files,
    listWorkflowArtifacts,
    downloadWorkflowArtifact,
    read
  };
}

describe("run-scoped deployment application identity", () => {
  it("refuses an artifact that lacks its identity payload", async () => {
    const h = fixture();
    h.downloadWorkflowArtifact.mockResolvedValue({});
    expect(await h.read("org/app", "dev", 42, "deploy")).toMatchObject({
      state: "unavailable",
      reason: expect.stringContaining("missing")
    });
  });

  it("uses matching run evidence rather than artifact names or default models", async () => {
    const h = fixture();
    h.artifact.name = "radius-deploy-status-dev-wrong";
    expect(await h.read("org/app", "dev", 42, "deploy")).toEqual({
      state: "known",
      application: "custom"
    });
    expect(h.listWorkflowArtifacts).toHaveBeenCalledWith(
      "org/app",
      42,
      undefined,
      expect.any(Object)
    );
    expect(h.downloadWorkflowArtifact).toHaveBeenCalledWith(
      "org/app",
      h.artifact,
      expect.any(Object)
    );
  });
  it("accepts legacy missing payload run ID only within the exact run-scoped listing", async () => {
    const h = fixture();
    h.artifact.workflow_run = undefined;
    h.files[DEPLOY_STATUS_FILES.progress] = JSON.stringify({
      ...h.progress,
      runId: undefined
    });
    expect(await h.read("org/app", "dev", 42, "deploy")).toMatchObject({
      state: "known"
    });
    expect(h.downloadWorkflowArtifact).toHaveBeenCalledWith(
      "org/app",
      expect.objectContaining({ workflow_run: { id: 42 } }),
      expect.any(Object)
    );
  });
  it.each([
    { runId: 0 },
    { runId: 43 },
    { environment: "other" },
    { application: "" },
    { schemaVersion: 99 }
  ])("refuses malformed or mismatched payload %j", async (change) => {
    const h = fixture();
    h.files[DEPLOY_STATUS_FILES.progress] = JSON.stringify({
      ...h.progress,
      ...change
    });
    expect(await h.read("org/app", "dev", 42, "deploy")).toMatchObject({
      state: "unavailable"
    });
  });
  it.each(["expired", "other-run", "unrelated", "empty", "too-many"] as const)(
    "does not guess when artifact listing is %s",
    async (kind) => {
      const h = fixture();
      if (kind === "expired") h.artifact.expired = true;
      if (kind === "other-run") h.artifact.workflow_run = { id: 43 };
      if (kind === "unrelated") h.artifact.name = "other";
      if (kind === "empty") h.listWorkflowArtifacts.mockResolvedValue([]);
      if (kind === "too-many")
        h.listWorkflowArtifacts.mockResolvedValue(
          Array.from({ length: 10 }, (_, id) => ({ ...h.artifact, id }))
        );
      expect(await h.read("org/app", "dev", 42, "deploy")).toMatchObject({
        state: "unavailable"
      });
      expect(h.downloadWorkflowArtifact).not.toHaveBeenCalled();
    }
  );
  it("rejects conflicting application identities within one run", async () => {
    const h = fixture();
    h.listWorkflowArtifacts.mockResolvedValue([
      h.artifact,
      { ...h.artifact, id: 2 }
    ]);
    h.downloadWorkflowArtifact
      .mockResolvedValueOnce(h.files)
      .mockResolvedValueOnce({
        [DEPLOY_STATUS_FILES.progress]: JSON.stringify({
          ...h.progress,
          application: "other",
          sequence: 2
        })
      });

    expect(await h.read("org/app", "dev", 42, "deploy")).toMatchObject({
      state: "unavailable",
      reason: expect.stringContaining("conflicting")
    });
  });
  it("uses the newest consistent identity even when an older live slot is listed last", async () => {
    const h = fixture();
    h.listWorkflowArtifacts.mockResolvedValue([
      h.artifact,
      { ...h.artifact, id: 2 }
    ]);
    h.downloadWorkflowArtifact
      .mockResolvedValueOnce({
        [DEPLOY_STATUS_FILES.progress]: JSON.stringify({
          ...h.progress,
          application: "Custom",
          sequence: 3
        })
      })
      .mockResolvedValueOnce(h.files);
    expect(await h.read("org/app", "dev", 42, "deploy")).toEqual({
      state: "known",
      application: "Custom"
    });
  });
  it.each([1, 2])(
    "accepts consistent live-slot identities at sequence %s",
    async (sequence) => {
      const h = fixture();
      h.listWorkflowArtifacts.mockResolvedValue([
        h.artifact,
        {
          ...h.artifact,
          id: 2,
          name: "radius-deploy-status-dev-custom-live-42-slot-1"
        }
      ]);
      h.downloadWorkflowArtifact
        .mockResolvedValueOnce(h.files)
        .mockResolvedValueOnce({
          [DEPLOY_STATUS_FILES.progress]: JSON.stringify({
            ...h.progress,
            sequence
          })
        });
      expect(await h.read("org/app", "dev", 42, "deploy")).toMatchObject({
        state: "known",
        application: "custom"
      });
    }
  );
  it.each(["list", "download"] as const)(
    "surfaces a redacted %s failure",
    async (phase) => {
      const h = fixture();
      if (phase === "list")
        h.listWorkflowArtifacts.mockRejectedValue(new Error("private denied"));
      else h.downloadWorkflowArtifact.mockRejectedValue("private denied");
      expect(await h.read("org/app", "dev", 42, "deploy")).toMatchObject({
        state: "unavailable",
        readFailed: true,
        reason: expect.stringContaining("[redacted] denied")
      });
    }
  );
  it("does not cache missing or unreadable evidence", async () => {
    const h = fixture();
    h.downloadWorkflowArtifact.mockResolvedValueOnce(null);
    expect(await h.read("org/app", "dev", 42, "deploy")).toMatchObject({
      state: "unavailable"
    });
    expect(await h.read("org/app", "dev", 42, "deploy")).toMatchObject({
      state: "known"
    });
  });
  it.each(["application", "container"])(
    "requires application-delete evidence, not %s output",
    async (resourceType) => {
      const h = fixture();
      h.artifact.name = "rad-delete-result";
      h.downloadWorkflowArtifact.mockResolvedValue({
        "rad-delete-result.json": JSON.stringify({
          resourceType,
          name: "deleted-app",
          output: "wrong-app"
        })
      });
      expect(await h.read("org/app", "dev", 42, "delete")).toMatchObject(
        resourceType === "application" ?
          { state: "known", application: "deleted-app" }
        : { state: "unavailable" }
      );
    }
  );
});
