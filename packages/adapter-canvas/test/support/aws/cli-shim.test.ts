import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cliExec } from "../../../src/gh.js";
import { installCliShim, type CliAnswer, type CliShim } from "./cli-shim.js";

// Production's own spawn code, with the shim on PATH. On Windows a bare `gh`
// launches `gh.exe` and a bare `aws` reaches `aws.cmd` through cmd.exe, so
// these run the interception production depends on.

let shim: CliShim | null = null;

afterEach(async () => {
  await shim?.restore();
  shim = null;
});

function run(
  command: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    cliExec(command, args, { timeout: 15000 }, (error, stdout, stderr) => {
      const code = error?.code;
      resolve({
        code:
          typeof code === "number" ? code
          : error ? 1
          : 0,
        stdout,
        stderr
      });
    });
  });
}

// Records each call and answers with `answer`.
function recording(answer: CliAnswer) {
  const calls: string[][] = [];
  return {
    calls,
    handler: async (args: string[]) => {
      calls.push(args);
      return answer;
    }
  };
}

const unexpected = async (args: string[]): Promise<CliAnswer> => {
  throw new Error(`unexpected call ${args.join(" ")}`);
};

// Arguments a shell or cmd.exe would change if anything re-parsed them.
const TRICKY = [
  "api",
  "--paginate",
  "/repos/octo/shop/environments/dev/variables?per_page=100",
  "--jq",
  '.variables[] | .name + "\\t" + (.value // "")',
  "has space & %PATH% ^caret"
];

describe("the CLI shim through production cliExec", () => {
  it("forwards a bare gh call, with its arguments, output, and exit code", async () => {
    const gh = recording({ code: 4, stdout: "out", stderr: "err" });
    shim = await installCliShim({ aws: unexpected, gh: gh.handler });

    expect(await run("gh", TRICKY)).toEqual({
      code: 4,
      stdout: "out",
      stderr: "err"
    });
    expect(gh.calls).toEqual([TRICKY]);
  });

  it("forwards a bare aws call", async () => {
    const aws = recording({ code: 0, stdout: '{"Account":"1"}', stderr: "" });
    shim = await installCliShim({ aws: aws.handler, gh: unexpected });

    expect(await run("aws", ["sts", "get-caller-identity"])).toMatchObject({
      code: 0,
      stdout: '{"Account":"1"}'
    });
    expect(aws.calls).toEqual([["sts", "get-caller-identity"]]);
  });

  it("forwards a call to the gh.exe Windows production launches, on any platform", async () => {
    const gh = recording({ code: 0, stdout: "native", stderr: "" });
    shim = await installCliShim(
      { aws: unexpected, gh: gh.handler },
      { nativeGh: true }
    );

    expect(await run(path.join(shim.bin, "gh.exe"), TRICKY)).toMatchObject({
      code: 0,
      stdout: "native"
    });
    expect(gh.calls).toEqual([TRICKY]);
  });

  it("answers a flag Node owns from the gh.exe copy of Node, never an installed GitHub CLI", async () => {
    shim = await installCliShim(
      { aws: unexpected, gh: unexpected },
      { nativeGh: true }
    );

    const version = await run(path.join(shim.bin, "gh.exe"), ["--version"]);

    expect(version.stdout.trim()).toBe(process.version);
  });

  it("fails a call the fakes have no answer for, and every call once refused", async () => {
    shim = await installCliShim({ aws: unexpected, gh: unexpected });

    expect((await run("gh", ["api", "user"])).code).not.toBe(0);
    expect(shim.errors).toEqual(["gh api user: unexpected call api user"]);
    shim.refuseAll();
    expect(await run("aws", ["sts", "get-caller-identity"])).toMatchObject({
      code: 3,
      stderr: "The test is over."
    });
  });

  it("hides GitHub credentials and config while installed, and puts them back", async () => {
    const before = {
      GH_TOKEN: process.env.GH_TOKEN,
      GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
      NODE_OPTIONS: process.env.NODE_OPTIONS
    };
    process.env.GH_TOKEN = "synthetic-test-value";
    try {
      shim = await installCliShim({ aws: unexpected, gh: unexpected });
      expect(process.env.GH_TOKEN).toBeUndefined();
      expect(await fs.readdir(process.env.GH_CONFIG_DIR ?? "")).toEqual([]);
      await shim.restore();
      shim = null;
      expect(process.env.GH_TOKEN).toBe("synthetic-test-value");
      expect(process.env.GH_CONFIG_DIR).toBe(before.GH_CONFIG_DIR);
      expect(process.env.NODE_OPTIONS).toBe(before.NODE_OPTIONS);
    } finally {
      if (before.GH_TOKEN === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = before.GH_TOKEN;
    }
  });
});
