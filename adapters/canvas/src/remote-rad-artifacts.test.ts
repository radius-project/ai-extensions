import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import {
  artifactSelectionForBranch,
  stageRemoteRadArtifacts,
  radArtifactsDirForSelection,
  radArtifactsFingerprint
} from "./remote-rad-artifacts.js";

const CONFIG_API = "/repos/acme/app/contents/.radius/bicepconfig.json?ref=dev";
const TGZ_API = "/repos/acme/app/contents/.radius/custom-types.tgz?ref=dev";

function mockGithub(
  texts: Record<string, string> = {},
  bytes: Record<string, Buffer | { tooLarge: true }> = {}
) {
  const calls: { getContent: string[]; getContentBytes: string[] } = {
    getContent: [],
    getContentBytes: []
  };
  return {
    calls,
    async getContent(apiPath: string) {
      calls.getContent.push(apiPath);
      return apiPath in texts ? texts[apiPath] : null;
    },
    async getContentBytes(apiPath: string) {
      calls.getContentBytes.push(apiPath);
      return apiPath in bytes ? bytes[apiPath] : null;
    }
  };
}

const CONFIG = JSON.stringify({
  experimentalFeaturesEnabled: { extensibility: true },
  extensions: {
    radius: "br:biceptypes.azurecr.io/radius:latest",
    customTypes: "./custom-types.tgz"
  }
});

function cleanup(dir: string | null) {
  if (dir) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

test("artifact fingerprint changes with config and local extension content", () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), "rad-fingerprint-"));
  try {
    fs.writeFileSync(path.join(dir, "bicepconfig.json"), CONFIG);
    fs.writeFileSync(path.join(dir, "custom-types.tgz"), "one");
    const first = radArtifactsFingerprint(dir);
    fs.writeFileSync(path.join(dir, "custom-types.tgz"), "two");
    const second = radArtifactsFingerprint(dir);
    assert.notEqual(first, second);

    fs.writeFileSync(
      path.join(dir, "bicepconfig.json"),
      JSON.stringify({
        experimentalFeaturesEnabled: { extensibility: true },
        extensions: {
          radius: "br:biceptypes.azurecr.io/radius:v2",
          customTypes: "./custom-types.tgz"
        }
      })
    );
    assert.notEqual(second, radArtifactsFingerprint(dir));
  } finally {
    cleanup(dir);
  }
});

test("stages bicepconfig.json and the referenced custom-types.tgz for a committed branch", async () => {
  const gh = mockGithub(
    { [CONFIG_API]: CONFIG },
    { [TGZ_API]: Buffer.from("TGZBYTES") }
  );
  const dir = await stageRemoteRadArtifacts(
    gh,
    "acme/app",
    "dev",
    ".radius/app.bicep"
  );
  try {
    assert.ok(dir);
    assert.equal(
      fs.readFileSync(path.join(dir, "bicepconfig.json"), "utf8"),
      CONFIG
    );
    // Binary bytes must survive verbatim (getContentBytes, not the UTF-8 getContent).
    assert.equal(
      fs.readFileSync(path.join(dir, "custom-types.tgz"), "utf8"),
      "TGZBYTES"
    );
    assert.deepEqual(gh.calls.getContentBytes, [TGZ_API]);
  } finally {
    cleanup(dir);
  }
});

test("returns null when the branch has no committed bicepconfig.json", async () => {
  const gh = mockGithub({}, {});
  assert.equal(
    await stageRemoteRadArtifacts(gh, "acme/app", "dev", ".radius/app.bicep"),
    null
  );
  assert.deepEqual(gh.calls.getContentBytes, []);
});

test("stages config but copies no artifact for OCI-only extensions", async () => {
  const config = JSON.stringify({
    extensions: { radius: "br:biceptypes.azurecr.io/radius:latest" }
  });
  const gh = mockGithub({ [CONFIG_API]: config }, {});
  const dir = await stageRemoteRadArtifacts(
    gh,
    "acme/app",
    "dev",
    ".radius/app.bicep"
  );
  try {
    assert.ok(dir);
    assert.equal(gh.calls.getContentBytes.length, 0);
    assert.equal(fs.existsSync(path.join(dir, "custom-types.tgz")), false);
  } finally {
    cleanup(dir);
  }
});

test("skips an artifact too large for the contents API and logs it", async () => {
  const gh = mockGithub(
    { [CONFIG_API]: CONFIG },
    { [TGZ_API]: { tooLarge: true } }
  );
  const logs: string[] = [];
  const dir = await stageRemoteRadArtifacts(
    gh,
    "acme/app",
    "dev",
    ".radius/app.bicep",
    { log: (m) => logs.push(m) }
  );
  try {
    assert.ok(dir);
    assert.equal(fs.existsSync(path.join(dir, "custom-types.tgz")), false);
    assert.ok(logs.some((m) => /exceeds the GitHub contents API/.test(m)));
  } finally {
    cleanup(dir);
  }
});

test("skips a missing artifact and logs it", async () => {
  const gh = mockGithub({ [CONFIG_API]: CONFIG }, {});
  const logs: string[] = [];
  const dir = await stageRemoteRadArtifacts(
    gh,
    "acme/app",
    "dev",
    ".radius/app.bicep",
    { log: (m) => logs.push(m) }
  );
  try {
    assert.ok(dir);
    assert.equal(fs.existsSync(path.join(dir, "custom-types.tgz")), false);
    assert.ok(logs.some((m) => /not found on dev/.test(m)));
  } finally {
    cleanup(dir);
  }
});

test("refuses a traversing local extension reference", async () => {
  const config = JSON.stringify({
    extensions: {
      radius: "br:biceptypes.azurecr.io/radius:latest",
      evil: "../../secret.tgz"
    }
  });
  const gh = mockGithub({ [CONFIG_API]: config }, {});
  const logs: string[] = [];
  const dir = await stageRemoteRadArtifacts(
    gh,
    "acme/app",
    "dev",
    ".radius/app.bicep",
    { log: (m) => logs.push(m) }
  );
  try {
    assert.ok(dir);
    assert.equal(gh.calls.getContentBytes.length, 0);
    assert.ok(logs.some((m) => /non-local extension artifact/.test(m)));
  } finally {
    cleanup(dir);
  }
});

test("returns null when the config is not valid JSON", async () => {
  const gh = mockGithub({ [CONFIG_API]: "{ not json" }, {});
  assert.equal(
    await stageRemoteRadArtifacts(gh, "acme/app", "dev", ".radius/app.bicep"),
    null
  );
});

test("radArtifactsDirForSelection stages a temp dir for a remote selection", async () => {
  const gh = mockGithub(
    { [CONFIG_API]: CONFIG },
    { [TGZ_API]: Buffer.from("X") }
  );
  const { dir, remote } = await radArtifactsDirForSelection({
    isLocal: false,
    github: gh,
    repo: "acme/app",
    branch: "dev",
    bicepRepoPath: ".radius/app.bicep"
  });
  try {
    assert.equal(remote, true);
    assert.ok(dir && fs.existsSync(path.join(dir, "custom-types.tgz")));
  } finally {
    cleanup(dir);
  }
});

test("radArtifactsDirForSelection uses the workspace dir for a local selection", async () => {
  const workspacePath = path.resolve(path.sep, "tmp", "ws");
  const { dir, remote } = await radArtifactsDirForSelection({
    isLocal: true,
    state: { workspacePath },
    bicepRepoPath: ".radius/app.bicep"
  });
  assert.equal(remote, false);
  assert.equal(dir, path.join(workspacePath, ".radius"));
});

test("artifactSelectionForBranch preserves a computed local selection as a discriminated case", () => {
  const state = { workspacePath: path.resolve(path.sep, "tmp", "ws") };
  assert.deepEqual(
    artifactSelectionForBranch({
      isLocal: Boolean(state.workspacePath),
      state,
      github: mockGithub(),
      repo: "acme/app",
      branch: "dev",
      bicepRepoPath: ".radius/app.bicep"
    }),
    {
      isLocal: true,
      state,
      bicepRepoPath: ".radius/app.bicep"
    }
  );
});

test("artifactSelectionForBranch preserves a computed remote selection as a discriminated case", () => {
  const github = mockGithub();
  assert.deepEqual(
    artifactSelectionForBranch({
      isLocal: Boolean(""),
      github,
      repo: "acme/app",
      branch: "dev",
      bicepRepoPath: ".radius/app.bicep"
    }),
    {
      isLocal: false,
      state: undefined,
      github,
      repo: "acme/app",
      branch: "dev",
      bicepRepoPath: ".radius/app.bicep",
      log: undefined
    }
  );
});

test("artifactSelectionForBranch rejects a local selection without state", () => {
  assert.throws(
    () =>
      artifactSelectionForBranch({
        isLocal: Boolean("local"),
        github: mockGithub(),
        repo: "acme/app",
        branch: "dev",
        bicepRepoPath: ".radius/app.bicep"
      }),
    /requires canvas state/
  );
});
