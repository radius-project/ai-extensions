import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

let joinCount = 0;
let joinedDeclaration;
let sessionSendCount = 0;
let panelOpenCount = 0;
let canvasOpenCount = 0;

const REQUIRED_SKILL_FILES = [
  "SKILL.md",
  "scripts/promote-app-model.mjs",
  "scripts/validate-bicep.mjs",
  "scripts/write-app-origin.mjs",
  "references/source-code-references.md"
];
const LEGACY_INLINED_HEADING =
  "# radius-app-bicep skill (bundled with the Radius extension)";

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
  return {
    ...declaration,
    open: (...args) => {
      canvasOpenCount++;
      return declaration.open(...args);
    }
  };
}

export async function joinSession(declaration) {
  joinCount++;
  joinedDeclaration = declaration;
  const generateApp = declaration.tools.find(
    (tool) => tool.name === "radius_generate_app"
  );
  if (!generateApp) throw new Error("Radius generate app was not registered.");
  const generateAppText = await generateApp.handler({
    repoPath: process.env.RADIUS_ARTIFACT_WORKSPACE
  });
  const generateAppResult = JSON.parse(String(generateAppText));
  const artifactDir = resolve(process.env.RADIUS_ARTIFACT_ROOT);
  // Packaging evidence is independent of authoring: a refusal must never be
  // reinterpreted as a skill handoff or supply a path to inspect.
  const skillBase = join(artifactDir, "skills", "radius-app-bicep");
  const packageVersion = JSON.parse(
    readFileSync(join(artifactDir, "package.json"), "utf8")
  ).version;
  const pluginVersion = JSON.parse(
    readFileSync(join(artifactDir, "plugin.json"), "utf8")
  ).version;
  const lifecycle = declaration.tools.find(
    (tool) => tool.name === "radius_lifecycle"
  );
  if (!lifecycle) throw new Error("Radius lifecycle was not registered.");
  const lifecycleIntent = {
    operation: "operation.respond",
    target: { repo: "fixture/repository" },
    input: {
      operationId: "missing",
      actionId: "action",
      response: { kind: "user.decision", choice: "approve" }
    }
  };
  const invalidAuthorityResult = JSON.parse(
    await lifecycle.handler({ ...lifecycleIntent, approved: true })
  );
  const unattachedResult = JSON.parse(await lifecycle.handler(lifecycleIntent));
  await send({
    type: "registered",
    snapshot: {
      joinCount,
      lifecycle: { invalidAuthorityResult, unattachedResult },
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
      authoringBeforeAttachment: {
        result: generateAppResult,
        sessionSendCount,
        panelOpenCount,
        canvasOpenCount,
        containsLegacyInlinedHeading: String(generateAppText).includes(
          LEGACY_INLINED_HEADING
        )
      },
      packagedSkill: {
        skillBaseRelativeToArtifact: relative(
          artifactDir,
          skillBase
        ).replaceAll("\\", "/"),
        packageVersionPresent:
          typeof packageVersion === "string" && packageVersion.length > 0,
        pluginVersionMatchesPackage: pluginVersion === packageVersion,
        requiredFiles: REQUIRED_SKILL_FILES.filter((requiredFile) =>
          existsSync(join(skillBase, requiredFile))
        )
      }
    }
  });
  return {
    workspacePath: process.env.RADIUS_ARTIFACT_WORKSPACE,
    send: async () => {
      sessionSendCount++;
    },
    log: () => undefined,
    rpc: {
      canvas: {
        open: async () => {
          panelOpenCount++;
          return {};
        }
      }
    },
    metadata: { snapshot: async () => ({}) },
    close: () => send({ type: "shutdown", closeCount: 1 })
  };
}

export async function renderArtifactPage() {
  const lifecycle = joinedDeclaration?.tools.find(
    (tool) => tool.name === "radius_lifecycle"
  );
  if (!lifecycle) throw new Error("Radius lifecycle was not registered.");
  const graphReadResult = JSON.parse(
    await lifecycle.handler({
      operation: "graph.get",
      target: { repo: "fixture/repository" },
      input: { kind: "authored" }
    })
  );
  const validationIntent = {
    operation: "definition.validate",
    target: {
      repo: "fixture/repository",
      definition: ".radius/app.bicep"
    },
    input: {}
  };
  const validationResult = JSON.parse(
    await lifecycle.handler(validationIntent)
  );
  const invalidApprovalResult = JSON.parse(
    await lifecycle.handler({ ...validationIntent, approved: true })
  );
  const authorResult = JSON.parse(
    await lifecycle.handler({
      operation: "definition.author",
      target: validationIntent.target,
      input: { intent: "Model the workspace application.", provider: "azure" }
    })
  );
  await send({
    type: "lifecycle",
    evidence: {
      validationResult,
      invalidApprovalResult,
      authorResult,
      sessionSendCount,
      panelOpenCount,
      canvasOpenCount
    }
  });
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
    return { html: await response.text(), graphReadResult };
  } finally {
    if (opened) await canvas.onClose(context);
  }
}
