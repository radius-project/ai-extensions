import { describe, expect, it, vi } from "vitest";
import {
  ensureDeploymentSecret,
  type DeploymentSecretPorts
} from "./deployment-secret.js";

const target = { repo: "acme/widgets", environment: "production" };
const parameters = { dbPassword: "synthetic-value" };

function fixture(overrides: Partial<DeploymentSecretPorts> = {}) {
  const events: string[] = [];
  let written = false;
  const ports: DeploymentSecretPorts = {
    isCurrent: () => true,
    readNames: async () => {
      events.push("read");
      return written ? ["RADIUS_DEPLOY_PARAMS"] : [];
    },
    write: async () => {
      events.push("write");
      written = true;
    },
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    log: (message) => {
      events.push(message);
    },
    ...overrides
  };
  return { ports, events };
}

describe("deployment secret preparation", () => {
  it("reads, writes and verifies using the captured target and secret map", async () => {
    const selected = { ...target };
    const values = { ...parameters };
    const { ports, events } = fixture();
    const read = ports.readNames;
    ports.readNames = vi.fn(async (actual) => {
      expect(actual).toEqual(target);
      selected.repo = "other/repo";
      values.dbPassword = "replacement";
      return read(actual);
    });
    const write = ports.write;
    ports.write = vi.fn(async (actual, secret) => {
      expect(actual).toEqual(target);
      expect(secret).toEqual(parameters);
      return write(actual, secret);
    });
    expect(await ensureDeploymentSecret(selected, values, ports)).toEqual({
      kind: "ready",
      provisioned: true
    });
    expect(events).toEqual([
      "read",
      'Provisioning RADIUS_DEPLOY_PARAMS for "production" (dbPassword)...',
      "write",
      "read",
      'RADIUS_DEPLOY_PARAMS is set on "production".'
    ]);
    expect(events.join("\n")).not.toContain(parameters.dbPassword);
  });

  it("preserves an existing secret without overwriting it", async () => {
    const write = vi.fn();
    const { ports } = fixture({
      readNames: async () => ["OTHER", "RADIUS_DEPLOY_PARAMS"],
      write
    });
    expect(await ensureDeploymentSecret(target, parameters, ports)).toEqual({
      kind: "ready",
      provisioned: false
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("does not read or mutate secrets when none are needed", async () => {
    const { ports, events } = fixture();
    expect(await ensureDeploymentSecret(target, {}, ports)).toEqual({
      kind: "ready",
      provisioned: false
    });
    expect(events).toEqual([]);
  });

  it.each([
    { ...target, repo: " " },
    { ...target, environment: "" }
  ])(
    "refuses an incomplete target before external calls: %j",
    async (selected) => {
      const { ports, events } = fixture();
      expect(
        await ensureDeploymentSecret(selected, parameters, ports)
      ).toMatchObject({
        kind: "refused",
        message: "A repository and environment are required."
      });
      expect(events).toEqual([]);
    }
  );

  it.each(["start", "read", "log", "write", "verify"] as const)(
    "stops before the next external effect when retired at %s",
    async (step) => {
      let current = step !== "start";
      let reads = 0;
      const write = vi.fn(async () => {
        if (step === "write") current = false;
      });
      const { ports } = fixture({
        isCurrent: () => current,
        readNames: async () => {
          reads++;
          if (step === (reads === 1 ? "read" : "verify")) current = false;
          return reads === 1 ? [] : ["RADIUS_DEPLOY_PARAMS"];
        },
        write,
        log: () => {
          if (step === "log") current = false;
        }
      });
      expect(
        await ensureDeploymentSecret(target, parameters, ports)
      ).toMatchObject({
        kind: "cancelled"
      });
      expect(reads).toBe(
        step === "start" ? 0
        : step === "verify" ? 2
        : 1
      );
      expect(write).toHaveBeenCalledTimes(
        step === "write" || step === "verify" ? 1 : 0
      );
    }
  );

  it.each(["read", "write", "verify"] as const)(
    "surfaces a failed %s without retrying a secret mutation",
    async (step) => {
      let reads = 0;
      const write = vi.fn(async () => {
        if (step === "write") throw new Error("HTTP 403");
      });
      const { ports } = fixture({
        write,
        readNames: async () => {
          reads++;
          if (step === (reads === 1 ? "read" : "verify"))
            throw new Error("HTTP 403");
          return [];
        }
      });
      const outcome = await ensureDeploymentSecret(target, parameters, ports);
      expect(outcome).toMatchObject({
        kind: "refused",
        message: expect.stringContaining("HTTP 403")
      });
      if (outcome.kind !== "ready") {
        expect(outcome.message).toContain(
          step === "write" ? "Could not provision" : `Could not ${step}`
        );
      }
      expect(write).toHaveBeenCalledTimes(step === "read" ? 0 : 1);
      expect(reads).toBe(step === "verify" ? 2 : 1);
    }
  );

  it("does not claim verification when the accepted secret is absent", async () => {
    const { ports } = fixture({ readNames: async () => ["OTHER"] });
    expect(
      await ensureDeploymentSecret(target, parameters, ports)
    ).toMatchObject({
      kind: "refused",
      message: expect.stringContaining("was accepted but is not present")
    });
  });

  it("does not surface a late failure after retirement", async () => {
    let current = true;
    const { ports } = fixture({
      isCurrent: () => current,
      readNames: async () => {
        current = false;
        throw new Error("late failure");
      }
    });
    expect(await ensureDeploymentSecret(target, parameters, ports)).toEqual({
      kind: "cancelled",
      message: "Deployment preparation stopped; no workflow was dispatched."
    });
  });

  it.each([
    { value: "ab", diagnostic: "read rejected ab" },
    { value: "a.*[x]", diagnostic: "read rejected a.*[x]" },
    {
      value: 'quote"and\\slash',
      diagnostic: 'payload {"key":"quote\\"and\\\\slash"}'
    },
    { value: "", diagnostic: "access_token=synthetic-value" }
  ])(
    "redacts known secrets and generic credentials: $value",
    async ({ value, diagnostic }) => {
      const { ports } = fixture({
        readNames: async () => {
          throw new Error(diagnostic);
        }
      });
      const outcome = await ensureDeploymentSecret(
        target,
        { key: value },
        ports
      );
      expect(outcome).toMatchObject({
        kind: "refused",
        message: expect.stringContaining("[REDACTED]")
      });
      if (value && outcome.kind !== "ready") {
        expect(outcome.message).not.toContain(value);
        expect(outcome.message).not.toContain(
          JSON.stringify(value).slice(1, -1)
        );
      }
    }
  );

  it("bounds external diagnostics without hiding that preparation failed", async () => {
    const { ports } = fixture({
      readNames: async () => {
        throw new Error("x".repeat(5000));
      }
    });
    const outcome = await ensureDeploymentSecret(target, parameters, ports);
    expect(outcome).toMatchObject({ kind: "refused" });
    if (outcome.kind !== "ready") {
      expect(outcome.message).toContain("x".repeat(4000));
      expect(outcome.message).not.toContain("x".repeat(4001));
      expect(outcome.message).toContain("so it was not started");
    }
  });
});
