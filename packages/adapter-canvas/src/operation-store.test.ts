import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFileOperationStore,
  parseOperationsEnvelope,
  PERSISTED_OPERATIONS_VERSION
} from "./operation-store.js";

const directories: string[] = [];

async function temporaryFile(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "radius-operation-store-")
  );
  directories.push(directory);
  return path.join(directory, "nested", "operations.json");
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe("file operation store", () => {
  it("round-trips a versioned envelope through an atomic replacement", async () => {
    const filePath = await temporaryFile();
    const store = createFileOperationStore({ filePath });
    const envelope = {
      schemaVersion: PERSISTED_OPERATIONS_VERSION as 1,
      operations: [{ operationId: "op_1" }]
    };

    await store.save(envelope);

    await expect(store.load()).resolves.toEqual(envelope);
    const replacement = {
      schemaVersion: PERSISTED_OPERATIONS_VERSION as 1,
      operations: [{ operationId: "op_2" }]
    };
    await store.save(replacement);
    await expect(store.load()).resolves.toEqual(replacement);
    if (process.platform !== "win32") {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    }
    expect(
      (await fs.readdir(path.dirname(filePath))).filter((name) =>
        name.endsWith(".tmp")
      )
    ).toEqual([]);
  });

  it("returns no records when the file does not exist", async () => {
    const store = createFileOperationStore({
      filePath: await temporaryFile()
    });
    await expect(store.load()).resolves.toBeNull();
  });

  it("fails closed and reports corrupt JSON", async () => {
    const filePath = await temporaryFile();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{not-json", "utf8");
    const report = vi.fn();
    const store = createFileOperationStore({ filePath, report });

    await expect(store.load()).resolves.toBeNull();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ code: "operation-store-corrupt" })
    );
  });

  it("rejects unknown schema versions", () => {
    expect(() =>
      parseOperationsEnvelope({ schemaVersion: 2, operations: [] })
    ).toThrow(/schema/i);
  });
});
