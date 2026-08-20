import { describe, it, expect, afterEach } from "vitest";
import {
  CREDENTIAL_PROVENANCE_SCHEMA_VERSION,
  GITHUB_ACTIONS_OIDC_ISSUER,
  AZURE_AD_TOKEN_EXCHANGE_AUDIENCE,
  sanitizeCredentialProvenanceRecord,
  planCredentialReclamation,
  configureCredentialProvenanceStore,
  recordCredentialProvenance,
  listCredentialProvenance,
  clearCredentialProvenance,
  allCredentialProvenance,
  persistCredentialProvenance,
  resetCredentialProvenanceForTest,
  type CredentialProvenanceRecord
} from "./credential-provenance.js";
import type { CredentialProvenanceStore } from "./credential-provenance-store.js";

afterEach(() => resetCredentialProvenanceForTest());

function record(
  over: Partial<CredentialProvenanceRecord> = {}
): CredentialProvenanceRecord {
  return {
    schemaVersion: CREDENTIAL_PROVENANCE_SCHEMA_VERSION,
    repo: "octo/app",
    environment: "dev",
    clientId: "app-1",
    name: "github-octo-app-dev-mutable",
    subject: "repo:octo/app:environment:dev",
    issuer: GITHUB_ACTIONS_OIDC_ISSUER,
    audiences: [AZURE_AD_TOKEN_EXCHANGE_AUDIENCE],
    origin: "created",
    recordedAt: new Date(0).toISOString(),
    ...over
  };
}

function credential(
  over: Partial<{ id: string; name: string; subject: string }> = {}
) {
  return {
    id: over.id ?? "c1",
    name: over.name ?? "github-octo-app-dev-mutable",
    subject: over.subject ?? "repo:octo/app:environment:dev"
  };
}

describe("sanitizeCredentialProvenanceRecord", () => {
  it("accepts a well-formed record and fills issuer/audiences defaults", () => {
    const out = sanitizeCredentialProvenanceRecord({
      schemaVersion: 1,
      repo: "octo/app",
      environment: "dev",
      clientId: "app-1",
      name: "fic",
      subject: "s",
      origin: "created"
    });
    expect(out?.issuer).toBe(GITHUB_ACTIONS_OIDC_ISSUER);
    expect(out?.audiences).toEqual([AZURE_AD_TOKEN_EXCHANGE_AUDIENCE]);
    expect(out?.recordedAt).toBe(new Date(0).toISOString());
  });

  it("preserves optional repoId, operationId, issuer and audiences", () => {
    const out = sanitizeCredentialProvenanceRecord({
      schemaVersion: 1,
      repo: "octo/app",
      environment: "dev",
      clientId: "app-1",
      name: "fic",
      subject: "s",
      origin: "reused",
      issuer: "https://issuer",
      audiences: ["aud", 5],
      repoId: 42,
      operationId: "op_1",
      recordedAt: "2026-01-01T00:00:00.000Z"
    });
    expect(out?.origin).toBe("reused");
    expect(out?.issuer).toBe("https://issuer");
    expect(out?.audiences).toEqual(["aud"]);
    expect(out?.repoId).toBe(42);
    expect(out?.operationId).toBe("op_1");
    expect(out?.recordedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("rejects non-objects, wrong schema, unknown origin and missing fields", () => {
    expect(sanitizeCredentialProvenanceRecord(null)).toBeNull();
    expect(sanitizeCredentialProvenanceRecord([])).toBeNull();
    expect(sanitizeCredentialProvenanceRecord({ schemaVersion: 2 })).toBeNull();
    expect(
      sanitizeCredentialProvenanceRecord({
        schemaVersion: 1,
        repo: "octo/app",
        environment: "dev",
        clientId: "app-1",
        name: "fic",
        subject: "s",
        origin: "made-up"
      })
    ).toBeNull();
    expect(
      sanitizeCredentialProvenanceRecord({
        schemaVersion: 1,
        repo: "octo/app",
        environment: "dev",
        clientId: "app-1",
        name: "",
        subject: "s",
        origin: "created"
      })
    ).toBeNull();
  });

  it("rejects an object whose required fields are not strings", () => {
    expect(
      sanitizeCredentialProvenanceRecord({
        schemaVersion: 1,
        repo: 1,
        environment: 2,
        clientId: 3,
        name: 4,
        subject: 5,
        origin: "created"
      })
    ).toBeNull();
  });

  it("ignores a non-finite repoId", () => {
    const out = sanitizeCredentialProvenanceRecord({
      schemaVersion: 1,
      repo: "octo/app",
      environment: "dev",
      clientId: "app-1",
      name: "fic",
      subject: "s",
      origin: "created",
      repoId: Number.NaN
    });
    expect(out?.repoId).toBeUndefined();
  });
});

describe("planCredentialReclamation", () => {
  it("deletes a created credential whose subject matches", () => {
    const plan = planCredentialReclamation([credential()], [record()], "app-1");
    expect(plan.delete).toHaveLength(1);
    expect(plan.retain).toHaveLength(0);
    expect(plan.delete[0].record.origin).toBe("created");
  });

  it("matches the client id case-insensitively", () => {
    const plan = planCredentialReclamation(
      [credential()],
      [record({ clientId: "APP-1" })],
      "app-1"
    );
    expect(plan.delete).toHaveLength(1);
  });

  it("retains when there is no matching provenance", () => {
    const plan = planCredentialReclamation([credential()], [], "app-1");
    expect(plan.delete).toHaveLength(0);
    expect(plan.retain[0].reason).toBe("no-provenance");
  });

  it("retains a reused credential over a created one for the same identity", () => {
    const plan = planCredentialReclamation(
      [credential()],
      [record(), record({ origin: "reused" })],
      "app-1"
    );
    expect(plan.delete).toHaveLength(0);
    expect(plan.retain[0].reason).toBe("reused");
  });

  it("retains a created credential whose subject drifted", () => {
    const plan = planCredentialReclamation(
      [credential({ subject: "changed" })],
      [record()],
      "app-1"
    );
    expect(plan.delete).toHaveLength(0);
    expect(plan.retain[0].reason).toBe("evidence-changed");
  });

  it("treats non-string record identity fields as empty (no match)", () => {
    const plan = planCredentialReclamation(
      [credential()],
      [
        {
          ...record(),
          repo: 1 as unknown as string,
          clientId: 2 as unknown as string
        }
      ],
      "app-1"
    );
    expect(plan.delete).toHaveLength(0);
    expect(plan.retain[0].reason).toBe("no-provenance");
  });
});

describe("credential provenance registry", () => {
  it("is disabled by default: records in memory without a store", async () => {
    expect(recordCredentialProvenance(record())).not.toBeNull();
    expect(listCredentialProvenance("octo/app", "dev")).toHaveLength(1);
    // A no-op persist is safe when no store is configured.
    await persistCredentialProvenance();
  });

  it("rejects an incomplete record input", () => {
    expect(recordCredentialProvenance({ ...record(), name: "" })).toBeNull();
    expect(allCredentialProvenance()).toHaveLength(0);
  });

  it("defaults issuer, audiences and recordedAt when omitted", () => {
    const out = recordCredentialProvenance({
      repo: "octo/app",
      environment: "dev",
      clientId: "app-1",
      name: "fic",
      subject: "s",
      origin: "created"
    });
    expect(out?.issuer).toBe(GITHUB_ACTIONS_OIDC_ISSUER);
    expect(out?.audiences).toEqual([AZURE_AD_TOKEN_EXCHANGE_AUDIENCE]);
    expect(typeof out?.recordedAt).toBe("string");
  });

  it("keeps explicit issuer, audiences, repoId, operationId and origin", () => {
    const out = recordCredentialProvenance({
      repo: "octo/app",
      environment: "dev",
      clientId: "app-1",
      name: "fic",
      subject: "s",
      origin: "reused",
      issuer: "https://issuer",
      audiences: ["aud"],
      repoId: 7,
      operationId: "op_9",
      recordedAt: "2026-02-02T00:00:00.000Z"
    });
    expect(out?.origin).toBe("reused");
    expect(out?.issuer).toBe("https://issuer");
    expect(out?.audiences).toEqual(["aud"]);
    expect(out?.repoId).toBe(7);
    expect(out?.operationId).toBe("op_9");
    expect(out?.recordedAt).toBe("2026-02-02T00:00:00.000Z");
  });

  it("upserts by identity and lists by repo + environment", () => {
    recordCredentialProvenance(record({ subject: "old" }));
    recordCredentialProvenance(record({ subject: "new" }));
    const listed = listCredentialProvenance("OCTO/APP", "dev");
    expect(listed).toHaveLength(1);
    expect(listed[0].subject).toBe("new");
    expect(listCredentialProvenance("octo/app", "prod")).toHaveLength(0);
    // A non-string repo argument normalizes to empty and matches nothing.
    expect(
      listCredentialProvenance(0 as unknown as string, "dev")
    ).toHaveLength(0);
  });

  it("clears only the targeted repo + environment", async () => {
    recordCredentialProvenance(record());
    recordCredentialProvenance(
      record({ environment: "prod", name: "fic-prod" })
    );
    await clearCredentialProvenance("octo/app", "dev");
    expect(listCredentialProvenance("octo/app", "dev")).toHaveLength(0);
    expect(listCredentialProvenance("octo/app", "prod")).toHaveLength(1);
    // Clearing a repo/env with nothing to remove is a no-op.
    await clearCredentialProvenance("octo/app", "dev");
  });

  it("hydrates from a store, persists changes and reports write failures", async () => {
    const saved: unknown[] = [];
    const diagnostics: string[] = [];
    let failNextSave = false;
    const store: CredentialProvenanceStore = {
      report: (d) => diagnostics.push(d.code),
      async load() {
        return {
          schemaVersion: 1,
          credentials: [record(), { bogus: true }]
        };
      },
      async save(envelope) {
        if (failNextSave) throw new Error("disk full");
        saved.push(envelope.credentials);
      }
    };
    await configureCredentialProvenanceStore(store);
    // Only the valid record survived the sanitize pass.
    expect(listCredentialProvenance("octo/app", "dev")).toHaveLength(1);

    recordCredentialProvenance(record({ name: "fic-2" }));
    await persistCredentialProvenance();
    expect(saved.length).toBeGreaterThan(0);

    failNextSave = true;
    recordCredentialProvenance(record({ name: "fic-3" }));
    await persistCredentialProvenance();
    expect(diagnostics).toContain("credential-provenance-write-failed");
  });

  it("configuring with null disables persistence and clears memory", async () => {
    recordCredentialProvenance(record());
    await configureCredentialProvenanceStore(null);
    expect(allCredentialProvenance()).toHaveLength(0);
  });

  it("ignores an empty store load without throwing", async () => {
    await configureCredentialProvenanceStore({
      async load() {
        return null;
      },
      async save() {}
    });
    expect(allCredentialProvenance()).toHaveLength(0);
  });

  it("rejects records whose required fields are not strings", () => {
    expect(
      recordCredentialProvenance({
        ...record(),
        repo: undefined as unknown as string
      })
    ).toBeNull();
    expect(
      recordCredentialProvenance({
        ...record(),
        environment: 0 as unknown as string
      })
    ).toBeNull();
    expect(
      recordCredentialProvenance({
        ...record(),
        clientId: 5 as unknown as string
      })
    ).toBeNull();
    expect(
      recordCredentialProvenance({
        ...record(),
        name: {} as unknown as string
      })
    ).toBeNull();
    expect(
      recordCredentialProvenance({
        ...record(),
        subject: null as unknown as string
      })
    ).toBeNull();
  });

  it("swallows write failures when the store has no report callback", async () => {
    await configureCredentialProvenanceStore({
      async load() {
        return null;
      },
      async save() {
        throw new Error("disk full");
      }
    });
    recordCredentialProvenance(record());
    await expect(persistCredentialProvenance()).resolves.toBeUndefined();
  });
});
