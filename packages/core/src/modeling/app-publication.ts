type WorkspacePath = string | null | undefined;
type ArtifactPath = (
  workspace: WorkspacePath,
  input: unknown,
  fallback: string | null
) => string;

export interface AppPublicationPorts {
  resolveExisting: ArtifactPath;
  resolveTarget: ArtifactPath;
  stagingPrefix(workspace: WorkspacePath, input: unknown): string;
  validateRegistryTarget(target: unknown, repo: WorkspacePath): string | null;
  exists(path: string): boolean;
  compileExtension(fromFile: string, target: string): Promise<unknown>;
  publishRecipe(file: string, target: string): Promise<unknown>;
}

export function createAppPublication(ports: AppPublicationPorts) {
  return {
    async compileExtension(
      workspace: WorkspacePath,
      input: {
        stagingDir?: unknown;
        manifestPath?: unknown;
        targetPath?: unknown;
      }
    ) {
      const prefix = ports.stagingPrefix(workspace, input.stagingDir);
      const from = ports.resolveExisting(
        workspace,
        input.manifestPath,
        `.radius/${prefix}custom-types.yaml`
      );
      const target = ports.resolveTarget(
        workspace,
        input.targetPath,
        `.radius/${prefix}custom-types.tgz`
      );
      if (!ports.exists(from)) return { kind: "missing", path: from } as const;
      await ports.compileExtension(from, target);
      return { kind: "compiled", target } as const;
    },
    async publishRecipe(
      workspace: WorkspacePath,
      repo: string | null | undefined,
      input: { file?: unknown; target?: unknown }
    ) {
      const error = ports.validateRegistryTarget(input.target, repo);
      if (error) return { kind: "refused", error } as const;
      const file = ports.resolveExisting(workspace, input.file, null);
      if (!ports.exists(file)) return { kind: "missing", path: file } as const;
      const published = await ports.publishRecipe(
        file,
        String(input.target).trim()
      );
      return { kind: "published", reference: String(published) } as const;
    }
  };
}
