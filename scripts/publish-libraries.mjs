import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { libraryReleasePlan } from "./library-release.mjs";
import { isMainModule } from "./module-entry.mjs";

const registry = "https://registry.npmjs.org/";

function command(args) {
  const result = spawnSync("npm", args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.error) throw result.error;
  return result;
}

export function publishLibrary(release, bytes, path, run = command) {
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const spec = `${release.name}@${release.version}`;
  const query = () =>
    run(["view", spec, "dist.integrity", "--json", "--registry", registry]);
  const existing = query();
  if (existing.status === 0) {
    assert.equal(
      JSON.parse(existing.stdout),
      integrity,
      `${spec} already exists with different bytes; publish a new version.`
    );
    return;
  }
  // Only an explicit registry 404 permits publication. Auth and network errors
  // must not be interpreted as an unpublished version.
  let failure;
  try {
    failure = JSON.parse(existing.stdout);
  } catch (cause) {
    throw new Error(`Cannot check ${spec}: ${existing.stderr}`, { cause });
  }
  assert.equal(
    failure?.error?.code,
    "E404",
    `Cannot check ${spec}: ${existing.stderr}`
  );
  const published = run([
    "publish",
    path,
    "--access",
    "public",
    "--provenance",
    "--ignore-scripts",
    "--registry",
    registry
  ]);
  assert.equal(
    published.status,
    0,
    `Cannot publish ${spec}: ${published.stderr}`
  );
  const verified = query();
  assert.equal(verified.status, 0, `Cannot verify ${spec}: ${verified.stderr}`);
  assert.equal(
    JSON.parse(verified.stdout),
    integrity,
    `Published ${spec} does not match the qualified tarball.`
  );
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const directory = process.argv[2];
  assert.ok(directory, "Supply the qualified candidate directory.");
  const plan = libraryReleasePlan();
  assert.deepEqual(
    JSON.parse(readFileSync(join(directory, "release-plan.json"), "utf8")),
    plan,
    "The qualified candidate does not match the checked-out release source."
  );
  for (const release of plan) {
    const path = join(directory, "packages", release.tarball);
    publishLibrary(release, readFileSync(path), path);
    console.log(`Verified ${release.name}@${release.version} on npm.`);
  }
}
