import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createFileCredentialProvenanceStore,
  type CredentialProvenanceStoreDiagnostic
} from "./credential-provenance-store.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});

async function tempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "prov-store-"));
  directories.push(directory);
  return directory;
}

describe("createFileCredentialProvenanceStore", () => {
  it("loads an empty set when the directory does not exist", async () => {
    const parent = await tempDirectory();
    const store = createFileCredentialProvenanceStore({
      directory: path.join(parent, "missing")
    });
    expect(await store.load()).toEqual([]);
  });

  it("round-trips independent records with restrictive permissions", async () => {
    const directory = await tempDirectory();
    const store = createFileCredentialProvenanceStore({ directory });
    await store.write("one", { id: 1 });
    await store.write("two", { id: 2 });
    expect(await store.read("one")).toEqual({ id: 1 });
    expect(await store.load()).toEqual(
      expect.arrayContaining([{ id: 1 }, { id: 2 }])
    );
    const names = await fs.readdir(directory);
    expect(names).toHaveLength(2);
    expect((await fs.stat(path.join(directory, names[0]))).mode & 0o777).toBe(
      0o600
    );
    await store.remove(["one"]);
    expect(await store.read("one")).toBeNull();
    expect(await store.load()).toEqual([{ id: 2 }]);
  });

  it("makes records visible to another store instance", async () => {
    const directory = await tempDirectory();
    const writer = createFileCredentialProvenanceStore({ directory });
    const reader = createFileCredentialProvenanceStore({ directory });
    await writer.write("consumer-a", { id: 1 });
    expect(await reader.load()).toEqual([{ id: 1 }]);
  });

  it("serializes reclamation and setup across store instances", async () => {
    const directory = await tempDirectory();
    const firstStore = createFileCredentialProvenanceStore({ directory });
    const secondStore = createFileCredentialProvenanceStore({ directory });
    const entered: string[] = [];
    let releaseFirst: () => void = () => {};
    let signalFirstEntered: () => void = () => {};
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstEntered = new Promise<void>((resolve) => {
      signalFirstEntered = resolve;
    });
    const first = firstStore.withLock(async () => {
      entered.push("first");
      signalFirstEntered();
      await holdFirst;
    });
    await firstEntered;
    const second = secondStore.withLock(async () => {
      entered.push("second");
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(entered).toEqual(["first"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(entered).toEqual(["first", "second"]);
  });

  it("keeps the lock directory mtime fresh with a heartbeat while held", async () => {
    const utimesSpy = vi.spyOn(fs, "utimes");
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      const directory = await tempDirectory();
      const store = createFileCredentialProvenanceStore({ directory });
      let release: () => void = () => {};
      const running = store.withLock(
        () => new Promise<void>((resolve) => (release = resolve))
      );
      // Wait until the heartbeat interval has been scheduled, which only happens
      // once the lock is acquired (after the real mkdir/writeFile I/O).
      for (let i = 0; i < 50 && intervalSpy.mock.calls.length === 0; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(intervalSpy).toHaveBeenCalled();
      const tick = intervalSpy.mock.calls[0][0] as () => void;
      utimesSpy.mockClear();
      tick();
      await new Promise((resolve) => setImmediate(resolve));
      const lockDir = path.join(directory, ".lock");
      expect(utimesSpy).toHaveBeenCalled();
      expect(utimesSpy.mock.calls[0][0]).toBe(lockDir);
      release();
      await running;
      // The heartbeat is cleared and the lock released when work resolves.
      await expect(fs.stat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      intervalSpy.mockRestore();
      utimesSpy.mockRestore();
    }
  });

  it("ignores non-json files but fails closed on corrupt records", async () => {
    const directory = await tempDirectory();
    await fs.writeFile(path.join(directory, "ignore.txt"), "x");
    await fs.writeFile(path.join(directory, "broken.json"), "{oops");
    const diagnostics: CredentialProvenanceStoreDiagnostic[] = [];
    const store = createFileCredentialProvenanceStore({
      directory,
      report: (diagnostic) => diagnostics.push(diagnostic)
    });
    await expect(store.load()).rejects.toThrow(
      'Credential provenance file "broken.json" is incomplete'
    );
    expect(diagnostics[0].code).toBe("credential-provenance-corrupt");
    expect(diagnostics[0].message).toContain("broken.json");
  });

  it("reports an unreadable directory and record", async () => {
    const file = path.join(await tempDirectory(), "file");
    await fs.writeFile(file, "x");
    const diagnostics: CredentialProvenanceStoreDiagnostic[] = [];
    const store = createFileCredentialProvenanceStore({
      directory: file,
      report: (diagnostic) => diagnostics.push(diagnostic)
    });
    await expect(store.load()).rejects.toThrow(
      "Credential provenance could not be listed"
    );
    await expect(store.read("key")).rejects.toThrow("could not be read");
    expect(diagnostics.map((entry) => entry.code)).toEqual([
      "credential-provenance-unavailable",
      "credential-provenance-unavailable"
    ]);
  });

  it("cleans up the temporary file and rethrows a failed rename", async () => {
    const directory = await tempDirectory();
    const targetDirectory = path.join(directory, "records");
    await fs.mkdir(targetDirectory);
    const store = createFileCredentialProvenanceStore({
      directory: targetDirectory
    });
    const originalRename = fs.rename;
    Object.defineProperty(fs, "rename", {
      configurable: true,
      value: async () => {
        throw new Error("rename failed");
      }
    });
    try {
      await expect(store.write("key", { id: 1 })).rejects.toThrow(
        "rename failed"
      );
      expect(await fs.readdir(targetDirectory)).toEqual([]);
    } finally {
      Object.defineProperty(fs, "rename", {
        configurable: true,
        value: originalRename
      });
    }
  });
});
