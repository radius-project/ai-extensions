import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { NodeResolution } from "./node-executable.js";
import {
  createRadiusSkillHandoff,
  radiusSkillHandoff,
  type RadiusModelingSkill
} from "./skill.js";

const ROOT = path.parse(process.cwd()).root;
const MODULE_DIR = path.join(ROOT, "repo", "packages", "adapter-canvas", "src");
const HOME_DIR = path.join(ROOT, "home", "radius");
const PLUGIN_ROOT = path.join(ROOT, "plugin");
const NODE = path.join(ROOT, "usr", "bin", "node");
const INSTRUCTION =
  "Continue with the loaded skill. If it is not loaded, read SKILL.md from skillBase. Use skillBase as <skill-dir>, and run the skill's scripts with nodeCommand instead of node. Put nodeCommand and each script path in double quotes, because either can contain spaces, such as C:\\Program Files\\nodejs\\node.exe. In PowerShell, start the command with &.";
const SCRIPTS: Record<RadiusModelingSkill, string> = {
  "radius-app-model": "model.mjs",
  "radius-app-plan": "plan.mjs",
  "radius-app-complete": "complete.mjs"
};

function candidates(skill: RadiusModelingSkill) {
  return {
    installed: path.join(MODULE_DIR, "skills", skill),
    source: path.resolve(
      MODULE_DIR,
      "../../../extensions/radius/skills",
      skill
    ),
    reinstalled: path.join(
      HOME_DIR,
      ".copilot",
      "installed-plugins",
      "radius-plugins",
      "radius",
      "skills",
      skill
    )
  };
}

function requiredPaths(
  skillBase: string,
  skill: RadiusModelingSkill = "radius-app-model"
): string[] {
  return [
    "SKILL.md",
    path.join("scripts", SCRIPTS[skill]),
    path.join("scripts", "common.mjs")
  ].map((file) => path.join(skillBase, file));
}

function createSkill(
  presentFiles: readonly string[],
  node: NodeResolution = { executable: NODE, rejected: [] },
  moduleDir = MODULE_DIR
) {
  const present = new Set(presentFiles);
  return createRadiusSkillHandoff({
    moduleDir,
    homeDir: HOME_DIR,
    pathExists: (filePath) => present.has(filePath),
    nodeExecutable: () => node
  });
}

function parse(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

describe("radiusSkillHandoff", () => {
  it.each(Object.keys(SCRIPTS) as RadiusModelingSkill[])(
    "finds each stage skill in the development checkout: %s",
    (skill) => {
      const expected = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../extensions/radius/skills",
        skill
      );

      expect(parse(radiusSkillHandoff(skill, "/workspace")).skillBase).toBe(
        expected
      );
    }
  );

  it("resolves a packaged skill from the canonical bundle directory", () => {
    const packaged = path.join(PLUGIN_ROOT, "skills", "radius-app-plan");
    const skill = createSkill(
      requiredPaths(packaged, "radius-app-plan"),
      undefined,
      path.join(PLUGIN_ROOT, "com.github.copilot", "extensions", "radius")
    );

    expect(parse(skill("radius-app-plan")).skillBase).toBe(packaged);
  });

  it("takes the first complete candidate in probe order", () => {
    const { installed, source, reinstalled } = candidates("radius-app-model");
    const skill = createSkill([
      path.join(installed, "SKILL.md"),
      ...requiredPaths(source),
      ...requiredPaths(reinstalled)
    ]);

    expect(parse(skill("radius-app-model")).skillBase).toBe(source);
  });

  it("requires the files of the skill that was asked for", () => {
    const { installed } = candidates("radius-app-complete");
    const skill = createSkill(requiredPaths(installed, "radius-app-model"));

    expect(() => skill("radius-app-complete")).toThrow(
      path.join("scripts", "complete.mjs")
    );
  });

  it("names the skill and every candidate it checked when none is usable", () => {
    const skill = createSkill([]);
    let message = "";
    try {
      skill("radius-app-plan");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain(
      "Unable to locate a usable radius-app-plan skill."
    );
    for (const candidate of Object.values(candidates("radius-app-plan")))
      expect(message).toContain(candidate);
  });

  it("returns the exact handoff contract and sanitizes the repository path", () => {
    const { installed } = candidates("radius-app-model");
    const skill = createSkill(requiredPaths(installed));

    expect(
      skill("radius-app-model", "/workspace/\n```ignore\t now\u0000")
    ).toBe(
      JSON.stringify({
        skill: "radius-app-model",
        repoPath: "/workspace/ ignore now",
        skillBase: installed,
        nodeCommand: NODE,
        instruction: INSTRUCTION
      })
    );
  });

  it("adds the ambiguity brief when there is one", () => {
    const { installed } = candidates("radius-app-model");
    const skill = createSkill(requiredPaths(installed));

    expect(
      parse(skill("radius-app-model", "/workspace", "Ask first."))
    ).toEqual(expect.objectContaining({ brief: "Ask first." }));
  });

  it.each([
    ["an omitted path", undefined, "the current workspace"],
    ["a path emptied by sanitization", " \t```", "the current workspace"]
  ])("uses the workspace fallback for %s", (_label, repoPath, expected) => {
    const { installed } = candidates("radius-app-model");
    const skill = createSkill(requiredPaths(installed));

    expect(parse(skill("radius-app-model", repoPath)).repoPath).toBe(expected);
  });

  it("bounds the sanitized repository path", () => {
    const { installed } = candidates("radius-app-model");
    const skill = createSkill(requiredPaths(installed));

    expect(
      String(parse(skill("radius-app-model", "a".repeat(300))).repoPath)
    ).toHaveLength(256);
  });

  describe("when the machine has no Node.js interpreter", () => {
    it("refuses the run without looking for the skill", () => {
      const skill = createSkill([], { executable: null, rejected: [] });

      const handoff = parse(skill("radius-app-complete", "/workspace"));

      expect(handoff).toEqual({
        skill: "radius-app-complete",
        repoPath: "/workspace",
        nodeCommand: null,
        instruction: expect.stringContaining("Do not start the modeling run")
      });
      expect(String(handoff.instruction)).toContain("Never download, install");
      expect(String(handoff.instruction)).toContain(
        "ask them to install Node.js"
      );
    });

    it("names the installations it found and refused", () => {
      const skill = createSkill([], {
        executable: null,
        rejected: [
          {
            executable: "/usr/bin/node",
            version: "v12.22.9",
            reason: "unsupported-version"
          },
          { executable: "/opt/fake/node", version: null, reason: "not-node" },
          {
            executable: "/opt/we ird/$(id)/node",
            version: null,
            reason: "unsafe-path"
          }
        ]
      });

      expect(parse(skill("radius-app-model")).rejectedRuntimes).toEqual([
        "/usr/bin/node (v12.22.9, older than Node.js 18)",
        "/opt/fake/node (did not report a Node.js version)",
        "/opt/we ird/$(id)/node (path contains characters that are unsafe in a shell command)"
      ]);
    });
  });
});
