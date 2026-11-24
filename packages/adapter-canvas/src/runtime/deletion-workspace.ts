import {
  selectGitHubAccount,
  type GitHubAccountSelection,
  type GitHubAccountSelectionTarget
} from "@radius-project/core";
import type { SelectedGhExecutor } from "../gh.js";
import {
  createApplicationDeletionTool,
  type ApplicationDeletionToolPorts
} from "./application-deletion-tool.js";
import type { SessionHolder, SessionPort } from "./session.js";

interface DeletionWorkspacePorts {
  session: SessionHolder;
  isActive(): boolean;
  workspace(
    session: SessionPort
  ): Promise<{ repo: string; workspacePath: string }>;
  account(input: {
    target: GitHubAccountSelectionTarget;
    isCurrent(): boolean;
  }): Promise<GitHubAccountSelection>;
}

export function createDeletionWorkspace(ports: DeletionWorkspacePorts) {
  return async (target: { repo: string; environment: string }) => {
    const session = ports.session.tryGet();
    if (!session) return undefined;
    const isCurrent = () =>
      ports.isActive() && ports.session.tryGet() === session;
    if (!isCurrent()) return undefined;
    const { repo, workspacePath } = await ports.workspace(session);
    if (
      !repo ||
      !workspacePath ||
      repo.toLowerCase() !== target.repo.toLowerCase() ||
      !isCurrent()
    ) {
      return undefined;
    }
    const selection = await ports.account({
      target: { repo, environment: target.environment },
      isCurrent
    });
    if (selection.state !== "selected" || !isCurrent()) return undefined;

    return {
      repo,
      login: selection.login,
      isCurrent,
      async validate() {
        if (!isCurrent()) return false;
        const workspace = await ports.workspace(session);
        return (
          isCurrent() &&
          workspace.workspacePath === workspacePath &&
          workspace.repo.toLowerCase() === repo.toLowerCase()
        );
      }
    };
  };
}

export function createWorkspaceApplicationDeletion(
  ports: Omit<DeletionWorkspacePorts, "account"> &
    Pick<ApplicationDeletionToolPorts, "confirm" | "redact"> & {
      listLogins(): Promise<string[]>;
      createExecutor(
        login: string
      ): Promise<Pick<SelectedGhExecutor, "login" | "verifyIdentity">>;
      chooseAccount(): Parameters<typeof selectGitHubAccount>[1]["choose"];
      prepare(input: {
        login: string;
        request: Parameters<ApplicationDeletionToolPorts["prepare"]>[0];
        isCurrent(): boolean;
      }): ReturnType<ApplicationDeletionToolPorts["prepare"]>;
    }
) {
  const workspace = createDeletionWorkspace({
    ...ports,
    account: ({ target, isCurrent }) =>
      selectGitHubAccount(
        { target },
        {
          listLogins: ports.listLogins,
          async check(login) {
            try {
              const executor = await ports.createExecutor(login);
              await executor.verifyIdentity();
              if (executor.login.toLowerCase() === login.toLowerCase())
                return { state: "eligible" };
            } catch {
              // The target binding separately checks repository permissions.
            }
            return {
              state: "ineligible",
              message: "The selected GitHub account could not be verified."
            };
          },
          choose: ports.chooseAccount(),
          isCurrent
        }
      )
  });
  return createApplicationDeletionTool({
    confirm: ports.confirm,
    async prepare(request) {
      const scope = await workspace(request);
      if (!scope || !(await scope.validate())) return undefined;
      const prepared = await ports.prepare({
        login: scope.login,
        request: { ...request, repo: scope.repo },
        isCurrent: scope.isCurrent
      });
      if (!prepared) return undefined;
      return {
        login: prepared.login,
        async execute() {
          if (!(await scope.validate())) {
            return {
              status: 409,
              body: { error: "The workspace changed before deletion." }
            };
          }
          return prepared.execute();
        }
      };
    },
    redact: ports.redact
  }).handler;
}
