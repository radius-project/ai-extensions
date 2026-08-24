import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface CredentialProvenanceStoreDiagnostic {
  code: "credential-provenance-corrupt" | "credential-provenance-unavailable";
  message: string;
}

export type CredentialProvenanceStoreReporter = (
  diagnostic: CredentialProvenanceStoreDiagnostic
) => void;

export interface CredentialProvenanceStore {
  load(): Promise<unknown[]>;
  read(key: string): Promise<unknown | null>;
  write(key: string, value: unknown): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
  withLock<T>(work: () => Promise<T>): Promise<T>;
}

function fileName(key: string): string {
  return `${createHash("sha256").update(key).digest("hex")}.json`;
}

export function createFileCredentialProvenanceStore({
  directory,
  report = () => {}
}: {
  directory: string;
  report?: CredentialProvenanceStoreReporter;
}): CredentialProvenanceStore {
  const lockDirectory = path.join(directory, ".lock");
  // While a holder works, refresh the lock directory's mtime on this cadence so
  // a long-but-live holder is never mistaken for a crashed one and stolen. It
  // must be comfortably shorter than the STALE_LOCK_MS steal threshold.
  const LOCK_HEARTBEAT_MS = 60_000;
  const STALE_LOCK_MS = 5 * 60_000;
  const readFile = async (filePath: string): Promise<unknown | null> => {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      report({
        code: "credential-provenance-unavailable",
        message: `Could not read credential provenance file "${path.basename(
          filePath
        )}": ${String(error)}`
      });
      throw new Error(
        `Credential provenance file "${path.basename(
          filePath
        )}" could not be read.`,
        {
          cause: error
        }
      );
    }
    try {
      return JSON.parse(raw);
    } catch (error) {
      report({
        code: "credential-provenance-corrupt",
        message: `Invalid credential provenance file "${path.basename(
          filePath
        )}" prevented a complete read; move or delete it to recover: ${String(
          error
        )}`
      });
      throw new Error(
        `Credential provenance file "${path.basename(
          filePath
        )}" is incomplete.`,
        { cause: error }
      );
    }
  };

  return {
    async load() {
      let names: string[];
      try {
        names = await fs.readdir(directory);
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return [];
        }
        report({
          code: "credential-provenance-unavailable",
          message: `Could not list credential provenance: ${String(error)}`
        });
        throw new Error("Credential provenance could not be listed.", {
          cause: error
        });
      }
      const values = await Promise.all(
        names
          .filter((name) => name.endsWith(".json"))
          .map((name) => readFile(path.join(directory, name)))
      );
      return values.filter((value) => value !== null);
    },
    read(key) {
      return readFile(path.join(directory, fileName(key)));
    },
    async write(key, value) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const target = path.join(directory, fileName(key));
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600
        });
        await fs.rename(temporary, target);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    },
    async remove(keys) {
      await Promise.all(
        keys.map((key) =>
          fs.rm(path.join(directory, fileName(key)), { force: true })
        )
      );
    },
    async withLock(work) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const startedAt = Date.now();
      const owner = `${process.pid}:${randomUUID()}`;
      const ownerFile = path.join(lockDirectory, "owner");
      while (true) {
        let acquired = false;
        try {
          await fs.mkdir(lockDirectory);
          acquired = true;
          await fs.writeFile(ownerFile, owner, {
            encoding: "utf8",
            mode: 0o600
          });
          break;
        } catch (error) {
          if (
            !error ||
            typeof error !== "object" ||
            !("code" in error) ||
            error.code !== "EEXIST"
          ) {
            if (acquired) {
              await fs.rm(lockDirectory, { recursive: true, force: true });
            }
            throw error;
          }
          const stat = await fs.stat(lockDirectory).catch(() => null);
          if (stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
            await fs.rm(lockDirectory, { recursive: true, force: true });
            continue;
          }
          if (Date.now() - startedAt > 2 * 60_000) {
            throw new Error(
              "Timed out waiting for credential provenance lock.",
              { cause: error }
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      // Keep the lock's mtime fresh while we hold it. A holder that legitimately
      // runs longer than STALE_LOCK_MS (setup wraps az calls and replication-lag
      // retries in this lock) would otherwise look crashed and have its lock
      // stolen, letting a second process mutate provenance concurrently. If this
      // process crashes the interval stops, the mtime goes stale, and the lock
      // is correctly reclaimed. `unref` so the timer never keeps the event loop
      // alive on its own.
      const heartbeat = setInterval(() => {
        const when = new Date();
        void fs.utimes(lockDirectory, when, when).catch(() => {});
      }, LOCK_HEARTBEAT_MS);
      (heartbeat as { unref?: () => void }).unref?.();
      try {
        return await work();
      } finally {
        clearInterval(heartbeat);
        const currentOwner = await fs
          .readFile(ownerFile, "utf8")
          .catch(() => "");
        if (currentOwner === owner) {
          await fs.rm(lockDirectory, { recursive: true, force: true });
        }
      }
    }
  };
}
