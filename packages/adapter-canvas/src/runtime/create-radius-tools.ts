// createRadiusTools — builds the 6 radius_* tools from RADIUS_TOOL_DECLARATIONS
// plus a RadiusExtensionDependencies dependency object. Same shape as
// createRadiusCanvas: pure construction, no I/O until a handler is invoked.

import { RADIUS_TOOL_DECLARATIONS } from "./declarations.js";
import {
  ambiguousAppSourceBrief,
  unsupportedAppSourceReport
} from "@radius-project/core";
import { errorMessage } from "./util.js";
import { createGraphContextHelpers } from "./graph-context.js";
import {
  failedGraphDiffResult,
  successfulGraphDiffResult,
  unavailableGraphDiffResult
} from "./pr-graph-diff-result.js";
import type { RadiusExtensionDependencies } from "./dependencies.js";
import type { DeployToolArgs } from "../deploy-tools.js";

interface ToolArgs {
  [key: string]: unknown;
}

export function createRadiusTools(deps: RadiusExtensionDependencies) {
  const {
    workspaceState,
    fetchBicepForBranch,
    evaluateAppSourceForBranch,
    listSourceTreeForBranch
  } = createGraphContextHelpers(deps);
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
      // Two source checks gate the authoring instructions, and they differ in
      // kind. A repository with no Dockerfile is refused outright (2.1): the
      // product cannot model it, so the skill is withheld entirely. A repository
      // with SEVERAL Dockerfiles is not refused at all (2.2) — it is the normal
      // shape of a microservices application and must still be modeled as one
      // application — so the skill is handed over as usual, with a brief
      // appended describing the candidate directories and the narrow case in
      // which the agent should stop and ask the user where the application is.
      //
      // Any failure to establish the repository's contents hands over the skill
      // unchanged: both checks act on evidence, never on a lookup that did not
      // work.
      handler: async (args: ToolArgs) => {
        const repoPath = args.repoPath as string | undefined;
        const state = await workspaceState().catch(() => null);
        // The listing this check can obtain describes the worktree, so it is
        // evidence about the worktree and anything inside it — a subdirectory
        // of a tree with no Dockerfile has none either. A caller naming some
        // other location is asking about a target the extension cannot
        // enumerate, and there is no evidence to refuse on. An omitted path
        // means the workspace, which is how the tool is invoked in practice.
        const targetsWorkspace =
          !repoPath ||
          deps.workspace.isWorkspacePath(state?.workspacePath, repoPath);
        if (state && targetsWorkspace) {
          const source = await evaluateAppSourceForBranch(
            state.contextRepo || "",
            state.contextBranch || "",
            state
          ).catch(() => null);
          if (source?.status === "none") {
            return unsupportedAppSourceReport(state.contextRepo);
          }
          // The workspace-manifest signal needs the listing itself, which the
          // classification does not carry. It is re-read only on the
          // `ambiguous` branch — the rare case — through the same branch-aware
          // lister, so a branch that is not the current worktree gets the same
          // signal the classification was derived from.
          //
          // A null listing means the re-read did not happen, so the brief
          // simply omits the signal; it must never be read as "no manifests
          // present".
          const listing =
            source?.status === "ambiguous" ?
              await listSourceTreeForBranch(
                state.contextRepo || "",
                state.contextBranch || "",
                state
              )
            : null;
          // A repoPath naming somewhere INSIDE the worktree is the user's
          // answer to the very question this brief asks. The gate above
          // deliberately lets a subdirectory through, because a tree with no
          // Dockerfile has none in any subdirectory either — but that evidence
          // only justifies the refusal above. Asking again here, with
          // candidates from outside the directory they just named, would undo
          // their answer and loop. So the brief is for the worktree itself.
          const answeredWithDirectory =
            !!repoPath &&
            deps.workspace.isWorkspacePath(state.workspacePath, repoPath) &&
            !deps.workspace.isWorkspacePath(repoPath, state.workspacePath);
          const brief =
            answeredWithDirectory ? null : (
              ambiguousAppSourceBrief(source, listing)
            );
          if (brief) {
            return `${deps.radiusAppBicepSkill(repoPath)}\n---\n\n${brief}\n`;
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
            return unavailableGraphDiffResult(
              `.radius/app.bicep does not exist on ${baseBranch} or ${headBranch} yet. A PR diff compares the committed model on each branch. Create the pull request without a graph diff section, report this reason in chat, and do not open the graph-diff Canvas.`
            );
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
          return successfulGraphDiffResult(
            deps.renderPrDiffMarkdown(diffResources, baseBranch, headBranch)
          );
        } catch (err) {
          return failedGraphDiffResult(
            `Could not generate app graph diff: ${errorMessage(err)}`
          );
        }
      }
    },
    {
      ...declarationByName.get("radius_publish_custom_type_extension")!,
      // Modeling now writes its whole run into `.radius/.staging-<runId>/` and
      // publishes it only once it is complete, so the custom-type package this
      // tool produces has to land there with the rest of the run rather than in
      // `.radius/` where the product reads it. `stagingDir` moves the defaults
      // into that directory; path confinement is unchanged, and the staging
      // directory is itself confined to a `.staging-*` child of `.radius/`.
      handler: async (args: ToolArgs) => {
        try {
          const { workspacePath } = await workspaceState();
          const stagingPrefix = deps.publishTargets.resolveStagingDirPrefix(
            workspacePath,
            args.stagingDir
          );
          const fromFile = deps.publishTargets.resolveExistingRadiusArtifact(
            workspacePath,
            args.manifestPath,
            `.radius/${stagingPrefix}custom-types.yaml`
          );
          const target = deps.publishTargets.resolveRadiusArtifactTarget(
            workspacePath,
            args.targetPath,
            `.radius/${stagingPrefix}custom-types.tgz`
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
