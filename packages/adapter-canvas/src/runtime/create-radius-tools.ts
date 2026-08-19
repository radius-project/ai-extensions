// createRadiusTools — builds the 6 radius_* tools from RADIUS_TOOL_DECLARATIONS
// plus a RadiusExtensionDependencies dependency object. Same shape as
// createRadiusCanvas: pure construction, no I/O until a handler is invoked.

import { RADIUS_TOOL_DECLARATIONS } from "./declarations.js";
import { unsupportedAppSourceReport } from "@radius-project/core";
import { errorMessage } from "./util.js";
import { createGraphContextHelpers } from "./graph-context.js";
import type { RadiusExtensionDependencies } from "./dependencies.js";
import type { DeployToolArgs } from "../deploy-tools.js";

interface ToolArgs {
  [key: string]: unknown;
}

// Whether a caller-supplied repository path denotes the workspace the extension
// can enumerate. Absent means the workspace by default, which is how the tool is
// invoked in practice. Compared loosely (separator- and trailing-slash-
// insensitive) because the value reaches us as agent-authored prose.
function targetsWorkspace(
  repoPath: string | undefined,
  workspacePath: string | null | undefined
): boolean {
  if (!repoPath) return true;
  if (!workspacePath) return false;
  const normalize = (value: string) =>
    value.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalize(repoPath) === normalize(workspacePath);
}

export function createRadiusTools(deps: RadiusExtensionDependencies) {
  const { workspaceState, fetchBicepForBranch, evaluateAppSourceForBranch } =
    createGraphContextHelpers(deps);
  const declarationByName = new Map(
    RADIUS_TOOL_DECLARATIONS.map((decl) => [decl.name, decl])
  );

  function logToSession(message: string): void {
    try {
      deps.session.get().log?.(message);
    } catch {
      /* logging is best-effort */
    }
  }

  return [
    {
      ...declarationByName.get("radius_generate_app")!,
      // The Dockerfile requirement is enforced here rather than asked for in the
      // skill text. Withholding the authoring instructions turns "please stop"
      // into "there is nothing to act on", which is the only form of the rule an
      // agent cannot read past. Any failure to establish the repository's
      // contents hands over the skill as before — the check refuses modeling on
      // evidence, never on a lookup that did not work.
      handler: async (args: ToolArgs) => {
        const repoPath = args.repoPath as string | undefined;
        const state = await workspaceState().catch(() => null);
        // The listing this check can obtain describes the workspace. A caller
        // naming some other directory is asking about a target the extension
        // cannot enumerate, and the workspace's contents say nothing about it,
        // so there is no evidence to refuse on.
        if (state && targetsWorkspace(repoPath, state.workspacePath)) {
          const source = await evaluateAppSourceForBranch(
            state.contextRepo || "",
            state.contextBranch || "",
            state
          ).catch(() => null);
          if (source?.status === "none") {
            return unsupportedAppSourceReport(state.contextRepo);
          }
        }
        return deps.radiusAppBicepSkill(repoPath);
      }
    },
    {
      ...declarationByName.get("radius_generate_pr_diff_markdown")!,
      handler: async (args: ToolArgs) => {
        const { repo, baseBranch, headBranch } = args as {
          repo: string;
          baseBranch: string;
          headBranch: string;
        };
        try {
          const state = await workspaceState();
          const [baseContent, headContent] = await Promise.all([
            fetchBicepForBranch(repo, baseBranch, state),
            fetchBicepForBranch(repo, headBranch, state)
          ]);

          if (!baseContent && !headContent) {
            return `.radius/app.bicep does not exist on ${baseBranch} or ${headBranch} yet. A PR diff compares the committed model on each branch, so author it with the Radius app-bicep skill (run the radius_generate_app tool) and make sure each branch you are comparing contains the committed file, then re-run this tool.`;
          }

          const { dir: baseRadArtifactsDir, remote: baseRadArtifactsRemote } =
            await deps.rad.radArtifactsDirForSelection({
              isLocal: deps.workspace.isWorkspaceSelection(
                state,
                repo,
                baseBranch
              ),
              state,
              github: deps.github,
              repo,
              branch: baseBranch,
              bicepRepoPath: ".radius/app.bicep",
              log: logToSession
            });
          const { dir: headRadArtifactsDir, remote: headRadArtifactsRemote } =
            await deps.rad.radArtifactsDirForSelection({
              isLocal: deps.workspace.isWorkspaceSelection(
                state,
                repo,
                headBranch
              ),
              state,
              github: deps.github,
              repo,
              branch: headBranch,
              bicepRepoPath: ".radius/app.bicep",
              log: logToSession
            });
          const baseResources = await deps.rad.buildGraphViaRad(
            baseContent || "",
            ".radius/app.bicep",
            {
              log: logToSession,
              radArtifactsDir: baseRadArtifactsDir,
              cleanupRadArtifactsDir: baseRadArtifactsRemote
            }
          );
          const headResources = await deps.rad.buildGraphViaRad(
            headContent || "",
            ".radius/app.bicep",
            {
              log: logToSession,
              radArtifactsDir: headRadArtifactsDir,
              cleanupRadArtifactsDir: headRadArtifactsRemote
            }
          );

          const diffResources = deps.core.computeGraphDiff(
            baseResources,
            headResources
          );
          return deps.renderPrDiffMarkdown(
            diffResources,
            baseBranch,
            headBranch
          );
        } catch (err) {
          return `⚠️ Could not generate app graph diff: ${errorMessage(err)}`;
        }
      }
    },
    {
      ...declarationByName.get("radius_publish_custom_type_extension")!,
      handler: async (args: ToolArgs) => {
        try {
          const { workspacePath } = await workspaceState();
          const fromFile = deps.publishTargets.resolveExistingRadiusArtifact(
            workspacePath,
            args.manifestPath,
            ".radius/custom-types.yaml"
          );
          const target = deps.publishTargets.resolveRadiusArtifactTarget(
            workspacePath,
            args.targetPath,
            ".radius/custom-types.tgz"
          );
          if (!deps.process.existsSync(fromFile)) {
            return `Resource-type manifest not found at ${fromFile}. Author it first (see the radius-app-bicep custom-resource-types reference), then re-run this tool.`;
          }
          await deps.rad.runRadBicepPublishExtension({
            fromFile,
            target,
            log: logToSession
          });
          return `Published custom-type extension to ${target}. Reference it from .radius/bicepconfig.json and recompile the app graph through the Radius canvas.`;
        } catch (err) {
          return `⚠️ Could not publish the custom-type extension: ${errorMessage(err)}`;
        }
      }
    },
    {
      ...declarationByName.get("radius_publish_recipe")!,
      handler: async (args: ToolArgs) => {
        try {
          const { workspacePath, workspaceRepo } = await workspaceState();
          const targetError = deps.publishTargets.validateGhcrTargetForRepo(
            args.target,
            workspaceRepo
          );
          if (targetError) return targetError;
          const file = deps.publishTargets.resolveExistingRadiusArtifact(
            workspacePath,
            args.file,
            null
          );
          if (!deps.process.existsSync(file)) {
            return `Recipe file not found at ${file}. Author it first (see the radius-app-bicep custom-resource-types reference), then re-run this tool.`;
          }
          const target = String(args.target).trim();
          const published = await deps.withGhcrDockerConfig((env) =>
            deps.rad.runRadBicepPublish({
              file,
              target,
              env,
              log: logToSession
            })
          );
          return `Published recipe to ${String(published)}. Reference it from the recipe pack (Radius.Core/recipePacks) for the custom type.`;
        } catch (err) {
          return `⚠️ Could not publish the recipe: ${errorMessage(err)}`;
        }
      }
    },
    {
      ...declarationByName.get("radius_deploy")!,
      handler: async (args: ToolArgs = {}) => {
        try {
          const deployArgs = args as DeployToolArgs;
          const entry = deps.deployTools.selectDeployEntry(
            deps.servers,
            deployArgs.attemptId
          );
          if (!entry) {
            return args.attemptId ?
                `Deploy attempt "${args.attemptId}" is no longer active, so this redeploy was not started. A newer deploy may have replaced it; ask the user which deploy to repair rather than retrying against a different one.`
              : "No Radius canvas session is open, so there is no deploy to repeat. Open the Radius canvas and start a deploy first.";
          }
          const retarget = deps.deployTools.validateDeployAttempt(
            deployArgs,
            entry.state || {}
          );
          if (retarget) return retarget;
          const payload = deps.deployTools.buildDeployPayload(
            deployArgs,
            entry.state || {}
          );
          const invalid = deps.deployTools.validateDeployPayload(payload);
          if (invalid) return invalid;
          const response = await deps.deploy.fetch(
            `${entry.baseUrl}/api/deploy`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload)
            }
          );
          const result = (await response.json().catch(() => ({}))) as Record<
            string,
            unknown
          >;
          if (!response.ok || result.error) {
            return `⚠️ Could not start the deploy: ${result.error || `HTTP ${response.status}`}`;
          }
          return deps.deployTools.describeDeployStarted(payload, result);
        } catch (err) {
          return `⚠️ Could not start the deploy: ${errorMessage(err)}`;
        }
      }
    },
    {
      ...declarationByName.get("radius_deploy_status")!,
      handler: async (args: ToolArgs = {}) => {
        try {
          const entry = deps.deployTools.selectDeployEntry(
            deps.servers,
            args.attemptId as string | undefined
          );
          if (!entry) {
            return args.attemptId ?
                `Deploy attempt "${args.attemptId}" is no longer active, so its status is unavailable.`
              : "No Radius canvas session is open, so there is no deploy status to report.";
          }
          const response = await deps.deploy.fetch(
            `${entry.baseUrl}/api/deploy-status`
          );
          if (!response.ok)
            return `⚠️ Could not read the deploy status: HTTP ${response.status}`;
          const d = (await response.json().catch(() => ({}))) as Record<
            string,
            unknown
          >;
          return JSON.stringify(
            deps.deployTools.summarizeDeployStatus(
              {
                status: typeof d.status === "string" ? d.status : "",
                errorKind: typeof d.errorKind === "string" ? d.errorKind : null,
                deployRunUrl:
                  typeof d.deployRunUrl === "string" ? d.deployRunUrl : null,
                startedAt:
                  (
                    typeof d.startedAt === "string" ||
                    typeof d.startedAt === "number"
                  ) ?
                    d.startedAt
                  : null,
                finishedAt:
                  (
                    typeof d.finishedAt === "string" ||
                    typeof d.finishedAt === "number"
                  ) ?
                    d.finishedAt
                  : null,
                error: d.error,
                logs: d.logs
              },
              args.logLines as number | undefined
            )
          );
        } catch (err) {
          return `⚠️ Could not read the deploy status: ${errorMessage(err)}`;
        }
      }
    }
  ];
}

export type RadiusTools = ReturnType<typeof createRadiusTools>;
