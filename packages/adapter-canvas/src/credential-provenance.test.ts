import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CREDENTIAL_PROVENANCE_SCHEMA_VERSION,
  GITHUB_ACTIONS_OIDC_ISSUER,
  AZURE_AD_TOKEN_EXCHANGE_AUDIENCE,
  sanitizeCredentialProvenanceRecord,
  planCredentialReclamation,
  configureCredentialProvenanceStore,
  recordCredentialProvenance,
  listCredentialProvenanceForClient,
  removeCredentialProvenance,
  clearEnvironmentCredentialProvenance,
  withCredentialProvenanceLock,
  allCredentialProvenance,
  resetCredentialProvenanceForTest,
  type CredentialProvenanceRecord,
  type CredentialReclamationContext
} from "./credential-provenance.js";
import type { CredentialProvenanceStore } from "./credential-provenance-store.js";

afterEach(() => resetCredentialProvenanceForTest());

function record(
  over: Partial<CredentialProvenanceRecord> = {}
): CredentialProvenanceRecord {
  return {
    schemaVersion: CREDENTIAL_PROVENANCE_SCHEMA_VERSION,
    repo: "octo/app",
    repoId: 5,
    environment: "dev",
    tenantId: "tenant-1",
    clientId: "app-1",
    applicationObjectId: "app-object-1",
    credentialId: "credential-1",
    name: "github-octo-app-dev-mutable",
    subject: "repo:octo/app:environment:dev",
    issuer: GITHUB_ACTIONS_OIDC_ISSUER,
    audiences: [AZURE_AD_TOKEN_EXCHANGE_AUDIENCE],
    subjectConfig: { useDefault: true },
    origin: "created",
    operationId: "op-1",
    recordedAt: "2026-08-20T00:00:00.000Z",
    ...over
  };
}

function credential(
  over: Partial<{
    id: string;
    name: string;
    subject: string;
    issuer: string;
    audiences: string[];
  }> = {}
) {
  return {
    id: "credential-1",
    name: "github-octo-app-dev-mutable",
    subject: "repo:octo/app:environment:dev",
    issuer: GITHUB_ACTIONS_OIDC_ISSUER,
    audiences: [AZURE_AD_TOKEN_EXCHANGE_AUDIENCE],
    ...over
  };
}

const context: CredentialReclamationContext = {
  tenantId: "tenant-1",
  clientId: "app-1",
  applicationObjectId: "app-object-1",
  repoId: 5,
  environment: "dev"
};

function memoryStore(initial: unknown[] = []): CredentialProvenanceStore & {
  values: Map<string, unknown>;
  write: ReturnType<typeof vi.fn<CredentialProvenanceStore["write"]>>;
  remove: ReturnType<typeof vi.fn<CredentialProvenanceStore["remove"]>>;
} {
  const values = new Map<string, unknown>();
  return {
    values,
    async load() {
      return [...initial, ...values.values()];
    },
    async read(key) {
      return values.get(key) ?? null;
    },
    write: vi.fn(async (key, value) => {
      values.set(key, value);
    }),
    remove: vi.fn(async (keys) => {
      for (const key of keys) values.delete(key);
    }),
    async withLock(work) {
      return work();
    }
  };
}

describe("sanitizeCredentialProvenanceRecord", () => {
  it("accepts the complete version 2 record", () => {
    expect(sanitizeCredentialProvenanceRecord(record())).toEqual(record());
  });

  it.each([
    null,
    [],
    { ...record(), schemaVersion: 1 },
    { ...record(), repo: "" },
    { ...record(), repoId: 0 },
    { ...record(), origin: "unknown" },
    { ...record(), audiences: [] },
    { ...record(), audiences: [4] },
    { ...record(), subjectConfig: null },
    { ...record(), subjectConfig: { useDefault: "yes" } },
    {
      ...record(),
      subjectConfig: { useDefault: false, includeClaimKeys: [4] }
    }
  ])("rejects incomplete or malformed evidence %#", (value) => {
    expect(sanitizeCredentialProvenanceRecord(value)).toBeNull();
  });

  it("preserves optional subject configuration evidence", () => {
    const value = record({
      subjectConfig: {
        useDefault: false,
        includeClaimKeys: ["repository_id", "environment"],
        useImmutableSubject: true,
        subClaimPrefix: "octo@7/app@5"
      }
    });
    expect(sanitizeCredentialProvenanceRecord(value)?.subjectConfig).toEqual(
      value.subjectConfig
    );
  });
});

describe("planCredentialReclamation", () => {
  it("deletes only an exact, exclusive, Radius-created live object", () => {
    const plan = planCredentialReclamation([credential()], [record()], context);
    expect(plan.delete).toHaveLength(1);
    expect(plan.retain).toEqual([]);
  });

  it.each([
    {
      name: "reused target",
      records: [record({ origin: "reused" })],
      reason: "reused"
    },
    {
      name: "another environment consumes the same object",
      records: [
        record(),
        record({
          repoId: 9,
          repo: "other/repo",
          environment: "prod",
          origin: "reused"
        })
      ],
      reason: "shared-consumer"
    },
    {
      name: "custom subject lacks stable repository exclusivity",
      records: [
        record({
          subjectConfig: {
            useDefault: false,
            includeClaimKeys: ["repository", "environment"],
            useImmutableSubject: false
          }
        })
      ],
      reason: "shared-custom-subject"
    },
    {
      name: "no creation record",
      records: [],
      reason: "no-provenance"
    }
  ])("retains $name", ({ records, reason }) => {
    const plan = planCredentialReclamation([credential()], records, context);
    expect(plan.delete).toEqual([]);
    expect(plan.retain[0].reason).toBe(reason);
  });

  it("allows a custom subject proven stable and environment-exclusive", () => {
    const plan = planCredentialReclamation(
      [credential()],
      [
        record({
          subjectConfig: {
            useDefault: false,
            includeClaimKeys: ["repository_id", "environment"]
          }
        })
      ],
      context
    );
    expect(plan.delete).toHaveLength(1);
  });

  it.each([
    ["credential id", credential({ id: "replacement" })],
    ["name", credential({ name: "changed" })],
    ["subject", credential({ subject: "changed" })],
    ["issuer", credential({ issuer: "https://changed.example" })],
    ["audience", credential({ audiences: ["changed"] })]
  ])("retains when the live %s changed", (_name, live) => {
    const plan = planCredentialReclamation([live], [record()], context);
    expect(plan.delete).toEqual([]);
    expect(plan.retain[0].reason).toBe(
      live.id === "replacement" ? "no-provenance" : "evidence-changed"
    );
  });

  it("matches tenant and client ids case-insensitively", () => {
    const plan = planCredentialReclamation(
      [credential()],
      [record({ tenantId: "TENANT-1", clientId: "APP-1" })],
      context
    );
    expect(plan.delete).toHaveLength(1);
  });

  it("keeps created ownership when a concurrent session also records reuse", () => {
    const plan = planCredentialReclamation(
      [credential()],
      [record(), record({ origin: "reused", operationId: "op-2" })],
      context
    );
    expect(plan.delete).toHaveLength(1);
    expect(plan.retain).toEqual([]);
  });
});

describe("credential provenance registry", () => {
  it("fails closed when any durable record is invalid", async () => {
    const store = memoryStore([record(), { invalid: true }]);
    await expect(configureCredentialProvenanceStore(store)).rejects.toThrow(
      "Credential provenance is incomplete"
    );
    await expect(recordCredentialProvenance(record())).rejects.toThrow(
      "Credential provenance is incomplete"
    );
  });

  it("refreshes durable records written by another session before planning", async () => {
    const durable = [record()];
    await configureCredentialProvenanceStore(memoryStore(durable));
    durable.push(
      record({
        repo: "other/repo",
        repoId: 9,
        environment: "prod",
        origin: "reused"
      })
    );
    expect(await listCredentialProvenanceForClient("app-1")).toHaveLength(2);
  });

  it("awaits durable writes before publishing records in memory", async () => {
    const store = memoryStore();
    await configureCredentialProvenanceStore(store);
    const written = await recordCredentialProvenance(record());
    expect(written).toEqual(record());
    expect(store.write).toHaveBeenCalledOnce();
    expect(allCredentialProvenance()).toEqual([record()]);
  });

  it("keeps created ownership when a later setup reuses the same object", async () => {
    await configureCredentialProvenanceStore(memoryStore());
    await recordCredentialProvenance(record());
    const retained = await recordCredentialProvenance(
      record({ origin: "reused", operationId: "op-2" })
    );
    expect(retained?.origin).toBe("created");
    expect(allCredentialProvenance()).toHaveLength(1);
  });

  it("does not change memory when a durable write fails", async () => {
    const store = memoryStore();
    store.write.mockRejectedValueOnce(new Error("disk full"));
    await configureCredentialProvenanceStore(store);
    await expect(recordCredentialProvenance(record())).rejects.toThrow(
      "disk full"
    );
    expect(allCredentialProvenance()).toEqual([]);
  });

  it("removes all consumers only after durable credential removal succeeds", async () => {
    const store = memoryStore();
    await configureCredentialProvenanceStore(store);
    await recordCredentialProvenance(record());
    await recordCredentialProvenance(
      record({ repoId: 9, repo: "other/repo", environment: "prod" })
    );
    store.remove.mockRejectedValueOnce(new Error("locked"));
    await expect(
      removeCredentialProvenance("app-1", "credential-1")
    ).rejects.toThrow("locked");
    expect(allCredentialProvenance()).toHaveLength(2);
    await removeCredentialProvenance("app-1", "credential-1");
    expect(allCredentialProvenance()).toEqual([]);
  });

  it("clears only one repository environment", async () => {
    await configureCredentialProvenanceStore(memoryStore());
    await recordCredentialProvenance(record());
    await recordCredentialProvenance(
      record({
        credentialId: "credential-2",
        name: "prod",
        environment: "prod"
      })
    );
    await clearEnvironmentCredentialProvenance(5, "dev");
    expect(allCredentialProvenance().map((entry) => entry.environment)).toEqual(
      ["prod"]
    );
  });

  it("supports a disabled store", async () => {
    await configureCredentialProvenanceStore(null);
    await expect(recordCredentialProvenance(record())).resolves.toEqual(
      record()
    );
  });

  it("fails closed when a destructive lock has no durable store", async () => {
    await configureCredentialProvenanceStore(null);
    await expect(
      withCredentialProvenanceLock(async () => "unreachable")
    ).rejects.toThrow("Durable credential provenance is unavailable");
  });
});
