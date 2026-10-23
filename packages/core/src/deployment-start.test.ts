import { describe, expect, it, vi } from "vitest";
import {
  startDeployment,
  type DeploymentStartPorts
} from "./deployment-start.js";

const target = {
  repo: "acme/widgets",
  branch: "feature/model",
  environment: "production",
  provider: "aws",
  workflowFile: "run-rad-commands.yml",
  appFile: "apps/custom.bicep"
};
const workflow = {
  repo: target.repo,
  branch: target.branch,
  environment: target.environment,
  workflowFile: target.workflowFile
};

function fixture() {
  const effects: string[] = [];
  let current = true;
  const ports: DeploymentStartPorts = {
    isCurrent: () => current,
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    branch: {
      head: async () => {
        effects.push("head");
        return "sha";
      },
      defaultBranch: async () => "trunk"
    },
    azure: {
      readGitHub: async (path) => {
        if (path.endsWith("/variables/AZURE_CLIENT_ID"))
          return { ok: true, json: { value: "client" } };
        if (path.endsWith("/environments/production"))
          return { ok: true, json: { name: "production" } };
        if (path === "/repos/acme/widgets")
          return {
            ok: true,
            json: { full_name: "acme/widgets", id: 202, owner: { id: 101 } }
          };
        if (path.endsWith("/customization/sub"))
          return { ok: false, status: 404 };
        throw new Error("Unexpected Azure read");
      },
      readSubjects: async () => ({
        code: 0,
        stderr: "",
        stdout: JSON.stringify([
          "repo:acme/widgets:environment:production",
          "repo:acme@101/widgets@202:environment:production"
        ])
      })
    },
    commands: {
      readFile: async () => {
        effects.push("source");
        return "source";
      },
      parameters: () => ({ public: {}, secret: {} }),
      applicationName: () => "todo",
      deployCommand: (file) => `deploy ${file}`,
      graphCommand: (app) => `app graph --application ${app}`,
      ensureSecret: async () => {
        throw new Error("Unexpected secret mutation");
      }
    },
    publication: {
      publish: async () => {
        effects.push("publish");
      },
      synchronize: async () => {
        effects.push("sync");
        return { created: [], updated: [] };
      }
    },
    dispatch: {
      latestRunId: async () => {
        effects.push("baseline");
        return 41;
      },
      sleep: async (ms) => {
        effects.push(`wait:${ms}`);
      },
      now: () => 1000,
      dispatch: vi.fn(async () => {
        effects.push("dispatch");
        return {
          result: { code: 0, stdout: "", stderr: "" },
          credentialSource: "keyring" as const
        };
      })
    },
    onCommands: () => {
      effects.push("commands");
    },
    onAzureNote: (status) => {
      effects.push(status);
    },
    onDispatchReady: () => {
      effects.push("ready");
    }
  };
  return {
    ports,
    effects,
    stop: () => {
      current = false;
    }
  };
}

describe("panel-independent deployment start", () => {
  it("runs shared preparation in order and captures an exact execution reference", async () => {
    const { ports, effects } = fixture();
    const selected = { ...target };
    ports.commands.readFile = async (actual, path) => {
      effects.push("source");
      expect(actual).toEqual(target);
      expect(path).toBe(target.appFile);
      selected.repo = "other/repository";
      selected.branch = "other";
      return "source";
    };
    expect(await startDeployment(selected, ports)).toEqual({
      kind: "dispatch",
      recentlyPublished: false,
      evidence: {
        kind: "accepted",
        reference: { ...workflow, baselineRunId: 41, dispatchedAt: 1000 },
        command: {
          result: { code: 0, stdout: "", stderr: "" },
          credentialSource: "keyring"
        }
      }
    });
    expect(effects).toEqual([
      "head",
      "source",
      "commands",
      "publish",
      "sync",
      "ready",
      "baseline",
      "dispatch"
    ]);
    expect(ports.dispatch.dispatch).toHaveBeenCalledExactlyOnceWith(workflow, [
      "deploy apps/custom.bicep",
      "app graph --application todo"
    ]);
  });

  it("retains registration waits after confirmed publication", async () => {
    const { ports, effects } = fixture();
    ports.publication.publish = async (_target, written) => {
      written(target.workflowFile);
    };
    expect(await startDeployment(target, ports)).toMatchObject({
      kind: "dispatch",
      recentlyPublished: true,
      evidence: { kind: "accepted" }
    });
    expect(effects.slice(-3)).toEqual(["wait:3000", "baseline", "dispatch"]);
  });

  it.each([
    "unknown-branch",
    "missing-branch",
    "missing-source",
    "publication"
  ] as const)("refuses %s before dispatch", async (stage) => {
    const { ports } = fixture();
    if (stage === "unknown-branch")
      ports.branch.head = async () => {
        throw new Error("unavailable");
      };
    if (stage === "missing-branch") ports.branch.head = async () => null;
    if (stage === "missing-source") ports.commands.readFile = async () => null;
    if (stage === "publication")
      ports.publication.publish = async () => {
        throw new Error("protected");
      };
    expect(await startDeployment(target, ports)).toMatchObject({
      kind: "refused",
      reason: stage === "missing-branch" ? "branch-not-pushed" : "preparation"
    });
    expect(ports.dispatch.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    "missing",
    "case-mismatch",
    "covered",
    "skipped",
    "unverified"
  ] as const)(
    "preserves Azure %s policy through shared preparation",
    async (status) => {
      const { ports, effects } = fixture();
      if (status === "missing")
        ports.azure.readSubjects = async () => ({
          code: 0,
          stdout: "[]",
          stderr: ""
        });
      if (status === "case-mismatch")
        ports.azure.readSubjects = async () => ({
          code: 0,
          stderr: "",
          stdout: JSON.stringify([
            "REPO:ACME/WIDGETS:ENVIRONMENT:PRODUCTION",
            "REPO:ACME@101/WIDGETS@202:ENVIRONMENT:PRODUCTION"
          ])
        });
      if (status === "skipped")
        ports.azure.readGitHub = async () => ({
          ok: true,
          json: { value: "" }
        });
      if (status === "unverified")
        ports.azure.readGitHub = async () => ({ ok: false, status: 403 });
      const result = await startDeployment(
        { ...target, provider: "azure" },
        ports
      );
      if (status === "missing" || status === "case-mismatch") {
        expect(result).toMatchObject({
          kind: "refused",
          reason:
            status === "missing" ?
              "oidc-subject-missing"
            : "oidc-subject-case-mismatch"
        });
        expect(effects).toEqual(["head"]);
        expect(ports.dispatch.dispatch).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({
          kind: "dispatch",
          evidence: { kind: "accepted" }
        });
        expect(effects.includes(status)).toBe(status !== "covered");
      }
    }
  );

  it.each([
    "start",
    "head",
    "source",
    "commands",
    "publish",
    "azure-read",
    "azure-note",
    "error"
  ] as const)(
    "fences retirement at %s without a mutation dispatch",
    async (stage) => {
      const { ports, stop } = fixture();
      let provider = "aws";
      if (stage === "start") stop();
      if (stage === "head")
        ports.branch.head = async () => {
          stop();
          return "sha";
        };
      if (stage === "source")
        ports.commands.readFile = async () => {
          stop();
          return "source";
        };
      if (stage === "commands") ports.onCommands = stop;
      if (stage === "publish")
        ports.publication.publish = async () => {
          stop();
        };
      if (stage === "azure-read" || stage === "azure-note") {
        provider = "azure";
        ports.azure.readGitHub = async () => {
          if (stage === "azure-read") stop();
          return { ok: true, json: { value: "" } };
        };
        ports.onAzureNote = stop;
      }
      if (stage === "error")
        ports.onCommands = () => {
          stop();
          throw new Error("late failure");
        };
      expect(await startDeployment({ ...target, provider }, ports)).toEqual({
        kind: "cancelled"
      });
      expect(ports.dispatch.dispatch).not.toHaveBeenCalled();
    }
  );

  it.each(["head", "source", "sync"] as const)(
    "closes the microtask boundary after the %s coordinator returns",
    async (stage) => {
      const { ports, stop } = fixture();
      const later = () => queueMicrotask(() => queueMicrotask(stop));
      if (stage === "head")
        ports.branch.head = async () => {
          later();
          return "sha";
        };
      if (stage === "source")
        ports.commands.readFile = async () => {
          later();
          return "source";
        };
      if (stage === "sync")
        ports.publication.synchronize = async () => {
          later();
          return { created: [], updated: [] };
        };
      expect(await startDeployment(target, ports)).toEqual({
        kind: "cancelled"
      });
      expect(ports.dispatch.dispatch).not.toHaveBeenCalled();
    }
  );

  it("reports preparation callback failures without starting a workflow", async () => {
    const { ports } = fixture();
    ports.onDispatchReady = () => {
      throw new Error("presentation unavailable");
    };
    expect(await startDeployment(target, ports)).toEqual({
      kind: "refused",
      reason: "preparation",
      message: "Could not prepare deployment: presentation unavailable"
    });
    expect(ports.dispatch.dispatch).not.toHaveBeenCalled();
  });

  it("preserves uncertain dispatch instead of turning it into a preparation refusal", async () => {
    const { ports } = fixture();
    ports.dispatch.dispatch = async () => {
      throw new Error("connection lost");
    };
    expect(await startDeployment(target, ports)).toMatchObject({
      kind: "dispatch",
      evidence: {
        kind: "uncertain",
        reason: "dispatch",
        message: "connection lost",
        reference: { ...workflow, baselineRunId: 41, dispatchedAt: 1000 }
      }
    });
  });

  it("does not relabel a post-dispatch diagnostic failure as a confirmed refusal", async () => {
    const { ports } = fixture();
    ports.dispatch.dispatch = async () => {
      throw new Error("connection lost");
    };
    ports.errorMessage = () => {
      throw new Error("formatter failed");
    };
    await expect(startDeployment(target, ports)).rejects.toThrow(
      "formatter failed"
    );
  });
});
