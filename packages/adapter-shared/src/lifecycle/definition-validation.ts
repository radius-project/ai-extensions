import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, posix } from "node:path";
import {
  createValidationPolicy,
  portFailure,
  portSuccess,
  reduceValidationReport,
  sameLifecycleData,
  type DefinitionValidationPort,
  type ValidationCheck,
  type ValidationReport
} from "@radius-project/core/lifecycle";
import {
  evaluateAppSource,
  normalizeAppBicep,
  parseAppOrigin,
  requiredStagedFiles
} from "@radius-project/core/modeling";
import {
  RadProcessError,
  spawnRad,
  verifyIsolatedBicepConfiguration
} from "../rad.js";
import {
  createCapturedSourceExecutor,
  type GraphCompilationDependencies
} from "./graph-execution.js";
import { readSourceFile } from "./source-access-files.js";

export interface DefinitionValidationDependencies extends Omit<
  GraphCompilationDependencies,
  "runGraph"
> {
  readonly nodePath: string;
  readonly scriptPath: string;
  readonly runProcess?: typeof spawnRad;
}

const machineChecks = [
  "bicep-compile",
  "type-compatibility",
  "secret-safety",
  "runtime-contract",
  "reference-consistency",
  "recipe-constraints"
] as const;
const unavailableReasons = {
  "bicep-compile":
    "The compiler did not return a complete template and SARIF diagnostics.",
  "type-compatibility":
    "Required resolved-type schema evidence is missing or incomplete.",
  "secret-safety":
    "Required schema sensitivity evidence is missing or incomplete.",
  "runtime-contract":
    "Static variable-expansion rules ran, but application/client and selected Recipe runtime evidence is not captured.",
  "reference-consistency":
    "Reference syntax and build-ref rules ran, but referenced source existence and revision evidence is not captured.",
  "recipe-constraints":
    "Selected provider Recipe registration, behavior, and output mapping evidence is not captured."
};

function parseChecks(text: string): ValidationCheck[] {
  const value: unknown = JSON.parse(text);
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("checks" in value) ||
    !Array.isArray(value.checks) ||
    value.checks.length !== machineChecks.length
  )
    throw new Error("The validation executable returned an invalid report.");
  const checks: unknown[] = value.checks;
  return machineChecks.map((checkId, index) => {
    const check: unknown = checks[index];
    if (
      !check ||
      typeof check !== "object" ||
      !("checkId" in check) ||
      check.checkId !== checkId ||
      !("status" in check) ||
      (check.status !== "passed" &&
        check.status !== "failed" &&
        check.status !== "unavailable")
    )
      throw new Error(
        "The validation executable returned invalid check evidence."
      );
    return {
      checkId,
      classification: "required",
      status: check.status,
      reason:
        check.status === "passed" ? "The available validation rules passed."
        : check.status === "failed" ?
          "A required validation rule rejected the definition."
        : unavailableReasons[checkId]
    };
  });
}

/** Runs installed validation rules against owned bytes, without an agent or publication. */
export function createDefinitionValidationAdapter(
  deps: DefinitionValidationDependencies
): DefinitionValidationPort {
  if (
    !isAbsolute(deps.nodePath) ||
    !isAbsolute(deps.scriptPath) ||
    (deps.runProcess !== undefined && typeof deps.runProcess !== "function")
  )
    throw new TypeError(
      "Definition validation requires explicit trusted executable paths."
    );
  const executor = createCapturedSourceExecutor(deps);
  const run = deps.runProcess ?? spawnRad;
  return {
    async validate(request, control) {
      const { snapshot, sourceFingerprint, proposalFingerprint } = request;
      const policy = createValidationPolicy(
        request.policy.purpose,
        request.policy.provider
      );
      if (
        !sameLifecycleData(policy, request.policy) ||
        (proposalFingerprint ?? sourceFingerprint) !==
          snapshot.manifest.fingerprint ||
        (policy.purpose === "authoring" && !proposalFingerprint)
      )
        return portFailure("EVIDENCE_MISMATCH");
      const outcomes: ValidationCheck[] = [];
      const add = (
        checkId: string,
        status: ValidationCheck["status"],
        reason: string
      ) => {
        const existing = outcomes.findIndex(
          (check) => check.checkId === checkId
        );
        const check: ValidationCheck = {
          checkId,
          classification: "required",
          status,
          reason
        };
        if (existing < 0) outcomes.push(check);
        else outcomes[existing] = check;
      };
      const execution = await executor.execute(
        snapshot,
        control,
        async (context) => {
          add(
            "path-input-closure",
            "passed",
            "The exact captured input closure was materialized and verified."
          );
          verifyIsolatedBicepConfiguration(context.isolation);
          for (const file of [deps.nodePath, deps.scriptPath]) {
            if (!(await deps.files.lstat(file)).isFile())
              throw new Error(
                "A trusted validation executable is unavailable."
              );
          }
          const names = snapshot.manifest.inputs
            .filter((input) => input.existed)
            .map((input) => input.path);
          if (policy.purpose === "authoring") {
            const modelability = evaluateAppSource(names);
            add(
              "modelability",
              modelability.dockerfiles.length ? "passed" : "unavailable",
              modelability.dockerfiles.length ?
                "Captured Dockerfile evidence establishes containerized application source."
              : "The definition snapshot does not establish the application's Dockerfile source."
            );
            const folder = posix.dirname(snapshot.manifest.definition);
            const staged = names
              .filter((name) => posix.dirname(name) === folder)
              .map((name) => posix.basename(name));
            const complete = requiredStagedFiles(staged).every((name) =>
              staged.includes(name)
            );
            let artifactStatus: ValidationCheck["status"] = "unavailable";
            if (complete) {
              const originFile = await readSourceFile(
                deps.files,
                context.isolation.cwd,
                posix.join(folder, "app.origin.json"),
                Number.MAX_SAFE_INTEGER,
                control.cancellation
              );
              if (originFile.status === "present") {
                const origin = parseAppOrigin(
                  new TextDecoder().decode(originFile.bytes)
                );
                artifactStatus =
                  (
                    origin &&
                    origin.appBicepHash ===
                      `sha256:${createHash("sha256").update(normalizeAppBicep(context.content)).digest("hex")}`
                  ) ?
                    "passed"
                  : "failed";
              }
            }
            add(
              "staged-artifacts",
              artifactStatus,
              artifactStatus === "passed" ?
                "The required staged artifact set and matching model origin are captured."
              : artifactStatus === "failed" ?
                "The staged origin does not describe the proposed application model."
              : "Required staged artifacts are absent from the captured proposal."
            );
          }
          const options = {
            cwd: dirname(context.definition),
            env: {
              ...context.isolation.env,
              BICEP: context.binaries.bicepPath
            },
            inheritEnv: false,
            signal: context.signal,
            timeout: deps.timeoutMs,
            label: "Bicep validation compile"
          };
          let compiled;
          let compilerStatus = "passed";
          try {
            compiled = await run(
              context.binaries.bicepPath,
              [
                "build",
                context.definition,
                "--diagnostics-format",
                "sarif",
                "--stdout"
              ],
              options
            );
          } catch (error) {
            if (
              !(error instanceof RadProcessError) ||
              error.cleanupIncomplete ||
              !/^Bicep validation compile exited with code \d+$/.test(
                error.message
              )
            )
              throw error;
            compiled = error;
            compilerStatus = "failed";
            add(
              "bicep-compile",
              "failed",
              "The compiler rejected the definition."
            );
          }
          context.signal.throwIfAborted();
          const temporary = dirname(context.isolation.cwd);
          const template = join(temporary, "validation-template.json");
          const diagnostics = join(temporary, "validation-diagnostics.json");
          await deps.files.write(
            template,
            new TextEncoder().encode(compiled.stdout)
          );
          await deps.files.write(
            diagnostics,
            new TextEncoder().encode(compiled.stderr)
          );
          const result = await run(
            deps.nodePath,
            [
              deps.scriptPath,
              "--validate-json",
              context.definition,
              template,
              diagnostics,
              compilerStatus,
              policy.provider ?? "unspecified",
              ...names
                .filter(
                  (name) => posix.basename(name) === "custom-recipe-pack.bicep"
                )
                .map((name) => join(context.isolation.cwd, name))
            ],
            { ...options, label: "Definition validation" }
          );
          for (const check of parseChecks(result.stdout))
            add(check.checkId, check.status, check.reason);
          return portSuccess(undefined);
        }
      );
      if (execution.status !== "ok" && execution.status !== "unavailable")
        return execution;
      // A missing evidence channel remains required. No post-execution
      // reclassification and no raw compiler/source text in public diagnostics.
      const report: ValidationReport = reduceValidationReport(
        policy,
        outcomes,
        {
          sourceFingerprint,
          ...(proposalFingerprint ? { proposalFingerprint } : {})
        }
      );
      return portSuccess(report);
    }
  };
}
