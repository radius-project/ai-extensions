import type { GitHub } from "@radius-project/core";
import {
  selectedGhApiJson,
  type ContentBytesTooLarge,
  type SelectedGhExecutor
} from "./gh.js";

export interface SelectedRepositoryReader extends GitHub {
  getContentBytes(
    apiPath: string
  ): Promise<Buffer | ContentBytesTooLarge | null>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createSelectedRepositoryReader(
  executor: SelectedGhExecutor
): SelectedRepositoryReader {
  const read = async (
    apiPath: string,
    allowMissing = true
  ): Promise<unknown> => {
    const result = await selectedGhApiJson(executor, apiPath);
    if (!result.ok) {
      if (allowMissing && result.status === 404) return null;
      throw new Error(
        executor.redact(
          result.stderr || "Could not read the selected repository."
        )
      );
    }
    if (result.json === null)
      throw new Error("GitHub returned an invalid repository response.");
    return result.json;
  };
  const getContentBytes = async (
    apiPath: string
  ): Promise<Buffer | ContentBytesTooLarge | null> => {
    const file = await read(apiPath);
    if (file === null) return null;
    if (!record(file) || file.type !== "file")
      throw new Error("GitHub did not return a repository file.");
    if (file.encoding === "none") return { tooLarge: true };
    if (file.encoding !== "base64" || typeof file.content !== "string")
      throw new Error("GitHub returned an invalid repository file encoding.");
    const encoded = file.content.replace(/\s/g, "");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded)
      throw new Error("GitHub returned malformed repository file content.");
    return bytes;
  };
  return {
    getContentBytes,
    async getContent(apiPath) {
      const bytes = await getContentBytes(apiPath);
      if (bytes === null) return null;
      if (!Buffer.isBuffer(bytes))
        throw new Error(
          "The repository file exceeds GitHub's inline content limit."
        );
      return bytes.toString("utf8");
    },
    async listNames(apiPath) {
      const entries = await read(apiPath);
      if (entries === null) return [];
      if (!Array.isArray(entries))
        throw new Error("GitHub did not return a repository directory.");
      return entries.map((entry: unknown) => {
        if (!record(entry) || typeof entry.name !== "string" || !entry.name)
          throw new Error("GitHub returned an invalid directory entry.");
        return entry.name;
      });
    },
    async treePaths(repo, branch) {
      if (!branch.trim())
        throw new Error("An explicit repository branch is required.");
      const tree = await read(
        `/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
        false
      );
      if (
        !record(tree) ||
        tree.truncated !== false ||
        !Array.isArray(tree.tree)
      )
        throw new Error("GitHub did not return a complete repository tree.");
      return tree.tree.flatMap((entry: unknown) => {
        if (
          !record(entry) ||
          typeof entry.path !== "string" ||
          !entry.path ||
          typeof entry.type !== "string" ||
          !["blob", "tree", "commit"].includes(entry.type)
        )
          throw new Error("GitHub returned an invalid repository tree entry.");
        return entry.type === "blob" ? [entry.path] : [];
      });
    }
  };
}
