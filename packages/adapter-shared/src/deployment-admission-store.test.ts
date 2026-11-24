import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeploymentAdmissionStore } from "./deployment-admission-store.js";

const key = { host: "github.com", repositoryId: 42, environment: "prod" };
const record = {
  correlation: "dep-fixture",
  account: "fixture-user",
  application: "fixture-app",
  environment: "prod",
  deploymentId: "7",
  approvedRunId: 17,
  startedAt: 123
};

describe("host-local deployment admission", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "radius-deployment-admission-"));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("admits only one owner and retains the record across store reconstruction", async () => {
    const alias = { ...key, host: "GITHUB.COM", environment: "Prod" };
    const first = createDeploymentAdmissionStore(root);
    const second = createDeploymentAdmissionStore(root);
    expect(await first.read(key)).toBeNull();
    const results = await Promise.all([
      first.acquire(key, record),
      second.acquire(alias, record)
    ]);
    const winners = results.filter((result) => result !== null);
    expect(winners).toHaveLength(1);
    expect(await createDeploymentAdmissionStore(root).read(alias)).toEqual(
      winners[0]
    );
    expect(
      await first.acquire({ ...key, repositoryId: 43 }, record)
    ).not.toBeNull();
  });

  it("does not let a stale owner release a replacement", async () => {
    const store = createDeploymentAdmissionStore(root);
    const first = await store.acquire(key, record);
    if (!first) throw new Error("Fixture could not acquire admission.");
    expect(await store.release(key, first.nonce)).toBe(true);
    const replacement = await store.acquire(key, record);
    expect(replacement).not.toBeNull();
    expect(await store.release(key, first.nonce)).toBe(false);
    expect(await store.read(key)).toEqual(replacement);
  });

  it("keeps the winning admission after both competing processes exit", async () => {
    const source = new URL("./deployment-admission-store.ts", import.meta.url)
      .href;
    const run = promisify(execFile);
    const acquire = () =>
      run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const [source, root, key, record] = process.argv.slice(1);
          const {createDeploymentAdmissionStore} = await import(source);
          const lease = await createDeploymentAdmissionStore(root).acquire(
            JSON.parse(key), JSON.parse(record)
          );
          process.stdout.write(JSON.stringify(lease));`,
          source,
          root,
          JSON.stringify(key),
          JSON.stringify(record)
        ],
        { windowsHide: true }
      );
    const results = await Promise.all([acquire(), acquire()]);
    const store = createDeploymentAdmissionStore(root);
    const remaining = await store.read(key);
    expect(remaining).toMatchObject({ record });
    expect(results.map(({ stdout }) => stdout)).toEqual(
      expect.arrayContaining(["null", JSON.stringify(remaining)])
    );
    expect(await store.acquire(key, record)).toBeNull();
  });

  it("keeps a corrupt or incomplete admission blocked", async () => {
    const store = createDeploymentAdmissionStore(root);
    const lease = await store.acquire(key, record);
    if (!lease) throw new Error("Fixture could not acquire admission.");
    const [directory] = await readdir(root);
    if (!directory) throw new Error("Fixture admission directory is missing.");
    const file = join(root, directory, lease.nonce);
    await writeFile(file, '{"version":1,"record":');
    await expect(store.read(key)).rejects.toThrow();
    expect(await store.acquire(key, record)).toBeNull();
    await writeFile(file, JSON.stringify({ version: 2, record }));
    await expect(store.read(key)).rejects.toThrow("remains blocked");
    expect(await store.acquire(key, record)).toBeNull();
    await unlink(file);
    await expect(store.read(key)).resolves.toBeNull();
    expect(await store.acquire(key, record)).not.toBeNull();
  });

  it("reports unavailable storage rather than treating it as an empty store", async () => {
    const unusableRoot = join(root, "regular-file");
    await writeFile(unusableRoot, "");
    const store = createDeploymentAdmissionStore(unusableRoot);
    await expect(store.acquire(key, record)).rejects.toThrow();
    await expect(store.read(key)).rejects.toThrow();
  });
});
