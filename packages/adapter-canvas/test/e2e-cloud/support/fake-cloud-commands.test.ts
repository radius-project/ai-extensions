import { describe, it, expect } from "vitest";
import {
  argsMatch,
  createFakeCloudCommands,
  createFakeFixturePorts
} from "./fake-cloud-commands.js";

describe("argsMatch", () => {
  it.each([
    ["an exact argv", ["ad", "app", "list"], ["ad", "app", "list"], true],
    [
      "tokens separated by flags",
      ["ad", "app", "list", "--display-name", "x"],
      ["ad", "app", "list"],
      true
    ],
    ["an empty match, which matches anything", ["group", "create"], [], true],
    [
      "tokens present but out of order",
      ["app", "ad", "list"],
      ["ad", "app", "list"],
      false
    ],
    ["a missing token", ["ad", "app"], ["ad", "app", "list"], false],
    ["an empty argv against a real match", [], ["ad"], false]
  ])("matches %s", (_label, args, match, expected) => {
    expect(argsMatch(args, match)).toBe(expected);
  });
});

describe("createFakeCloudCommands", () => {
  it("returns the stubbed result for a matching invocation", async () => {
    const fake = createFakeCloudCommands([
      { tool: "az", match: ["group", "create"], respond: { stdout: "{}" } }
    ]);

    await expect(
      fake.port.runAz(["group", "create", "-n", "radtest-canvas-a"])
    ).resolves.toEqual({ code: 0, stdout: "{}", stderr: "" });
  });

  it("fills in a zero exit and empty streams the stub left out", async () => {
    const fake = createFakeCloudCommands([
      { tool: "gh", match: ["api"], respond: {} }
    ]);

    await expect(fake.port.runGh(["api", "repos/o/r"])).resolves.toEqual({
      code: 0,
      stdout: "",
      stderr: ""
    });
  });

  it("throws on an operation no stub declared, naming the argv", async () => {
    const fake = createFakeCloudCommands([
      { tool: "az", match: ["group", "create"], respond: {} }
    ]);

    await expect(fake.port.runAz(["aks", "create"])).rejects.toThrow(
      "The cloud command fake has no stub for: az aks create"
    );
  });

  it("lists the declared stubs so an unmatched call is diagnosable", async () => {
    const fake = createFakeCloudCommands([
      { tool: "az", match: ["group", "create"], respond: {} }
    ]);

    await expect(fake.port.runGh(["api"])).rejects.toThrow(
      "Declared stubs: az group create"
    );
  });

  it("reports having no stubs at all rather than an empty list", async () => {
    const fake = createFakeCloudCommands([]);

    await expect(fake.port.runAz(["version"])).rejects.toThrow(
      "Declared stubs: (none)"
    );
  });

  it("does not match a stub declared for a different tool", async () => {
    const fake = createFakeCloudCommands([
      { tool: "az", match: ["api"], respond: {} }
    ]);

    await expect(fake.port.runGh(["api"])).rejects.toThrow(
      "no stub for: gh api"
    );
  });

  it("derives a response from the actual argv when the stub is a function", async () => {
    const fake = createFakeCloudCommands([
      {
        tool: "gh",
        match: ["api"],
        respond: (args) => ({ stdout: args[args.length - 1] })
      }
    ]);

    await expect(fake.port.runGh(["api", "repos/o/r"])).resolves.toMatchObject({
      stdout: "repos/o/r"
    });
  });

  it("consumes a limited stub and falls through to a later one", async () => {
    const fake = createFakeCloudCommands([
      {
        tool: "az",
        match: ["ad", "app", "list"],
        respond: { stdout: "[]" },
        times: 1
      },
      {
        tool: "az",
        match: ["ad", "app", "list"],
        respond: { stdout: '[{"appId":"a"}]' }
      }
    ]);

    await expect(fake.port.runAz(["ad", "app", "list"])).resolves.toMatchObject(
      {
        stdout: "[]"
      }
    );
    await expect(fake.port.runAz(["ad", "app", "list"])).resolves.toMatchObject(
      {
        stdout: '[{"appId":"a"}]'
      }
    );
  });

  it("throws once a limited stub is exhausted with nothing behind it", async () => {
    const fake = createFakeCloudCommands([
      { tool: "az", match: ["version"], respond: {}, times: 1 }
    ]);

    await fake.port.runAz(["version"]);
    await expect(fake.port.runAz(["version"])).rejects.toThrow("no stub for");
  });

  it("records every invocation, including ones that found no stub", async () => {
    const fake = createFakeCloudCommands([
      { tool: "az", match: ["version"], respond: {} }
    ]);

    await fake.port.runAz(["version"]);
    await expect(fake.port.runGh(["api"])).rejects.toThrow();

    expect(fake.calls).toEqual([
      { tool: "az", args: ["version"], cwd: undefined },
      { tool: "gh", args: ["api"], cwd: undefined }
    ]);
  });

  it("records the working directory a git invocation ran in", async () => {
    const fake = createFakeCloudCommands([
      { tool: "git", match: ["status"], respond: {} }
    ]);

    await fake.port.runGit(["status"], "/tmp/clone");

    expect(fake.calls[0]).toEqual({
      tool: "git",
      args: ["status"],
      cwd: "/tmp/clone"
    });
  });

  it("copies the argv so a caller cannot mutate the recording", async () => {
    const fake = createFakeCloudCommands([
      { tool: "az", match: ["version"], respond: {} }
    ]);
    const args = ["version"];

    await fake.port.runAz(args);
    args.push("--mutated");

    expect(fake.calls[0].args).toEqual(["version"]);
  });

  it("summarises invocations per tool as readable command lines", async () => {
    const fake = createFakeCloudCommands([
      { tool: "az", match: [], respond: {} },
      { tool: "gh", match: [], respond: {} }
    ]);

    await fake.port.runAz(["group", "create", "-n", "rg"]);
    await fake.port.runGh(["api", "repos/o/r"]);

    expect(fake.commandLines("az")).toEqual(["group create -n rg"]);
    expect(fake.commandLines("gh")).toEqual(["api repos/o/r"]);
    expect(fake.commandLines("git")).toEqual([]);
  });
});

describe("createFakeFixturePorts", () => {
  it("pins the clock, the run id, and the workspace directory", async () => {
    const fake = createFakeFixturePorts();

    expect(fake.ports.now().toISOString()).toBe("2026-08-29T00:00:00.000Z");
    expect(fake.ports.newUniqueId()).toBe("run0000000a");
    expect(fake.ports.newUniqueId()).toBe("run0000000a");
    await expect(fake.ports.makeWorkspaceDir("radtest")).resolves.toBe(
      "/tmp/radtest-workspace"
    );
  });

  it("honours overridden values", async () => {
    const fake = createFakeFixturePorts({
      uniqueId: "custom01",
      now: new Date("2030-01-02T03:04:05.000Z"),
      workspaceDir: "/clones/one"
    });

    expect(fake.ports.newUniqueId()).toBe("custom01");
    expect(fake.ports.now().toISOString()).toBe("2030-01-02T03:04:05.000Z");
    await expect(fake.ports.makeWorkspaceDir("x")).resolves.toBe("/clones/one");
  });

  it("records directories the fixture asked to remove", async () => {
    const fake = createFakeFixturePorts();

    await fake.ports.removeDir("/clones/one");
    await fake.ports.removeDir("/clones/two");

    expect(fake.removed).toEqual(["/clones/one", "/clones/two"]);
  });

  it("lets a test substitute failing filesystem ports", async () => {
    const fake = createFakeFixturePorts({
      makeWorkspaceDir: () => Promise.reject(new Error("no space")),
      removeDir: () => Promise.reject(new Error("locked"))
    });

    await expect(fake.ports.makeWorkspaceDir("x")).rejects.toThrow("no space");
    await expect(fake.ports.removeDir("/x")).rejects.toThrow("locked");
  });

  it("exposes the command fake, which still throws on unstubbed operations", async () => {
    const fake = createFakeFixturePorts({
      stubs: [{ tool: "az", match: ["version"], respond: { stdout: "ok" } }]
    });

    await expect(fake.ports.commands.runAz(["version"])).resolves.toMatchObject(
      {
        stdout: "ok"
      }
    );
    await expect(
      fake.ports.commands.runAz(["group", "create"])
    ).rejects.toThrow("no stub for");
    expect(fake.commands.commandLines("az")).toEqual([
      "version",
      "group create"
    ]);
  });
});
