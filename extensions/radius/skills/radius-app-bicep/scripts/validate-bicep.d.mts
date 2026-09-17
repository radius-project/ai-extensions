export interface CompiledValidationInput {
  app: string;
  templateText: string;
  diagnosticsText: string;
  compilerStatus: "passed" | "failed";
  provider?: string;
  recipeFiles?: string[];
}

export function validateCompiledDefinition(input: CompiledValidationInput): {
  version: 1;
  checks: {
    checkId: string;
    status: "passed" | "failed" | "unavailable";
  }[];
};

export function validateCompiledDefinitionFiles(
  args: readonly string[]
): ReturnType<typeof validateCompiledDefinition>;

export function verifyLegacyDefinition(app: string, bicep: string): number;
