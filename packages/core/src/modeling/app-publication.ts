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
  publishRecipe(
    file: string,
    target: string,
    workspace: WorkspacePath
  ): Promise<unknown>;
}

export function createAppPublication(ports: AppPublicationPorts) {
  const recipePublications = new Map<string, Promise<unknown>>();

  async function publishRecipeInOrder<T>(target: string, publish: () => T) {
    // A late push must settle before another request can publish that tag.
    // This queue belongs to one runtime, not to the registry or the workspace.
    const key = target.toLowerCase();
    const preceding = recipePublications.get(key);
    const publication = Promise.resolve(preceding)
      .catch(() => undefined)
      .then(publish);
    recipePublications.set(key, publication);
    try {
      return await publication;
    } finally {
      if (recipePublications.get(key) === publication) {
        recipePublications.delete(key);
      }
    }
  }

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
      input: { file?: unknown; target?: unknown },
      managedPublish?: (target: string) => Promise<unknown>
    ) {
      const error = ports.validateRegistryTarget(input.target, repo);
      if (error) return { kind: "refused", error } as const;
      const target = String(input.target).trim();
      return publishRecipeInOrder(target, async () => {
        if (managedPublish) {
          const published = await managedPublish(target);
          return { kind: "published", reference: String(published) } as const;
        }
        const file = ports.resolveExisting(workspace, input.file, null);
        if (!ports.exists(file))
          return { kind: "missing", path: file } as const;
        const published = await ports.publishRecipe(file, target, workspace);
        return { kind: "published", reference: String(published) } as const;
      });
    }
  };
}
