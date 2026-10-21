import {
  selectedFetchFileFromRepoResult,
  selectedGhApiJson,
  type SelectedGhExecutor
} from "../gh.js";
import {
  createWorkflowTemplateReader,
  generateDeleteWorkflow,
  generateDeployWorkflow,
  generateVerifyWorkflow,
  type WorkflowSyncPorts
} from "../infra.js";
import { writeSelectedRepositoryFile } from "../selected-repository-write.js";
import { createSelectedRepositoryReader } from "../selected-repository-reader.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createDeploymentWorkflowPorts(
  executor: SelectedGhExecutor
): WorkflowSyncPorts {
  const reader = createSelectedRepositoryReader(executor);
  const readTemplate = createWorkflowTemplateReader((repo, path, ref) =>
    selectedFetchFileFromRepoResult(executor, repo, path, ref)
  );
  const metadata = async (path: string, allowMissing = false) => {
    const result = await selectedGhApiJson(executor, path);
    if (!result.ok) {
      if (allowMissing && result.status === 404) return null;
      throw new Error(
        executor.redact(result.stderr || "Could not read repository metadata.")
      );
    }
    if (!record(result.json))
      throw new Error("GitHub returned invalid repository metadata.");
    return result.json;
  };

  return {
    async getDefaultBranch(repo) {
      const result = await metadata(`/repos/${repo}`);
      const branch = result?.default_branch;
      if (typeof branch !== "string" || !branch.trim())
        throw new Error("Could not resolve the repository's default branch.");
      return branch;
    },
    async getBranchHeadSha(repo, branch) {
      const result = await metadata(
        `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
        true
      );
      if (!result) return null;
      const sha = record(result.object) ? result.object.sha : undefined;
      if (typeof sha !== "string" || !/^[a-f0-9]{40}$/i.test(sha))
        throw new Error("GitHub returned an invalid branch identity.");
      return sha;
    },
    fetchFileFromRepo: (repo, path, branch) =>
      reader.getContent(
        `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`
      ),
    commitFileToRepo: (repo, path, content, branch, message) =>
      writeSelectedRepositoryFile(executor, {
        repo,
        path,
        content,
        branch,
        message
      }),
    generateVerifyWorkflow: (environment, provider, ref, options) =>
      generateVerifyWorkflow(environment, provider, ref, options, readTemplate),
    generateDeployWorkflow: (environment, appFile) =>
      generateDeployWorkflow(environment, appFile, {}, readTemplate),
    generateDeleteWorkflow: (environment) =>
      generateDeleteWorkflow(environment, readTemplate)
  };
}
