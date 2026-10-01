import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GRAPH_CACHE_DIR_ENV,
  GRAPH_CACHE_FORMAT,
  graphCacheDir,
  graphCacheKey,
  pruneGraphCache,
  readCachedGraph,
  writeCachedGraph
} from "./graph-cache.js";

const GRAPH = {
  resources: [{ id: "app", type: "Radius.Core/applications" }],
  icons: {}
};

let root: string;
let compileDir: string;
let cacheDir: string;
let radPath: string;
let bicepPath: string;

function keyFor(
  overrides: Partial<Parameters<typeof graphCacheKey>[0]> = {}
): string {
  return graphCacheKey({
    compileDir,
    radPath,
    bicepPath,
    flags: ["--include-icons"],
    ...overrides
  });
}

function entryFile(key: string): string {
  return path.join(cacheDir, `${key}.json`);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-cache-"));
  compileDir = path.join(root, "compile");
  cacheDir = path.join(root, "cache");
  fs.mkdirSync(compileDir);
  fs.writeFileSync(path.join(compileDir, "app.bicep"), "resource a\nb\n");
  fs.writeFileSync(path.join(compileDir, "bicepconfig.json"), "{}");
  radPath = path.join(root, "rad");
  bicepPath = path.join(root, "bicep");
  fs.writeFileSync(radPath, "rad-1");
  fs.writeFileSync(bicepPath, "bicep-1");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("graphCacheDir", () => {
  it("defaults to the extension-owned directory under the home directory", () => {
    expect(graphCacheDir({})).toBe(
      path.join(os.homedir(), ".radius", "ai-extensions", "graph-cache")
    );
  });

  it("honors an override and resolves it to an absolute path", () => {
    expect(graphCacheDir({ [GRAPH_CACHE_DIR_ENV]: " relative-cache " })).toBe(
      path.resolve("relative-cache")
    );
  });

  it.each(["off", "OFF", " Off "])("is disabled by %j", (value) => {
    expect(graphCacheDir({ [GRAPH_CACHE_DIR_ENV]: value })).toBeNull();
  });

  it("treats a blank override as unset", () => {
    expect(graphCacheDir({ [GRAPH_CACHE_DIR_ENV]: "  " })).toBe(
      graphCacheDir({})
    );
  });
});

describe("graphCacheKey", () => {
  it("is a stable SHA-256 hex digest", () => {
    expect(keyFor()).toMatch(/^[0-9a-f]{64}$/u);
    expect(keyFor()).toBe(keyFor());
  });

  it("ignores CRLF line endings in app.bicep only", () => {
    const lf = keyFor();
    fs.writeFileSync(path.join(compileDir, "app.bicep"), "resource a\r\nb\r\n");
    expect(keyFor()).toBe(lf);

    fs.writeFileSync(path.join(compileDir, "bicepconfig.json"), "{\r\n}");
    const crlfConfig = keyFor();
    fs.writeFileSync(path.join(compileDir, "bicepconfig.json"), "{\n}");
    expect(keyFor()).not.toBe(crlfConfig);
  });

  it("changes when the model changes", () => {
    const before = keyFor();
    fs.writeFileSync(path.join(compileDir, "app.bicep"), "resource c\n");
    expect(keyFor()).not.toBe(before);
  });

  it("changes when bicepconfig.json or a nested extension artifact changes", () => {
    const before = keyFor();
    fs.writeFileSync(
      path.join(compileDir, "bicepconfig.json"),
      '{"extensions":{"radius":"br:x:0.60"}}'
    );
    const configured = keyFor();
    expect(configured).not.toBe(before);

    fs.mkdirSync(path.join(compileDir, "ext"));
    fs.writeFileSync(path.join(compileDir, "ext", "types.tgz"), "v1");
    const withArtifact = keyFor();
    expect(withArtifact).not.toBe(configured);

    fs.writeFileSync(path.join(compileDir, "ext", "types.tgz"), "v2");
    expect(keyFor()).not.toBe(withArtifact);
  });

  it("does not let a file name run into its contents", () => {
    fs.rmSync(path.join(compileDir, "bicepconfig.json"));
    fs.writeFileSync(path.join(compileDir, "ab"), "c");
    const split = keyFor();
    fs.rmSync(path.join(compileDir, "ab"));
    fs.writeFileSync(path.join(compileDir, "a"), "bc");
    expect(keyFor()).not.toBe(split);
  });

  it("changes when the rad or Bicep binary is replaced", () => {
    const before = keyFor();
    fs.writeFileSync(radPath, "rad-2-longer");
    const afterRad = keyFor();
    expect(afterRad).not.toBe(before);

    fs.writeFileSync(bicepPath, "bicep-2-longer");
    expect(keyFor()).not.toBe(afterRad);
  });

  it("distinguishes a missing binary from an installed one", () => {
    const installed = keyFor();
    fs.rmSync(bicepPath);
    expect(keyFor()).not.toBe(installed);
  });

  it("changes with the CLI flags", () => {
    expect(keyFor({ flags: [] })).not.toBe(keyFor());
  });

  it("throws when the compile directory cannot be read", () => {
    expect(() => keyFor({ compileDir: path.join(root, "missing") })).toThrow();
  });
});

describe("writeCachedGraph and readCachedGraph", () => {
  it("round-trips a graph and writes nothing else", () => {
    const key = keyFor();
    const messages: string[] = [];
    writeCachedGraph(cacheDir, key, GRAPH, (m) => messages.push(m));

    expect(readCachedGraph(cacheDir, key)).toEqual(GRAPH);
    expect(fs.readdirSync(cacheDir)).toEqual([`${key}.json`]);
    expect(messages).toEqual([]);
    expect(JSON.parse(fs.readFileSync(entryFile(key), "utf8"))).toEqual({
      format: GRAPH_CACHE_FORMAT,
      key,
      graph: GRAPH
    });
  });

  it("restricts the entry to the current user on POSIX", () => {
    if (process.platform === "win32") return;
    const key = keyFor();
    writeCachedGraph(cacheDir, key, GRAPH);
    expect(fs.statSync(cacheDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(entryFile(key)).mode & 0o777).toBe(0o600);
  });

  it("misses when no entry exists", () => {
    expect(readCachedGraph(cacheDir, keyFor())).toBeNull();
  });

  it("does nothing when the cache is disabled", () => {
    const key = keyFor();
    writeCachedGraph(null, key, GRAPH);
    expect(readCachedGraph(null, key)).toBeNull();
    expect(fs.existsSync(cacheDir)).toBe(false);
  });

  it("rejects a key that is not a SHA-256 digest, so it cannot name another path", () => {
    const traversal = `../${"a".repeat(64)}`;
    writeCachedGraph(cacheDir, traversal, GRAPH);
    expect(fs.existsSync(cacheDir)).toBe(false);
    expect(fs.existsSync(path.join(root, `${"a".repeat(64)}.json`))).toBe(
      false
    );
    expect(readCachedGraph(cacheDir, traversal)).toBeNull();
  });

  it.each([
    ["invalid JSON", () => "{"],
    ["a non-object", () => "[]"],
    [
      "another format version",
      (key: string) =>
        JSON.stringify({ format: GRAPH_CACHE_FORMAT + 1, key, graph: GRAPH })
    ],
    [
      "an entry filed under the wrong key",
      () =>
        JSON.stringify({
          format: GRAPH_CACHE_FORMAT,
          key: "b".repeat(64),
          graph: GRAPH
        })
    ],
    [
      "a graph without a resources array",
      (key: string) =>
        JSON.stringify({ format: GRAPH_CACHE_FORMAT, key, graph: {} })
    ],
    [
      "a graph whose resources are not objects",
      (key: string) =>
        JSON.stringify({
          format: GRAPH_CACHE_FORMAT,
          key,
          graph: { resources: ["x"] }
        })
    ],
    [
      "a non-object graph",
      (key: string) =>
        JSON.stringify({ format: GRAPH_CACHE_FORMAT, key, graph: [] })
    ]
  ])("discards %s and reports a miss", (_name, body) => {
    const key = keyFor();
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(entryFile(key), body(key));
    const messages: string[] = [];

    expect(readCachedGraph(cacheDir, key, (m) => messages.push(m))).toBeNull();
    expect(fs.existsSync(entryFile(key))).toBe(false);
    expect(messages).toEqual([
      `Discarding an unreadable cached application graph: ${entryFile(key)}`
    ]);
  });

  it("discards a corrupt entry without a logger", () => {
    const key = keyFor();
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(entryFile(key), "{");

    expect(readCachedGraph(cacheDir, key)).toBeNull();
    expect(fs.existsSync(entryFile(key))).toBe(false);
  });

  it("refreshes the entry's recency on a hit", () => {
    const key = keyFor();
    writeCachedGraph(cacheDir, key, GRAPH);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(entryFile(key), old, old);

    readCachedGraph(cacheDir, key);

    expect(fs.statSync(entryFile(key)).mtimeMs).toBeGreaterThan(
      old.getTime() + 1000
    );
  });

  it("logs a failed write, leaves no temporary file, and does not throw", () => {
    fs.writeFileSync(cacheDir, "a file where the directory should be");
    const messages: string[] = [];

    expect(() =>
      writeCachedGraph(cacheDir, keyFor(), GRAPH, (m) => messages.push(m))
    ).not.toThrow();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(
      /^Warning: could not cache the application graph in /u
    );
    expect(fs.readdirSync(root).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("prunes to the most recently used entries after a write", () => {
    const keys = ["1", "2", "3"].map((c) => c.repeat(64));
    keys.forEach((key, index) => {
      writeCachedGraph(cacheDir, key, GRAPH);
      const at = new Date(Date.now() - (keys.length - index) * 60_000);
      fs.utimesSync(entryFile(key), at, at);
    });

    writeCachedGraph(cacheDir, "4".repeat(64), GRAPH, undefined, 2);

    expect(fs.readdirSync(cacheDir).sort()).toEqual([
      `${"3".repeat(64)}.json`,
      `${"4".repeat(64)}.json`
    ]);
  });
});

describe("pruneGraphCache", () => {
  it("removes abandoned temporary files but keeps recent ones and foreign files", () => {
    fs.mkdirSync(cacheDir);
    const stale = path.join(cacheDir, "stale.tmp");
    const fresh = path.join(cacheDir, "fresh.tmp");
    const foreign = path.join(cacheDir, "notes.json");
    fs.writeFileSync(stale, "");
    fs.writeFileSync(fresh, "");
    fs.writeFileSync(foreign, "");
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);

    pruneGraphCache(cacheDir, 0);

    expect(fs.readdirSync(cacheDir).sort()).toEqual([
      "fresh.tmp",
      "notes.json"
    ]);
  });

  it("ignores a missing cache directory", () => {
    expect(() => pruneGraphCache(path.join(root, "absent"))).not.toThrow();
  });
});
