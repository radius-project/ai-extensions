declare module "*radius-app-bicep/scripts/app-model-staging.mjs" {
  export interface ManagedModelStaging {
    readonly stagingDir: string;
    artifact(name: string, required: boolean): string;
    assertBaseline(): void;
    cancel(): void;
    validate(check: (appFile: string) => Promise<void>): Promise<void>;
    promote(
      prepareCommit: () => Promise<void>,
      beforeCommit: () => void,
      options?: {
        gitPorts?: PromotionGitPorts;
        onFilesystemCommitted?: () => void;
      }
    ): Promise<{
      published: string[];
      gitError: string;
    }>;
  }

  interface PromotionGitPorts {
    discoverRepositoryRoot(radiusDir: string): Promise<string>;
    stageFiles(repoRoot: string, files: string[]): Promise<void>;
  }

  export function beginManagedRun(workspaceRoot: string): ManagedModelStaging;
  export function isManagedRun(stagingPath: string): boolean;
}
