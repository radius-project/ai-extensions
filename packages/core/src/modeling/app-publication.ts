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
  isUnconfirmedExit(error: unknown): boolean;
  localTargetKey(path: string): string;
  exists(path: string): boolean;
  compileExtension(
    fromFile: string,
    target: string,
    workspace: WorkspacePath
  ): Promise<unknown>;
  publishRecipe(
    file: string,
    target: string,
    workspace: WorkspacePath
  ): Promise<unknown>;
}

export function createAppPublication(ports: AppPublicationPorts) {
  const publications = new Map<string, Promise<unknown>>();
  const blockedTargets = new Set<string>();

  async function publishInOrder<T>(
    key: string,
    publish: () => T | Promise<T>
  ): Promise<T> {
    // A late writer must settle before another request can use that target.
    // This queue belongs to one runtime, not to the registry or the workspace.
    const preceding = publications.get(key);
    const publication = Promise.resolve(preceding)
      .catch(() => undefined)
      .then(async () => {
        if (blockedTargets.has(key)) {
          throw new Error(
            "Publication to this target is blocked because the previous Windows process tree could not be confirmed stopped."
          );
        }
        try {
          return await publish();
        } catch (error) {
          if (ports.isUnconfirmedExit(error)) blockedTargets.add(key);
          throw error;
        }
      });
    publications.set(key, publication);
    try {
      return await publication;
    } finally {
      if (publications.get(key) === publication) publications.delete(key);
    }
  }

  const extensionKey = (target: string) =>
    `extension:${ports.localTargetKey(target)}`;
  const recipeKey = (target: string) => `recipe:${target.trim().toLowerCase()}`;

  return {
    enqueue: publishInOrder,
    extensionKey,
    recipeKey,
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
      await publishInOrder(extensionKey(target), () =>
        ports.compileExtension(from, target, workspace)
      );
      return { kind: "compiled", target } as const;
    },
    async publishRecipe(
      workspace: WorkspacePath,
      repo: string | null | undefined,
      input: { file?: unknown; target?: unknown }
    ) {
      const error = ports.validateRegistryTarget(input.target, repo);
      if (error) return { kind: "refused", error } as const;
      const target = String(input.target).trim();
      return publishInOrder(recipeKey(target), async () => {
        const file = ports.resolveExisting(workspace, input.file, null);
        if (!ports.exists(file))
          return { kind: "missing", path: file } as const;
        const published = await ports.publishRecipe(file, target, workspace);
        return { kind: "published", reference: String(published) } as const;
      });
    }
  };
}
