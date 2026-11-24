export interface WorkflowCandidate {
  content: string;
  provider: string | null;
  environment: string | null;
}

export interface WorkflowCommitFailure {
  path: string;
  branch: string;
}

export interface WorkflowSynchronizationResult {
  updated: string[];
  created: string[];
  registrationPending?: string[];
  failed: WorkflowCommitFailure[];
  branches: string[];
  skipped: false;
}

export interface WorkflowSynchronizationRequest {
  repo: string;
  branches: readonly string[];
  candidates: ReadonlyMap<string, readonly WorkflowCandidate[]>;
  dispatcherProviders: ReadonlyMap<string, readonly string[]>;
  createMissing: boolean;
}

export interface WorkflowSynchronizationPorts {
  readFile(repo: string, path: string, branch: string): Promise<string | null>;
  branchExists(repo: string, branch: string): Promise<boolean>;
  commitFile(
    repo: string,
    path: string,
    content: string,
    branch: string,
    message: string
  ): Promise<boolean>;
  matchesVariant?(
    path: string,
    committed: string,
    candidates: readonly WorkflowCandidate[]
  ): Promise<boolean>;
  log(message: string): void;
  errorMessage(error: unknown): string;
}

/** Publishes providers before dispatchers and never authors an unpushed branch. */
export async function synchronizeWorkflowCandidates(
  request: WorkflowSynchronizationRequest,
  ports: WorkflowSynchronizationPorts
): Promise<WorkflowSynchronizationResult> {
  const { repo, branches, candidates, dispatcherProviders, createMissing } =
    request;
  const fileNameOf = (path: string): string =>
    path.slice(path.lastIndexOf("/") + 1);
  const workflowPath = (file: string): string => `.github/workflows/${file}`;
  const isDispatcher = (path: string): boolean =>
    dispatcherProviders.has(fileNameOf(path));
  const ordered = [...candidates].sort(
    ([a], [b]) => Number(isDispatcher(a)) - Number(isDispatcher(b))
  );
  for (const [path, choices] of ordered) {
    if (choices.length === 0)
      throw new Error(`No generated workflow candidate exists for ${path}.`);
  }
  const updated = new Set<string>();
  const created = new Set<string>();
  const registrationPending = new Set<string>();
  const failed: WorkflowCommitFailure[] = [];
  const branchPresence = new Map<string, boolean>();
  const remoteHasBranch = async (branch: string): Promise<boolean> => {
    const known = branchPresence.get(branch);
    if (known !== undefined) return known;
    const exists = await ports.branchExists(repo, branch);
    branchPresence.set(branch, exists);
    return exists;
  };

  for (const branch of branches) {
    const committedFiles = new Map<string, string | null>();
    for (const [path] of ordered) {
      committedFiles.set(path, await ports.readFile(repo, path, branch));
    }
    const present = new Set(
      [...committedFiles]
        .filter(([, content]) => content != null && content !== "")
        .map(([path]) => fileNameOf(path))
    );
    for (const [path] of ordered) {
      for (const provider of dispatcherProviders.get(fileNameOf(path)) || []) {
        const providerPath = workflowPath(provider);
        if (committedFiles.has(providerPath) || present.has(provider)) continue;
        const content = await ports.readFile(repo, providerPath, branch);
        if (content != null && content !== "") present.add(provider);
      }
    }
    const requiredProviders = new Set(
      [...dispatcherProviders]
        .filter(([dispatcher]) => present.has(dispatcher))
        .flatMap(([, providers]) => providers)
    );
    for (const [path, choices] of ordered) {
      const fileName = fileNameOf(path);
      const committed = committedFiles.get(path);
      const missing = committed == null || committed === "";
      const absentProviders = (dispatcherProviders.get(fileName) || []).filter(
        (provider) => !present.has(provider)
      );
      if (absentProviders.length > 0) {
        const wanted =
          missing ? createMissing : (
            !choices.some((candidate) => candidate.content === committed)
          );
        if (wanted && (await remoteHasBranch(branch))) {
          failed.push({ path, branch });
          ports.log(
            `left ${path} unchanged on "${branch}" until ${absentProviders.join(", ")} can be committed`
          );
        }
        continue;
      }
      if (missing) {
        if (!createMissing && !requiredProviders.has(fileName)) continue;
        if (!(await remoteHasBranch(branch))) {
          ports.log(
            `skipped creating ${path} on "${branch}" (branch not on remote)`
          );
          continue;
        }
        try {
          const changed = await ports.commitFile(
            repo,
            path,
            choices[0].content,
            branch,
            `Add ${fileName} from upstream Radius workflow templates`
          );
          if (changed) {
            created.add(path);
            ports.log(`created ${path} on "${branch}"`);
          } else {
            registrationPending.add(path);
          }
          present.add(fileName);
        } catch (error) {
          failed.push({ path, branch });
          ports.log(
            `could not create ${path} on "${branch}": ${ports.errorMessage(error)}`
          );
        }
        continue;
      }
      if (choices.some((choice) => choice.content === committed)) continue;
      if (await ports.matchesVariant?.(path, committed, choices)) continue;

      const committedProvider =
        /AZURE_/.test(committed) ? "azure"
        : /AWS_/.test(committed) ? "aws"
        : null;
      const choice =
        (committedProvider &&
          choices.find(
            (candidate) => candidate.provider === committedProvider
          )) ||
        choices[0];
      try {
        const changed = await ports.commitFile(
          repo,
          path,
          choice.content,
          branch,
          `Update ${fileName} to match upstream Radius workflow templates`
        );
        if (changed) {
          updated.add(path);
          ports.log(`updated ${path} on "${branch}"`);
        }
      } catch (error) {
        failed.push({ path, branch });
        ports.log(
          `could not update ${path} on "${branch}": ${ports.errorMessage(error)}`
        );
      }
    }
  }
  return {
    updated: [...updated],
    created: [...created],
    ...(registrationPending.size ?
      { registrationPending: [...registrationPending] }
    : {}),
    failed,
    branches: [...branches],
    skipped: false
  };
}
