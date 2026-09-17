import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnRad } from "./rad-process.mjs";
import { GraphIsolationError, runRadAppGraph } from "./rad.js";

let directory: string;
const windowsEnv =
  process.platform === "win32" ?
    {
      SystemRoot: process.env.SystemRoot,
      HOMEDRIVE: "",
      HOMEPATH: "",
      LOGONSERVER: "",
      SYSTEMDRIVE: "",
      TEMP: "",
      USERDOMAIN: "",
      USERNAME: "",
      WINDIR: ""
    }
  : {};
beforeEach(async () => {
  directory = join(
    process.cwd(),
    ".artifacts",
    `process-isolation-${randomUUID()}`
  );
  await mkdir(directory, { recursive: true });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  const ownedPids = new Set<number>();
  for (const file of [
    join(directory, "child.pid"),
    join(directory, "source", "child.pid")
  ]) {
    const pid = await readFile(file, "utf8").catch(() => undefined);
    if (pid) ownedPids.add(Number(pid));
  }
  const tree = await readFile(join(directory, "tree.json"), "utf8").catch(
    () => undefined
  );
  if (tree) {
    const pids: unknown = JSON.parse(tree);
    if (Array.isArray(pids))
      for (const pid of pids) {
        if (typeof pid === "number") ownedPids.add(pid);
      }
  }
  for (const pid of ownedPids) {
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ))
        throw error;
    }
    await vi.waitFor(
      () => {
        expect(() => process.kill(pid, 0)).toThrow();
      },
      { timeout: 2_000, interval: 10 }
    );
  }
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 50
  });
});

describe("managed process explicit environment boundary", () => {
  it.each(["cancellation", "timeout"])(
    "waits for the isolated process tree before reporting %s",
    async (mode) => {
      const controller = new AbortController();
      const pending = spawnRad(
        process.execPath,
        [
          "-e",
          `
      const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {stdio: "ignore"});
      require("node:fs").writeFileSync("tree.json", JSON.stringify([process.pid, child.pid]));
      setInterval(()=>{},1000);
    `
        ],
        {
          cwd: directory,
          env: windowsEnv,
          inheritEnv: false,
          signal: controller.signal,
          timeout: mode === "timeout" ? 750 : 2_000
        }
      );
      const rejected = expect(pending).rejects.toMatchObject({
        name: mode === "cancellation" ? "AbortError" : "RadProcessError"
      });
      let pids: number[] = [];
      try {
        await vi.waitFor(async () => {
          const parsed: unknown = JSON.parse(
            await readFile(join(directory, "tree.json"), "utf8")
          );
          if (
            !Array.isArray(parsed) ||
            !parsed.every((pid): pid is number => typeof pid === "number")
          )
            throw new Error("Expected process-tree IDs");
          pids = parsed;
          expect(pids).toHaveLength(2);
        });
        if (mode === "cancellation") controller.abort();
        await rejected;
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        controller.abort();
        await pending.catch(() => undefined);
        for (const pid of pids) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* Already terminated. */
          }
        }
      }
    }
  );

  it.runIf(process.platform === "win32")(
    "suppresses libuv's implicit host environment inheritance",
    async () => {
      const result = await spawnRad(
        process.execPath,
        ["-e", "console.log(JSON.stringify(process.env))"],
        {
          cwd: directory,
          inheritEnv: false,
          env: { SystemRoot: process.env.SystemRoot },
          timeout: 2_000
        }
      );
      expect(JSON.parse(result.stdout)).toEqual({
        SystemRoot: process.env.SystemRoot,
        HOMEDRIVE: "",
        HOMEPATH: "",
        LOGONSERVER: "",
        PATH: "",
        SYSTEMDRIVE: "",
        TEMP: "",
        USERDOMAIN: "",
        USERNAME: "",
        USERPROFILE: "",
        WINDIR: ""
      });
      for (const env of [
        {},
        { SystemRoot: "" },
        { PATH: "" },
        { systemroot: "" }
      ]) {
        await expect(
          spawnRad(process.execPath, [], {
            cwd: directory,
            inheritEnv: false,
            env
          })
        ).rejects.toThrow("explicit SystemRoot");
      }
      const explicit = await spawnRad(
        process.execPath,
        ["-e", "console.log(JSON.stringify(process.env))"],
        {
          cwd: directory,
          inheritEnv: false,
          env: {
            pAtH: "owned-bin",
            systemroot: process.env.SystemRoot,
            USERPROFILE: directory
          },
          timeout: 2_000
        }
      );
      expect(JSON.parse(explicit.stdout)).toMatchObject({
        pAtH: "owned-bin",
        systemroot: process.env.SystemRoot,
        USERPROFILE: directory
      });
    }
  );

  it("passes only explicit environment, literal argv and owned cwd to a real child", async () => {
    vi.stubEnv("GH_TOKEN", "fixture-only");
    vi.stubEnv("GITHUB_TOKEN", "fixture-only");
    vi.stubEnv("AZURE_CLIENT_SECRET", "fixture-only");
    vi.stubEnv("AWS_SESSION_TOKEN", "fixture-only");
    vi.stubEnv("NODE_OPTIONS", "");
    vi.stubEnv("RADIUS_AMBIENT_MARKER", "fixture-only");
    const home = join(directory, "home");
    await mkdir(home);
    const env = {
      ...windowsEnv,
      HOME: home,
      USERPROFILE: home,
      GH_CONFIG_DIR: join(home, "gh"),
      AZURE_CONFIG_DIR: join(home, "azure"),
      AWS_SHARED_CREDENTIALS_FILE: join(home, "aws-credentials"),
      AWS_CONFIG_FILE: join(home, "aws-config"),
      GITHUB_ACTIONS: "",
      PATH: "",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {})
    };
    const args = [
      "two words",
      "file; echo forbidden",
      "$(echo forbidden)",
      'say "hello"'
    ];
    const result = await spawnRad(
      process.execPath,
      [
        "-e",
        `const expected=${JSON.stringify(Object.keys(env).map((key) => key.toUpperCase()))}; console.log(JSON.stringify({unexpectedKeys:Object.keys(process.env).filter(key=>!expected.includes(key.toUpperCase())).length,home:process.env.HOME,profile:process.env.USERPROFILE,cwd:process.cwd(),args:process.argv.slice(1)}))`,
        ...args
      ],
      { cwd: directory, env, inheritEnv: false, timeout: 2_000 }
    );

    expect(JSON.parse(result.stdout)).toEqual({
      unexpectedKeys: 0,
      home,
      profile: home,
      cwd: directory,
      args
    });
    expect(await readdir(home)).toEqual([]);
    expect(result.stderr).toBe("");
  });

  it("preserves legacy environment inheritance unless explicitly disabled", async () => {
    vi.stubEnv("RADIUS_LEGACY_MARKER", "legacy-fixture");
    const result = await spawnRad(
      process.execPath,
      ["-e", "console.log(process.env.RADIUS_LEGACY_MARKER)"],
      { cwd: directory, timeout: 2_000 }
    );
    expect(result.stdout.trim()).toBe("legacy-fixture");
  });

  it("does not launch an already-cancelled child", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      spawnRad(
        process.execPath,
        ["-e", "require('node:fs').writeFileSync('launched','unexpected')"],
        {
          cwd: directory,
          env: windowsEnv,
          inheritEnv: false,
          signal: controller.signal,
          timeout: 2_000
        }
      )
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await readdir(directory)).toEqual([]);
  });

  it("reports cancellation rather than timeout when a running child is cancelled", async () => {
    const controller = new AbortController();
    const pending = spawnRad(
      process.execPath,
      [
        "-e",
        "require('node:fs').writeFileSync('child.pid',String(process.pid));setInterval(()=>{},1000)"
      ],
      {
        cwd: directory,
        env: windowsEnv,
        inheritEnv: false,
        signal: controller.signal,
        timeout: 2_000
      }
    );
    const rejection = expect(pending).rejects.toMatchObject({
      name: "AbortError"
    });
    await vi.waitFor(
      async () => {
        expect(
          Number(await readFile(join(directory, "child.pid"), "utf8"))
        ).toBeGreaterThan(0);
      },
      { timeout: 1_000, interval: 10 }
    );
    controller.abort();
    await rejection;
    const pid = Number(await readFile(join(directory, "child.pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("retains timeout and spawn-failure behavior with inheritance disabled", async () => {
    await expect(
      spawnRad(
        process.execPath,
        [
          "-e",
          "require('node:fs').writeFileSync('child.pid',String(process.pid));setInterval(()=>{},1000)"
        ],
        {
          cwd: directory,
          env: windowsEnv,
          inheritEnv: false,
          timeout: 500,
          label: "isolated fixture"
        }
      )
    ).rejects.toMatchObject({
      name: "RadProcessError",
      message: "isolated fixture timed out after 500ms"
    });
    await expect(
      spawnRad(join(directory, "not-installed"), [], {
        cwd: directory,
        env: windowsEnv,
        inheritEnv: false,
        timeout: 1_000
      })
    ).rejects.toMatchObject({ name: "RadProcessError" });
  });
});
describe("isolated rad graph process boundary", () => {
  async function graphFixture(script: string) {
    const cwd = join(directory, "source");
    await mkdir(cwd);
    await writeFile(
      join(directory, "bicepconfig.json"),
      JSON.stringify({
        cacheRootDirectory: join(directory, ".bicep")
      })
    );
    await writeFile(
      join(cwd, "app"),
      `const require = (await import("node:module")).createRequire(import.meta.url);\n${script}`
    );
    const file = join(cwd, "literal ; definition.bicep");
    await writeFile(file, "extension radius\n");
    return {
      file,
      options: {
        radPath: process.execPath,
        isolation: {
          cwd,
          env: {
            ...windowsEnv,
            HOME: directory,
            USERPROFILE: directory,
            PATH: "",
            GITHUB_ACTIONS: "true"
          },
          bicepPath: process.execPath
        },
        timeout: 2_000
      }
    };
  }

  it("uses exact graph argv, cwd, managed Bicep and non-inheriting environment without installation or publication", async () => {
    vi.stubEnv("GRAPH_AMBIENT_MARKER", "fixture-only");
    const { file, options } = await graphFixture(`
          const fs = require("node:fs");
          fs.writeFileSync("app-graph.json", JSON.stringify({
            args: process.argv.slice(2), cwd: process.cwd(),
            bicep: process.env.BICEP, home: process.env.HOME,
            actions: process.env.GITHUB_ACTIONS,
            ambient: process.env.GRAPH_AMBIENT_MARKER ?? null
          }));
        `);
    expect(await runRadAppGraph(file, options)).toEqual({
      args: ["graph", file, "--include-icons"],
      cwd: options.isolation.cwd,
      bicep: process.execPath,
      home: directory,
      actions: "",
      ambient: null
    });
    expect(await readFile(file, "utf8")).toBe("extension radius\n");
  });

  it.each(["missing", "malformed", "nonzero"])(
    "fails on %s compiler output",
    async (kind) => {
      const { file, options } = await graphFixture(
        kind === "nonzero" ? "process.exit(19)"
        : kind === "malformed" ?
          "require('node:fs').writeFileSync('app-graph.json','{')"
        : ""
      );
      await expect(runRadAppGraph(file, options)).rejects.toThrow();
    }
  );
  it.each([
    null,
    {},
    { cacheRootDirectory: "outside" },
    {
      cacheRootDirectory: "outside",
      extensions: { radius: "host-only" }
    }
  ])("refuses an invalid toolchain baseline: %j", async (baseline) => {
    const { file, options } = await graphFixture(
      "throw new Error('must not launch')"
    );
    await writeFile(
      join(directory, "bicepconfig.json"),
      JSON.stringify(baseline)
    );
    await expect(runRadAppGraph(file, options)).rejects.toThrow(
      GraphIsolationError
    );
    expect(await readdir(options.isolation.cwd)).toEqual([
      "app",
      "literal ; definition.bicep"
    ]);
  });

  it.each(["", "relative", join(process.cwd(), "outside-profile")])(
    "refuses an unowned runtime home: %s",
    async (home) => {
      const { file, options } = await graphFixture("");
      options.isolation.env.HOME = home;
      await expect(runRadAppGraph(file, options)).rejects.toThrow(
        GraphIsolationError
      );
    }
  );

  it.runIf(process.platform === "win32")(
    "refuses captured configuration rather than restoring extensions into the OS user's native profile cache",
    async () => {
      const { file, options } = await graphFixture("");
      const config = '{"extensions":{"radius":"./types.tgz"}}';
      const nested = join(options.isolation.cwd, "module");
      await mkdir(nested);
      await writeFile(join(nested, "bicepconfig.json"), config);
      await expect(runRadAppGraph(file, options)).rejects.toThrow(
        GraphIsolationError
      );
      expect(await readFile(join(nested, "bicepconfig.json"), "utf8")).toBe(
        config
      );
    }
  );

  it("refuses source links before configuration traversal", async () => {
    const { file, options } = await graphFixture("");
    await symlink(
      directory,
      join(options.isolation.cwd, "escape"),
      process.platform === "win32" ? "junction" : "dir"
    );
    await expect(runRadAppGraph(file, options)).rejects.toThrow(
      GraphIsolationError
    );
  });
  it("refuses publication and implicit paths before starting a process", async () => {
    const { file, options } = await graphFixture(
      "throw new Error('must not start')"
    );
    for (const invalid of [
      { ...options, radPath: "" },
      {
        ...options,
        isolation: { ...options.isolation, bicepPath: "relative" }
      },
      { ...options, isolation: { ...options.isolation, cwd: "relative" } },
      { ...options, saveGraphJsonTo: join(directory, "published") }
    ])
      await expect(runRadAppGraph(file, invalid)).rejects.toThrow(TypeError);
    await expect(runRadAppGraph("relative.bicep", options)).rejects.toThrow(
      TypeError
    );
    await expect(
      runRadAppGraph(join(directory, "..", "outside.bicep"), options)
    ).rejects.toThrow(TypeError);
    expect(await readdir(options.isolation.cwd)).toEqual([
      "app",
      "literal ; definition.bicep"
    ]);
  });

  it("preserves a captured configuration already pinned to the exact owned cache", async () => {
    const { file, options } = await graphFixture(
      "require('node:fs').writeFileSync('app-graph.json', JSON.stringify({resources: []}));"
    );
    const config = JSON.stringify({
      cacheRootDirectory: join(directory, ".bicep"),
      analyzers: { core: { enabled: false } }
    });
    await writeFile(join(options.isolation.cwd, "bicepconfig.json"), config);
    expect(await runRadAppGraph(file, options)).toEqual({ resources: [] });
    expect(
      await readFile(join(options.isolation.cwd, "bicepconfig.json"), "utf8")
    ).toBe(config);
  });

  it("refuses a captured cache override outside owned storage", async () => {
    const { file, options } = await graphFixture("");
    await writeFile(
      join(options.isolation.cwd, "bicepconfig.json"),
      JSON.stringify({
        cacheRootDirectory: join(directory, "..", "host-cache")
      })
    );
    await expect(runRadAppGraph(file, options)).rejects.toThrow(
      GraphIsolationError
    );
  });

  it("cancels a running graph child before returning ownership for deletion", async () => {
    const { file, options } = await graphFixture(
      "require('node:fs').writeFileSync('child.pid',String(process.pid));setInterval(()=>{},1000)"
    );
    const controller = new AbortController();
    const pending = runRadAppGraph(file, {
      ...options,
      signal: controller.signal
    });
    const rejection = expect(pending).rejects.toMatchObject({
      name: "AbortError"
    });
    await vi.waitFor(async () =>
      expect(
        Number(await readFile(join(options.isolation.cwd, "child.pid"), "utf8"))
      ).toBeGreaterThan(0)
    );
    controller.abort();
    await rejection;
    const pid = Number(
      await readFile(join(options.isolation.cwd, "child.pid"), "utf8")
    );
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
