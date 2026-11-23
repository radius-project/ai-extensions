declare module "*radius-app-bicep/scripts/app-model-staging.mjs" {
  export interface ManagedModelStaging {
    readonly stagingDir: string;
    artifact(name: string, required: boolean): string;
    cancel(): void;
    validate(check: (appFile: string) => Promise<void>): Promise<void>;
    promote(): { published: string[]; gitError: string };
  }

  export function beginManagedRun(workspaceRoot: string): ManagedModelStaging;
}
