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
    expect(
      (await fs.readdir(path.dirname(filePath))).filter((name) =>
        name.endsWith(".tmp")
      )
    ).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "restricts the persisted file to its owner on POSIX systems",
    async () => {
      const filePath = await temporaryFile();
      const store = createFileOperationStore({ filePath });

      await store.save({
        schemaVersion: PERSISTED_OPERATIONS_VERSION,
        operations: []
      });

      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    }
  );

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

  it("keeps the envelope at version 1 while operation records move to version 2", () => {
    // The outer shape did not change, so a store written by issues #304 and
    // #305 stays readable. Only the per-record schema advanced.
    expect(PERSISTED_OPERATIONS_VERSION).toBe(1);
    expect(
      parseOperationsEnvelope({
        schemaVersion: 1,
        operations: [
          { operationId: "op_1", schemaVersion: 1 },
          { operationId: "op_2", schemaVersion: 2, control: { attempts: {} } }
        ]
      }).operations
    ).toHaveLength(2);
  });

  it("persists a command record through the atomic replacement", async () => {
    const filePath = await temporaryFile();
    const store = createFileOperationStore({ filePath });
    const envelope = {
      schemaVersion: PERSISTED_OPERATIONS_VERSION as 1,
      operations: [
        {
          operationId: "op_1",
          schemaVersion: 2,
          control: {
            stop: {
              requestedAt: "2026-01-01T00:00:00.000Z",
              acknowledgedAt: null,
              boundary: null
            },
            attempts: { setup: 2, verification: 1, cleanup: 0 },
            commands: [
              {
                kind: "retry_setup",
                commandId: "op_1:retry_setup:2:setup",
                attempt: 2,
                target: "setup",
                idempotencyKey: "idem:op_1:retry_setup:2:setup",
                state: "accepted",
                acceptedAt: "2026-01-01T00:00:00.000Z",
                completedAt: null,
                outcome: null
              }
            ],
            idempotency: { "idem:op_1:retry_setup:2:setup": "setup" },
            outcomes: []
          }
        }
      ]
    };

    await store.save(envelope);

    await expect(store.load()).resolves.toEqual(envelope);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
  });
});
