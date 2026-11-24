import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  stat,
  unlink
} from "node:fs/promises";
import { join } from "node:path";

export interface DeploymentAdmissionKey {
  host: string;
  repositoryId: number;
  environment: string;
}

export interface DeploymentAdmissionRecord {
  correlation: string;
  account: string;
  application: string;
  environment: string;
  workflow?: string;
  deploymentId?: string;
  approvedRunId?: number;
  startedAt: number;
}

export interface StoredDeploymentAdmission {
  nonce: string;
  record: DeploymentAdmissionRecord;
}

const noncePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isRecord(value: unknown): value is DeploymentAdmissionRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "correlation" in value &&
    typeof value.correlation === "string" &&
    /^dep-[a-zA-Z0-9-]{1,64}$/.test(value.correlation) &&
    "account" in value &&
    typeof value.account === "string" &&
    value.account.length > 0 &&
    "application" in value &&
    typeof value.application === "string" &&
    value.application.length > 0 &&
    "environment" in value &&
    typeof value.environment === "string" &&
    value.environment.length > 0 &&
    (!("workflow" in value) ||
      (typeof value.workflow === "string" &&
        /^(?:run-rad-commands|delete-application)\.yml$/.test(
          value.workflow
        ))) &&
    ("deploymentId" in value || "approvedRunId" in value ?
      "deploymentId" in value &&
      typeof value.deploymentId === "string" &&
      /^[1-9]\d*$/.test(value.deploymentId) &&
      "approvedRunId" in value &&
      typeof value.approvedRunId === "number" &&
      Number.isSafeInteger(value.approvedRunId) &&
      value.approvedRunId > 0
    : "workflow" in value) &&
    "startedAt" in value &&
    typeof value.startedAt === "number" &&
    Number.isSafeInteger(value.startedAt) &&
    value.startedAt > 0
  );
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export function createDeploymentAdmissionStore(root: string) {
  function directory(key: DeploymentAdmissionKey): string {
    if (
      !key.host.trim() ||
      !Number.isSafeInteger(key.repositoryId) ||
      key.repositoryId < 1 ||
      !key.environment.trim()
    )
      throw new Error("Deployment admission requires a verified target.");
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          key.host.toLowerCase(),
          key.repositoryId,
          key.environment.toLowerCase()
        ])
      )
      .digest("hex");
    return join(root, hash);
  }

  async function removeEmpty(path: string): Promise<void> {
    try {
      await rmdir(path);
    } catch (error) {
      if (
        hasCode(error, "ENOENT") ||
        hasCode(error, "ENOTEMPTY") ||
        hasCode(error, "EEXIST")
      )
        return;
      throw error;
    }
  }

  return {
    async acquire(
      key: DeploymentAdmissionKey,
      record: DeploymentAdmissionRecord
    ): Promise<StoredDeploymentAdmission | null> {
      if (
        !isRecord(record) ||
        record.environment.toLowerCase() !== key.environment.toLowerCase()
      )
        throw new Error("Invalid deployment admission.");
      const path = directory(key);
      const nonce = randomUUID();
      const staging = join(root, `.stage-${nonce}`);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await mkdir(staging, { mode: 0o700 });
      let published = false;
      try {
        const file = await open(join(staging, nonce), "wx", 0o600);
        try {
          await file.writeFile(
            JSON.stringify({
              version: 1,
              record: {
                correlation: record.correlation,
                account: record.account,
                application: record.application,
                environment: record.environment,
                workflow: record.workflow,
                deploymentId: record.deploymentId,
                approvedRunId: record.approvedRunId,
                startedAt: record.startedAt
              }
            })
          );
          await file.sync();
        } finally {
          await file.close();
        }
        // The visible directory is installed with a complete record. An
        // empty visible directory can only remain from a nonce removal.
        await removeEmpty(path);
        try {
          await rename(staging, path);
          published = true;
        } catch (error) {
          if (
            hasCode(error, "ENOTEMPTY") ||
            hasCode(error, "EEXIST") ||
            (hasCode(error, "EPERM") &&
              (
                await stat(path).catch((cause: unknown) => {
                  if (hasCode(cause, "ENOENT")) return null;
                  throw cause;
                })
              )?.isDirectory())
          )
            return null;
          throw error;
        }
        return { nonce, record };
      } finally {
        if (!published) {
          await unlink(join(staging, nonce)).catch((error: unknown) => {
            if (!hasCode(error, "ENOENT")) throw error;
          });
          await removeEmpty(staging);
        }
      }
    },
    async read(
      key: DeploymentAdmissionKey
    ): Promise<StoredDeploymentAdmission | null> {
      const path = directory(key);
      const entries = await readdir(path).catch((error: unknown) => {
        if (hasCode(error, "ENOENT")) return null;
        throw error;
      });
      if (!entries) {
        const info = await stat(root).catch((error: unknown) => {
          if (hasCode(error, "ENOENT")) return null;
          throw error;
        });
        if (info && !info.isDirectory())
          throw new Error("Deployment admission storage is not a directory.");
        return null;
      }
      if (entries.length === 0) return null;
      const [nonce] = entries;
      if (entries.length !== 1 || !nonce || !noncePattern.test(nonce))
        throw new Error(
          "Deployment admission is incomplete; it remains blocked."
        );
      const value: unknown = JSON.parse(
        await readFile(join(path, nonce), "utf8")
      );
      if (
        typeof value !== "object" ||
        value === null ||
        !("version" in value) ||
        value.version !== 1 ||
        !("record" in value) ||
        !isRecord(value.record) ||
        value.record.environment.toLowerCase() !== key.environment.toLowerCase()
      )
        throw new Error("Deployment admission is invalid; it remains blocked.");
      return { nonce, record: value.record };
    },
    async release(
      key: DeploymentAdmissionKey,
      nonce: string
    ): Promise<boolean> {
      if (!noncePattern.test(nonce))
        throw new Error("Invalid admission nonce.");
      const path = directory(key);
      try {
        await unlink(join(path, nonce));
      } catch (error) {
        if (hasCode(error, "ENOENT")) return false;
        throw error;
      }
      // Only the caller that unlinked this nonce can remove the directory.
      await removeEmpty(path);
      return true;
    }
  };
}
