import { describe, expect, it, vi } from "vitest";
import {
  createCredentialProvenanceRegistry,
  sanitizeCredentialProvenanceRecord,
  planCredentialReclamation,
  type CredentialProvenanceRecord,
  type CredentialProvenanceStore,
  type RecordCredentialProvenanceInput
} from "./credential-provenance.js";
import type { AzureFederatedCredential } from "./azure-oidc.js";

const input: RecordCredentialProvenanceInput = {
  repo: "octo/app",
  repoId: 7,
  environment: "dev",
  tenantId: "tenant",
  clientId: "client",
  applicationObjectId: "application",
  credentialId: "credential",
  name: "dev",
  subject: "repo:octo/app:environment:dev",
  issuer: "https://token.actions.githubusercontent.com",
  audiences: ["api://AzureADTokenExchange"],
  subjectConfig: { useDefault: true },
  origin: "created",
  operationId: "op-test"
};

describe("instance-scoped credential provenance", () => {
  it("isolates independent consumers and uses their injected clock", async () => {
    const first = createCredentialProvenanceRegistry(
      () => "2026-09-18T00:00:00.000Z"
    );
    const second = createCredentialProvenanceRegistry(
      () => "2026-09-19T00:00:00.000Z"
    );
    const recorded = await first.record(input);
    expect(recorded?.recordedAt).toBe("2026-09-18T00:00:00.000Z");
    expect(await first.listForClient("client")).toHaveLength(1);
    expect(await second.listForClient("client")).toEqual([]);
    await first.record({ ...input, origin: "reused" });
    expect((await first.listForClient("client"))[0].origin).toBe("created");
    await first.clearEnvironment(7, "dev");
    expect(first.all()).toEqual([]);
  });

  const stored: CredentialProvenanceRecord = {
    ...input,
    schemaVersion: 2,
    recordedAt: "2026-09-18T00:00:00.000Z"
  };

  function memoryStore(initial: CredentialProvenanceRecord[] = []) {
    const values = new Map<string, unknown>(
      initial.map((record) => [
        JSON.stringify([
          record.tenantId.trim().toLowerCase(),
          record.clientId.trim().toLowerCase(),
          record.applicationObjectId,
          record.credentialId,
          record.repoId,
          record.environment,
          record.origin
        ]),
        record
      ])
    );
    const store: CredentialProvenanceStore = {
      load: vi.fn(async () => [...values.values()]),
      read: async (key) => values.get(key) ?? null,
      write: vi.fn(async (key, record) => {
        values.set(key, record);
      }),
      remove: vi.fn(async (keys) => {
        for (const key of keys) values.delete(key);
      }),
      withLock: vi.fn(async (work) => work())
    };
    return { store, values };
  }

  describe("credential provenance input validation", () => {
    it.each(
      [
        null,
        [],
        "record",
        {},
        { ...stored, schemaVersion: 1 },
        { ...stored, name: "" },
        { ...stored, repo: 7 },
        { ...stored, repoId: "7" },
        { ...stored, repoId: Infinity },
        { ...stored, repoId: 0 },
        { ...stored, origin: "inferred" },
        { ...stored, audiences: null },
        { ...stored, audiences: [7] },
        { ...stored, audiences: [] },
        { ...stored, subjectConfig: null },
        { ...stored, subjectConfig: [] },
        { ...stored, subjectConfig: { useDefault: "true" } },
        {
          ...stored,
          subjectConfig: { useDefault: false, includeClaimKeys: [7] }
        }
      ].map((value) => ({ value }))
    )("rejects invalid stored evidence $value", ({ value }) => {
      expect(sanitizeCredentialProvenanceRecord(value)).toBeNull();
    });

    it("retains explicit custom subject settings and copies audiences", () => {
      const value = {
        ...stored,
        subjectConfig: {
          useDefault: false,
          includeClaimKeys: ["repository_id", "environment"],
          useImmutableSubject: false,
          subClaimPrefix: "repo:octo/app"
        }
      };
      const result = sanitizeCredentialProvenanceRecord(value);
      expect(result).toEqual(value);
      expect(result?.audiences).not.toBe(value.audiences);
      expect(result?.subjectConfig).not.toBe(value.subjectConfig);
    });

    it("does not preserve blank optional prefixes or unknown optional fields", () => {
      expect(
        sanitizeCredentialProvenanceRecord({
          ...stored,
          subjectConfig: {
            useDefault: true,
            subClaimPrefix: "",
            useImmutableSubject: "unknown"
          }
        })?.subjectConfig
      ).toEqual({ useDefault: true });
    });
  });

  describe("durable credential provenance registry", () => {
    it("refreshes environment/client listings and returns copies, not internal records", async () => {
      const { store, values } = memoryStore([stored]);
      const registry = createCredentialProvenanceRegistry(() => "now");
      await registry.configure(store);
      values.set("another-session", {
        ...stored,
        repoId: 8,
        environment: "prod",
        clientId: "other"
      });
      const found = await registry.listForEnvironment(7, "dev");
      expect(found).toEqual([stored]);
      found[0].name = "modified outside the registry";
      expect(registry.all()[0].name).toBe("dev");
      const snapshot = registry.all();
      snapshot[0].name = "another external change";
      expect(await registry.listForClient(" CLIENT ")).toEqual([stored]);
      expect(await registry.listForEnvironment(7, "prod")).toEqual([]);
      expect(await registry.listForEnvironment(8, "prod")).toHaveLength(1);
    });

    it("supports environment lookup and credential removal without a durable store", async () => {
      const registry = createCredentialProvenanceRegistry(() => "now");
      await registry.record(input);
      await registry.record({ ...input, credentialId: "second" });
      await registry.record({ ...input, clientId: "other" });
      expect(await registry.listForEnvironment(7, "dev")).toHaveLength(3);
      await registry.removeCredential(" CLIENT ", "credential");
      expect(
        registry.all().map((record) => [record.clientId, record.credentialId])
      ).toEqual([
        ["client", "second"],
        ["other", "credential"]
      ]);
      await registry.configure(null);
      expect(registry.all()).toEqual([]);
    });

    it("updates the same consumer key and preserves creation evidence across reuse", async () => {
      const { store } = memoryStore([stored]);
      const registry = createCredentialProvenanceRegistry(() => "clock");
      await registry.configure(store);
      expect(
        await registry.record({
          ...input,
          recordedAt: "explicit",
          operationId: "updated"
        })
      ).toMatchObject({
        recordedAt: "explicit",
        operationId: "updated"
      });
      expect(
        await registry.record({ ...input, origin: "reused" })
      ).toMatchObject({
        origin: "created",
        recordedAt: "explicit",
        operationId: "updated"
      });
      expect(store.write).toHaveBeenCalledTimes(1);
      expect(registry.all()).toHaveLength(1);
    });

    it("rejects invalid evidence without persistence and rejects corrupt stored records", async () => {
      const { store, values } = memoryStore();
      const registry = createCredentialProvenanceRegistry(() => "clock");
      await registry.configure(store);
      expect(await registry.record({ ...input, credentialId: "" })).toBeNull();
      expect(store.write).not.toHaveBeenCalled();
      values.set("corrupt", { schemaVersion: 1 });
      await expect(registry.listForClient("client")).rejects.toThrow(
        "stored record is invalid"
      );
      await expect(registry.record(input)).rejects.toThrow(
        "stored record is invalid"
      );
      values.delete("corrupt");
      expect(await registry.record(input)).toMatchObject({
        credentialId: "credential"
      });
    });

    it("refreshes records written by another session before removing credentials", async () => {
      const { store, values } = memoryStore();
      const registry = createCredentialProvenanceRegistry(() => "clock");
      await registry.configure(store);
      const writtenElsewhere = memoryStore([
        stored,
        { ...stored, repoId: 9 },
        { ...stored, credentialId: "keep" },
        { ...stored, clientId: "other" }
      ]).values;
      for (const [key, value] of writtenElsewhere) values.set(key, value);
      await registry.removeCredential(" CLIENT ", "credential");
      expect(await store.load()).toEqual([
        { ...stored, credentialId: "keep" },
        { ...stored, clientId: "other" }
      ]);
      expect(registry.all()).toEqual(await store.load());
    });

    it("refreshes and removes only the requested environment", async () => {
      const { store, values } = memoryStore();
      const registry = createCredentialProvenanceRegistry(() => "clock");
      await registry.configure(store);
      for (const [key, value] of memoryStore([
        stored,
        { ...stored, environment: "prod" },
        { ...stored, repoId: 8 }
      ]).values)
        values.set(key, value);
      await registry.clearEnvironment(7, "dev");
      expect(await store.load()).toEqual([
        { ...stored, environment: "prod" },
        { ...stored, repoId: 8 }
      ]);
      expect(registry.all()).toEqual(await store.load());
    });

    it("delegates durable locking and preserves work failures", async () => {
      const { store } = memoryStore();
      const registry = createCredentialProvenanceRegistry(() => "clock");
      await registry.configure(store);
      expect(await registry.withLock(async () => "locked result")).toBe(
        "locked result"
      );
      const error = new Error("protected operation failed");
      await expect(
        registry.withLock(async () => {
          throw error;
        })
      ).rejects.toBe(error);
      expect(store.withLock).toHaveBeenCalledTimes(2);
    });

    it("serializes pending writes and recovers after a persistence failure", async () => {
      const { store } = memoryStore();
      const registry = createCredentialProvenanceRegistry(() => "clock");
      await registry.configure(store);
      const error = new Error("write denied");
      const originalWrite = store.write;
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      store.write = vi.fn(async (key, value) => {
        await gate;
        if (key.includes("credential")) throw error;
        await originalWrite(key, value);
      });
      const first = registry.record(input);
      const rejected = expect(first).rejects.toBe(error);
      const second = registry.record({ ...input, credentialId: "second" });
      release?.();
      await rejected;
      expect(await second).toMatchObject({ credentialId: "second" });
      expect(registry.all()).toHaveLength(1);
    });
  });

  describe("credential reclamation evidence", () => {
    const credential: AzureFederatedCredential = {
      id: stored.credentialId,
      name: stored.name,
      subject: stored.subject,
      issuer: stored.issuer,
      audiences: stored.audiences
    };
    const context = {
      tenantId: " TENANT ",
      clientId: " CLIENT ",
      applicationObjectId: stored.applicationObjectId,
      repoId: stored.repoId,
      environment: stored.environment
    };

    it("deletes only credentials created exclusively for the target consumer", () => {
      expect(
        planCredentialReclamation([credential], [stored], context)
      ).toEqual({
        delete: [{ credential, record: stored }],
        retain: []
      });
    });

    it.each([
      { tenantId: "other" },
      { clientId: "other" },
      { applicationObjectId: "other" },
      { credentialId: "other" },
      { repoId: 8 },
      { environment: "prod" }
    ])(
      "retains credentials with no matching consumer evidence %j",
      (change) => {
        expect(
          planCredentialReclamation(
            [credential],
            [{ ...stored, ...change }],
            context
          ).retain
        ).toEqual([{ credential, reason: "no-provenance" }]);
      }
    );

    it("retains reused and shared-consumer credentials", () => {
      expect(
        planCredentialReclamation(
          [credential],
          [{ ...stored, origin: "reused" }],
          context
        ).retain[0].reason
      ).toBe("reused");
      expect(
        planCredentialReclamation(
          [credential],
          [stored, { ...stored, repoId: 8 }],
          context
        ).retain[0].reason
      ).toBe("shared-consumer");
    });

    it.each([
      { useDefault: false },
      { useDefault: false, includeClaimKeys: ["environment"] },
      { useDefault: false, includeClaimKeys: ["repository_id"] },
      {
        useDefault: false,
        includeClaimKeys: ["repository", "environment"],
        useImmutableSubject: false
      },
      {
        useDefault: false,
        includeClaimKeys: ["repository_owner", "context"],
        useImmutableSubject: true
      }
    ])(
      "retains custom subjects lacking exclusive stable consumer scope %j",
      (subjectConfig) => {
        const plan = planCredentialReclamation(
          [credential],
          [{ ...stored, subjectConfig }],
          context
        );
        expect(plan.delete).toEqual([]);
        expect(plan.retain[0].reason).toBe("shared-custom-subject");
      }
    );

    it.each([
      { useDefault: false, includeClaimKeys: ["repository_id", "environment"] },
      {
        useDefault: false,
        includeClaimKeys: ["repository", "context"],
        useImmutableSubject: true
      },
      {
        useDefault: false,
        includeClaimKeys: ["repo", "environment"],
        useImmutableSubject: true
      }
    ])(
      "accepts stable repository and environment scoped custom subjects %j",
      (subjectConfig) => {
        expect(
          planCredentialReclamation(
            [credential],
            [{ ...stored, subjectConfig }],
            context
          ).delete
        ).toHaveLength(1);
      }
    );

    it.each([
      { name: "changed" },
      { subject: "changed" },
      { issuer: "changed" },
      { audiences: [] },
      { audiences: ["other"] }
    ])("retains credentials whose observed identity changed %j", (change) => {
      expect(
        planCredentialReclamation(
          [{ ...credential, ...change }],
          [stored],
          context
        ).retain[0].reason
      ).toBe("evidence-changed");
    });

    it("compares audience sets independent of order without mutating evidence", () => {
      const record = { ...stored, audiences: ["first", "second"] };
      const observed = { ...credential, audiences: ["second", "first"] };
      expect(
        planCredentialReclamation([observed], [record], context).delete
      ).toEqual([{ credential: observed, record }]);
      expect(record.audiences).toEqual(["first", "second"]);
      expect(observed.audiences).toEqual(["second", "first"]);
    });
  });

  it("does not claim durable locking without a configured store", async () => {
    const registry = createCredentialProvenanceRegistry(() => "now");
    await expect(registry.withLock(async () => "unexpected")).rejects.toThrow(
      "Durable credential provenance is unavailable."
    );
  });

  it("propagates unreadable durable state instead of treating it as empty", async () => {
    const registry = createCredentialProvenanceRegistry(() => "now");
    await expect(
      registry.configure({
        load: async () => {
          throw new Error("storage unavailable");
        },
        read: async () => null,
        write: async () => {
          throw new Error("unexpected write");
        },
        remove: async () => {
          throw new Error("unexpected remove");
        },
        withLock: async (work) => work()
      })
    ).rejects.toThrow("storage unavailable");
  });
});
