import {
  encodeWorkflowContent,
  workflowBlobSha
} from "@radius-project/adapter-shared";
import { selectedGhApiJson, type SelectedGhExecutor } from "./gh.js";

export interface RepositoryFileWrite {
  repo: string;
  path: string;
  branch: string;
  content: string;
  message: string;
}

export async function writeSelectedRepositoryFile(
  executor: SelectedGhExecutor,
  input: RepositoryFileWrite
): Promise<boolean> {
  if (!input.branch.trim())
    throw new Error("An explicit repository branch is required.");
  const endpoint = `/repos/${input.repo}/contents/${input.path}`;
  const existing = await selectedGhApiJson(
    executor,
    `${endpoint}?ref=${encodeURIComponent(input.branch)}`
  );
  let sha: string | undefined;
  if (existing.ok) {
    const file = existing.json;
    if (
      file === null ||
      typeof file !== "object" ||
      !("sha" in file) ||
      typeof file.sha !== "string" ||
      !/^[a-f0-9]{40}$/i.test(file.sha)
    ) {
      throw new Error("GitHub returned an invalid repository file identity.");
    }
    sha = file.sha;
  } else if (existing.status !== 404) {
    throw new Error(
      executor.redact(
        existing.stderr || "Could not verify the current repository file."
      )
    );
  }
  const content = encodeWorkflowContent(input.content);
  if (sha?.toLowerCase() === workflowBlobSha(content)) return false;
  await executor.runOrThrow(
    ["api", "--method", "PUT", endpoint, "--input", "-"],
    "Could not write the repository file.",
    {
      timeout: 30000,
      stdin: JSON.stringify({
        message: input.message,
        content,
        branch: input.branch,
        ...(sha ? { sha } : {})
      })
    }
  );
  return true;
}
