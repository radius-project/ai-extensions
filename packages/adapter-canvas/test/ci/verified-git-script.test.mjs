import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPTS = ["plugins.mjs", "verified-git.mjs"].map((name) => [
  name,
  fileURLToPath(new URL(`../../../../scripts/${name}`, import.meta.url))
]);
const TARGET = "a".repeat(40);
const COMMIT = "b".repeat(40);
const TREE = "c".repeat(40);
const TAG = "d".repeat(40);
const SOURCE_TAG = "e".repeat(40);
const SOURCE = "f".repeat(40);
const PACKAGE_BLOB = "1".repeat(40);
const MARKETPLACE_BLOB = "2".repeat(40);
const EXTENSION_BLOB = "3".repeat(40);
// File modes and symlinks are not reproducible on Windows.
const WINDOWS = process.platform === "win32";

const servers = [];
const roots = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise((resolve) => server.close(resolve));
  }
  while (roots.length > 0) {
    rmSync(roots.pop(), { recursive: true, force: true });
  }
});

/**
 * A stand-in for the GitHub REST API that records every request, so tests can
 * assert on exactly what the script sends as well as how it reacts.
 */
async function api({
  verified = true,
  // Separate from `verified` so a scenario can sign the tag object but not the
  // commit it targets.
  commitVerified = verified,
  parents = [],
  refs = [],
  broken,
  tagObject
} = {}) {
  const calls = [];
  const existing = new Set(refs);
  let blobs = 0;

  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const path = request.url.replace("/repos/owner/repo", "");
      const route = `${request.method} ${path}`;
      calls.push({
        route,
        authorization: request.headers.authorization,
        body: raw === "" ? undefined : JSON.parse(raw)
      });

      const send = (status, body) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };

      if (broken?.route === route) {
        return send(broken.status, broken.body);
      }
      if (route === "POST /git/blobs") {
        return send(201, { sha: (++blobs).toString(16).padStart(40, "e") });
      }
      if (route === "POST /git/trees") return send(201, { sha: TREE });
      if (route === "POST /git/commits") {
        return send(201, {
          sha: COMMIT,
          parents,
          verification: { verified, reason: verified ? "valid" : "unsigned" }
        });
      }
      if (request.method === "GET" && path.startsWith("/git/commits/")) {
        return send(200, {
          sha: path.slice("/git/commits/".length),
          verification: {
            verified: commitVerified,
            reason: commitVerified ? "valid" : "unsigned"
          }
        });
      }
      if (route === "POST /git/tags") {
        return send(201, {
          sha: TAG,
          verification: { verified, reason: verified ? "valid" : "unsigned" }
        });
      }
      if (request.method === "GET" && path.startsWith("/git/ref/")) {
        const name = `refs/${path.slice("/git/ref/".length)}`;
        if (!existing.has(name)) return send(404, { message: "Not Found" });
        return send(200, {
          ref: name,
          ...(tagObject ?
            {
              object: {
                type: tagObject.type,
                sha: tagObject.type === "commit" ? tagObject.target : TAG
              }
            }
          : {})
        });
      }
      if (request.method === "GET" && path.startsWith("/git/tags/")) {
        return send(200, {
          sha: TAG,
          object: { type: "commit", sha: tagObject?.target },
          verification: { verified, reason: verified ? "valid" : "unsigned" }
        });
      }
      if (route === "POST /git/refs") return send(201, { ref: "created" });
      if (request.method === "PATCH" && path.startsWith("/git/refs/")) {
        return send(200, { ref: "updated" });
      }
      return send(500, { message: `unexpected ${route}` });
    });
  });

  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}

async function completionApi({
  artifactBranch = "releases/radius/v1.2.0",
  artifactTarget = COMMIT,
  sourceTarget = SOURCE,
  commitVerified = true,
  parents = [],
  commitSource = SOURCE,
  packageSource = commitSource,
  includePackageSource = true,
  commitVersion,
  packageVersion = "1.2.0",
  catalogVersion = "1.2.0",
  catalogRef,
  catalogPath = "plugins/radius/dist",
  includeRootExtension = true,
  includeBundledExtension = true,
  rootExtensionBlob = EXTENSION_BLOB,
  bundledExtensionBlob = rootExtensionBlob,
  releaseDraft = false,
  releaseAssets = [
    "radius-plugin.tar.gz",
    "radius-plugin.spdx.json",
    "radius-awesome-copilot.zip"
  ]
} = {}) {
  const calls = [];
  const publishedVersion = commitVersion ?? packageVersion;
  const publishedRef = catalogRef ?? artifactBranch;
  const jsonBlob = (value) => ({
    encoding: "base64",
    content: Buffer.from(`${JSON.stringify(value)}\n`).toString("base64")
  });
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const path = decodeURIComponent(
        request.url.replace("/repos/owner/repo", "")
      );
      const route = `${request.method} ${path}`;
      calls.push(route);
      const send = (status, body) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };

      const refs = {
        [`/git/ref/heads/${artifactBranch}`]: {
          type: "commit",
          sha: COMMIT
        },
        "/git/ref/tags/radius/v1.2.0": {
          type: "commit",
          sha: artifactTarget
        },
        "/git/ref/tags/radius@1.2.0": {
          type: "commit",
          sha: sourceTarget
        }
      };
      if (request.method === "GET" && refs[path]) {
        return send(200, {
          ref: path.slice("/git/ref/".length),
          object: refs[path]
        });
      }
      if (route === `GET /git/tags/${TAG}`) {
        return send(200, {
          object: { type: "commit", sha: artifactTarget },
          verification: { verified: true, reason: "valid" }
        });
      }
      if (route === `GET /git/tags/${SOURCE_TAG}`) {
        return send(200, {
          object: { type: "commit", sha: sourceTarget },
          verification: { verified: true, reason: "valid" }
        });
      }
      if (route === `GET /git/commits/${COMMIT}`) {
        return send(200, {
          message: `chore(release): radius@${publishedVersion} for ${commitSource}`,
          tree: { sha: TREE },
          parents,
          verification: {
            verified: commitVerified,
            reason: commitVerified ? "valid" : "unsigned"
          }
        });
      }
      if (route === `GET /git/commits/${SOURCE}`) {
        return send(200, {
          sha: SOURCE,
          verification: { verified: true, reason: "valid" }
        });
      }
      if (route === `GET /git/trees/${TREE}?recursive=1`) {
        return send(200, {
          truncated: false,
          tree: [
            {
              path: ".github/plugin/marketplace.json",
              mode: "100644",
              type: "blob",
              sha: MARKETPLACE_BLOB
            },
            {
              path: "plugins/radius/dist/package.json",
              mode: "100644",
              type: "blob",
              sha: PACKAGE_BLOB
            },
            {
              path: "plugins/radius/dist/extension.mjs",
              mode: "100644",
              type: "blob",
              sha: "3".repeat(40)
            },
            ...(includeRootExtension ?
              [
                {
                  path: ".github/extension/actions/example/action.yml",
                  mode: "100644",
                  type: "blob",
                  sha: rootExtensionBlob
                }
              ]
            : []),
            ...(includeBundledExtension ?
              [
                {
                  path: "plugins/radius/dist/workflows/actions/example/action.yml",
                  mode: "100644",
                  type: "blob",
                  sha: bundledExtensionBlob
                }
              ]
            : [])
          ]
        });
      }
      if (route === `GET /git/blobs/${PACKAGE_BLOB}`) {
        return send(
          200,
          jsonBlob({
            name: "radius",
            version: packageVersion,
            ...(includePackageSource ? { radiusSourceRef: packageSource } : {})
          })
        );
      }
      if (route === `GET /git/blobs/${MARKETPLACE_BLOB}`) {
        return send(
          200,
          jsonBlob({
            plugins: [
              {
                name: "radius",
                version: catalogVersion,
                source: { ref: publishedRef, path: catalogPath }
              }
            ]
          })
        );
      }
      if (route === "GET /releases/tags/radius@1.2.0") {
        return send(200, {
          draft: releaseDraft,
          assets: releaseAssets.map((name) => ({ name }))
        });
      }
      return send(500, { message: `unexpected ${route}` });
    });
  });

  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "radius-verified-git-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  for (const [name, source] of SCRIPTS) {
    copyFileSync(source, join(root, "scripts", name));
  }
  mkdirSync(join(root, "dist", "skills"), { recursive: true });
  writeFileSync(join(root, "dist", "extension.mjs"), "export {};\n");
  writeFileSync(join(root, "dist", "skills", "SKILL.md"), "# Skill\n");
  writeFileSync(join(root, "catalog.json"), '{"plugins":[]}\n');
  mkdirSync(join(root, "plugins", "radius"), { recursive: true });
  writeFileSync(
    join(root, "plugins", "radius", "package.json"),
    '{"name":"radius","version":"1.2.0","scripts":{"test:artifact":"echo tested"}}\n'
  );
  writeFileSync(
    join(root, "plugins", "radius", "plugin.json"),
    '{"name":"radius","version":"1.2.0"}\n'
  );
  writeFileSync(join(root, "plugins", "radius", "README.md"), "Radius\n");
  return root;
}

// The fake API shares this process's event loop, so the child must be awaited
// asynchronously; spawnSync would deadlock against it.
function run(root, url, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(root, "scripts", "verified-git.mjs"), ...args],
      {
        cwd: root,
        env: {
          ...process.env,
          GITHUB_API_URL: url,
          GITHUB_REPOSITORY: "owner/repo",
          GITHUB_TOKEN: "app-installation-token",
          ...env
        }
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) =>
      resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() })
    );
  });
}

function commitArgs(paths = ["dist", "catalog.json"]) {
  return [
    "commit",
    "--message",
    "chore(release): publish",
    ...paths.flatMap((path) => ["--path", path])
  ];
}

function tagArgs(name, ...rest) {
  return ["tag", "--name", name, "--target", TARGET, ...rest];
}

describe("scripts/verified-git.mjs", () => {
  it("writes the given paths as a signed, parentless root commit", async () => {
    const root = repository();
    const { url, calls } = await api();

    const result = await run(root, url, commitArgs());

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ commit: COMMIT, tree: TREE });

    expect(calls.find((call) => call.route === "POST /git/trees").body).toEqual(
      {
        tree: [
          {
            path: "catalog.json",
            mode: "100644",
            type: "blob",
            sha: expect.any(String)
          },
          {
            path: "dist/extension.mjs",
            mode: "100644",
            type: "blob",
            sha: expect.any(String)
          },
          {
            path: "dist/skills/SKILL.md",
            mode: "100644",
            type: "blob",
            sha: expect.any(String)
          }
        ]
      }
    );

    // GitHub only signs for the app when none of author, committer or
    // signature is supplied, and an empty parents list makes it a root commit.
    const commit = calls.find((call) => call.route === "POST /git/commits");
    expect(commit.body).toEqual({
      message: "chore(release): publish",
      tree: TREE,
      parents: []
    });
    expect(commit.authorization).toBe("Bearer app-installation-token");
    // Creating a commit must not move anything on its own.
    expect(calls.map((call) => call.route)).not.toContain("POST /git/refs");
  });

  it("uploads each file as a base64 blob", async () => {
    const root = repository();
    const { url, calls } = await api();

    expect((await run(root, url, commitArgs(["catalog.json"]))).status).toBe(0);

    const blobs = calls.filter((call) => call.route === "POST /git/blobs");
    expect(blobs).toHaveLength(1);
    expect(blobs[0].body.encoding).toBe("base64");
    expect(Buffer.from(blobs[0].body.content, "base64").toString()).toBe(
      '{"plugins":[]}\n'
    );
  });

  it.skipIf(WINDOWS)("preserves the executable bit", async () => {
    const root = repository();
    chmodSync(join(root, "dist", "extension.mjs"), 0o755);
    const { url, calls } = await api();

    const result = await run(root, url, commitArgs(["dist/extension.mjs"]));

    expect(result.status).toBe(0);
    expect(
      calls.find((call) => call.route === "POST /git/trees").body.tree
    ).toEqual([
      {
        path: "dist/extension.mjs",
        mode: "100755",
        type: "blob",
        sha: expect.any(String)
      }
    ]);
  });

  it("refuses to publish a commit GitHub did not sign", async () => {
    const root = repository();
    const { url, calls } = await api({ verified: false });

    const result = await run(root, url, commitArgs());

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GitHub did not sign the commit");
    expect(result.stderr).toContain("unsigned");
    expect(result.stdout).toBe("");
    expect(calls.map((call) => call.route)).not.toContain("POST /git/refs");
  });

  it("refuses a commit GitHub gave a parent", async () => {
    const root = repository();
    const { url } = await api({ parents: [{ sha: TARGET }] });

    const result = await run(root, url, commitArgs());

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not a root commit");
  });

  it.skipIf(WINDOWS)("refuses to publish a symlink", async () => {
    const root = repository();
    symlinkSync(join(root, "catalog.json"), join(root, "dist", "link.json"));
    const { url } = await api();

    const result = await run(root, url, commitArgs());

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing to publish a symlink");
    expect(result.stderr).toContain("dist/link.json");
  });

  it("refuses a file reached through an ancestor symlink outside the repo", async () => {
    const root = repository();
    const outside = mkdtempSync(join(tmpdir(), "radius-outside-repo-"));
    roots.push(outside);
    writeFileSync(join(outside, "secret.txt"), "outside\n");
    symlinkSync(
      outside,
      join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir"
    );
    const { url } = await api();

    const result = await run(root, url, commitArgs(["linked/secret.txt"]));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("resolves outside the repository");
  });

  it.each([
    ["..", "escapes the repository"],
    ["../elsewhere", "escapes the repository"],
    ["dist/missing.json", "does not exist"]
  ])("rejects the unusable path %s", async (path, reason) => {
    const root = repository();
    const { url } = await api();

    const result = await run(root, url, commitArgs([path]));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(reason);
  });

  it("rejects an absolute path", async () => {
    const root = repository();
    const { url } = await api();

    const result = await run(
      root,
      url,
      commitArgs([join(root, "catalog.json")])
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be repository-relative");
  });

  it("requires at least one path", async () => {
    const root = repository();
    const { url } = await api();

    const result = await run(root, url, ["commit", "--message", "m"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("at least one --path is required");
  });

  it("creates a lightweight tag ref to a verified commit", async () => {
    const root = repository();
    const { url, calls } = await api();

    const result = await run(root, url, tagArgs("radius@1.2.0"));

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(TARGET);
    expect(calls.map((call) => call.route)).not.toContain("POST /git/tags");
    expect(calls[0]).toMatchObject({
      route: `GET /git/commits/${TARGET}`,
      authorization: "Bearer app-installation-token"
    });
    expect(calls.at(-1)).toMatchObject({
      route: "POST /git/refs",
      body: { ref: "refs/tags/radius@1.2.0", sha: TARGET }
    });
  });

  it("refuses to publish a tag whose target commit GitHub did not sign", async () => {
    const root = repository();
    const { url, calls } = await api({ verified: false });

    const result = await run(root, url, tagArgs("radius@1.2.0"));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "GitHub did not sign the target commit for tag radius@1.2.0"
    );
    expect(calls.map((call) => call.route)).not.toContain("POST /git/refs");
  });

  it("will not move an existing tag without --force", async () => {
    const root = repository();
    const { url, calls } = await api({ refs: ["refs/tags/radius@latest"] });

    const result = await run(root, url, tagArgs("radius@latest"));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already exists; pass --force to move it");
    expect(calls.map((call) => call.route)).not.toContain(
      "PATCH /git/refs/tags/radius@latest"
    );
  });

  it("force-moves an existing tag", async () => {
    const root = repository();
    const { url, calls } = await api({ refs: ["refs/tags/radius@latest"] });

    const result = await run(root, url, tagArgs("radius@latest", "--force"));

    expect(result.status).toBe(0);
    expect(calls.at(-1)).toEqual({
      route: "PATCH /git/refs/tags/radius@latest",
      authorization: "Bearer app-installation-token",
      body: { sha: TARGET, force: true }
    });
  });

  it("creates a branch ref that does not exist yet", async () => {
    const root = repository();
    const { url, calls } = await api();

    const result = await run(root, url, [
      "ref",
      "--name",
      "refs/heads/releases/radius/v1.2.0",
      "--sha",
      COMMIT
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(COMMIT);
    expect(calls.at(-1)).toMatchObject({
      route: "POST /git/refs",
      body: { ref: "refs/heads/releases/radius/v1.2.0", sha: COMMIT }
    });
  });

  it("force-moves an existing branch ref", async () => {
    const root = repository();
    const { url, calls } = await api({
      refs: ["refs/heads/releases/radius/edge"]
    });

    const result = await run(root, url, [
      "ref",
      "--name",
      "refs/heads/releases/radius/edge",
      "--sha",
      COMMIT,
      "--force"
    ]);

    expect(result.status).toBe(0);
    expect(calls.at(-1)).toMatchObject({
      route: "PATCH /git/refs/heads/releases/radius/edge",
      body: { sha: COMMIT, force: true }
    });
  });

  it.each([
    ["refs/notes/build"],
    ["releases/radius/edge"],
    ["refs/heads/bad ref"]
  ])("rejects the unusable ref %s", async (name) => {
    const root = repository();
    const { url } = await api();

    const result = await run(root, url, [
      "ref",
      "--name",
      name,
      "--sha",
      COMMIT
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be a refs/heads or refs/tags ref");
  });

  it.each([
    [["ref", "--name", "refs/heads/edge", "--sha", "abc"], "--sha"],
    [tagArgs("radius@1.2.0").slice(0, -1).concat("abc"), "--target"]
  ])("rejects an abbreviated SHA in %#", async (args, label) => {
    const root = repository();
    const { url } = await api();

    const result = await run(root, url, args);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${label} must be a full 40-character commit SHA`
    );
  });

  it("surfaces an API failure with its status and body", async () => {
    const root = repository();
    const { url } = await api({
      broken: {
        route: "POST /git/commits",
        status: 422,
        body: { message: "tree is invalid" }
      }
    });

    const result = await run(root, url, commitArgs());

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("POST /git/commits failed with 422");
    expect(result.stderr).toContain("tree is invalid");
  });

  it("fails when GitHub cannot be reached", async () => {
    const root = repository();

    const result = await run(root, "http://127.0.0.1:1", commitArgs());

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not reach GitHub");
  });

  it.each([["GITHUB_TOKEN"], ["GITHUB_REPOSITORY"]])(
    "requires %s",
    async (name) => {
      const root = repository();
      const { url } = await api();

      const result = await run(root, url, commitArgs(), { [name]: "" });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${name} is required`);
    }
  );

  it("rejects an unknown command", async () => {
    const root = repository();
    const { url } = await api();

    expect((await run(root, url, [])).stderr).toContain(
      "unknown command: (none)"
    );
    expect((await run(root, url, ["push"])).stderr).toContain(
      "unknown command: push"
    );
  });

  describe("verify-tag", () => {
    it("accepts a lightweight tag whose target commit GitHub signed", async () => {
      const root = repository();
      const { url } = await api({
        refs: ["refs/tags/radius@1.2.0"],
        tagObject: { type: "commit", target: TARGET }
      });

      const result = await run(root, url, [
        "verify-tag",
        "--name",
        "radius@1.2.0",
        "--target",
        TARGET
      ]);

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(TARGET);
    });

    it("rejects a lightweight tag whose target commit is unverified", async () => {
      const root = repository();
      const { url } = await api({
        verified: false,
        refs: ["refs/tags/radius@1.2.0"],
        tagObject: { type: "commit", target: TARGET }
      });

      const result = await run(root, url, [
        "verify-tag",
        "--name",
        "radius@1.2.0"
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "GitHub did not sign the target commit for tag radius@1.2.0"
      );
    });

    it("accepts a signed annotated tag whose target commit is also verified", async () => {
      const root = repository();
      const { url } = await api({
        refs: ["refs/tags/radius@1.2.0"],
        tagObject: { type: "tag", target: TARGET }
      });

      const result = await run(root, url, [
        "verify-tag",
        "--name",
        "radius@1.2.0"
      ]);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(TARGET);
    });

    it("rejects a signed annotated tag whose target commit is unverified", async () => {
      const root = repository();
      const { url } = await api({
        commitVerified: false,
        refs: ["refs/tags/radius@1.2.0"],
        tagObject: { type: "tag", target: TARGET }
      });

      const result = await run(root, url, [
        "verify-tag",
        "--name",
        "radius@1.2.0"
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "GitHub did not sign the target commit for tag radius@1.2.0"
      );
      // A signed tag object must not mask an unsigned target.
      expect(result.stderr).not.toContain(
        "GitHub did not sign the tag radius@1.2.0"
      );
    });

    it("rejects an annotated tag GitHub did not sign", async () => {
      const root = repository();
      const { url } = await api({
        verified: false,
        refs: ["refs/tags/radius@1.2.0"],
        tagObject: { type: "tag", target: TARGET }
      });

      const result = await run(root, url, [
        "verify-tag",
        "--name",
        "radius@1.2.0"
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("GitHub did not sign the tag");
    });

    it("rejects a verified tag pointing somewhere else", async () => {
      const root = repository();
      const { url } = await api({
        refs: ["refs/tags/radius@1.2.0"],
        tagObject: { type: "tag", target: COMMIT }
      });

      const result = await run(root, url, [
        "verify-tag",
        "--name",
        "radius@1.2.0",
        "--target",
        TARGET
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`points at ${COMMIT}, not ${TARGET}`);
    });

    it("rejects a tag that does not exist", async () => {
      const root = repository();
      const { url } = await api();

      const result = await run(root, url, [
        "verify-tag",
        "--name",
        "radius@9.9.9"
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("does not exist");
    });
  });

  describe("verify-completion", () => {
    const args = [
      "verify-completion",
      "--plugin",
      "radius",
      "--version",
      "1.2.0",
      "--source",
      SOURCE
    ];

    it("accepts a complete release whose marker targets its pinned artifact", async () => {
      const root = repository();
      const { url } = await completionApi();

      const result = await run(root, url, args);

      expect(result).toEqual({
        status: 0,
        stdout: JSON.stringify({
          commit: COMMIT,
          tree: TREE,
          version: "1.2.0",
          source: SOURCE
        }),
        stderr: ""
      });
    });

    it("rejects a verified completion tag targeting the wrong commit", async () => {
      const root = repository();
      const wrong = "9".repeat(40);
      const { url } = await completionApi({ artifactTarget: wrong });

      const result = await run(root, url, args);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`points at ${wrong}, not ${COMMIT}`);
    });

    it.each([
      ["an unverified artifact", { commitVerified: false }, "did not sign"],
      ["a parented artifact", { parents: [{ sha: SOURCE }] }, "zero-parent"],
      ["the wrong version", { packageVersion: "1.1.0" }, "radius@1.2.0"],
      ["the wrong source", { commitSource: TARGET }, `from ${SOURCE}`],
      [
        "a package pin on another source",
        { packageSource: TARGET },
        `pins ${TARGET}, not recorded source ${SOURCE}`
      ],
      [
        "a missing root extension tree",
        { includeRootExtension: false },
        "does not contain .github/extension"
      ],
      [
        "a missing bundled extension tree",
        { includeBundledExtension: false },
        "does not bundle an exact copy"
      ],
      [
        "divergent bundled extension assets",
        { bundledExtensionBlob: TARGET },
        "does not bundle an exact copy"
      ],
      [
        "a source tag on the wrong commit",
        { sourceTarget: TARGET },
        `points at ${TARGET}, not ${SOURCE}`
      ],
      [
        "the wrong catalog ref",
        { catalogRef: "radius@latest" },
        "does not publish"
      ],
      [
        "the wrong catalog path",
        { catalogPath: "plugins/other/dist" },
        "does not publish"
      ],
      ["a draft release", { releaseDraft: true }, "published GitHub release"],
      ["missing release assets", { releaseAssets: [] }, "expected assets"],
      [
        "an extra release asset",
        {
          releaseAssets: [
            "radius-plugin.tar.gz",
            "radius-plugin.spdx.json",
            "radius-awesome-copilot.zip",
            "unexpected.txt"
          ]
        },
        "expected assets"
      ]
    ])("rejects completion with %s", async (_label, options, message) => {
      const root = repository();
      const { url } = await completionApi(options);

      const result = await run(root, url, args);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
    });

    it("exposes artifact verification as a reusable command", async () => {
      const root = repository();
      const { url } = await completionApi();

      const result = await run(root, url, [
        "verify-artifact",
        "--branch",
        "releases/radius/v1.2.0",
        "--plugin",
        "radius",
        "--version",
        "1.2.0",
        "--source",
        SOURCE
      ]);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        commit: COMMIT,
        tree: TREE,
        version: "1.2.0",
        source: SOURCE
      });
    });

    it("inspects a verified latest artifact before exposing its version", async () => {
      const root = repository();
      const branch = "releases/radius/latest";
      const { url } = await completionApi({
        artifactBranch: branch,
        packageVersion: "2.0.0",
        catalogVersion: "2.0.0"
      });

      const result = await run(root, url, [
        "inspect-artifact",
        "--branch",
        branch,
        "--plugin",
        "radius"
      ]);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        commit: COMMIT,
        tree: TREE,
        version: "2.0.0",
        source: SOURCE
      });
    });

    it("inspects a complete legacy latest artifact for forward migration", async () => {
      const root = repository();
      const branch = "releases/radius/latest";
      const { url } = await completionApi({
        artifactBranch: branch,
        includePackageSource: false,
        includeRootExtension: false,
        includeBundledExtension: false
      });

      const result = await run(root, url, [
        "inspect-artifact",
        "--branch",
        branch,
        "--plugin",
        "radius"
      ]);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).source).toBe(SOURCE);
    });

    it("rejects a partially migrated latest artifact", async () => {
      const root = repository();
      const branch = "releases/radius/latest";
      const { url } = await completionApi({
        artifactBranch: branch,
        includeBundledExtension: false
      });

      const result = await run(root, url, [
        "inspect-artifact",
        "--branch",
        branch,
        "--plugin",
        "radius"
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("does not bundle an exact copy");
    });
  });
});
