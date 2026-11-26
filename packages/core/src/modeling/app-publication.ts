type WorkspacePath = string | null | undefined;

// Publishes an authored Recipe file to the repository's registry. The
// radius-app-plan skill writes the Recipe as `<name>-recipe.bicep`, and the
// canvas publishes it because it holds the registry credentials. Publications
// to one target run in order, so a later call cannot overtake an earlier one.
export interface AppPublicationPorts {
  resolveExisting(
    workspace: WorkspacePath,
    input: unknown,
    fallback: string | null
  ): string;
  validateRegistryTarget(target: unknown, repo: WorkspacePath): string | null;
  isUnconfirmedExit(error: unknown): boolean;
  exists(path: string): boolean;
  publishRecipe(
    file: string,
    target: string,
    workspace: WorkspacePath
  ): Promise<unknown>;
}

export function createAppPublication(ports: AppPublicationPorts) {
  const publications = new Map<string, Promise<unknown>>();
  const blockedTargets = new Set<string>();
  let closed = false;

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
        if (closed) throw new Error("Radius publication is shutting down.");
        if (blockedTargets.has(key)) {
          throw new Error(
            "Publication to this target is blocked because the previous process tree could not be confirmed stopped."
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

  const recipeKey = (target: string) => {
    const reference = target.trim();
    const tag = reference.lastIndexOf(":");
    const split =
      tag > reference.lastIndexOf("/") && reference.includes("/") ?
        tag
      : reference.length;
    return `recipe:${reference.slice(0, split).toLowerCase()}${reference.slice(split)}`;
  };

  return {
    async close() {
      closed = true;
      await Promise.allSettled(publications.values());
      return blockedTargets.size === 0;
    },
    enqueue: publishInOrder,
    recipeKey,
    async publishRecipe(
      resolveWorkspace: () => Promise<{
        workspacePath?: WorkspacePath;
        workspaceRepo?: WorkspacePath;
      }>,
      input: { file?: unknown; target?: unknown }
    ) {
      const { target: requestedTarget } = input;
      const target = String(requestedTarget || "").trim();
      return publishInOrder(recipeKey(target), async () => {
        const { workspacePath: workspace, workspaceRepo: repo } =
          await resolveWorkspace();
        const error = ports.validateRegistryTarget(requestedTarget, repo);
        if (error) return { kind: "refused", error } as const;
        const file = ports.resolveExisting(workspace, input.file, null);
        if (!ports.exists(file))
          return { kind: "missing", path: file } as const;
        const published = await ports.publishRecipe(file, target, workspace);
        return { kind: "published", reference: String(published) } as const;
      });
    }
  };
}
