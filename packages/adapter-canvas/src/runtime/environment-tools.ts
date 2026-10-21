import { randomUUID } from "node:crypto";
import { isValidRepoSlug, isUuid } from "../azure-oidc.js";
import { canExitSetup } from "../operations.js";
import type { SelectedGhExecutor } from "../gh.js";
import type { OperationRecord } from "../server/routes/operations-status.js";
import type {
  OperationControlService,
  OperationControlResult
} from "../server/services/operation-control.js";
import type { OperationResumeService } from "../server/services/operation-resume.js";
import type { createSetupStartService } from "../server/services/setup-start.js";
import type { VerificationStatusResult } from "../server/services/verification-status.js";
import type { DeploymentAccountResolver } from "./deployment-account.js";
import type { EnvironmentExecutionOwner } from "./environment-execution-owner.js";
import type { SessionHolder } from "./session.js";
import {
  ENVIRONMENT_SETUP_ARGUMENT_SCHEMA,
  ENVIRONMENT_STATUS_SCHEMA,
  ENVIRONMENT_CONTROL_ARGUMENT_SCHEMA,
  environmentRecord,
  environmentString as text,
  readEnvironmentArguments
} from "./environment-tool-schema.js";
import {
  environmentActions,
  environmentDiagnostic,
  projectEnvironmentOperation,
  projectEnvironmentVerification,
  type EnvironmentTarget,
  type EnvironmentRequiredInteraction,
  type EnvironmentToolResult
} from "./environment-tool-result.js";

export interface EnvironmentToolsPorts {
  owner: EnvironmentExecutionOwner;
  session: SessionHolder;
  account: DeploymentAccountResolver;
  readExecutor(login: string): Promise<SelectedGhExecutor>;
  workspace(): Promise<{ repo: string; branch: string }>;
  validateBranch(branch: string): Promise<void>;
  getOperation(operationId: string): OperationRecord | null | undefined;
  start: ReturnType<typeof createSetupStartService>;
  control: OperationControlService;
  resume: OperationResumeService;
  verification(
    target: EnvironmentTarget & { operationId: string },
    executor: SelectedGhExecutor
  ): Promise<VerificationStatusResult>;
  bypass(
    target: EnvironmentTarget & { operationId: string; runId: string },
    executor: SelectedGhExecutor,
    isCurrent: () => boolean
  ): Promise<OperationControlResult>;
  redact(value: string): string;
  reportError(error: unknown): void;
}

interface PromptInteraction {
  prompt: object;
  fingerprint: string;
  interaction: EnvironmentRequiredInteraction;
  consumed: boolean;
}

class EnvironmentRefusal extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function fingerprint(operation: OperationRecord): string {
  return JSON.stringify([
    operation.repo,
    operation.environment,
    operation.provider,
    operation.context,
    operation.state,
    operation.currentStage,
    operation.control,
    operation.verification,
    operation.inputRequired,
    operation.failure,
    operation.request,
    operation.resumeRequest,
    operation.providerRecovery
  ]);
}

export function createEnvironmentTools(ports: EnvironmentToolsPorts) {
  const pending = new Set<string>();
  const prompts = new WeakMap<OperationRecord, PromptInteraction>();
  const diagnostic = (value: string) =>
    environmentDiagnostic(value, ports.redact);
  const safe = (operation: OperationRecord) =>
    projectEnvironmentOperation(operation, ports.redact);
  const refused = (code: string, message: string): EnvironmentToolResult => ({
    kind: "refused",
    code,
    message: diagnostic(message)
  });
  const unavailable = (
    code: string,
    message: string
  ): EnvironmentToolResult => ({
    kind: "unavailable",
    code,
    message: diagnostic(message)
  });
  const interaction = (
    target: EnvironmentTarget,
    kind: EnvironmentRequiredInteraction["kind"],
    code: string,
    message: string,
    supported = false
  ): EnvironmentToolResult => ({
    kind: "interaction_required",
    code,
    interaction: {
      ...target,
      interactionId: randomUUID(),
      kind,
      code,
      supported,
      message: diagnostic(message)
    }
  });
  function targetOf(
    args: Record<string, unknown>
  ): EnvironmentTarget & { operationId: string } {
    const repo = text(args.repo);
    if (!isValidRepoSlug(repo))
      throw new Error("repo must use the owner/repository format.");
    return {
      repo,
      environment: text(args.environment),
      operationId: text(args.operationId)
    };
  }
  function lookup(target: EnvironmentTarget): OperationRecord {
    const operation = ports.getOperation(target.operationId ?? "");
    if (!operation)
      throw new EnvironmentRefusal(
        "unknown-operation",
        "No saved setup operation has that operationId."
      );
    if (
      operation.kind === "delete" ||
      operation.repo !== target.repo ||
      operation.environment !== target.environment
    ) {
      throw new EnvironmentRefusal(
        "operation-target-mismatch",
        "The saved setup operation does not match operationId, repo and environment."
      );
    }
    safe(operation);
    return operation;
  }
  const savedLogin = (operation: OperationRecord) =>
    text(environmentRecord(operation.context)?.githubLogin);
  function current(operation: OperationRecord, snapshot: string): boolean {
    return (
      !ports.owner.isShuttingDown() &&
      ports.getOperation(operation.operationId) === operation &&
      fingerprint(operation) === snapshot
    );
  }
  function promptFor(
    operation: OperationRecord
  ): EnvironmentRequiredInteraction | undefined {
    const prompt = environmentRecord(operation.inputRequired);
    if (!prompt || operation.state !== "input_required") return undefined;
    const snapshot = fingerprint(operation);
    const previous = prompts.get(operation);
    if (
      previous?.prompt === prompt &&
      previous.fingerprint === snapshot &&
      !previous.consumed
    ) {
      return previous.interaction;
    }
    const code = text(prompt.code);
    const kind =
      code.includes("consent") ? "azure-consent"
      : code.includes("login") || code.includes("authentication") ?
        "azure-login"
      : "setup-input";
    const supported = environmentActions(operation).includes("resume");
    const issued: EnvironmentRequiredInteraction = {
      operationId: operation.operationId,
      repo: text(operation.repo),
      environment: text(operation.environment),
      interactionId: randomUUID(),
      kind,
      code,
      checkpoint: text(prompt.checkpoint),
      supported,
      message: diagnostic(
        text(prompt.message) ||
          "Review the saved setup prompt before continuing."
      )
    };
    prompts.set(operation, {
      prompt,
      fingerprint: snapshot,
      interaction: issued,
      consumed: false
    });
    return issued;
  }
  async function account(
    target: EnvironmentTarget,
    isCurrent: () => boolean,
    login?: string
  ): Promise<SelectedGhExecutor | EnvironmentToolResult> {
    const selection = await ports.account({
      target,
      isCurrent,
      ...(login !== undefined ? { savedLogin: login } : {})
    });
    if (selection.state === "selected") return selection.executor;
    if (selection.state === "choice-required") {
      return interaction(
        target,
        "github-account-selection",
        "github-account-selection-required",
        "Choose an eligible GitHub account in a host with account-selection support, then retry this target."
      );
    }
    if (selection.state === "reauthorization-required") {
      return interaction(
        target,
        "github-reauthorization",
        "github-reauthorization-required",
        selection.message
      );
    }
    if (selection.state === "unavailable")
      return unavailable("github-account-unavailable", selection.message);
    return refused(
      `github-account-${selection.state}`,
      "Account selection was declined, superseded or stopped. No work was admitted."
    );
  }
  async function run(
    input: unknown,
    schema: Parameters<typeof readEnvironmentArguments>[1],
    body: (args: Record<string, unknown>) => Promise<EnvironmentToolResult>
  ): Promise<EnvironmentToolResult> {
    if (ports.owner.isShuttingDown())
      return unavailable(
        "operation-shutting-down",
        "The environment runtime is shutting down."
      );
    let args: Record<string, unknown>;
    try {
      args = readEnvironmentArguments(input, schema);
      targetOf(args);
    } catch (error) {
      return refused(
        "invalid-environment-tool-input",
        error instanceof Error ? error.message : String(error)
      );
    }
    try {
      return await body(args);
    } catch (error) {
      if (error instanceof EnvironmentRefusal)
        return refused(error.code, error.message);
      ports.reportError(error);
      return unavailable(
        "environment-tool-failed",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  function outcome(
    result: OperationControlResult,
    target: EnvironmentTarget
  ): EnvironmentToolResult {
    const code = text(result.body.code);
    if (result.status >= 400) {
      const message =
        text(result.body.error) ||
        "The environment service refused the operation.";
      if (code.includes("merge"))
        return interaction(target, "pull-request-merge", code, message);
      return result.status >= 500 ?
          unavailable(code || "environment-service-unavailable", message)
        : refused(code || "environment-command-refused", message);
    }
    const operation = lookup({
      ...target,
      operationId: text(result.body.operationId) || target.operationId
    });
    const prompt = promptFor(operation);
    return {
      kind: "accepted",
      code: code || "operation-accepted",
      operation: safe(operation),
      ...(prompt ? { interaction: prompt } : {})
    };
  }
  return {
    start(input: unknown): Promise<EnvironmentToolResult> {
      return run(input, ENVIRONMENT_SETUP_ARGUMENT_SCHEMA, async (args) => {
        const { repo, environment } = targetOf(args);
        const target = { repo, environment };
        const key = `setup:${target.repo}`;
        if (pending.has(key))
          return refused(
            "operation-interaction-pending",
            "A setup request for this repository is already being admitted."
          );
        pending.add(key);
        try {
          const workspace = await ports.workspace();
          if (!args.branch) {
            if (workspace.repo !== target.repo || !workspace.branch) {
              return interaction(
                target,
                "target-required",
                "setup-branch-required",
                "Specify branch explicitly for a repository other than the current session repository."
              );
            }
            args.branch = workspace.branch;
          }
          await ports.validateBranch(text(args.branch));
          for (const key of ["clientId", "appId"]) {
            if (args[key] !== undefined && !isUuid(args[key])) {
              return refused(
                "invalid-azure-operation-input",
                `${key} must be a UUID.`
              );
            }
          }
          const isCurrent = () => !ports.owner.isShuttingDown();
          let required: EnvironmentToolResult | undefined;
          const result = await ports.start({
            data: args,
            isCurrent,
            claimAccount: async () => {
              const selected = await account(target, isCurrent);
              if ("kind" in selected) {
                required = selected;
                return { ok: false, error: "missing" };
              }
              return {
                ok: true,
                login: selected.login,
                credentialSource: selected.credentialSource,
                commit() {},
                release() {}
              };
            }
          });
          return required ?? outcome(result, target);
        } finally {
          pending.delete(key);
        }
      });
    },
    status(input: unknown): Promise<EnvironmentToolResult> {
      return run(input, ENVIRONMENT_STATUS_SCHEMA, async (args) => {
        const target = targetOf(args);
        const operation = lookup(target);
        const snapshot = fingerprint(operation);
        const login = savedLogin(operation);
        if (!login)
          return interaction(
            target,
            "github-reauthorization",
            "github-reauthorization-required",
            "The saved GitHub account is missing. Reauthorize the original account before continuing."
          );
        let executor: SelectedGhExecutor;
        try {
          executor = await ports.readExecutor(login);
        } catch {
          return interaction(
            target,
            "github-reauthorization",
            "github-reauthorization-required",
            "The saved GitHub account is unavailable. Reauthorize that account; another login cannot replace it."
          );
        }
        if (executor.login !== login || !current(operation, snapshot)) {
          return refused(
            "operation-context-changed",
            "The operation or its saved account changed during the read."
          );
        }
        const verification = operation.verification;
        const observed =
          verification ? await ports.verification(target, executor) : undefined;
        // The observer may persist legitimate progress, but cannot retarget its owner.
        if (
          ports.owner.isShuttingDown() ||
          ports.getOperation(target.operationId) !== operation ||
          savedLogin(operation) !== login ||
          operation.repo !== target.repo ||
          operation.environment !== target.environment ||
          operation.verification !== verification
        ) {
          return refused(
            "operation-context-changed",
            "The verification target changed during observation."
          );
        }
        if (observed && observed.status >= 400)
          return unavailable(
            "verification-unavailable",
            text(observed.body.error)
          );
        const projected = safe(operation);
        if (
          observed?.body.state === "failed" &&
          observed.body.category === "permissions"
        ) {
          projected.actions.push("bypass-verification");
        }
        const prompt = promptFor(operation);
        return {
          kind: "status",
          code: "operation-status",
          operation: projected,
          ...(observed ?
            {
              verification: projectEnvironmentVerification(
                observed.body,
                ports.redact
              )
            }
          : {}),
          ...(prompt ? { interaction: prompt } : {})
        };
      });
    },
    control(input: unknown): Promise<EnvironmentToolResult> {
      return run(input, ENVIRONMENT_CONTROL_ARGUMENT_SCHEMA, async (args) => {
        const target = targetOf(args);
        const operation = lookup(target);
        const key = `control:${target.operationId}`;
        if (pending.has(key))
          return refused(
            "operation-interaction-pending",
            "A command or host interaction is already pending for this operation."
          );
        pending.add(key);
        try {
          let snapshot = fingerprint(operation);
          const isCurrent = () => current(operation, snapshot);
          const action = text(args.action);
          const selected = await account(
            target,
            isCurrent,
            savedLogin(operation)
          );
          if ("kind" in selected) return selected;
          if (!isCurrent())
            return refused(
              "operation-context-changed",
              "The operation changed before command admission."
            );
          if (action === "resume") {
            const issued = prompts.get(operation);
            const answer = environmentRecord(args.answer);
            if (
              !issued ||
              issued.consumed ||
              issued.fingerprint !== snapshot ||
              issued.prompt !== operation.inputRequired ||
              issued.interaction.interactionId !== args.interactionId ||
              issued.interaction.code !== answer?.code ||
              issued.interaction.checkpoint !== args.checkpoint ||
              operation.provider !== args.provider
            ) {
              return refused(
                "operation-resume-mismatch",
                "The answer does not match the current, unconsumed setup interaction."
              );
            }
            if (answer?.appId !== undefined && !isUuid(answer.appId)) {
              return refused(
                "invalid-azure-operation-input",
                "appId must be a UUID."
              );
            }
            issued.consumed = true;
            return outcome(
              await ports.resume(
                {
                  operationId: target.operationId,
                  code: text(answer?.code)
                },
                async () => {
                  if (!isCurrent() || operation.inputRequired !== issued.prompt)
                    throw new Error(
                      "The setup interaction changed before its answer was admitted."
                    );
                  return {
                    ...answer,
                    repo: target.repo,
                    environment: target.environment,
                    provider: text(args.provider),
                    checkpoint: text(args.checkpoint)
                  };
                }
              ),
              target
            );
          }
          let bypassRun = "";
          if (action === "bypass-verification") {
            const verification = JSON.stringify(operation.verification);
            const login = savedLogin(operation);
            const control = JSON.stringify(operation.control);
            const observed = await ports.verification(target, selected);
            if (
              ports.owner.isShuttingDown() ||
              ports.getOperation(target.operationId) !== operation ||
              savedLogin(operation) !== login ||
              JSON.stringify(operation.verification) !== verification ||
              JSON.stringify(operation.control) !== control ||
              operation.repo !== target.repo ||
              operation.environment !== target.environment ||
              observed.status !== 200 ||
              observed.body.state !== "failed" ||
              observed.body.category !== "permissions"
            ) {
              return refused(
                "verification-bypass-ineligible",
                "Only a positively classified permissions failure may be bypassed."
              );
            }
            bypassRun =
              text(observed.body.runId) || String(observed.body.runId ?? "");
            if (!/^\d+$/.test(bypassRun))
              return refused(
                "verification-bypass-ineligible",
                "Verification has no exact saved run identity."
              );
            snapshot = fingerprint(operation);
          } else if (
            !environmentActions(operation).some(
              (eligible) => eligible === action
            )
          ) {
            return refused(
              "operation-command-ineligible",
              "The command is not currently eligible for this setup operation."
            );
          }
          const exit: { ok: boolean; abandon?: boolean; targets?: unknown[] } =
            canExitSetup(operation);
          const sensitive =
            [
              "rollback",
              "retry-cleanup",
              "abandon",
              "cancel-workflow",
              "bypass-verification"
            ].includes(action) ||
            (action === "exit" && !!exit.targets?.length);
          if (sensitive) {
            const session = ports.session.tryGet();
            const confirm =
              session?.capabilities?.ui?.elicitation === true ?
                session.ui?.confirm?.bind(session.ui)
              : undefined;
            if (!confirm)
              return interaction(
                target,
                "confirmation",
                "host-confirmation-required",
                `Use a trusted host to confirm ${action} for this saved setup. No command was admitted.`
              );
            const effect =
              action === "cancel-workflow" ?
                "Cancel only the exact saved verification workflow run."
              : action === "bypass-verification" ?
                "Allow this environment to be used despite the confirmed permissions-only verification failure."
              : action === "abandon" ?
                "Close setup and leave remaining resources in place; manual cleanup may be needed."
              : "Remove only setup resources whose ownership the saved operation proves. Reused resources remain. This cannot be undone.";
            const confirmed = await confirm(
              `Confirm ${action} for ${target.repo}, environment ${target.environment}, operation ${target.operationId}. ${effect}`
            );
            if (!confirmed)
              return refused(
                "host-confirmation-declined",
                "The host did not confirm this command."
              );
            if (!isCurrent())
              return refused(
                "operation-context-changed",
                "The operation changed while confirmation was pending. Confirm the current operation instead."
              );
          }
          if (action === "bypass-verification") {
            return outcome(
              await ports.bypass(
                { ...target, runId: bypassRun },
                selected,
                isCurrent
              ),
              target
            );
          }
          const commands = {
            continue: { command: "continue" },
            verify: { command: "retry", retryKind: "verification" },
            "retry-setup": { command: "retry", retryKind: "setup" },
            "retry-cleanup": { command: "retry", retryKind: "cleanup" },
            stop: { command: "stop" },
            "cancel-workflow": { command: "cancel-workflow" },
            rollback: { command: "rollback" },
            exit: { command: "exit" },
            abandon: { command: "exit", abandon: true }
          } as const;
          if (!Object.hasOwn(commands, action))
            throw new Error("Unsupported environment command.");
          const command = commands[action as keyof typeof commands];
          return outcome(
            await ports.control({
              operationId: target.operationId,
              ...command,
              isCurrent
            }),
            target
          );
        } finally {
          pending.delete(key);
        }
      });
    }
  };
}

export type EnvironmentTools = ReturnType<typeof createEnvironmentTools>;
