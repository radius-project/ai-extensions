import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import {
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

test("artifact fingerprint is stable for absent, invalid, and incomplete artifacts", () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), "rad-fingerprint-"));
  try {
    const baseline = radArtifactsFingerprint();
    assert.equal(radArtifactsFingerprint(dir), baseline);

    fs.writeFileSync(path.join(dir, "bicepconfig.json"), "{ invalid");
    assert.notEqual(radArtifactsFingerprint(dir), baseline);

    fs.writeFileSync(
      path.join(dir, "bicepconfig.json"),
      JSON.stringify({
        extensions: {
          missing: "./missing.tgz",
          invalid: "../outside.tgz",
          nonString: 42,
          oci: "oci:ghcr.io/acme/extension:v1"
        }
      })
    );
    const first = radArtifactsFingerprint(dir);
    assert.equal(first, radArtifactsFingerprint(dir));
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

test("returns null when repository identity is incomplete or config fetch fails", async () => {
  const failure = {
    getContent: async () => {
      throw "network unavailable";
    },
    getContentBytes: async () => null
  };
  const logs: string[] = [];

  assert.equal(
    await stageRemoteRadArtifacts(failure, "", "dev", ".radius/app.bicep"),
    null
  );
  assert.equal(
    await stageRemoteRadArtifacts(failure, "acme/app", "", ".radius/app.bicep"),
    null
  );
  assert.equal(
    await stageRemoteRadArtifacts(
      failure,
      "acme/app",
      "dev",
      ".radius/app.bicep",
      { log: (message) => logs.push(message) }
    ),
    null
  );
  assert.match(logs[0] || "", /network unavailable/);
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

test("stages nested artifacts for a root model and contains fetch failures", async () => {
  const configApi = "/repos/acme/app/contents/bicepconfig.json?ref=dev";
  const nestedApi = "/repos/acme/app/contents/nested/custom.tgz?ref=dev";
  const config = JSON.stringify({
    extensions: {
      nested: "./nested/custom.tgz",
      failed: "./failed.tgz",
      ignored: 1
    }
  });
  const logs: string[] = [];
  const github = {
    async getContent(apiPath: string) {
      return apiPath === configApi ? config : null;
    },
    async getContentBytes(apiPath: string) {
      if (apiPath.endsWith("/failed.tgz?ref=dev"))
        throw new Error("artifact fetch failed");
      return apiPath === nestedApi ? Buffer.from("nested") : null;
    }
  };
  const dir = await stageRemoteRadArtifacts(
    github,
    "acme/app",
    "dev",
    "app.bicep",
    { log: (message) => logs.push(message) }
  );
  try {
    assert.ok(dir);
    assert.equal(
      fs.readFileSync(path.join(dir, "nested", "custom.tgz"), "utf8"),
      "nested"
    );
    assert.ok(logs.some((message) => /artifact fetch failed/.test(message)));
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

test("radArtifactsDirForSelection accepts a computed local selection", async () => {
  const state = { workspacePath: path.resolve(path.sep, "tmp", "ws") };
  assert.deepEqual(
    await radArtifactsDirForSelection({
      isLocal: Boolean(state.workspacePath),
      state,
      github: mockGithub(),
      repo: "acme/app",
      branch: "dev",
      bicepRepoPath: ".radius/app.bicep"
    }),
    { dir: path.join(state.workspacePath, ".radius"), remote: false }
  );
});

test("radArtifactsDirForSelection accepts a computed remote selection", async () => {
  const github = mockGithub();
  const { dir, remote } = await radArtifactsDirForSelection({
    isLocal: Boolean(""),
    github,
    repo: "acme/app",
    branch: "dev",
    bicepRepoPath: ".radius/app.bicep"
  });
  try {
    assert.equal(remote, false);
    assert.equal(dir, "");
  } finally {
    cleanup(dir);
  }
});

test("radArtifactsDirForSelection rejects a local selection without state", async () => {
  await assert.rejects(
    radArtifactsDirForSelection({
      isLocal: Boolean("local"),
      github: mockGithub(),
      repo: "acme/app",
      branch: "dev",
      bicepRepoPath: ".radius/app.bicep"
    }),
    /requires canvas state/
  );
});
