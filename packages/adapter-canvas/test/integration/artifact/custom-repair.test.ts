import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repository = path.resolve(import.meta.dirname, "../../../../..");
const scripts = path.join(
  repository,
  ".artifacts/radius/skills/radius-app-bicep/scripts"
);
const compiler = process.env.RADIUS_REPAIR_TEST_BICEP;
if (process.env.RADIUS_REQUIRE_REPAIR_COMPILER === "1" && !compiler)
  throw new Error(
    "The required checksummed repair-test compiler was not installed."
  );

describe.runIf(Boolean(compiler))(
  "packaged custom repair with real offline Bicep",
  () => {
    it.each([false, true])(
      "preserves dependency resolution and changes only the admitted target (canonical=%s)",
      (canonical) => {
        if (!compiler) throw new Error("Missing explicit test compiler.");
        const root = fs.realpathSync.native(
          fs.mkdtempSync(path.join(os.tmpdir(), "packaged-repair-"))
        );
        const home = path.join(root, "home");
        const repo = path.join(root, "repo");
        const env = { ...process.env, HOME: home, USERPROFILE: home };
        const write = (file: string, content: string) => {
          const destination = path.join(repo, file);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.writeFileSync(destination, content);
        };
        const execute = (command: string, args: string[]) =>
          spawnSync(command, args, {
            cwd: repo,
            env,
            encoding: "utf8",
            timeout: 15000
          });
        const run = (command: string, args: string[]) => {
          const result = execute(command, args);
          expect(result.status, result.stderr || result.error?.message).toBe(0);
          return result.stdout;
        };
        const publisher = path.join(scripts, "promote-app-model.mjs");
        const checker = path.join(scripts, "validate-bicep.mjs");
        const begin = () =>
          JSON.parse(
            run(process.execPath, [
              publisher,
              "--begin",
              "--repair-target",
              "apps/custom [model].bicep"
            ])
          ) as { staged: string; context: string };
        try {
          fs.mkdirSync(repo);
          const managed = path.join(
            home,
            ".radius",
            "ai-extensions",
            "bin",
            process.platform === "win32" ? "bicep.exe" : "bicep"
          );
          fs.mkdirSync(path.dirname(managed), { recursive: true });
          fs.copyFileSync(compiler, managed);
          if (process.platform !== "win32") fs.chmodSync(managed, 0o755);
          run("git", ["init", "--quiet", "--initial-branch", "main"]);
          run("git", ["config", "user.name", "Repair fixture"]);
          run("git", ["config", "user.email", "fixture@example.invalid"]);
          run("git", ["config", "core.autocrlf", "false"]);
          fs.cpSync(
            path.join(
              repository,
              "packages/adapter-canvas/test/fixtures/radius-type-definition"
            ),
            path.join(repo, "schema"),
            { recursive: true }
          );
          run(compiler, [
            "publish-extension",
            path.join(repo, "schema/index.json"),
            "--target",
            path.join(repo, "types.tgz")
          ]);
          write(
            "bicepconfig.json",
            JSON.stringify({
              experimentalFeaturesEnabled: { extensibility: true },
              extensions: {
                custom: canonical ? "./types.tgz" : "../types.tgz"
              },
              ...(canonical ? {} : { implicitExtensions: ["custom"] }),
              cacheRootDirectory: path.join(repo, ".git", "compiler-cache")
            })
          );
          write("types/messages.bicep", "@export()\ntype Message = string\n");
          write("modules/nested.bicep", "output message string = 'nested'\n");
          write(
            "modules/legacy.json",
            JSON.stringify({
              $schema:
                "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
              contentVersion: "1.0.0.0",
              resources: [],
              outputs: { message: { type: "string", value: "legacy" } }
            })
          );
          write("data/settings.json", '{"value":"data"}\n');
          const model = [
            canonical ? "extension custom" : "",
            "import { Message } from '../types/messages.bicep'",
            "param message Message = 'original'",
            "module nested '../modules/nested.bicep' = { name: 'nested' }",
            "module legacy '../modules/legacy.json' = { name: 'legacy' }",
            "resource app 'custom:Radius.Core/applications@2025-08-01-preview' = {",
            " name: 'fixture'",
            " properties: { environment: 'dev' }",
            "}",
            "output result object = { message: message, nested: nested.outputs.message, legacy: legacy.outputs.message, data: loadJsonContent('../data/settings.json') }",
            ""
          ].join("\n");
          write("apps/custom [model].bicep", model);
          if (canonical) {
            write(".radius/app.bicep", "canonical model\n");
            write(".radius/app.origin.json", "canonical metadata\n");
          }
          write("unrelated.txt", "original");
          run("git", ["add", "."]);
          run("git", ["commit", "--quiet", "-m", "fixture"]);
          write("unrelated.txt", "unrelated staged");
          run("git", ["add", "--", "unrelated.txt"]);
          const task = begin();
          const repaired =
            model.replace("'original'", "'repaired'").replaceAll("\n", "\r\n") +
            " \t";
          fs.writeFileSync(task.staged, repaired);
          run(process.execPath, [
            checker,
            task.staged,
            "--repair-context",
            task.context
          ]);
          const record = JSON.parse(fs.readFileSync(task.context, "utf8")) as {
            validated: { dependencies: Record<string, unknown> };
          };
          for (const dependency of [
            "types.tgz",
            "modules/legacy.json",
            "modules/nested.bicep",
            "types/messages.bicep",
            "data/settings.json",
            "bicepconfig.json"
          ])
            expect(
              Object.hasOwn(
                record.validated.dependencies,
                path.join(repo, dependency)
              )
            ).toBe(true);
          expect(
            Object.keys(record.validated.dependencies).some((file) =>
              file.includes(`compiler-cache${path.sep}local`)
            )
          ).toBe(true);
          run(process.execPath, [publisher, "--repair-context", task.context]);
          expect(
            fs.readFileSync(
              path.join(repo, "apps/custom [model].bicep"),
              "utf8"
            )
          ).toBe(repaired);
          expect(run("git", ["show", ":apps/custom [model].bicep"])).toBe(
            repaired
          );
          expect(run("git", ["show", ":unrelated.txt"])).toBe(
            "unrelated staged"
          );
          expect(run("git", ["diff", "--name-only"])).toBe("");
          expect(
            run("git", ["diff", "--cached", "--name-only"]).trim().split("\n")
          ).toEqual(["apps/custom [model].bicep", "unrelated.txt"]);
          expect(fs.existsSync(path.join(repo, ".radius"))).toBe(canonical);
          if (canonical)
            expect(
              fs.readFileSync(path.join(repo, ".radius/app.bicep"), "utf8")
            ).toBe("canonical model\n");
          for (let index = 0; index < 2; index++)
            run(process.execPath, [
              publisher,
              "--abort",
              "--repair-context",
              task.context
            ]);
          expect(fs.readdirSync(path.join(repo, "apps"))).toEqual([
            "custom [model].bicep"
          ]);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }
    );
    it("rejects encoded self-reads through the real compiler, not a filename substring heuristic", () => {
      if (!compiler) throw new Error("Missing explicit test compiler.");
      const root = fs.realpathSync.native(
        fs.mkdtempSync(path.join(os.tmpdir(), "repair-self-read-"))
      );
      const repo = path.join(root, "repo");
      const home = path.join(root, "home");
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      try {
        fs.mkdirSync(repo);
        const managed = path.join(
          home,
          ".radius/ai-extensions/bin",
          process.platform === "win32" ? "bicep.exe" : "bicep"
        );
        fs.mkdirSync(path.dirname(managed), { recursive: true });
        fs.copyFileSync(compiler, managed);
        if (process.platform !== "win32") fs.chmodSync(managed, 0o755);
        expect(
          spawnSync("git", ["init", "--quiet"], { cwd: repo }).status
        ).toBe(0);
        fs.writeFileSync(
          path.join(repo, "custom.bicep"),
          "output original string = 'original'\n"
        );
        const run = (script: string, args: string[]) =>
          spawnSync(process.execPath, [path.join(scripts, script), ...args], {
            cwd: repo,
            env,
            encoding: "utf8",
            timeout: 15000
          });
        const admitted = run("promote-app-model.mjs", [
          "--begin",
          "--repair-target",
          "custom.bicep"
        ]);
        expect(admitted.status, admitted.stderr).toBe(0);
        const context = JSON.parse(admitted.stdout) as {
          staged: string;
          context: string;
        };
        const name = path
          .basename(context.staged)
          .replace("radius", "\\u{72}adius");
        fs.writeFileSync(
          context.staged,
          `output self string = loadTextContent('./${name}')\n`
        );
        const refused = run("validate-bicep.mjs", [
          context.staged,
          "--repair-context",
          context.context
        ]);
        expect(refused.status, refused.stderr).toBe(2);
        expect(refused.stderr).toContain("Self-referential");
        expect(
          fs.readFileSync(path.join(repo, "custom.bicep"), "utf8")
        ).toContain("original");
        expect(
          run("promote-app-model.mjs", [
            "--abort",
            "--repair-context",
            context.context
          ]).status
        ).toBe(0);
        expect(fs.readdirSync(repo).filter((name) => name !== ".git")).toEqual([
          "custom.bicep"
        ]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
);
