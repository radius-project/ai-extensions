// createRadiusTools — builds the radius_* tools from RADIUS_TOOL_DECLARATIONS
// plus a RadiusExtensionDependencies dependency object. Same shape as
// createRadiusCanvas: pure construction, no I/O until a handler is invoked.

import { RADIUS_TOOL_DECLARATIONS } from "./declarations.js";
import {
  createAppPublication,
  GraphSourceError,
  inspectAppModelFailure,
  prepareAppAuthoring,
  unsupportedAppSourceReport
} from "@radius-project/core";
import { errorMessage, optionalString } from "./util.js";
import {
  createGraphContextHelpers,
  createRuntimeGraphOrchestrator
} from "./graph-context.js";
import {
  failedGraphDiffResult,
  successfulGraphDiffResult,
  unavailableGraphDiffResult,
  type PullRequestGraphDiffToolResult
} from "./pr-graph-diff-result.js";
import type { RadiusExtensionDependencies } from "./dependencies.js";
import type { ModelingActivity } from "./modeling-activity.js";
import type { createModelAuthoringOwner } from "./model-authoring-owner.js";
import type { MissingModelHandoffClaims } from "./missing-model-handoff-claims.js";
import { missingModelHandoffIncludesBranch } from "./missing-model-handoff-claims.js";
import type { CanvasState } from "../shared.js";
import { createDeploymentTools } from "./deployment-tools.js";
import {
  appModelTargetKey,
  clearAppModelAuthoringFailure,
  readSelectedSourceRevision
} from "../app-model-authoring-failure.js";

interface ToolArgs {
  [key: string]: unknown;
}

export function createRadiusTools(
  deps: RadiusExtensionDependencies,
  // Told when this tool hands the modeling skill over, so a graph render that
  // finds no model does not ask for the run that is about to start.
  modelingActivity: ModelingActivity,
  // Released when a modeling run reports a terminal failure, so the retry the
  // failure message promises is not swallowed by the dead run's claim.
  missingModelHandoffs: MissingModelHandoffClaims,
  authoring: ReturnType<typeof createModelAuthoringOwner>
) {
  const {
    workspaceState,
    readBicepForBranch,
    evaluateAppSourceForBranch,
    listSourceTreeForBranch
  } = createGraphContextHelpers(deps);
  const declarationByName = new Map(
    RADIUS_TOOL_DECLARATIONS.map((decl) => [decl.name, decl])
  );
  const deployment = createDeploymentTools({
    runtime: deps.deployment,
    readModel: deps.readDeploymentModel,
    workspace: async () => {
      const context = await deps.workspace.detectWorkspaceContext(
        deps.session.get()
      );
      return context.repo ? context : undefined;
    }
  });

  function logToSession(message: string): void {
    try {
      deps.session.get().log?.(message);
    } catch {
      /* logging is best-effort */
    }
  }

  function managedToken(args: ToolArgs): string | undefined {
    if (args.requestToken === undefined) return undefined;
    if (typeof args.requestToken !== "string" || !args.requestToken.trim()) {
      throw new Error("A valid Radius authoring request token is required.");
    }
    return args.requestToken;
  }

  const publication = createAppPublication({
    resolveExisting: deps.publishTargets.resolveExistingRadiusArtifact,
    resolveTarget: deps.publishTargets.resolveRadiusArtifactTarget,
    stagingPrefix: deps.publishTargets.resolveStagingDirPrefix,
    validateRegistryTarget: deps.publishTargets.validateGhcrTargetForRepo,
    exists: deps.process.existsSync,
    compileExtension: (fromFile, target) =>
      deps.rad.runRadBicepPublishExtension({
        fromFile,
        target,
        log: logToSession
      }),
    publishRecipe: (file, target) =>
      deps.withGhcrDockerConfig((env) =>
        deps.rad.runRadBicepPublish({ file, target, env, log: logToSession })
      )
  });

  // Records that a modeling run is about to start, so a graph render that finds
  // no model defers to it instead of asking for the same work again. Called
  // only on the paths that actually hand the skill over: a refused repository
  // is not being modeled.
  function announceModelingRun(state: CanvasState | null): void {
    if (!state?.contextRepo || !state.contextBranch) return;
    modelingActivity.announce({
      repo: state.contextRepo,
      branch: state.contextBranch
    });
  }

  return [
    {
      ...declarationByName.get("radius_generate_app")!,
      // Two source checks gate the authoring handoff, and they differ in
      // kind. A repository with no Dockerfile is refused outright (2.1): the
      // product cannot model it, so the skill is withheld entirely. A repository
      // with SEVERAL Dockerfiles is not refused at all (2.2) — it is the normal
      // shape of a microservices application and must still be modeled as one
      // application — so the bootstrap is returned as usual, with a brief field
      // describing the candidate directories and the narrow case in which the
      // agent should stop and ask the user where the application is.
      //
      // Any failure to establish the repository's contents returns the handoff
      // unchanged: both checks act on evidence, never on a lookup that did not
      // work.
      handler: async (args: ToolArgs) => {
        const repoPath = args.repoPath as string | undefined;
        let brief: string | undefined;
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
          const repo = state.contextRepo || "";
          const branch = state.contextBranch || "";
          const authoring = await prepareAppAuthoring({
            evaluate: () =>
              evaluateAppSourceForBranch(repo, branch, state).catch(() => null),
            listPaths: () => listSourceTreeForBranch(repo, branch, state),
            explicitlySelectedDirectory: () =>
              !!repoPath &&
              deps.workspace.isWorkspacePath(state.workspacePath, repoPath) &&
              !deps.workspace.isWorkspacePath(repoPath, state.workspacePath)
          });
          if (authoring.kind === "unsupported") {
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
          brief = authoring.brief;
        }
        if (targetsWorkspace) announceModelingRun(state);
        return deps.radiusAppBicepSkill(repoPath, brief);
      }
    },
    {
      ...declarationByName.get("radius_report_modeling_failure")!,
      handler: async (args: ToolArgs) => {
        const instanceId = optionalString(args.instanceId).trim();
        const repo = optionalString(args.repo).trim();
        const branch = optionalString(args.branch).trim();
        const attemptToken = optionalString(args.attemptToken).trim();
        const failure = optionalString(args.error).trim();
        if (!instanceId || !repo || !branch || !attemptToken || !failure) {
          return {
            recorded: false,
            error:
              "instanceId, repo, branch, attemptToken, and error are required"
          };
        }
        if (failure.length > 4000) {
          return {
            recorded: false,
            error: "error must not exceed 4000 characters"
          };
        }
        const entry = deps.servers.get(instanceId);
        const target = appModelTargetKey(repo, branch);
        if (
          !entry ||
          entry.state.appModelAttemptTokens?.[target] !== attemptToken
        ) {
          return {
            recorded: false,
            error:
              "The Canvas modeling attempt is no longer current; the failure was not recorded."
          };
        }
        const stillCurrent = () =>
          deps.servers.get(instanceId) === entry &&
          entry.state.appModelAttemptTokens?.[target] === attemptToken;
        const inspection = await inspectAppModelFailure({
          current: stillCurrent,
          readModel: () => readBicepForBranch(repo, branch, entry.state),
          baseline: entry.state.appModelAttemptSourceRevisions?.[target],
          readSourceRevision: () =>
            readSelectedSourceRevision(entry.state, repo, branch, {
              isWorkspaceSelection: deps.workspace.isWorkspaceSelection,
              workspaceSourceRevision: deps.appModel.workspaceSourceRevision,
              branchHeadCommit: deps.appModel.branchHeadCommit
            }).catch(() => "")
        });
        if (inspection.kind === "stale" || !stillCurrent()) {
          return {
            recorded: false,
            error:
              "A newer Canvas modeling attempt replaced this one; the stale failure was not recorded."
          };
        }
        if (inspection.kind === "model-present") {
          clearAppModelAuthoringFailure(entry.state, repo, branch);
          return {
            recorded: false,
            error:
              "The application model now exists; the stale failure was not recorded."
          };
        }
        const { sourceRevision } = inspection;
        entry.state.appModelFailures ??= {};
        entry.state.appModelFailures[target] = {
          attemptToken,
          error: failure,
          ...(sourceRevision ? { sourceRevision } : {}),
          ...(entry.state.appModelAttemptEnvironments?.[target] !== undefined ?
            { environmentKey: entry.state.appModelAttemptEnvironments[target] }
          : {})
        };
        authoring.cancel(attemptToken);
        const claim = entry.state.appModelAttemptClaims?.[target];
        if (claim) missingModelHandoffs.release(claim);
        for (const [handoffTarget, key] of Object.entries(
          entry.state.appBicepHandoffKeys ?? {}
        )) {
          if (!missingModelHandoffIncludesBranch(handoffTarget, repo, branch))
            continue;
          delete entry.state.appBicepHandoffKeys?.[handoffTarget];
          if (entry.state.appBicepHandoffKey === key)
            delete entry.state.appBicepHandoffKey;
        }
        modelingActivity.release({ repo, branch });
        return { recorded: true };
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
        let sources: PullRequestGraphDiffToolResult["sources"];
        try {
          const [baseRead, headRead] = await Promise.all([
            deps.graphSources.read({
              repo,
              ref: baseBranch,
              committedOnly: true
            }),
            deps.graphSources.read({
              repo,
              ref: headBranch,
              committedOnly: true
            })
          ]);
          sources = { base: baseRead.source, head: headRead.source };
          const result = await createRuntimeGraphOrchestrator(
            deps,
            logToSession
          ).compare(baseRead, headRead);
          if (result.status === "definitions-absent") {
            return unavailableGraphDiffResult(
              `No .radius/app.bicep or app.bicep could be read for ${baseBranch} or ${headBranch}. Create the pull request without a graph diff section, report this reason in chat, and do not open the graph-diff Canvas.`,
              sources
            );
          }
          return successfulGraphDiffResult(
            deps.renderPrDiffMarkdown(result.diff, baseBranch, headBranch),
            sources
          );
        } catch (err) {
          const source =
            err instanceof GraphSourceError ?
              `${err.source.repo}@${err.source.ref} (${err.source.definitionPath}): `
            : "";
          return failedGraphDiffResult(
            `Could not generate app graph diff: ${source}${errorMessage(err)}`,
            sources
          );
        }
      }
    },
    {
      ...declarationByName.get("radius_complete_app_authoring")!,
      handler: async (args: ToolArgs) => {
        try {
          const token = managedToken(args);
          if (!token)
            throw new Error("A Radius authoring request token is required.");
          if (args.outcome === "cancel") {
            if (!authoring.cancel(token))
              throw new Error("Unknown or expired Radius authoring request.");
            return { kind: "cancelled" };
          }
          if (args.outcome !== "complete")
            throw new Error("Choose complete or cancel.");
          const result = await authoring.finish(token);
          return { kind: "promoted", ...result };
        } catch (error) {
          return { kind: "refused", error: errorMessage(error) };
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
          const token = managedToken(args);
          if (token) {
            if (
              args.stagingDir !== undefined ||
              args.manifestPath !== undefined ||
              args.targetPath !== undefined
            )
              throw new Error(
                "Managed compilation takes a request token only; the staging paths are fixed."
              );
            return await authoring.publish(token, async (staging) => {
              const fromFile = staging.artifact("custom-types.yaml", true);
              const target = staging.artifact("custom-types.tgz", false);
              await deps.rad.runRadBicepPublishExtension({
                fromFile,
                target,
                log: logToSession
              });
              return `Published custom-type extension to ${target}. Reference it from the staged bicepconfig.json.`;
            });
          }
          const { workspacePath } = await workspaceState();
          const result = await publication.compileExtension(
            workspacePath,
            args
          );
          if (result.kind === "missing") {
            return `Resource-type manifest not found at ${result.path}. Author it first (see the radius-app-bicep custom-resource-types reference), then re-run this tool.`;
          }
          return `Published custom-type extension to ${result.target}. Reference it from .radius/bicepconfig.json and recompile the app graph through the Radius canvas.`;
        } catch (err) {
          return `⚠️ Could not publish the custom-type extension: ${errorMessage(err)}`;
        }
      }
    },
    {
      ...declarationByName.get("radius_publish_recipe")!,
      handler: async (args: ToolArgs) => {
        try {
          const token = managedToken(args);
          const recipe = token ? optionalString(args.file) : "";
          if (token && !/^[a-z][a-z0-9-]*-recipe\.bicep$/iu.test(recipe)) {
            throw new Error(
              "Managed publication requires a staged recipe filename, not a path."
            );
          }
          const { workspacePath, workspaceRepo } = await workspaceState();
          const result = await publication.publishRecipe(
            workspacePath,
            workspaceRepo,
            args,
            token ?
              (target) => {
                authoring.assertCurrent(token);
                return deps.withGhcrDockerConfig((env) =>
                  authoring.publish(token, (staging, source) => {
                    const error = deps.publishTargets.validateGhcrTargetForRepo(
                      target,
                      source.repo
                    );
                    if (error) throw new Error(error);
                    return deps.rad.runRadBicepPublish({
                      file: staging.artifact(recipe, true),
                      target,
                      env,
                      log: logToSession
                    });
                  })
                );
              }
            : undefined
          );
          if (result.kind === "refused") return result.error;
          if (result.kind === "missing") {
            return `Recipe file not found at ${result.path}. Author it first (see the radius-app-bicep custom-resource-types reference), then re-run this tool.`;
          }
          return `Published recipe to ${result.reference}. Reference it from the recipe pack (Radius.Core/recipePacks) for the custom type.`;
        } catch (err) {
          return `⚠️ Could not publish the recipe: ${errorMessage(err)}`;
        }
      }
    },
    {
      ...declarationByName.get("radius_deploy")!,
      handler: (args: ToolArgs = {}) => deployment.start(args)
    },
    {
      ...declarationByName.get("radius_deploy_status")!,
      handler: (args: ToolArgs = {}) => deployment.status(args)
    },
    {
      ...declarationByName.get("radius_setup_environment")!,
      handler: async (args: ToolArgs) =>
        JSON.stringify(await deps.environment.start(args))
    },
    {
      ...declarationByName.get("radius_environment_status")!,
      handler: async (args: ToolArgs) =>
        JSON.stringify(await deps.environment.status(args))
    },
    {
      ...declarationByName.get("radius_environment_control")!,
      handler: async (args: ToolArgs) =>
        JSON.stringify(await deps.environment.control(args))
    }
  ];
}

export type RadiusTools = ReturnType<typeof createRadiusTools>;
