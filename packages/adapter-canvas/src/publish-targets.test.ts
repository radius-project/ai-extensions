import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  resolveExistingRadiusArtifact,
  validateGhcrTargetForRepo
} from "./publish-targets.js";

const validationError = (
  target: unknown,
  workspaceRepo: string | null | undefined
): string => validateGhcrTargetForRepo(target, workspaceRepo) ?? "";

const WS = path.join(os.tmpdir(), "ws");
const RADIUS = path.join(WS, ".radius");

test("standalone publication refuses managed staging paths, including aliases", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "managed-publication-"));
  try {
    const managed = path.join(ws, ".radius", ".staging-managed-fixture");
    fs.mkdirSync(managed, { recursive: true });
    fs.symlinkSync(managed, path.join(ws, ".radius", "alias"), "junction");
    for (const file of [
      ".staging-managed-fixture/example-recipe.bicep",
      "alias/example-recipe.bicep"
    ]) {
      assert.throws(
        () => resolveExistingRadiusArtifact(ws, file, null),
        /run that the canvas started cannot be published/
      );
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("resolveExistingRadiusArtifact confines relative paths under .radius/", () => {
  // The radius-app-plan skill publishes its Recipe as .radius/<name>-recipe.bicep.
  // A leading .radius/ is accepted and normalized (not doubled).
  assert.equal(
    resolveExistingRadiusArtifact(WS, ".radius/cache-recipe.bicep", null),
    path.join(RADIUS, "cache-recipe.bicep")
  );
  assert.equal(
    resolveExistingRadiusArtifact(WS, "sub/dir/x.bicep", null),
    path.join(RADIUS, "sub/dir/x.bicep")
  );
  assert.equal(
    resolveExistingRadiusArtifact(WS, "   ", "cache-recipe.bicep"),
    path.join(RADIUS, "cache-recipe.bicep")
  );
});

test("resolveExistingRadiusArtifact checks the nearest existing parent of a missing file", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-parent-"));
  try {
    fs.mkdirSync(path.join(ws, ".radius", "existing"), { recursive: true });
    assert.equal(
      resolveExistingRadiusArtifact(
        ws,
        "existing/new/cache-recipe.bicep",
        null
      ),
      path.join(
        fs.realpathSync(path.join(ws, ".radius", "existing")),
        "new",
        "cache-recipe.bicep"
      )
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("resolveExistingRadiusArtifact rejects absolute paths and traversal", () => {
  assert.throws(
    () => resolveExistingRadiusArtifact(WS, "/etc/passwd", null),
    /not absolute/
  );
  assert.throws(
    () => resolveExistingRadiusArtifact(WS, ".radius/../secret", null),
    /invalid path/
  );
});

test("resolveExistingRadiusArtifact requires a workspace and a path", () => {
  assert.throws(
    () => resolveExistingRadiusArtifact("", "cache-recipe.bicep", null),
    /No repository workspace/
  );
  assert.throws(
    () => resolveExistingRadiusArtifact(WS, "", null),
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
    validationError("br:ghcr.io/evil/x:1.0.0", "acme/app"),
    /under the repository being modeled/
  );
  // A repo that is only a prefix of the target owner must not match.
  assert.match(
    validationError("br:ghcr.io/acme/app-evil:1.0.0", "acme/app"),
    /under the repository being modeled/
  );
});

test("validateGhcrTargetForRepo rejects non-ghcr, missing, and malformed tags", () => {
  assert.match(
    validationError("br:docker.io/acme/app:1", "acme/app"),
    /must be br:ghcr.io/
  );
  assert.match(
    validationError("br:ghcr.io/acme/app/recipe", "acme/app"),
    /must be br:ghcr.io/
  );
  assert.match(
    validationError("br:ghcr.io/acme/app:", "acme/app"),
    /must be br:ghcr.io/
  );
});

test("validateGhcrTargetForRepo rejects the mutable :latest tag", () => {
  assert.match(
    validationError("br:ghcr.io/acme/app/recipe:latest", "acme/app"),
    /immutable tag/
  );
  assert.match(
    validationError("br:ghcr.io/acme/app/recipe:LATEST", "acme/app"),
    /immutable tag/
  );
});

test("validateGhcrTargetForRepo requires a known workspace repo", () => {
  assert.match(
    validationError("br:ghcr.io/acme/app:1.0.0", ""),
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
  "rejects a missing file reached through a symlinked directory that escapes .radius/",
  () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-sym-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    try {
      fs.mkdirSync(path.join(ws, ".radius"), { recursive: true });
      fs.symlinkSync(outside, path.join(ws, ".radius", "link"), "dir");
      // Lexically fine (no `..`), but `.radius/link` resolves outside the workspace.
      assert.throws(
        () => resolveExistingRadiusArtifact(ws, "link/evil.bicep", null),
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
  "allows a real file or subdirectory under .radius/",
  () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-sym-"));
    try {
      fs.mkdirSync(path.join(ws, ".radius", "sub"), { recursive: true });
      const p = resolveExistingRadiusArtifact(
        ws,
        "sub/cache-recipe.bicep",
        null
      );
      assert.ok(p.endsWith(path.join("sub", "cache-recipe.bicep")));
      fs.writeFileSync(path.join(ws, ".radius", "cache-recipe.bicep"), "");
      assert.equal(
        resolveExistingRadiusArtifact(ws, ".radius/cache-recipe.bicep", null),
        fs.realpathSync(path.join(ws, ".radius", "cache-recipe.bicep"))
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);
