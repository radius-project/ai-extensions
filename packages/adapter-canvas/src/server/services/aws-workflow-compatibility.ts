import { verifyWorkflowFilesMatchSource } from "./delete-environment-workflow-verification.js";

export async function requireCurrentAwsWorkflows(
  input: { provider: string; files: readonly string[]; workingBranch: string },
  ports: {
    environmentProvider(): Promise<string>;
    defaultBranch(): Promise<string | null>;
    templates(): Promise<Record<string, string>>;
    readFile(path: string, branch: string): Promise<string | null>;
    errorMessage(error: unknown): string;
  }
): Promise<void> {
  const files = input.files.filter(
    (file) => file === "run-rad-commands-aws.yml" || file === "delete-aws.yml"
  );
  if (!files.length) return;
  const provider = await ports.environmentProvider();
  if (provider === "azure") return;
  if (provider !== "aws")
    throw new Error(
      "Could not determine the saved environment provider before dispatch."
    );
  const branch = await ports.defaultBranch();
  if (!branch)
    throw new Error(
      "Could not determine the default branch to verify the AWS workflows."
    );
  const templates = await ports.templates();
  for (const ref of new Set([branch, input.workingBranch].filter(Boolean))) {
    const result = await verifyWorkflowFilesMatchSource(
      files.map((file) => {
        const expected = templates[file];
        if (!expected)
          throw new Error(`The packaged AWS workflow ${file} is unavailable.`);
        return { file, path: `.github/workflows/${file}`, expected };
      }),
      { ...ports, defaultBranch: async () => ref }
    );
    if (!result.ok) {
      throw new Error(
        `AWS workflow ${result.file} on branch ${ref} is not confirmed current (${result.reason}). Commit the current Radius AWS workflow templates, using a pull request if the branch is protected, then retry. Older workflows try to administer EKS access, which the deployment role no longer grants.`
      );
    }
  }
}
