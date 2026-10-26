import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MARKETPLACE_NAME,
  PLUGIN_SOURCE,
  stageMarketplace
} from "../../../../scripts/copilot-cli-modeling/marketplace.mjs";
import { redactSecrets } from "../../../../scripts/copilot-cli-modeling/redact.mjs";
import {
  checkoutCommands,
  excludeTargets,
  parseCaseYaml,
  repositoryName,
  sessionRoot
} from "../../../../scripts/copilot-cli-modeling/sample.mjs";
import { summarizeSessionEvents } from "../../../../scripts/copilot-cli-modeling/session.mjs";
import { retry } from "../../../../scripts/copilot-cli-modeling/retry.mjs";

const COMMIT = "16f88a13365c84d7929b957cad8613ca7bc66387";

/** A clock whose sleep records the delay and returns at once. */
function fakeClock() {
  const sleeps = [];

  return {
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms);
    }
  };
}

const temporaryDirectories = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "copilot-cli-modeling-"));
  temporaryDirectories.push(directory);

  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("parseCaseYaml", () => {
  it("reads a case without a path", () => {
    expect(
      parseCaseYaml(
        `source:\n  repo: https://github.com/sosedoff/pgweb\n  commit: ${COMMIT}\n`
      )
    ).toEqual({
      repo: "https://github.com/sosedoff/pgweb",
      commit: COMMIT,
      path: undefined,
      exclude: []
    });
  });

  it("reads a path, an exclude list, comments, and a .git suffix", () => {
    const sample = parseCaseYaml(
      [
        "# A sample in a monorepo",
        "source:",
        "  repo: https://github.com/radius-project/samples.git",
        `  commit: ${COMMIT}  # v0.40`,
        "  path: samples/demo/",
        "  exclude:",
        "    - .radius",
        '    - "deploy/app.bicep"',
        ""
      ].join("\n")
    );

    expect(sample).toEqual({
      repo: "https://github.com/radius-project/samples",
      commit: COMMIT,
      path: "samples/demo",
      exclude: [".radius", "deploy/app.bicep"]
    });
  });

  it.each([
    ["an unknown key", `source:\n  branch: main\n  commit: ${COMMIT}`],
    ["a top-level key other than source", `case:\n  commit: ${COMMIT}`],
    ["a duplicate key", `source:\n  commit: ${COMMIT}\n  commit: ${COMMIT}`],
    ["an exclude item without exclude", `source:\n    - .radius`]
  ])("rejects %s", (_name, text) => {
    expect(() => parseCaseYaml(text)).toThrow(/not supported/);
  });

  it.each([
    [
      "a short commit",
      "source:\n  repo: https://github.com/a/b\n  commit: 16f88a1",
      /full commit SHA/
    ],
    [
      "a repository outside github.com",
      `source:\n  repo: https://example.com/a/b\n  commit: ${COMMIT}`,
      /source\.repo/
    ],
    [
      "a path that leaves the sample",
      `source:\n  repo: https://github.com/a/b\n  commit: ${COMMIT}\n  path: ../x`,
      /relative path/
    ],
    [
      "an absolute exclude path",
      `source:\n  repo: https://github.com/a/b\n  commit: ${COMMIT}\n  exclude:\n    - /etc`,
      /relative path/
    ],
    [
      "an empty exclude list",
      `source:\n  repo: https://github.com/a/b\n  commit: ${COMMIT}\n  exclude:`,
      /at least one path/
    ],
    ["an empty file", "", /no source section/]
  ])("rejects %s", (_name, text, message) => {
    expect(() => parseCaseYaml(text)).toThrow(message);
  });
});

describe("the trial checkout", () => {
  const sample = {
    repo: "https://github.com/radius-project/samples",
    commit: COMMIT,
    path: "samples/demo",
    exclude: [".radius"]
  };

  it("runs the git commands of the dataset protocol, in order", () => {
    expect(checkoutCommands(sample, "/work/samples")).toEqual([
      ["init", "-q", "/work/samples"],
      [
        "-C",
        "/work/samples",
        "remote",
        "add",
        "origin",
        "https://github.com/radius-project/samples"
      ],
      [
        "-C",
        "/work/samples",
        "sparse-checkout",
        "set",
        "--no-cone",
        "/samples/demo/"
      ],
      ["-C", "/work/samples", "fetch", "-q", "--depth", "1", "origin", COMMIT],
      ["-C", "/work/samples", "checkout", "-q", "FETCH_HEAD"]
    ]);
  });

  it("skips the sparse checkout when the case has no path", () => {
    const commands = checkoutCommands(
      { ...sample, path: undefined },
      "/work/samples"
    );

    expect(commands.flat()).not.toContain("sparse-checkout");
  });

  it("starts the session in source.path and resolves excludes from there", () => {
    const root = sessionRoot(sample, "/work/samples");
    expect(root).toBe(path.join("/work/samples", "samples/demo"));
    expect(excludeTargets(sample, root)).toEqual([path.join(root, ".radius")]);
  });

  it("names the checkout after the repository", () => {
    expect(repositoryName(sample)).toBe("samples");
  });
});

describe("redactSecrets", () => {
  it("removes GitHub tokens and the given secrets", () => {
    const text = `a ghp_${"a".repeat(36)} b github_pat_${"B".repeat(30)} c ghs_${"c".repeat(36)} d my-secret-value`;
    expect(redactSecrets(text, ["my-secret-value", "short"])).toBe(
      "a ghp_[REDACTED] b github_pat_[REDACTED] c ghs_[REDACTED] d [REDACTED]"
    );
  });

  it("ignores secrets too short to redact safely", () => {
    expect(redactSecrets("abc def", ["abc"])).toBe("abc def");
  });
});

describe("retry", () => {
  it("returns the first success and waits longer after each failure", async () => {
    const clock = fakeClock();
    const retried = [];
    let calls = 0;

    const value = await retry(
      () => {
        if (++calls < 3) throw new Error(`failure ${calls}`);

        return "fetched";
      },
      {
        attempts: 3,
        delayMs: 1_000,
        onRetry: (error, attempt) => retried.push([error.message, attempt])
      },
      clock
    );

    expect(value).toBe("fetched");
    expect(retried).toEqual([
      ["failure 1", 1],
      ["failure 2", 2]
    ]);
    expect(clock.sleeps).toEqual([1_000, 2_000]);
  });

  it("throws the last error when every attempt fails", async () => {
    const clock = fakeClock();
    let calls = 0;

    await expect(
      retry(
        () => {
          throw new Error(`failure ${++calls}`);
        },
        { attempts: 2, delayMs: 1_000 },
        clock
      )
    ).rejects.toThrow("failure 2");
    expect(calls).toBe(2);
    expect(clock.sleeps).toEqual([1_000]);
  });
});

describe("summarizeSessionEvents", () => {
  const jsonl = (events) =>
    events.map((event) => JSON.stringify(event)).join("\n");

  it("summarizes a completed session and skips a partial last line", () => {
    const events = [
      { type: "session.start", data: { selectedModel: "model-a" } },
      { type: "assistant.message", data: { model: "model-a", content: "a" } },
      { type: "skill.invoked", data: { name: "radius-app-bicep" } },
      { type: "skill.invoked", data: { name: "radius-app-bicep" } },
      { type: "tool.execution_start", data: { toolName: "bash" } },
      { type: "tool.execution_start", data: { toolName: "bash" } },
      { type: "tool.execution_start", data: { toolName: "view" } },
      { type: "assistant.message", data: { model: "model-b", content: "b" } },
      { type: "session.task_complete", data: { summary: "Wrote app.bicep." } }
    ];

    expect(summarizeSessionEvents(`${jsonl(events)}\n{"type":`)).toEqual({
      state: { kind: "completed" },
      models: ["model-a", "model-b"],
      skills: ["radius-app-bicep"],
      tools: { bash: 2, view: 1 },
      usage: {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        apiDurationMs: 0
      },
      finalReply: "Wrote app.bicep."
    });
  });

  it("adds up the tokens and API time of every model call", () => {
    const summary = summarizeSessionEvents(
      jsonl([
        {
          type: "session.usage_record",
          data: {
            usage: {
              inputTokens: 16420,
              outputTokens: 24,
              cacheReadTokens: 0,
              cacheWriteTokens: 16417,
              reasoningTokens: 3,
              duration: 2105
            }
          }
        },
        {
          type: "session.usage_record",
          data: { usage: { inputTokens: 16470, outputTokens: "5" } }
        },
        { type: "session.usage_record", data: {} }
      ])
    );

    expect(summary.usage).toEqual({
      calls: 2,
      inputTokens: 32890,
      outputTokens: 24,
      cacheReadTokens: 0,
      cacheWriteTokens: 16417,
      reasoningTokens: 3,
      apiDurationMs: 2105
    });
  });

  it("names a plugin's skill after its plugin, so a project skill cannot pass for it", () => {
    const summary = summarizeSessionEvents(
      jsonl([
        {
          type: "skill.invoked",
          data: { name: "radius-app-bicep", pluginName: "radius" }
        },
        {
          type: "skill.invoked",
          data: { name: "radius-app-bicep", pluginName: " " }
        }
      ])
    );

    expect(summary.skills).toEqual([
      "radius:radius-app-bicep",
      "radius-app-bicep"
    ]);
  });

  it("reports a session without an end event as running", () => {
    const summary = summarizeSessionEvents(
      jsonl([
        { type: "assistant.message", data: { model: "m", content: "Working" } }
      ])
    );

    expect(summary.state).toEqual({ kind: "running" });
    expect(summary.finalReply).toBe("Working");
  });

  it("ends on a session error and reports its message", () => {
    const summary = summarizeSessionEvents(
      jsonl([{ type: "session.error", data: { message: "Quota exceeded" } }])
    );

    expect(summary.state).toEqual({ kind: "failed", error: "Quota exceeded" });
  });

  it("uses the last assistant message when the completion has no summary", () => {
    const summary = summarizeSessionEvents(
      jsonl([
        { type: "assistant.message", data: { content: "first" } },
        { type: "assistant.message", data: { content: "last" } },
        { type: "assistant.message", data: { content: " " } },
        { type: "session.task_complete", data: {} }
      ])
    );

    expect(summary.finalReply).toBe("last");
  });
});

describe("stageMarketplace", () => {
  it("copies the plugin into a one-plugin marketplace", async () => {
    const root = await temporaryDirectory();
    const pluginDir = path.join(root, "plugin");
    await mkdir(path.join(pluginDir, "skills"), { recursive: true });
    await writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "radius", version: "1.2.3" })
    );
    await writeFile(path.join(pluginDir, "skills", "SKILL.md"), "skill");
    const marketplaceDir = path.join(root, "marketplace");
    await stageMarketplace({ pluginDir, marketplaceDir });

    const manifest = await readFile(
      path.join(marketplaceDir, ".github", "plugin", "marketplace.json"),
      "utf8"
    );

    expect(JSON.parse(manifest)).toMatchObject({
      name: MARKETPLACE_NAME,
      plugins: [expect.objectContaining({ name: "radius", source: "./radius" })]
    });
    expect(PLUGIN_SOURCE).toBe(`radius@${MARKETPLACE_NAME}`);
    expect(
      await readFile(
        path.join(marketplaceDir, "radius", "skills", "SKILL.md"),
        "utf8"
      )
    ).toBe("skill");
  });

  it("rejects a plugin with another name", async () => {
    const root = await temporaryDirectory();
    await writeFile(
      path.join(root, "plugin.json"),
      JSON.stringify({ name: "other" })
    );
    await expect(
      stageMarketplace({
        pluginDir: root,
        marketplaceDir: path.join(root, "m")
      })
    ).rejects.toThrow(/radius/);
  });

  it("reports a malformed manifest without asking for a build", async () => {
    const root = await temporaryDirectory();
    await writeFile(path.join(root, "plugin.json"), "[]");
    const staging = stageMarketplace({
      pluginDir: root,
      marketplaceDir: path.join(root, "m")
    });

    await expect(staging).rejects.toThrow("plugin.json is not a JSON object.");
    await expect(staging).rejects.not.toThrow(/pnpm build/);
  });

  it("asks for a build when the plugin is missing", async () => {
    const root = await temporaryDirectory();
    await expect(
      stageMarketplace({
        pluginDir: path.join(root, "missing"),
        marketplaceDir: path.join(root, "m")
      })
    ).rejects.toThrow(/pnpm build/);
  });
});
