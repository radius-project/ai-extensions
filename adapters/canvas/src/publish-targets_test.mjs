import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { resolveRadiusArtifactPath, validateGhcrTargetForRepo } from "./publish-targets.mjs";

const WS = path.join(os.tmpdir(), "ws");
const RADIUS = path.join(WS, ".radius");

test("resolveRadiusArtifactPath confines relative paths under .radius/", () => {
    assert.equal(resolveRadiusArtifactPath(WS, "custom-types.yaml", null), path.join(RADIUS, "custom-types.yaml"));
    // A leading .radius/ is accepted and normalized (not doubled).
    assert.equal(resolveRadiusArtifactPath(WS, ".radius/custom-types.tgz", null), path.join(RADIUS, "custom-types.tgz"));
    assert.equal(resolveRadiusArtifactPath(WS, "sub/dir/x.bicep", null), path.join(RADIUS, "sub/dir/x.bicep"));
});

test("resolveRadiusArtifactPath uses the fallback when no value is given", () => {
    assert.equal(
        resolveRadiusArtifactPath(WS, "", ".radius/custom-types.yaml"),
        path.join(RADIUS, "custom-types.yaml"),
    );
    assert.equal(
        resolveRadiusArtifactPath(WS, "   ", "custom-types.tgz"),
        path.join(RADIUS, "custom-types.tgz"),
    );
});

test("resolveRadiusArtifactPath rejects absolute paths", () => {
    assert.throws(() => resolveRadiusArtifactPath(WS, "/etc/passwd", null), /not absolute/);
});

test("resolveRadiusArtifactPath rejects parent-directory traversal", () => {
    assert.throws(() => resolveRadiusArtifactPath(WS, "../../secret.tgz", null), /invalid path/);
    assert.throws(() => resolveRadiusArtifactPath(WS, ".radius/../secret", null), /invalid path/);
});

test("resolveRadiusArtifactPath requires a workspace and a path", () => {
    assert.throws(() => resolveRadiusArtifactPath("", "custom-types.yaml", null), /No repository workspace/);
    assert.throws(() => resolveRadiusArtifactPath(WS, "", null), /file path is required/);
});

test("validateGhcrTargetForRepo accepts an immutable target under the modeled repo", () => {
    assert.equal(validateGhcrTargetForRepo("br:ghcr.io/acme/app/recipe:1.0.0", "acme/app"), null);
    assert.equal(validateGhcrTargetForRepo("br:ghcr.io/acme/app:1.0.0", "acme/app"), null);
    // GHCR image paths are lowercase; a mixed-case repo still matches.
    assert.equal(validateGhcrTargetForRepo("br:ghcr.io/acme/app/recipe:1.0.0", "Acme/App"), null);
});

test("validateGhcrTargetForRepo rejects a cross-repository target", () => {
    assert.match(validateGhcrTargetForRepo("br:ghcr.io/evil/x:1.0.0", "acme/app"), /under the repository being modeled/);
    // A repo that is only a prefix of the target owner must not match.
    assert.match(validateGhcrTargetForRepo("br:ghcr.io/acme/app-evil:1.0.0", "acme/app"), /under the repository being modeled/);
});

test("validateGhcrTargetForRepo rejects non-ghcr, missing, and malformed tags", () => {
    assert.match(validateGhcrTargetForRepo("br:docker.io/acme/app:1", "acme/app"), /must be br:ghcr.io/);
    assert.match(validateGhcrTargetForRepo("br:ghcr.io/acme/app/recipe", "acme/app"), /must be br:ghcr.io/);
    assert.match(validateGhcrTargetForRepo("br:ghcr.io/acme/app:", "acme/app"), /must be br:ghcr.io/);
});

test("validateGhcrTargetForRepo rejects the mutable :latest tag", () => {
    assert.match(validateGhcrTargetForRepo("br:ghcr.io/acme/app/recipe:latest", "acme/app"), /immutable tag/);
    assert.match(validateGhcrTargetForRepo("br:ghcr.io/acme/app/recipe:LATEST", "acme/app"), /immutable tag/);
});

test("validateGhcrTargetForRepo requires a known workspace repo", () => {
    assert.match(validateGhcrTargetForRepo("br:ghcr.io/acme/app:1.0.0", ""), /Cannot determine the repository/);
});
