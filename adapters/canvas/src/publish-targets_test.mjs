import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  resolveExistingRadiusArtifact,
  resolveRadiusArtifactTarget,
  validateGhcrTargetForRepo
} from "./publish-targets.mjs";

const WS = path.join(os.tmpdir(), "ws");
const RADIUS = path.join(WS, ".radius");

test("resolveRadiusArtifactTarget confines relative paths under .radius/", () => {
  assert.equal(
    resolveRadiusArtifactTarget(WS, "custom-types.yaml", null),
    path.join(RADIUS, "custom-types.yaml")
  );
  // A leading .radius/ is accepted and normalized (not doubled).
  assert.equal(
    resolveRadiusArtifactTarget(WS, ".radius/custom-types.tgz", null),
    path.join(RADIUS, "custom-types.tgz")
  );
  assert.equal(
    resolveRadiusArtifactTarget(WS, "sub/dir/x.bicep", null),
    path.join(RADIUS, "sub/dir/x.bicep")
  );
});

test("resolveRadiusArtifactTarget uses the fallback when no value is given", () => {
  assert.equal(
    resolveRadiusArtifactTarget(WS, "", ".radius/custom-types.yaml"),
    path.join(RADIUS, "custom-types.yaml")
  );
  assert.equal(
    resolveRadiusArtifactTarget(WS, "   ", "custom-types.tgz"),
    path.join(RADIUS, "custom-types.tgz")
  );
});

test("radius artifact resolvers reject absolute paths", () => {
  assert.throws(
    () => resolveRadiusArtifactTarget(WS, "/etc/passwd", null),
    /not absolute/
  );
  assert.throws(
    () => resolveExistingRadiusArtifact(WS, "/etc/passwd", null),
    /not absolute/
  );
});

test("radius artifact resolvers reject parent-directory traversal", () => {
  assert.throws(
    () => resolveRadiusArtifactTarget(WS, "../../secret.tgz", null),
    /invalid path/
  );
  assert.throws(
    () => resolveExistingRadiusArtifact(WS, ".radius/../secret", null),
    /invalid path/
  );
});

test("radius artifact resolvers require a workspace and a path", () => {
  assert.throws(
    () => resolveRadiusArtifactTarget("", "custom-types.yaml", null),
    /No repository workspace/
  );
  assert.throws(
    () => resolveRadiusArtifactTarget(WS, "", null),
    /file path is required/
  );
});

test("validateGhcrTargetForRepo accepts an immutable target under the modeled repo", () => {
  assert.equal(
    validateGhcrTargetForRepo("br:ghcr.io/acme/app/recipe:1.0.0", "acme/app"),
    null
  );
  assert.equal(
    validateGhcrTargetForRepo("br:ghcr.io/acme/app:1.0.0", "acme/app"),
    null
  );
  // GHCR image paths are lowercase; a mixed-case repo still matches.
  assert.equal(
    validateGhcrTargetForRepo("br:ghcr.io/acme/app/recipe:1.0.0", "Acme/App"),
    null
  );
});

test("validateGhcrTargetForRepo rejects a cross-repository target", () => {
  assert.match(
    validateGhcrTargetForRepo("br:ghcr.io/evil/x:1.0.0", "acme/app"),
    /under the repository being modeled/
  );
  // A repo that is only a prefix of the target owner must not match.
  assert.match(
    validateGhcrTargetForRepo("br:ghcr.io/acme/app-evil:1.0.0", "acme/app"),
    /under the repository being modeled/
  );
});

test("validateGhcrTargetForRepo rejects non-ghcr, missing, and malformed tags", () => {
  assert.match(
    validateGhcrTargetForRepo("br:docker.io/acme/app:1", "acme/app"),
    /must be br:ghcr.io/
  );
  assert.match(
    validateGhcrTargetForRepo("br:ghcr.io/acme/app/recipe", "acme/app"),
    /must be br:ghcr.io/
  );
  assert.match(
    validateGhcrTargetForRepo("br:ghcr.io/acme/app:", "acme/app"),
    /must be br:ghcr.io/
  );
});

test("validateGhcrTargetForRepo rejects the mutable :latest tag", () => {
  assert.match(
    validateGhcrTargetForRepo("br:ghcr.io/acme/app/recipe:latest", "acme/app"),
    /immutable tag/
  );
  assert.match(
    validateGhcrTargetForRepo("br:ghcr.io/acme/app/recipe:LATEST", "acme/app"),
    /immutable tag/
  );
});

test("validateGhcrTargetForRepo requires a known workspace repo", () => {
  assert.match(
    validateGhcrTargetForRepo("br:ghcr.io/acme/app:1.0.0", ""),
    /Cannot determine the repository/
  );
});

// Symlink-escape confinement. Creating symlinks can require privileges on some
// platforms (notably Windows), so detect capability and skip if unavailable
// rather than failing.
function symlinkCapable() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symcap-"));
  try {
    fs.symlinkSync(os.tmpdir(), path.join(dir, "l"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}
const SYMLINK_OK = symlinkCapable();

test.skipIf(!SYMLINK_OK)(
  "rejects a target reached through a symlinked directory that escapes .radius/",
  () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-sym-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    try {
      fs.mkdirSync(path.join(ws, ".radius"), { recursive: true });
      fs.symlinkSync(outside, path.join(ws, ".radius", "link"), "dir");
      // Lexically fine (no `..`), but `.radius/link` resolves outside the workspace.
      assert.throws(
        () => resolveRadiusArtifactTarget(ws, "link/evil.tgz", null),
        /via a symlink/
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }
);

test.skipIf(!SYMLINK_OK)(
  "rejects an existing source reached through a symlink out of .radius/",
  () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-sym-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    try {
      fs.mkdirSync(path.join(ws, ".radius"), { recursive: true });
      fs.writeFileSync(path.join(outside, "secret.bicep"), "secret");
      fs.symlinkSync(outside, path.join(ws, ".radius", "link"), "dir");
      assert.throws(
        () => resolveExistingRadiusArtifact(ws, "link/secret.bicep", null),
        /via a symlink/
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }
);

test.skipIf(!SYMLINK_OK)(
  "rejects a --force target that is itself a symlink pointing outside .radius/",
  () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-sym-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    try {
      fs.mkdirSync(path.join(ws, ".radius"), { recursive: true });
      fs.writeFileSync(path.join(outside, "target.tgz"), "");
      fs.symlinkSync(
        path.join(outside, "target.tgz"),
        path.join(ws, ".radius", "custom-types.tgz"),
        "file"
      );
      assert.throws(
        () => resolveRadiusArtifactTarget(ws, "custom-types.tgz", null),
        /via a symlink/
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }
);

test.skipIf(!SYMLINK_OK)("allows a real subdirectory under .radius/", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-sym-"));
  try {
    fs.mkdirSync(path.join(ws, ".radius", "sub"), { recursive: true });
    const p = resolveRadiusArtifactTarget(ws, "sub/custom-types.tgz", null);
    assert.ok(p.endsWith(path.join("sub", "custom-types.tgz")));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
