import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type PresentGraphSource } from "@radius-project/core";
import {
  stageGraphArtifacts,
  type GraphArtifactPorts
} from "./graph-artifacts.js";
import type { GraphBytesRead } from "./graph-source-bindings.js";
import { writeBicepCompileConfig } from "./rad.js";

const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(
    path.join(process.cwd(), ".graph-artifacts-test-")
  );
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

const present = (value: string | Buffer): GraphBytesRead => ({
  status: "present",
  bytes: Buffer.from(value)
});
const selection = (
  definitionPath = ".radius/app.bicep"
): PresentGraphSource => ({
  status: "present",
  content: "model",
  source: {
    kind: "github",
    repo: "owner/repository",
    ref: "branch",
    revision: "a".repeat(40),
    definitionPath
  }
});
function harness(root: string, values: Record<string, GraphBytesRead>) {
  const calls: string[] = [];
  const ports: GraphArtifactPorts = {
    stagingRoot: path.join(root, "staging"),
    redactDiagnostic: (message) =>
      message.replace("private-detail", "[redacted]"),
    async readBytes(source, file) {
      expect(source.revision).toBe("a".repeat(40));
      calls.push(file);
      if (!(file in values))
        throw new Error(`Unexpected artifact read: ${file}`);
      return values[file];
    }
  };
  return { ports, calls };
}

describe("graph artifact staging", () => {
  it("preserves binary extension bytes, nested paths and root model layout", async () => {
    const root = await fixture();
    const bytes = Buffer.from([0, 255, 254, 128, 31, 139]);
    const config = JSON.stringify({
      extensions: {
        custom: "./nested/custom.tgz",
        radius: "br:registry/radius:v1",
        another: "oci:registry/other:v1"
      }
    });
    const { ports, calls } = harness(root, {
      "bicepconfig.json": present(config),
      "nested/custom.tgz": present(bytes)
    });
    const staged = await stageGraphArtifacts(selection("app.bicep"), ports);
    expect(staged.owned).toBe(true);
    expect(staged.dir.startsWith(ports.stagingRoot + path.sep)).toBe(true);
    expect(
      await fs.readFile(path.join(staged.dir, "nested", "custom.tgz"))
    ).toEqual(bytes);
    expect(
      await fs.readFile(path.join(staged.dir, "bicepconfig.json"), "utf8")
    ).toBe(config);
    expect(calls).toEqual(["bicepconfig.json", "nested/custom.tgz"]);
    await staged.dispose();
    await staged.dispose();
    expect(await fs.readdir(ports.stagingRoot)).toEqual([]);
  });

  it("does not acquire a directory when optional config is confirmed absent", async () => {
    const root = await fixture();
    const { ports } = harness(root, {
      ".radius/bicepconfig.json": { status: "absent" }
    });
    const staged = await stageGraphArtifacts(selection(), ports);
    expect(staged).toMatchObject({ owned: false, dir: "" });
    await staged.dispose();
    await expect(fs.stat(ports.stagingRoot)).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it.each([
    ["unreadable", { status: "unavailable", diagnostic: "private-detail" }],
    ["empty", present("")],
    ["malformed", present("{")],
    ["unterminated comment", present("{ /* unfinished")],
    ["missing value", present('{"extensions":{"custom":,}}')],
    [
      "incomplete recovered object",
      present('{"extensions":{"custom":"types.tgz",}')
    ],
    ["trailing garbage", present("{} garbage")],
    ["null", present("null")],
    ["array", present("[]")],
    ["invalid extensions", present('{"extensions":null}')],
    ["array extensions", present('{"extensions":[]}')],
    ["non-string reference", present('{"extensions":{"x":23}}')]
  ] satisfies Array<[string, GraphBytesRead]>)(
    "fails explicitly for %s config instead of treating it as optional",
    async (_name, config) => {
      const root = await fixture();
      const { ports } = harness(root, { ".radius/bicepconfig.json": config });
      await expect(
        stageGraphArtifacts(selection(), ports)
      ).rejects.toMatchObject({ code: "invalid-artifact" });
      await expect(fs.stat(ports.stagingRoot)).rejects.toMatchObject({
        code: "ENOENT"
      });
    }
  );

  it.each(["", " \n", "  br:registry/radius:v1  ", "  ./types.tgz  "])(
    "stages supported aliases and compiles the Radius pin %j",
    async (radius) => {
      const root = await fixture();
      const config = `// captured JSONC\n${JSON.stringify({
        extensions: {
          radius,
          empty: "",
          blank: " \t",
          az: "builtin:",
          sys: "BUILTIN:sys",
          remote: "oci:registry/other:v1",
          local: "types.tgz"
        }
      })}`;
      const { ports, calls } = harness(root, {
        ".radius/bicepconfig.json": present(config),
        ".radius/types.tgz": present("types")
      });
      const staged = await stageGraphArtifacts(selection(), ports);
      try {
        expect(
          await fs.readFile(path.join(staged.dir, "bicepconfig.json"), "utf8")
        ).toBe(config);
        const output = path.join(root, "compile");
        await fs.mkdir(output);
        const logs: string[] = [];
        const compiled = writeBicepCompileConfig(
          output,
          staged.dir,
          (message) => logs.push(message),
          "br:registry/radius:fallback"
        );
        expect(compiled.extensions.radius).toBe(
          radius.trim() || "br:registry/radius:fallback"
        );
        expect(compiled.extensions.az).toBe("builtin:");
        expect(await fs.readFile(path.join(output, "types.tgz"), "utf8")).toBe(
          "types"
        );
        expect(logs.some((message) => message.startsWith("Warning:"))).toBe(
          false
        );
        expect(calls).toEqual([
          ".radius/bicepconfig.json",
          ".radius/types.tgz"
        ]);
      } finally {
        await staged.dispose();
      }
    }
  );

  it("does not trim non-Radius artifact references", async () => {
    const root = await fixture();
    const { ports, calls } = harness(root, {
      ".radius/bicepconfig.json": present(
        '{"extensions":{"custom":" types.tgz "}}'
      ),
      ".radius/ types.tgz ": { status: "absent" }
    });
    await expect(stageGraphArtifacts(selection(), ports)).rejects.toThrow(
      "absent"
    );
    expect(calls).toContain(".radius/ types.tgz ");
  });

  it.each([
    "../escape.tgz",
    "/absolute.tgz",
    "C:\\outside.tgz",
    "nested\\artifact.tgz",
    "a//b",
    "a/./b",
    "bad\0path",
    "bicepconfig.json",
    "./"
  ])("rejects unsafe extension artifact %j", async (ref) => {
    const root = await fixture();
    const { ports, calls } = harness(root, {
      ".radius/bicepconfig.json": present(
        JSON.stringify({ extensions: { custom: ref } })
      )
    });

    await expect(stageGraphArtifacts(selection(), ports)).rejects.toMatchObject(
      { code: "invalid-artifact" }
    );
    expect(calls).toEqual([".radius/bicepconfig.json"]);
  });

  it
    .runIf(process.platform === "win32")
    .each([
      { custom: "BicepConfig.json" },
      { first: "Types.tgz", second: "types.tgz" },
      { first: "types.tgz", second: "types.tgz." }
    ])(
    "rejects Windows destination aliases %j before writing",
    async (extensions) => {
      const root = await fixture();
      const { ports } = harness(root, {
        ".radius/bicepconfig.json": present(JSON.stringify({ extensions })),
        ".radius/Types.tgz": present("first"),
        ".radius/types.tgz": present("first")
      });
      await expect(
        stageGraphArtifacts(selection(), ports)
      ).rejects.toMatchObject({
        code: "invalid-artifact",
        message: expect.stringContaining("Conflicting")
      });
      await expect(fs.stat(ports.stagingRoot)).rejects.toMatchObject({
        code: "ENOENT"
      });
    }
  );

  it
    .runIf(process.platform === "win32")
    .each(["nested/.. /types.tgz", "nested/types.tgz:stream"])(
    "rejects unsafe Windows artifact path %j before reading",
    async (ref) => {
      const root = await fixture();
      const { ports, calls } = harness(root, {
        ".radius/bicepconfig.json": present(
          JSON.stringify({ extensions: { custom: ref } })
        )
      });
      await expect(
        stageGraphArtifacts(selection(), ports)
      ).rejects.toMatchObject({
        code: "invalid-artifact",
        message: expect.stringContaining("Unsafe")
      });
      expect(calls).toEqual([".radius/bicepconfig.json"]);
    }
  );

  it("distinguishes content changes across adjacent artifact boundaries", async () => {
    const root = await fixture();
    const marker = "secondsecond.tgz";
    const values = {
      ".radius/bicepconfig.json": present(
        '{"extensions":{"first":"first.tgz","second":"second.tgz"}}'
      ),
      ".radius/first.tgz": present(`a${marker}`),
      ".radius/second.tgz": present("b")
    };
    const { ports } = harness(root, values);
    const first = await stageGraphArtifacts(selection(), ports);
    values[".radius/first.tgz"] = present("a");
    values[".radius/second.tgz"] = present(`${marker}b`);
    const second = await stageGraphArtifacts(selection(), ports);
    expect(first.fingerprint).not.toBe(second.fingerprint);
    await Promise.all([first.dispose(), second.dispose()]);
  });
  it.each([
    { status: "absent" },
    { status: "unavailable", diagnostic: "private-detail" }
  ] satisfies GraphBytesRead[])(
    "fails closed for required artifact %j",
    async (artifact) => {
      const root = await fixture();
      const { ports } = harness(root, {
        ".radius/bicepconfig.json": present(
          '{"extensions":{"custom":"types.tgz"}}'
        ),
        ".radius/types.tgz": artifact
      });
      await expect(
        stageGraphArtifacts(selection(), ports)
      ).rejects.toMatchObject({
        code: "invalid-artifact",
        message:
          artifact.status === "unavailable" ?
            "[redacted]"
          : expect.stringContaining("absent")
      });
    }
  );

  it("removes a partially staged directory when conflicting artifact paths fail to write", async () => {
    const root = await fixture();
    const { ports } = harness(root, {
      ".radius/bicepconfig.json": present(
        '{"extensions":{"first":"nested","second":"nested/types.tgz"}}'
      ),
      ".radius/nested": present("file"),
      ".radius/nested/types.tgz": present("binary")
    });
    await expect(stageGraphArtifacts(selection(), ports)).rejects.toMatchObject(
      { code: "unavailable", cause: { code: "EEXIST" } }
    );
    expect(await fs.readdir(ports.stagingRoot)).toEqual([]);
  });

  it.each(["app.bicep", ".radius/app.bicep"])(
    "keeps a no-config workspace result empty for %s without borrowing mutable files",
    async (definitionPath) => {
      const root = await fixture();
      const model = path.join(root, definitionPath);
      await fs.mkdir(path.dirname(model), { recursive: true });
      await fs.writeFile(model, "saved");
      const { ports } = harness(root, {
        [path.posix.join(
          path.posix.dirname(definitionPath),
          "bicepconfig.json"
        )]: { status: "absent" }
      });
      const input = selection(definitionPath);
      input.source = {
        ...input.source,
        kind: "workspace",
        workspacePath: root
      };
      const staged = await stageGraphArtifacts(input, ports);
      expect(staged).toMatchObject({
        owned: false,
        dir: ""
      });
      await fs.writeFile(
        path.join(path.dirname(model), "bicepconfig.json"),
        "{}"
      );
      await staged.dispose();
      expect(await fs.readFile(model, "utf8")).toBe("saved");
      await expect(fs.stat(ports.stagingRoot)).rejects.toMatchObject({
        code: "ENOENT"
      });
    }
  );

  it("changes fingerprints when supporting binary content changes and isolates concurrent staging", async () => {
    const root = await fixture();
    const values = {
      ".radius/bicepconfig.json": present(
        '{"extensions":{"custom":"types.tgz"}}'
      ),
      ".radius/types.tgz": present(Buffer.from([0, 255]))
    };
    const { ports } = harness(root, values);
    const first = await stageGraphArtifacts(selection(), ports);
    values[".radius/types.tgz"] = present(Buffer.from([0, 254]));
    const [second, third] = await Promise.all([
      stageGraphArtifacts(selection(), ports),
      stageGraphArtifacts(selection(), ports)
    ]);
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(second.fingerprint).toBe(third.fingerprint);
    expect(new Set([first.dir, second.dir, third.dir]).size).toBe(3);
    await Promise.all([first.dispose(), second.dispose(), third.dispose()]);
    expect(await fs.readdir(ports.stagingRoot)).toEqual([]);
  });

  it.each(["diagnostic", "throwing-diagnostic", "no-diagnostic"])(
    "preserves partial-write failure when cleanup fails with %s",
    async (mode) => {
      const root = await fixture();
      const { ports } = harness(root, {
        ".radius/bicepconfig.json": present("{}")
      });
      const diagnostics: string[] = [];
      ports.files = {
        ...fs,
        async writeFile() {
          throw new Error("primary write failure");
        },
        async rm(target, options) {
          await fs.rm(target, options);
          throw new Error("cleanup failure");
        }
      };
      if (mode !== "no-diagnostic")
        ports.diagnostic = (message) => {
          diagnostics.push(message);
          if (mode === "throwing-diagnostic") throw new Error("logger failure");
        };
      await expect(stageGraphArtifacts(selection(), ports)).rejects.toThrow(
        "primary write failure"
      );
      expect(diagnostics).toHaveLength(mode === "no-diagnostic" ? 0 : 1);
      if (diagnostics.length)
        expect(diagnostics[0]).toContain("Graph staging cleanup failed");
      expect(await fs.readdir(ports.stagingRoot)).toEqual([]);
    }
  );

  it("reports external reader exceptions as typed unavailability", async () => {
    const root = await fixture();
    const { ports } = harness(root, {});
    ports.readBytes = async () => {
      throw "reader unavailable";
    };
    await expect(stageGraphArtifacts(selection(), ports)).rejects.toMatchObject(
      {
        code: "unavailable",
        message: "reader unavailable",
        cause: "reader unavailable"
      }
    );
  });
});
