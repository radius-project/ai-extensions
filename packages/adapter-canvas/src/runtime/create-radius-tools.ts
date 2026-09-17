// createRadiusTools — builds the retained tools and additive lifecycle tool
// from RADIUS_TOOL_DECLARATIONS
// plus a RadiusExtensionDependencies dependency object. Same shape as
// createRadiusCanvas: pure construction, no I/O until a handler is invoked.

import {
  RADIUS_TOOL_DECLARATIONS,
  RADIUS_LIFECYCLE_TOOL_DECLARATION
} from "./declarations.js";
import {
  ambiguousAppSourceBrief,
  evaluateAppSource,
  unsupportedAppSourceReport
} from "@radius-project/core";
import { errorMessage, optionalString } from "./util.js";
import { createGraphContextHelpers } from "./graph-context.js";
import { readCommittedGraphDiff, canvasResources } from "./graph-reader.js";
import {
  failedGraphDiffResult,
  successfulGraphDiffResult,
  unavailableGraphDiffResult
} from "./pr-graph-diff-result.js";
import type { RadiusExtensionDependencies } from "./dependencies.js";
import type { ModelingActivity } from "./modeling-activity.js";
import type { MissingModelHandoffClaims } from "./missing-model-handoff-claims.js";
import type { DeployToolArgs } from "../deploy-tools.js";
import {
  appModelTargetKey,
  clearAppModelAuthoringFailure
} from "../app-model-authoring-failure.js";

interface ToolArgs {
  [key: string]: unknown;
}

export function createRadiusTools(
  deps: RadiusExtensionDependencies,
  // Legacy handoffs and nonterminal canonical results announce an active run.
  modelingActivity: ModelingActivity,
  // Released when a modeling run reports a terminal failure, so the retry the
  // failure message promises is not swallowed by the dead run's claim.
  missingModelHandoffs: MissingModelHandoffClaims
) {
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

  async function legacyAuthoring(repoPath?: string): Promise<string> {
    let brief: string | undefined;
    const discoveryUnavailable =
      "Workspace discovery was unavailable. Inspect the requested source before authoring; no source scope or lifecycle authority has been established by this handoff.";
    const state = await workspaceState().catch(() => {
      brief = discoveryUnavailable;
      return null;
    });
    const targetsWorkspace =
      !repoPath ||
      deps.workspace.isWorkspacePath(state?.workspacePath, repoPath);
    if (state && targetsWorkspace) {
      const repo = state.contextRepo || "";
      const branch = state.contextBranch || "";
      const source = await evaluateAppSourceForBranch(
        repo,
        branch,
        state
      ).catch(() => null);
      if (source?.status === "none")
        return unsupportedAppSourceReport(state.contextRepo);
      if (!source || source.status === "unknown") {
        brief = discoveryUnavailable;
      } else {
        const listing =
          source.status === "ambiguous" ?
            await listSourceTreeForBranch(repo, branch, state)
          : null;
        const scoped =
          !!repoPath &&
          deps.workspace.isWorkspacePath(state.workspacePath, repoPath) &&
          !deps.workspace.isWorkspacePath(repoPath, state.workspacePath);
        brief =
          scoped ? undefined : (
            (ambiguousAppSourceBrief(source, listing) ?? undefined)
          );
      }
    }
    if (deps.lifecycle.routing.selection("definition").writer !== "legacy")
      return JSON.stringify({
        error: {
          code: "PRECONDITION_FAILED",
          message:
            "The authoring writer changed during source discovery. Retry the request."
        }
      });
    const handoff = deps.radiusAppBicepSkill(repoPath, brief);
    if (targetsWorkspace && state?.contextRepo && state.contextBranch)
      modelingActivity.announce({
        repo: state.contextRepo,
        branch: state.contextBranch
      });
    return handoff;
  }

  return [
    {
      ...RADIUS_LIFECYCLE_TOOL_DECLARATION,
      handler: async (args: ToolArgs) =>
        JSON.stringify(await deps.lifecycle.execute(args))
    },
    {
      ...declarationByName.get("radius_generate_app")!,
      handler: async (args: ToolArgs) => {
        const failure = (code: string, message: string) =>
          JSON.stringify({ error: { code, message } });
        if (args.repoPath !== undefined && typeof args.repoPath !== "string")
          return failure("INVALID_REQUEST", "repoPath must be a string.");
        try {
          if (
            deps.lifecycle.routing.selection("definition").writer === "legacy"
          )
            return await legacyAuthoring(args.repoPath);
          const state = await workspaceState();
          const repo = state.contextRepo;
          const branch = state.contextBranch;
          if (
            !state.workspacePath ||
            !repo ||
            !branch ||
            !deps.workspace.isWorkspaceSelection(state, repo, branch)
          )
            return failure(
              "RESULT_UNAVAILABLE",
              "The trusted workspace source could not be established."
            );
          const repoPath = args.repoPath;
          if (
            repoPath &&
            !deps.workspace.isWorkspacePath(state.workspacePath, repoPath)
          )
            return failure(
              "CAPABILITY_UNAVAILABLE",
              "Authoring supports only the trusted workspace root; the requested source path is unavailable."
            );
          const listing = await deps.workspace.fetchWorkspaceTree(
            state,
            repo,
            branch
          );
          const source = evaluateAppSource(listing);
          if (source.status === "unknown")
            return failure(
              "RESULT_UNAVAILABLE",
              "The workspace source listing could not be established."
            );
          if (source.status === "none") return unsupportedAppSourceReport(repo);
          // A scoped directory is not representable by the canonical source
          // contract. Never silently widen the user's selected application.
          if (
            repoPath &&
            !deps.workspace.isWorkspacePath(repoPath, state.workspacePath)
          )
            return failure(
              "CAPABILITY_UNAVAILABLE",
              "Canonical authoring cannot represent a source subdirectory; no application definition was started."
            );
          const brief = ambiguousAppSourceBrief(source, listing);
          const result = await deps.lifecycle.execute({
            operation: "definition.author",
            target: { repo, definition: ".radius/app.bicep" },
            input: {
              intent:
                "Generate a Radius application definition from the current workspace." +
                (brief ? `\n\n${brief}` : ""),
              provider: "azure"
            }
          });
          if (
            "operation" in result &&
            result.operation === "definition.author" &&
            (result.result.state === "queued" ||
              result.result.state === "running" ||
              result.result.state === "action_required")
          )
            modelingActivity.announce({ repo, branch });
          return JSON.stringify(result);
        } catch {
          return failure(
            "RESULT_UNAVAILABLE",
            "The workspace authoring request could not be completed."
          );
        }
      }
    },
    {
      ...declarationByName.get("radius_report_modeling_failure")!,
      // Legacy Canvas diagnostic only: this is not an authenticated agent
      // outcome and cannot complete, approve, or promote a lifecycle action.
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
        const content = await fetchBicepForBranch(repo, branch, entry.state);
        if (content) {
          clearAppModelAuthoringFailure(entry.state, repo, branch);
          return {
            recorded: false,
            error:
              "The application model now exists; the stale failure was not recorded."
          };
        }
        if (entry.state.appModelAttemptTokens?.[target] !== attemptToken) {
          return {
            recorded: false,
            error:
              "A newer Canvas modeling attempt replaced this one; the stale failure was not recorded."
          };
        }
        entry.state.appModelFailures ??= {};
        entry.state.appModelFailures[target] = {
          attemptToken,
          error: failure
        };
        // The run this claim belongs to just ended, so the claim can only
        // suppress the retry the failure message tells the user to make. Its
        // target key matches this one exactly: a claim is keyed
        // `repo::branches.join(",")`, and an attempt token is only minted for a
        // single branch, so a recordable failure always names one branch.
        // Without this release the explicit refresh clears the failure, asks for
        // a handoff, and is dropped by the dead run's claim until it expires.
        const claim = missingModelHandoffs.current(target);
        if (claim) missingModelHandoffs.release(claim);
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
        try {
          const result = await readCommittedGraphDiff(
            deps.lifecycle,
            repo,
            baseBranch,
            headBranch
          );
          if (result.status !== "ok")
            return unavailableGraphDiffResult(
              `${result.error.code}: ${result.error.message}`
            );
          if (result.value.status === "unavailable")
            return unavailableGraphDiffResult(
              `${result.value.source}: ${result.value.reason}: ${result.value.message}`
            );
          return successfulGraphDiffResult(
            deps.renderPrDiffMarkdown(
              canvasResources(result.value.graph),
              baseBranch,
              headBranch
            )
          );
        } catch {
          return failedGraphDiffResult(
            "Could not generate app graph diff: the selected graph evidence is unavailable."
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
