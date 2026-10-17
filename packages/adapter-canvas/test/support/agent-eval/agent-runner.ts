import type { ModelingCase } from "./modeling-cases.js";

export function evaluationMatrix(
  cases: readonly ModelingCase[],
  models: readonly string[] = [],
  selectedCase?: string
) {
  if (models.some((model) => !model.trim())) {
    throw new Error("Model identifiers must not be empty.");
  }
  const selected = cases.filter(
    (testCase) => !selectedCase || testCase.id === selectedCase
  );
  if (!selected.length) {
    throw new Error(`Unknown evaluation case: ${selectedCase}`);
  }
  const uniqueModels: Array<string | undefined> =
    models.length ? [...new Set(models)] : [undefined];
  return uniqueModels.flatMap((model, index) =>
    selected.map((testCase) => ({
      model,
      testCase,
      artifactId: `${index + 1}-${testCase.id}`
    }))
  );
}

export function agentArguments(prompt: string, url: string, model?: string) {
  return [
    "-p",
    prompt,
    "--silent",
    "--stream",
    "off",
    "--no-custom-instructions",
    "--disable-builtin-mcps",
    "--available-tools",
    "radius-eval",
    "--allow-tool",
    "radius-eval",
    "--additional-mcp-config",
    JSON.stringify({
      mcpServers: {
        "radius-eval": { type: "http", url, tools: ["*"] }
      }
    }),
    ...(model ? ["--model", model] : [])
  ];
}
