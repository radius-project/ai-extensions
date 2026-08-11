let joinCount = 0;

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
  const canvas = declaration.canvases[0];
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
      canvas: {
        id: canvas.id,
        displayName: canvas.displayName,
        description: canvas.description,
        inputSchema: json(canvas.inputSchema),
        actionNames: canvas.actions.map((action) => action.name),
        hasOpen: typeof canvas.open === "function",
        hasOnClose: typeof canvas.onClose === "function"
      },
      tools: declaration.tools.map((tool) => ({
        name: tool.name,
        parameters: json(tool.parameters)
      })),
      hooks: Object.keys(declaration.hooks).sort(),
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
