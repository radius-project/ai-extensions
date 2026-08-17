let joinCount = 0;
let joinedDeclaration;

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
  const bundledSkill = await generateApp?.handler({
    repoPath: process.env.RADIUS_ARTIFACT_WORKSPACE
  });
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
      bundledSkill: {
        hasSkill: String(bundledSkill).includes("# radius-app-bicep skill"),
        hasCustomTypes: String(bundledSkill).includes(
          "Reference: references/custom-resource-types.md"
        ),
        hasSourceReferences: String(bundledSkill).includes(
          "Reference: ../radius-app-graph/references/source-code-references.md"
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
