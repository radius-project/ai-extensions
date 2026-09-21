// Compact bootstrap for the radius-app-bicep skill packaged with the Canvas.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGeneratorVersion } from "./generator-version.js";
import { defaultNodeExecutable } from "./node-executable.js";
import { resolvePluginRoot } from "./plugin-root.js";

const REQUIRED_SKILL_FILES = [
  "SKILL.md",
  path.join("scripts", "validate-bicep.mjs"),
  path.join("references", "source-code-references.md")
];
const SKILL_INSTRUCTION =
  "Continue with the loaded skill. If it is unavailable, read SKILL.md from skillBase. Substitute skillBase for <loaded-skill-base>. Substitute nodeCommand for <loaded-node>. Substitute skillVersion for <loaded-skill-version> only when skillVersion is present; otherwise leave <loaded-skill-version> unchanged so the skill omits the flag.";
// Returned instead of the handoff when the machine has no Node.js interpreter.
// The run cannot start, and the only permitted next step is to ask the user —
// never to download or install a runtime on their behalf.
const MISSING_NODE_INSTRUCTION =
  "Do not start the modeling run: the skill's scripts need a Node.js interpreter and this machine has none that the Radius extension can see. Never download, install, unpack, or otherwise obtain a Node.js runtime, and never run the scripts through another runtime. Report this to the user, ask them to install Node.js 24 or newer (or to make their existing installation visible to the Copilot app), and stop. Only a fresh user request may start another run.";

export interface RadiusAppBicepSkillDependencies {
  moduleDir: string;
  homeDir: string;
  pathExists(filePath: string): boolean;
  generatorVersion(): string;
  // Absolute path of an existing Node.js interpreter, or null when the machine
  // has none. The skill scripts are never invoked as a bare `node`, because the
  // Copilot app's own runtime is not on the agent's PATH.
  nodeExecutable(): string | null;
}

interface RadiusAppBicepHandoff {
  skill: "radius-app-bicep";
  repoPath: string;
  skillBase: string;
  skillVersion?: string;
  nodeCommand: string;
  instruction: string;
  brief?: string;
}

interface RadiusAppBicepNodeMissing {
  skill: "radius-app-bicep";
  repoPath: string;
  nodeCommand: null;
  instruction: string;
}

function sanitizeRepoPath(repoPath: unknown): string {
  const FALLBACK = "the current workspace";
  if (typeof repoPath !== "string") return FALLBACK;
  const cleaned = repoPath
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 256);
  return cleaned || FALLBACK;
}

function skillBaseCandidates(
  moduleDir: string,
  homeDir: string
): readonly string[] {
  const pluginRoot = resolvePluginRoot(moduleDir);
  return [
    path.join(pluginRoot, "skills", "radius-app-bicep"),
    path.resolve(
      moduleDir,
      "../../../extensions/radius/skills/radius-app-bicep"
    ),
    path.join(
      homeDir,
      ".copilot",
      "installed-plugins",
      "radius-plugins",
      "radius",
      "skills",
      "radius-app-bicep"
    )
  ];
}

export function createRadiusAppBicepSkill(
  dependencies: RadiusAppBicepSkillDependencies
): (repoPath?: string, brief?: string) => string {
  const candidates = skillBaseCandidates(
    dependencies.moduleDir,
    dependencies.homeDir
  );

  return (repoPath?: string, brief?: string): string => {
    const nodeCommand = dependencies.nodeExecutable();
    if (!nodeCommand) {
      const missing: RadiusAppBicepNodeMissing = {
        skill: "radius-app-bicep",
        repoPath: sanitizeRepoPath(repoPath),
        nodeCommand: null,
        instruction: MISSING_NODE_INSTRUCTION
      };
      return JSON.stringify(missing);
    }
    const skillBase = candidates.find((candidate) =>
      REQUIRED_SKILL_FILES.every((requiredFile) =>
        dependencies.pathExists(path.join(candidate, requiredFile))
      )
    );
    if (!skillBase) {
      throw new Error(
        [
          "Unable to locate a usable radius-app-bicep skill.",
          "Checked candidates:",
          ...candidates.map((candidate) => `- ${candidate}`),
          "Each candidate must include:",
          ...REQUIRED_SKILL_FILES.map((requiredFile) => `- ${requiredFile}`),
          "Repair the Radius plugin installation or run the extension from its source checkout."
        ].join("\n")
      );
    }

    const skillVersion = dependencies.generatorVersion().trim();
    const handoff: RadiusAppBicepHandoff = {
      skill: "radius-app-bicep",
      repoPath: sanitizeRepoPath(repoPath),
      skillBase,
      ...(skillVersion ? { skillVersion } : {}),
      nodeCommand,
      instruction: SKILL_INSTRUCTION,
      ...(brief ? { brief } : {})
    };
    return JSON.stringify(handoff);
  };
}

const defaultRadiusAppBicepSkill = createRadiusAppBicepSkill({
  moduleDir: path.dirname(fileURLToPath(import.meta.url)),
  homeDir: homedir(),
  pathExists: existsSync,
  generatorVersion: resolveGeneratorVersion,
  nodeExecutable: defaultNodeExecutable
});

export function radiusAppBicepSkill(repoPath?: string, brief?: string): string {
  return defaultRadiusAppBicepSkill(repoPath, brief);
}
