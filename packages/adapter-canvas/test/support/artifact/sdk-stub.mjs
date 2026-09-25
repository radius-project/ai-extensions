import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

let joinCount = 0;
let joinedDeclaration;

const REQUIRED_SKILL_FILES = [
  "SKILL.md",
  "scripts/promote-app-model.mjs",
  "scripts/validate-bicep.mjs",
  "scripts/bicep-security-rules.mjs",
  "scripts/write-app-origin.mjs",
  "references/source-code-references.md"
];
const LEGACY_INLINED_HEADING =
  "# radius-app-bicep skill (bundled with the Radius extension)";

// The skill scripts are launched through the interpreter the bootstrap names,
// so the artifact contract is that the named path really runs a script rather
// than merely existing.
function runsScripts(nodeCommand) {
  if (typeof nodeCommand !== "string" || nodeCommand === "") return false;
  const result = spawnSync(nodeCommand, ["-e", "process.exit(0)"], {
    stdio: "ignore",
    timeout: 10_000
  });
  return !result.error && result.status === 0;
}

function json(value) {
  return JSON.parse(JSON.stringify(value));
}

function send(message) {
  if (typeof process.send !== "function") return Promise.resolve();
  return new Promise((resolve, reject) => {
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

export function createCanvas(declaration) {
  return declaration;
}

export async function joinSession(declaration) {
  joinCount++;
  joinedDeclaration = declaration;
  const generateApp = declaration.tools.find(
    (tool) => tool.name === "radius_generate_app"
  );
  const bootstrapText = await generateApp?.handler({
    repoPath: process.env.RADIUS_ARTIFACT_WORKSPACE
  });
  const bootstrap = JSON.parse(String(bootstrapText));
  const artifactDir = resolve(process.env.RADIUS_ARTIFACT_ROOT);
  const skillBase = String(bootstrap.skillBase);
  const packageVersion = JSON.parse(
    readFileSync(join(artifactDir, "package.json"), "utf8")
  ).version;
  await send({
    type: "registered",
    snapshot: {
      joinCount,
      canvases: declaration.canvases.map((canvas) => ({
        id: canvas.id,
        displayName: canvas.displayName,
        description: canvas.description,
        inputSchema: json(canvas.inputSchema),
        actions: canvas.actions.map((action) => ({
          name: action.name,
          description: action.description,
          inputSchema: json(action.inputSchema),
          handlerCallable: typeof action.handler === "function"
        })),
        hasOpen: typeof canvas.open === "function",
        hasOnClose: typeof canvas.onClose === "function"
      })),
      tools: declaration.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: json(tool.parameters),
        handlerCallable: typeof tool.handler === "function"
      })),
      hooks: Object.entries(declaration.hooks)
        .map(([name, hook]) => ({
          name,
          callable: typeof hook === "function"
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      bootstrap: {
        fields: Object.keys(bootstrap),
        skill: bootstrap.skill,
        repoPathMatchesWorkspace:
          bootstrap.repoPath === process.env.RADIUS_ARTIFACT_WORKSPACE,
        skillBaseRelativeToArtifact: relative(
          artifactDir,
          skillBase
        ).replaceAll("\\", "/"),
        skillVersionMatchesPackage: bootstrap.skillVersion === packageVersion,
        nodeCommandRunsScripts: runsScripts(bootstrap.nodeCommand),
        instruction: bootstrap.instruction,
        requiredFiles: REQUIRED_SKILL_FILES.filter((requiredFile) =>
          existsSync(join(skillBase, requiredFile))
        ),
        containsLegacyInlinedHeading: String(bootstrapText).includes(
          LEGACY_INLINED_HEADING
        )
      }
    }
  });
  return {
    workspacePath: process.env.RADIUS_ARTIFACT_WORKSPACE,
    send: async () => undefined,
    log: () => undefined,
    rpc: { canvas: { open: async () => ({}) } },
    metadata: { snapshot: async () => ({}) },
    close: () => send({ type: "shutdown", closeCount: 1 })
  };
}

export async function renderArtifactPage() {
  const canvas = joinedDeclaration?.canvases.find(
    (candidate) => candidate.id === "radius"
  );
  if (!canvas) throw new Error("Radius canvas was not registered.");
  const context = {
    extensionId: "radius",
    canvasId: "radius",
    instanceId: "artifact-smoke",
    input: { page: "environment" }
  };
  let opened = false;
  try {
    const page = await canvas.open(context);
    opened = true;
    const response = await fetch(page.url);
    if (!response.ok) {
      throw new Error(`Artifact page returned HTTP ${response.status}.`);
    }
    return await response.text();
  } finally {
    if (opened) await canvas.onClose(context);
  }
}
