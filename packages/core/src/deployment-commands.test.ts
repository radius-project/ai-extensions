import { describe, expect, it, vi } from "vitest";
import {
  prepareDeploymentCommands,
  type DeploymentCommandPorts,
  type DeploymentCommandTarget
} from "./deployment-commands.js";

const target = {
  repo: "acme/widgets",
  branch: "feat",
  environment: "production"
};

function ports(
  overrides: Partial<DeploymentCommandPorts> = {}
): DeploymentCommandPorts {
  return {
    isCurrent: () => true,
    readFile: async () => "bicep source",
    parameters: () => ({ public: { port: "8080" }, secret: {} }),
    applicationName: () => "todo",
    deployCommand: (file, environment, parameters) =>
      `deploy ${file} --environment ${environment} --parameters port=${parameters.port}`,
    graphCommand: (app) => `app graph --application ${app}`,
    ensureSecret: async () => {
      throw new Error("unexpected secret write");
    },
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    ...overrides
  };
}

describe("deployment command preparation", () => {
  it("uses the explicit captured file and target without consulting other sources", async () => {
    const selected = { ...target, appFile: "apps/todo.bicep" };
    const read = vi.fn(
      async (actual: DeploymentCommandTarget, path: string) => {
        expect(actual).toEqual({ ...target, appFile: "apps/todo.bicep" });
        selected.appFile = "other.bicep";
        selected.environment = "other";
        expect(path).toBe("apps/todo.bicep");
        return "selected source";
      }
    );
    const parameters = vi.fn(() => ({ public: { port: "8080" }, secret: {} }));
    expect(
      await prepareDeploymentCommands(
        selected,
        ports({ readFile: read, parameters })
      )
    ).toEqual({
      kind: "ready",
      appFile: "apps/todo.bicep",
      application: "todo",
      commands: [
        "deploy apps/todo.bicep --environment production --parameters port=8080",
        "app graph --application todo"
      ]
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(parameters).toHaveBeenCalledExactlyOnceWith("selected source");
  });

  it("uses the conventional file without a root lookup when it exists", async () => {
    const read = vi.fn(async () => "source");
    expect(
      await prepareDeploymentCommands(target, ports({ readFile: read }))
    ).toMatchObject({
      kind: "ready",
      appFile: ".radius/app.bicep"
    });
    expect(read).toHaveBeenCalledExactlyOnceWith(target, ".radius/app.bicep");
  });

  it("uses the root only after confirmed absence and omits an unresolved graph command", async () => {
    const read = vi.fn(
      async (_target: DeploymentCommandTarget, path: string) =>
        path === "app.bicep" ? "root" : null
    );
    const result = await prepareDeploymentCommands(
      target,
      ports({
        readFile: read,
        applicationName: () => ""
      })
    );
    expect(result).toMatchObject({
      kind: "ready",
      appFile: "app.bicep",
      application: "",
      commands: [
        "deploy app.bicep --environment production --parameters port=8080"
      ]
    });
    expect(read.mock.calls.map((call) => call[1])).toEqual([
      ".radius/app.bicep",
      "app.bicep"
    ]);
  });

  it.each([undefined, "apps/explicit.bicep"])(
    "refuses missing source without implicit commands: %s",
    async (appFile) => {
      const read = vi.fn(async () => null);
      expect(
        await prepareDeploymentCommands(
          { ...target, appFile },
          ports({ readFile: read })
        )
      ).toMatchObject({
        kind: "refused",
        message: expect.stringContaining("deployment was not started")
      });
      expect(read).toHaveBeenCalledTimes(appFile ? 1 : 2);
    }
  );

  it("refuses empty source rather than substituting another file", async () => {
    const read = vi.fn(async () => " \n ");
    expect(
      await prepareDeploymentCommands(target, ports({ readFile: read }))
    ).toEqual({
      kind: "refused",
      message: 'The application file ".radius/app.bicep" is empty.'
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    "",
    "../app.bicep",
    "apps/../app.bicep",
    "/app.bicep",
    "C:\\app.bicep",
    "apps\\app.bicep",
    "./app.bicep",
    "apps//app.bicep",
    "app.bicep;run",
    "app.bicep --parameters secret=value",
    "-file.bicep",
    "a.txt"
  ])(
    "rejects an unsafe or unsupported file before reading: %s",
    async (appFile) => {
      const read = vi.fn(async () => "source");
      expect(
        await prepareDeploymentCommands(
          { ...target, appFile },
          ports({ readFile: read })
        )
      ).toMatchObject({
        kind: "refused",
        message: expect.stringContaining("repository-relative Bicep path")
      });
      expect(read).not.toHaveBeenCalled();
    }
  );

  it.each(["repo", "branch", "environment"] as const)(
    "refuses missing %s before reading",
    async (field) => {
      const read = vi.fn();
      expect(
        await prepareDeploymentCommands(
          { ...target, [field]: " " },
          ports({ readFile: read })
        )
      ).toMatchObject({ kind: "refused" });
      expect(read).not.toHaveBeenCalled();
    }
  );

  it("passes secure values only to provisioning, not commands", async () => {
    const secret = { password: "synthetic-value" };
    const ensureSecret = vi.fn(async () => null);
    const result = await prepareDeploymentCommands(
      target,
      ports({
        parameters: () => ({ public: { port: "8080" }, secret }),
        ensureSecret
      })
    );
    expect(result).toMatchObject({ kind: "ready" });
    expect(ensureSecret).toHaveBeenCalledExactlyOnceWith(secret);
    expect(JSON.stringify(result)).not.toContain(secret.password);
  });

  it("preserves an explicit provisioning refusal", async () => {
    expect(
      await prepareDeploymentCommands(
        target,
        ports({
          parameters: () => ({
            public: {},
            secret: { password: "synthetic-value" }
          }),
          ensureSecret: async () => "secret unavailable"
        })
      )
    ).toEqual({ kind: "refused", message: "secret unavailable" });
  });

  it.each(["read", "parse", "command", "secret"] as const)(
    "surfaces %s failure without fallback",
    async (stage) => {
      const fail = () => {
        throw new Error(`${stage} failed`);
      };
      const read = vi.fn(stage === "read" ? fail : async () => "source");
      const ensureSecret = vi.fn(stage === "secret" ? fail : async () => null);
      const result = await prepareDeploymentCommands(
        target,
        ports({
          readFile: read,
          parameters:
            stage === "parse" ? fail : (
              () => ({ public: {}, secret: { password: "synthetic-value" } })
            ),
          deployCommand: stage === "command" ? fail : () => "deploy",
          ensureSecret
        })
      );
      expect(result).toEqual({
        kind: "refused",
        message: `Could not prepare deployment commands: ${stage} failed`
      });
      expect(read).toHaveBeenCalledTimes(1);
      expect(ensureSecret).toHaveBeenCalledTimes(stage === "secret" ? 1 : 0);
    }
  );

  it.each(["start", "read", "command", "secret", "error"] as const)(
    "fences retirement at %s",
    async (stage) => {
      let current = stage !== "start";
      const ensureSecret = vi.fn(async () => {
        if (stage === "secret") current = false;
        return null;
      });
      const result = await prepareDeploymentCommands(
        target,
        ports({
          isCurrent: () => current,
          readFile: async () => {
            if (stage === "read" || stage === "error") current = false;
            if (stage === "error") throw new Error("late read failure");
            return "source";
          },
          parameters: () => ({
            public: {},
            secret: { password: "synthetic-value" }
          }),
          deployCommand: () => {
            if (stage === "command") current = false;
            return "deploy";
          },
          ensureSecret
        })
      );
      expect(result).toMatchObject({ kind: "cancelled" });
      expect(ensureSecret).toHaveBeenCalledTimes(stage === "secret" ? 1 : 0);
    }
  );
});
