import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PERSISTED_CREDENTIAL_PROVENANCE_VERSION,
  parseCredentialProvenanceEnvelope,
  createFileCredentialProvenanceStore,
  disabledCredentialProvenanceStore,
  type CredentialProvenanceStoreDiagnostic,
  type PersistedCredentialProvenanceEnvelope
} from "./credential-provenance-store.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prov-store-"));
  dirs.push(dir);
  return path.join(dir, "credential-provenance.json");
}

const sampleEnvelope: PersistedCredentialProvenanceEnvelope = {
  schemaVersion: PERSISTED_CREDENTIAL_PROVENANCE_VERSION,
  credentials: [{ name: "fic" }]
};

describe("parseCredentialProvenanceEnvelope", () => {
  it("accepts a valid envelope", () => {
    expect(
      parseCredentialProvenanceEnvelope(sampleEnvelope).credentials
    ).toEqual([{ name: "fic" }]);
  });

  it("rejects wrong shapes", () => {
    expect(() => parseCredentialProvenanceEnvelope(null)).toThrow();
    expect(() => parseCredentialProvenanceEnvelope([])).toThrow();
    expect(() =>
      parseCredentialProvenanceEnvelope({ schemaVersion: 9, credentials: [] })
    ).toThrow();
    expect(() =>
      parseCredentialProvenanceEnvelope({ schemaVersion: 1, credentials: {} })
    ).toThrow();
  });
});

describe("createFileCredentialProvenanceStore", () => {
  it("returns null when the file does not exist", async () => {
    const store = createFileCredentialProvenanceStore({
      filePath: await tempFile()
    });
    expect(await store.load()).toBeNull();
  });

  it("round-trips a save and load", async () => {
    const filePath = await tempFile();
    const store = createFileCredentialProvenanceStore({ filePath });
    await store.save(sampleEnvelope);
    const loaded = await store.load();
    expect(loaded?.credentials).toEqual([{ name: "fic" }]);
    // The file is written with restrictive permissions.
    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("reports and ignores corrupt JSON", async () => {
    const filePath = await tempFile();
    await fs.writeFile(filePath, "{not json", "utf8");
    const diagnostics: CredentialProvenanceStoreDiagnostic[] = [];
    const store = createFileCredentialProvenanceStore({
      filePath,
      report: (d) => diagnostics.push(d)
    });
    expect(await store.load()).toBeNull();
    expect(diagnostics[0].code).toBe("credential-provenance-corrupt");
  });

  it("reports an unreadable path (a directory) as unavailable", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prov-dir-"));
    dirs.push(dir);
    const diagnostics: CredentialProvenanceStoreDiagnostic[] = [];
    const store = createFileCredentialProvenanceStore({
      filePath: dir, // reading a directory as a file fails with EISDIR
      report: (d) => diagnostics.push(d)
    });
    expect(await store.load()).toBeNull();
    expect(diagnostics[0].code).toBe("credential-provenance-unavailable");
  });

  it("rejects saving an invalid envelope", async () => {
    const store = createFileCredentialProvenanceStore({
      filePath: await tempFile()
    });
    await expect(
      store.save({ schemaVersion: 9, credentials: [] } as never)
    ).rejects.toThrow();
  });

  it("cleans up the temp file and rethrows when the rename fails", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prov-rn-"));
    dirs.push(dir);
    // Point the store at an existing non-empty directory so the final rename
    // fails; the store must remove its temp file and rethrow.
    const target = path.join(dir, "target");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "child"), "x", "utf8");
    const store = createFileCredentialProvenanceStore({ filePath: target });
    await expect(store.save(sampleEnvelope)).rejects.toThrow();
    const leftovers = (await fs.readdir(dir)).filter((n) => n !== "target");
    expect(leftovers).toEqual([]);
  });

  it("uses a default no-op reporter when none is supplied", async () => {
    const filePath = await tempFile();
    await fs.writeFile(filePath, "nonsense", "utf8");
    const store = createFileCredentialProvenanceStore({ filePath });
    expect(await store.load()).toBeNull();
  });
});

describe("disabledCredentialProvenanceStore", () => {
  it("loads null and saves nothing", async () => {
    const store = disabledCredentialProvenanceStore();
    expect(await store.load()).toBeNull();
    await expect(store.save(sampleEnvelope)).resolves.toBeUndefined();
  });
});
