import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  BASELINE_LABEL,
  COMMENT_STATES,
  MAX_BASELINE_BYTES,
  MAX_BASELINE_FILES,
  SNAPSHOT_DIRECTORY,
  affectsCanvasVisuals,
  applyBaselineUpdates,
  createGitHubRequest,
  renderComment,
  runCli,
  upsertStatusComment,
  validateCommentOptions
} from "../../../../scripts/canvas-visual-baselines.mjs";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RUN_URL = "https://github.com/owner/repo/actions/runs/1";
const COMMIT = "a".repeat(40);
const MARKER = "<!-- canvas-visual-baselines -->";
// Symlinks need elevated rights on Windows.
const WINDOWS = process.platform === "win32";

const roots = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop(), { recursive: true, force: true });
  }
});

function png(text) {
  return Buffer.concat([PNG, Buffer.from(text)]);
}

function workspace(baselines = {}) {
  const root = mkdtempSync(join(tmpdir(), "radius-visual-baselines-"));
  roots.push(root);
  const snapshots = join(root, SNAPSHOT_DIRECTORY);
  mkdirSync(snapshots, { recursive: true });
  for (const [name, content] of Object.entries(baselines)) {
    writeFileSync(join(snapshots, name), content);
  }
  const source = join(root, "artifact");
  mkdirSync(source);
  return { root, snapshots, source };
}

/**
 * An in-memory GitHub issue comments API that throws on any route the
 * scenario did not model.
 */
function commentsApi(comments = []) {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    const list = path.match(/^\/issues\/7\/comments\?per_page=100&page=(\d+)$/);
    if (method === "GET" && list) {
      const page = Number(list[1]);
      return comments.slice((page - 1) * 100, page * 100);
    }
    if (method === "PATCH" && /^\/issues\/comments\/\d+$/.test(path)) {
      return { id: Number(path.split("/").at(-1)) };
    }
    if (method === "POST" && path === "/issues/7/comments") return { id: 99 };
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { request, calls };
}

function botComment(id, state) {
  return {
    id,
    user: { login: "github-actions[bot]" },
    body: `${MARKER}\n<!-- canvas-visual-baselines:state=${state} -->\nold`
  };
}

describe("affectsCanvasVisuals", () => {
  it.each([
    ["packages/adapter-canvas/src/pages/shell.ts"],
    ["packages/core/src/graph/diff.ts"],
    ["packages/adapter-shared/src/rad.ts"],
    ["packages/adapter-canvas/test/visual/__screenshots__/vi-01-a-light.png"],
    ["pnpm-lock.yaml"],
    ["package.json"],
    ["pnpm-workspace.yaml"],
    [".npmrc"],
    [".node-version"],
    [".dockerignore"],
    ["scripts/canvas-visual.mjs"],
    [".github/workflows/canvas-functional.yml"]
  ])("runs the suite when %s changes", (path) => {
    expect(affectsCanvasVisuals(["README.md", path])).toBe(true);
  });

  it.each([
    [[]],
    [["README.md", "docs/design/plan.md"]],
    [["extensions/radius/skills/radius-deploy/SKILL.md"]],
    [[".github/workflows/build.yml", "scripts/canvas-visual-baselines.mjs"]],
    [["plugins/radius/package.json", "apackages/core/src/index.ts"]]
  ])("skips the suite for %j", (paths) => {
    expect(affectsCanvasVisuals(paths)).toBe(false);
  });
});

describe("applyBaselineUpdates", () => {
  it("copies changed and new baselines and reports them in order", () => {
    const { root, snapshots, source } = workspace({
      "vi-01-a-light.png": png("old"),
      "vi-02-b-light.png": png("same")
    });
    writeFileSync(join(source, "vi-02-b-light.png"), png("same"));
    writeFileSync(join(source, "vi-01-a-light.png"), png("new"));
    writeFileSync(join(source, "vi-03-c-dark.png"), png("added"));

    const files = applyBaselineUpdates(source, { root });

    expect(files).toEqual([
      `${SNAPSHOT_DIRECTORY}/vi-01-a-light.png`,
      `${SNAPSHOT_DIRECTORY}/vi-03-c-dark.png`
    ]);
    expect(readFileSync(join(snapshots, "vi-01-a-light.png"))).toEqual(
      png("new")
    );
    expect(readFileSync(join(snapshots, "vi-03-c-dark.png"))).toEqual(
      png("added")
    );
  });

  it("reports nothing when every baseline is already current", () => {
    const { root, source } = workspace({ "vi-01-a-light.png": png("same") });
    writeFileSync(join(source, "vi-01-a-light.png"), png("same"));

    expect(applyBaselineUpdates(source, { root })).toEqual([]);
  });

  it.each([
    ["VI-01-upper.png"],
    ["vi-02-upper-extension.PNG"],
    ["vi-01--double.png"],
    ["-vi-01.png"],
    [".hidden.png"],
    ["notes.md"],
    ["vi 01.png"]
  ])("rejects the entry %s without writing anything", (name) => {
    const { root, snapshots, source } = workspace();
    writeFileSync(join(source, "vi-01-a-light.png"), png("valid"));
    writeFileSync(join(source, name), png("x"));

    expect(() => applyBaselineUpdates(source, { root })).toThrow(
      `Refusing an unexpected baseline name: ${name}`
    );
    expect(() => readFileSync(join(snapshots, "vi-01-a-light.png"))).toThrow();
  });

  it("rejects a nested directory", () => {
    const { root, source } = workspace();
    mkdirSync(join(source, "nested"));

    expect(() => applyBaselineUpdates(source, { root })).toThrow(
      "Refusing an unexpected baseline name: nested"
    );
  });

  it("rejects a directory with a baseline name", () => {
    const { root, source } = workspace();
    mkdirSync(join(source, "vi-01-a-light.png"));

    expect(() => applyBaselineUpdates(source, { root })).toThrow(
      "not a regular file: vi-01-a-light.png"
    );
  });

  it.skipIf(WINDOWS)("rejects a symlinked baseline", () => {
    const { root, source } = workspace();
    const outside = join(root, "secret.png");
    writeFileSync(outside, png("secret"));
    symlinkSync(outside, join(source, "vi-01-a-light.png"));

    expect(() => applyBaselineUpdates(source, { root })).toThrow(
      "not a regular file: vi-01-a-light.png"
    );
  });

  it.skipIf(WINDOWS)("refuses to write through a symlinked destination", () => {
    const { root, snapshots, source } = workspace();
    const outside = join(root, "outside.png");
    writeFileSync(outside, png("outside"));
    symlinkSync(outside, join(snapshots, "vi-01-a-light.png"));
    writeFileSync(join(source, "vi-01-a-light.png"), png("new"));

    expect(() => applyBaselineUpdates(source, { root })).toThrow(
      `${SNAPSHOT_DIRECTORY}/vi-01-a-light.png is not a regular file`
    );
    expect(readFileSync(outside)).toEqual(png("outside"));
  });

  it("rejects a file that is not a PNG", () => {
    const { root, source } = workspace();
    writeFileSync(join(source, "vi-01-a-light.png"), "<svg/>");

    expect(() => applyBaselineUpdates(source, { root })).toThrow(
      "Refusing vi-01-a-light.png: it is not a PNG image"
    );
  });

  it("accepts a baseline at the size limit and rejects one byte more", () => {
    const { root, source } = workspace();
    const atLimit = Buffer.alloc(MAX_BASELINE_BYTES);
    PNG.copy(atLimit);
    writeFileSync(join(source, "vi-01-a-light.png"), atLimit);

    expect(applyBaselineUpdates(source, { root })).toHaveLength(1);

    writeFileSync(
      join(source, "vi-01-a-light.png"),
      Buffer.concat([atLimit, Buffer.from([0])])
    );
    expect(() => applyBaselineUpdates(source, { root })).toThrow(
      `exceeds the ${MAX_BASELINE_BYTES} byte limit`
    );
  });

  it("accepts the maximum number of baselines and rejects one more", () => {
    const { root, source } = workspace();
    for (let index = 0; index < MAX_BASELINE_FILES; index += 1) {
      writeFileSync(join(source, `vi-${index}.png`), png(String(index)));
    }

    expect(applyBaselineUpdates(source, { root })).toHaveLength(
      MAX_BASELINE_FILES
    );

    writeFileSync(join(source, "vi-extra.png"), png("extra"));
    expect(() => applyBaselineUpdates(source, { root })).toThrow(
      `has ${MAX_BASELINE_FILES + 1} entries; the limit is ${MAX_BASELINE_FILES}`
    );
  });

  it("writes nothing when any entry is rejected", () => {
    const { root, snapshots, source } = workspace({
      "vi-01-a-light.png": png("old")
    });
    writeFileSync(join(source, "vi-01-a-light.png"), png("new"));
    writeFileSync(join(source, "vi-02-b-light.png"), "not a png");

    expect(() => applyBaselineUpdates(source, { root })).toThrow(
      "not a PNG image"
    );
    expect(readFileSync(join(snapshots, "vi-01-a-light.png"))).toEqual(
      png("old")
    );
  });

  it("rejects an empty artifact", () => {
    const { root, source } = workspace();

    expect(() => applyBaselineUpdates(source, { root })).toThrow(
      "The regenerated baseline artifact is empty"
    );
  });

  it("requires the committed baseline directory", () => {
    const root = mkdtempSync(join(tmpdir(), "radius-visual-baselines-"));
    roots.push(root);

    expect(() => applyBaselineUpdates(root, { root })).toThrow(
      `${SNAPSHOT_DIRECTORY} is not a directory`
    );
  });
});

describe("renderComment", () => {
  it.each(COMMENT_STATES)(
    "marks the %s comment so it can be found and replaced",
    (state) => {
      const body = renderComment({
        state,
        runUrl: RUN_URL,
        files: [`${SNAPSHOT_DIRECTORY}/vi-01-a-light.png`],
        commit: COMMIT
      });

      expect(body.startsWith(`${MARKER}\n`)).toBe(true);
      expect(body).toContain(`<!-- canvas-visual-baselines:state=${state} -->`);
      expect(body).toContain(`](${RUN_URL})`);
    }
  );

  it("tells the author exactly how to accept an intended mismatch", () => {
    const body = renderComment({ state: "mismatch", runUrl: RUN_URL });

    expect(body).toContain(`add the \`${BASELINE_LABEL}\` label`);
    expect(body).toContain("fix the UI");
    expect(body).toContain("canvas-visual-functional");
  });

  it("lists every committed baseline and the commit", () => {
    const files = [
      `${SNAPSHOT_DIRECTORY}/vi-01-a-light.png`,
      `${SNAPSHOT_DIRECTORY}/vi-01-a-dark.png`
    ];
    const body = renderComment({
      state: "updated",
      runUrl: RUN_URL,
      files,
      commit: COMMIT
    });

    expect(body).toContain(`Committed 2 regenerated baselines in ${COMMIT}:`);
    for (const file of files) expect(body).toContain(`- \`${file}\``);
    expect(
      renderComment({
        state: "updated",
        runUrl: RUN_URL,
        files: files.slice(0, 1),
        commit: COMMIT
      })
    ).toContain("Committed 1 regenerated baseline in");
  });

  it("asks for the label again when an update failed", () => {
    expect(
      renderComment({ state: "update-failed", runUrl: RUN_URL })
    ).toContain(
      `add the \`${BASELINE_LABEL}\` label to this pull request again`
    );
  });
});

describe("validateCommentOptions", () => {
  const valid = {
    pr: "7",
    state: "updated",
    runUrl: RUN_URL,
    files: [`${SNAPSHOT_DIRECTORY}/vi-01-a-light.png`],
    commit: COMMIT
  };

  it("accepts a complete updated report", () => {
    expect(validateCommentOptions(valid)).toEqual({ ...valid, pr: 7 });
  });

  it.each([
    [{ pr: undefined }, "--pr must be a pull request number"],
    [{ pr: "0" }, "--pr must be a pull request number"],
    [{ pr: "7;" }, "--pr must be a pull request number"],
    [{ state: "done" }, "--state must be one of"],
    [{ runUrl: undefined }, "--run-url must be an https URL"],
    [{ runUrl: "http://example.test/run" }, "--run-url must be an https URL"],
    [{ runUrl: `${RUN_URL}) [x](y` }, "--run-url must be an https URL"],
    [{ files: ["README.md"] }, "--file is not a committed baseline path"],
    [
      { files: [`${SNAPSHOT_DIRECTORY}/../../../README.png`] },
      "--file is not a committed baseline path"
    ],
    [
      { files: [`${SNAPSHOT_DIRECTORY}/vi-01.png\` [x](y)`] },
      "--file is not a committed baseline path"
    ],
    [{ commit: undefined }, "--commit must be a full commit SHA"],
    [{ commit: "abc" }, "--commit must be a full commit SHA"],
    [{ files: [] }, "--file is required for updated"]
  ])("rejects %j", (override, message) => {
    expect(() => validateCommentOptions({ ...valid, ...override })).toThrow(
      message
    );
  });

  it("needs no commit or files for other states", () => {
    expect(
      validateCommentOptions({
        pr: "7",
        state: "mismatch",
        runUrl: RUN_URL,
        files: []
      }).state
    ).toBe("mismatch");
  });
});

describe("upsertStatusComment", () => {
  const options = { pr: 7, runUrl: RUN_URL, files: [] };

  it("creates the comment when none exists", async () => {
    const { request, calls } = commentsApi([
      { id: 1, user: { login: "someone" }, body: "hello" }
    ]);

    expect(
      await upsertStatusComment(request, { ...options, state: "mismatch" })
    ).toBe("created");
    expect(calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/issues/7/comments",
      body: { body: expect.stringContaining("state=mismatch") }
    });
  });

  it("replaces its own comment in place", async () => {
    const { request, calls } = commentsApi([botComment(5, "mismatch")]);

    expect(
      await upsertStatusComment(request, { ...options, state: "failed" })
    ).toBe("updated");
    expect(calls.at(-1)).toMatchObject({
      method: "PATCH",
      path: "/issues/comments/5",
      body: { body: expect.stringContaining("state=failed") }
    });
  });

  it("ignores a marker written by anyone else", async () => {
    const { request, calls } = commentsApi([
      { id: 3, user: { login: "someone" }, body: `${MARKER}\nspoofed` }
    ]);

    await upsertStatusComment(request, { ...options, state: "mismatch" });

    expect(calls.map(({ method }) => method)).toEqual(["GET", "POST"]);
  });

  it("finds its comment beyond the first page", async () => {
    const others = Array.from({ length: 100 }, (_, index) => ({
      id: index + 100,
      user: { login: "someone" },
      body: "noise"
    }));
    const { request, calls } = commentsApi([
      ...others,
      botComment(5, "mismatch")
    ]);

    await upsertStatusComment(request, { ...options, state: "unchanged" });

    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /issues/7/comments?per_page=100&page=1",
      "GET /issues/7/comments?per_page=100&page=2",
      "PATCH /issues/comments/5"
    ]);
  });

  it("does not comment on a pull request whose check always passed", async () => {
    const { request, calls } = commentsApi();

    expect(
      await upsertStatusComment(request, { ...options, state: "passed" })
    ).toBe("unchanged");
    expect(calls.map(({ method }) => method)).toEqual(["GET"]);
  });

  it.each([["updated"], ["passed"]])(
    "keeps a %s comment when the check passes",
    async (previous) => {
      const { request, calls } = commentsApi([botComment(5, previous)]);

      expect(
        await upsertStatusComment(request, { ...options, state: "passed" })
      ).toBe("unchanged");
      expect(calls.map(({ method }) => method)).toEqual(["GET"]);
    }
  );

  it.each([["mismatch"], ["failed"], ["unchanged"], ["update-failed"]])(
    "clears a %s comment when the check passes",
    async (previous) => {
      const { request, calls } = commentsApi([botComment(5, previous)]);

      expect(
        await upsertStatusComment(request, { ...options, state: "passed" })
      ).toBe("updated");
      expect(calls.at(-1).body.body).toContain("state=passed");
    }
  );

  it("propagates an API failure", async () => {
    const request = async () => {
      throw new Error("GET failed with 403");
    };

    await expect(
      upsertStatusComment(request, { ...options, state: "mismatch" })
    ).rejects.toThrow("GET failed with 403");
  });
});

describe("createGitHubRequest", () => {
  it("sends an authenticated JSON request to the repository API", async () => {
    const requests = [];
    const request = createGitHubRequest({
      token: "token-value",
      repository: "owner/repo",
      apiUrl: "https://api.example.test/",
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return { ok: true, status: 200, text: async () => '{"id":1}' };
      }
    });

    expect(await request("POST", "/issues/7/comments", { body: "x" })).toEqual({
      id: 1
    });
    expect(requests[0].url).toBe(
      "https://api.example.test/repos/owner/repo/issues/7/comments"
    );
    expect(requests[0].init).toMatchObject({
      method: "POST",
      body: '{"body":"x"}',
      headers: { authorization: "Bearer token-value" }
    });
  });

  it("omits the body for a read", async () => {
    let init;
    const request = createGitHubRequest({
      token: "token-value",
      repository: "owner/repo",
      fetchImpl: async (url, options) => {
        init = options;
        expect(url).toBe("https://api.github.com/repos/owner/repo/issues/7");
        return { ok: true, status: 200, text: async () => "[]" };
      }
    });

    await request("GET", "/issues/7");

    expect(init.body).toBeUndefined();
  });

  it("reports the status and body of a failed request", async () => {
    const request = createGitHubRequest({
      token: "token-value",
      repository: "owner/repo",
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        text: async () => '{"message":"Resource not accessible"}'
      })
    });

    await expect(request("GET", "/issues/7/comments")).rejects.toThrow(
      'GET /issues/7/comments failed with 403: {"message":"Resource not accessible"}'
    );
  });

  it.each([
    [{ repository: "owner/repo" }, "GITHUB_TOKEN is required"],
    [{ token: "token-value" }, "GITHUB_REPOSITORY is required"]
  ])("requires credentials %#", (options, message) => {
    expect(() => createGitHubRequest(options)).toThrow(message);
  });
});

describe("runCli", () => {
  function output() {
    const chunks = [];
    return { write: (text) => chunks.push(text), text: () => chunks.join("") };
  }

  it("reports whether stdin paths affect rendering", async () => {
    const affected = output();
    const unaffected = output();

    await runCli(["affects"], {
      readStdin: () => "README.md\r\npackages/core/src/index.ts\n",
      write: affected.write
    });
    await runCli(["affects"], {
      readStdin: () => "",
      write: unaffected.write
    });

    expect(affected.text()).toBe("true\n");
    expect(unaffected.text()).toBe("false\n");
  });

  it("prints the baselines apply changed, one per line", async () => {
    const { root, source } = workspace();
    writeFileSync(join(source, "vi-01-a-light.png"), png("a"));
    writeFileSync(join(source, "vi-02-b-light.png"), png("b"));
    const printed = output();

    await runCli(["apply", source], { root, write: printed.write });

    expect(printed.text()).toBe(
      `${SNAPSHOT_DIRECTORY}/vi-01-a-light.png\n${SNAPSHOT_DIRECTORY}/vi-02-b-light.png\n`
    );
  });

  it("prints nothing when apply changed nothing", async () => {
    const { root, source } = workspace({ "vi-01-a-light.png": png("a") });
    writeFileSync(join(source, "vi-01-a-light.png"), png("a"));
    const printed = output();

    await runCli(["apply", source], { root, write: printed.write });

    expect(printed.text()).toBe("");
  });

  it("requires exactly one apply directory", async () => {
    await expect(runCli(["apply"])).rejects.toThrow(
      "Usage: node scripts/canvas-visual-baselines.mjs apply <directory>"
    );
  });

  it("posts the status comment through the configured API", async () => {
    const requests = [];
    const printed = output();

    await runCli(
      [
        "comment",
        "--pr",
        "7",
        "--state",
        "updated",
        "--run-url",
        RUN_URL,
        "--commit",
        COMMIT,
        "--file",
        `${SNAPSHOT_DIRECTORY}/vi-01-a-light.png`
      ],
      {
        env: {
          GITHUB_TOKEN: "token-value",
          GITHUB_REPOSITORY: "owner/repo",
          GITHUB_API_URL: "https://api.example.test"
        },
        write: printed.write,
        fetchImpl: async (url, init) => {
          requests.push(`${init.method} ${url}`);
          return {
            ok: true,
            status: 200,
            text: async () => (init.method === "GET" ? "[]" : '{"id":1}')
          };
        }
      }
    );

    expect(requests).toEqual([
      "GET https://api.example.test/repos/owner/repo/issues/7/comments?per_page=100&page=1",
      "POST https://api.example.test/repos/owner/repo/issues/7/comments"
    ]);
    expect(printed.text()).toBe("created\n");
  });

  it("validates comment options before contacting GitHub", async () => {
    const fetchImpl = async () => {
      throw new Error("must not be called");
    };

    await expect(
      runCli(["comment", "--pr", "7", "--state", "updated", "--run-url"], {
        env: { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "owner/repo" },
        fetchImpl
      })
    ).rejects.toThrow("--run-url requires a value");
    await expect(
      runCli(["comment", "--color", "red"], { fetchImpl })
    ).rejects.toThrow("Unknown comment option: --color");
    await expect(
      runCli(
        ["comment", "--pr", "7", "--state", "mismatch", "--run-url", RUN_URL],
        {
          env: {},
          fetchImpl
        }
      )
    ).rejects.toThrow("GITHUB_TOKEN is required");
  });

  it.each([[[]], [["publish"]]])("rejects the command %j", async (argv) => {
    await expect(runCli(argv)).rejects.toThrow(
      `Unknown command: ${argv[0] ?? "(none)"}`
    );
  });
});

describe("command line", () => {
  const script = join(repoRoot, "scripts", "canvas-visual-baselines.mjs");

  it("reads changed paths from stdin as the workflow pipes them", () => {
    const result = spawnSync(process.execPath, [script, "affects"], {
      input: "docs/readme.md\npackages/core/src/index.ts\n",
      encoding: "utf8"
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("true\n");
  });

  it("exits nonzero with the error message on failure", () => {
    const result = spawnSync(process.execPath, [script, "publish"], {
      encoding: "utf8"
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Unknown command: publish\n");
  });
});

describe("workflow contract", () => {
  const read = (path) => readFileSync(join(repoRoot, path), "utf8");

  it("uses the same label in both workflows and the script", () => {
    for (const path of [
      ".github/workflows/canvas-functional.yml",
      ".github/workflows/canvas-visual-baselines.yml"
    ]) {
      expect(read(path), path).toContain(`LABEL: ${BASELINE_LABEL}`);
    }
    expect(
      read(".github/workflows/canvas-visual-baselines.yml").match(
        /label\.name == '([^']+)'/g
      )
    ).toEqual(Array(3).fill(`label.name == '${BASELINE_LABEL}'`));
  });

  it("stages regenerated files from the directory apply writes to", () => {
    expect(read(".github/workflows/canvas-visual-baselines.yml")).toContain(
      `SNAPSHOTS: ${SNAPSHOT_DIRECTORY}\n`
    );
  });
});
