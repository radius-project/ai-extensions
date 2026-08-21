// A deterministic in-memory GitHub port for functional scenarios.
//
// Unmodeled reads throw instead of resolving, so a scenario can never pass
// against a fetch it did not describe — the failure mode broad module mocks
// hide. `reads` records every path so a test can assert the lookup order the
// modeling layer relies on (`.radius/app.bicep` before the root fallback).

import type { GitHub } from "../../src/ports/index.js";

export interface FakeGitHubContent {
  /** Contents-API path -> decoded file body, or null for "exists but empty". */
  files?: Record<string, string | null>;
  /** Contents-API path -> directory entry names. */
  directories?: Record<string, string[]>;
  /** `${repo}@${branch}` -> every path in that tree. */
  trees?: Record<string, string[]>;
  /**
   * `getContent` paths that resolve to null ("no such file") instead of
   * throwing. Consulted only by `getContent`; `listNames` and `treePaths` are
   * unaffected.
   */
  absent?: string[];
}

export interface FakeGitHub extends GitHub {
  readonly reads: string[];
}

export function createFakeGitHub(content: FakeGitHubContent = {}): FakeGitHub {
  const files = content.files ?? {};
  const directories = content.directories ?? {};
  const trees = content.trees ?? {};
  const absent = new Set(content.absent ?? []);
  const reads: string[] = [];

  return {
    reads,
    async getContent(apiPath: string) {
      reads.push(apiPath);
      if (Object.prototype.hasOwnProperty.call(files, apiPath)) {
        return files[apiPath];
      }
      if (absent.has(apiPath)) return null;
      throw new Error(
        `FakeGitHub received an unmodeled getContent("${apiPath}"). ` +
          `Add it to the scenario's files or absent list.`
      );
    },
    async listNames(apiPath: string) {
      reads.push(apiPath);
      if (Object.prototype.hasOwnProperty.call(directories, apiPath)) {
        return directories[apiPath];
      }
      throw new Error(
        `FakeGitHub received an unmodeled listNames("${apiPath}").`
      );
    },
    async treePaths(repo: string, branch: string) {
      const key = `${repo}@${branch}`;
      reads.push(key);
      if (Object.prototype.hasOwnProperty.call(trees, key)) {
        return trees[key];
      }
      throw new Error(
        `FakeGitHub received an unmodeled treePaths("${repo}", "${branch}").`
      );
    }
  };
}
