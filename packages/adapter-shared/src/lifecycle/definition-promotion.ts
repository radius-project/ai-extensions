import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  CUSTOM_TYPE_STAGED_FILES,
  REQUIRED_STAGED_FILES,
  publishableFiles
} from "@radius-project/core/modeling";
import {
  buildEffectiveInputManifest,
  compareEffectiveInputManifests,
  createValidationPolicy,
  handleSchema,
  portCancelled,
  portFailure,
  portForbidden,
  portSuccess,
  portUnavailable,
  sameLifecycleData,
  validateSourcePath,
  verifyValidationReport,
  type AuthorizedScope,
  type CleanupResult,
  type DefinitionAuthoringSourcePort,
  type DefinitionInput,
  type PortResult,
  type PortError,
  type PortCancelled,
  type PromotionRequest,
  type PromotionResult,
  type ReadResult,
  type RequestControl,
  type SourceCapture,
  type SourceSnapshot,
  type StagedOutputs,
  type StagingArea
} from "@radius-project/core/lifecycle";
import {
  createSourceReadAdapter,
  type SourceReadAdapter,
  type SourceReadDependencies
} from "./source-access.js";
import {
  checkSourceCancellation,
  readSourceFile,
  sourceCleanupFailure,
  sourceUnavailable,
  SourceAccessFault
} from "./source-access-files.js";
import { collectSourceInputs } from "./source-access-closure.js";

export interface PromotionBaseline {
  readonly baseline: Readonly<Record<string, string | null>>;
  readonly sourceBaseline: Readonly<Record<string, string | null>>;
  readonly inputFiles: readonly string[];
}
/** Inject the shipped promote-app-model.mjs exports, not another filesystem writer. */
export interface DefinitionPromotionMachinery {
  beginStagedRun(options: { radiusDir: string; runId: string }): string;
  promoteStagedRun(options: {
    radiusDir: string;
    stagingDir: string;
    record: PromotionBaseline;
    validatedOutputs: Readonly<Record<string, string>>;
    checkInputs: (published?: readonly string[]) => Promise<void>;
    signal: AbortSignal;
    stageInGit: false;
  }): Promise<{ status: string; files: string[]; gitError: string }>;
  abortStagedRun(options: { radiusDir: string; stagingDir: string }): unknown;
}
export interface DefinitionPromotionDependencies {
  readonly source: SourceReadDependencies;
  readonly staging: DefinitionPromotionMachinery;
}
export interface DefinitionPromotionAdapter
  extends DefinitionAuthoringSourcePort, SourceReadAdapter {
  /** Trusted agent bridge only; a filesystem location never enters a public source/staging reference. */
  stagingLocation(
    staging: StagingArea,
    control: RequestControl
  ): Promise<PortResult<string>>;
}
interface Original {
  readonly scope: AuthorizedScope<"definition.author">;
  readonly root: string;
  readonly baseline: Readonly<Record<string, string | null>>;
}
interface OwnedStaging {
  readonly area: StagingArea;
  readonly original: Original;
  readonly scope: AuthorizedScope<"definition.author">;
  readonly directory: string;
  readonly active: Set<Promise<unknown>>;
  outputs?: StagedOutputs;
  bytes?: ReadonlyMap<string, Uint8Array>;
  proposal?: SourceSnapshot;
  consumed: boolean;
  recovery: boolean;
  releasing?: Promise<CleanupResult>;
}
const hash = (bytes: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function unwrap<T>(result: ReadResult<T>): T {
  if (result.status !== "ok")
    throw new SourceAccessFault(
      result.status === "absent" ? portFailure("SOURCE_CHANGED") : result
    );
  return result.value;
}
function errorResult(error: unknown): PortError | PortCancelled {
  if (
    error instanceof Error &&
    "rollback" in error &&
    error.rollback === "failed"
  ) {
    const primary = errorResult(error.cause);
    return sourceCleanupFailure(
      primary.status === "cancelled" ?
        portFailure("PRECONDITION_FAILED")
      : primary
    );
  }
  let primary: PortError | PortCancelled;
  if (
    error instanceof Error &&
    "cause" in error &&
    error.cause instanceof SourceAccessFault
  )
    primary = errorResult(error.cause);
  else if (
    error instanceof Error &&
    "code" in error &&
    error.code === "PROMOTION_CANCELLED"
  )
    primary = portCancelled("request_cancelled");
  else
    primary =
      error instanceof SourceAccessFault ?
        error.result.status === "absent" ?
          portFailure("SOURCE_CHANGED")
        : error.result
      : sourceUnavailable();
  if (
    error instanceof Error &&
    "cleanupFailed" in error &&
    error.cleanupFailed === true
  )
    return sourceCleanupFailure(
      primary.status === "cancelled" ?
        portFailure("PRECONDITION_FAILED")
      : primary
    );
  return primary;
}
function validHandle(value: string): boolean {
  return (
    value.length <= handleSchema.maxLength &&
    new RegExp(handleSchema.pattern, "u").exec(value)?.[0] === value
  );
}
export function createDefinitionPromotionAdapter(
  dependencies: DefinitionPromotionDependencies
): DefinitionPromotionAdapter {
  if (
    ![
      dependencies?.staging?.beginStagedRun,
      dependencies?.staging?.promoteStagedRun,
      dependencies?.staging?.abortStagedRun
    ].every((method) => typeof method === "function")
  )
    throw new TypeError(
      "Definition promotion requires the existing staging machinery."
    );
  const { source: deps, staging: machinery } = dependencies;
  const reader = createSourceReadAdapter(deps);
  const originals = new Map<SourceSnapshot, Original>();
  const staging = new Map<StagingArea, OwnedStaging>();
  const released = new WeakSet<StagingArea>();
  const pending = new Set<Promise<unknown>>();
  const shutdown = new AbortController();
  const locks = new Set<string>();
  let closed = false;
  async function run<T>(
    control: RequestControl,
    action: () => Promise<T>
  ): Promise<PortResult<T>> {
    if (closed) return portCancelled("session_shutdown");
    const work = (async () => {
      try {
        checkSourceCancellation(control.cancellation);
        return portSuccess(await action());
      } catch (error) {
        return errorResult(error);
      }
    })();
    pending.add(work);
    try {
      return await work;
    } finally {
      pending.delete(work);
    }
  }
  async function trackArea<T>(
    area: StagingArea,
    action: () => Promise<T>
  ): Promise<T> {
    const record = staging.get(area);
    const work = action();
    record?.active.add(work);
    pending.add(work);
    try {
      return await work;
    } finally {
      record?.active.delete(work);
      pending.delete(work);
    }
  }
  async function authority(
    record: OwnedStaging,
    scope: PromotionRequest["scope"],
    control: RequestControl
  ) {
    checkSourceCancellation(control.cancellation);
    if (closed) throw new SourceAccessFault(portCancelled("session_shutdown"));
    if (
      scope.operation !== "definition.author" ||
      !scope.authorizationRef ||
      scope.principalRef !== record.scope.principalRef ||
      scope.approvalRef !== record.scope.approvalRef ||
      !scope.approvalRef ||
      scope.operationId !== record.area.operationId ||
      !sameLifecycleData(scope.target, record.scope.target) ||
      !sameLifecycleData(scope.source, record.scope.source)
    )
      throw new SourceAccessFault(portForbidden());
    const location = unwrap(
      await deps.authority.resolve(
        scope,
        record.area.snapshot.selection,
        control
      )
    );
    if (
      location.kind !== "workspace" ||
      location.rootPath !== record.original.root ||
      location.repo.toLowerCase() !==
        record.area.snapshot.selection.repo.toLowerCase()
    )
      throw new SourceAccessFault(portForbidden());
    unwrap(await reader.authoringLocation(record.area.snapshot, control));
    checkSourceCancellation(control.cancellation);
  }
  function owned(area: StagingArea): OwnedStaging {
    const record = staging.get(area);
    if (!record || record.releasing || record.consumed)
      throw new SourceAccessFault(portFailure("PRECONDITION_FAILED"));
    return record;
  }
  async function captureForAuthoring(
    ...args: Parameters<DefinitionAuthoringSourcePort["captureForAuthoring"]>
  ): Promise<ReadResult<SourceCapture>> {
    const [scope, selection, control] = args;
    if (closed) return portCancelled("session_shutdown");
    if (!sameLifecycleData(scope.target, selection)) return portForbidden();
    if (selection.definition !== ".radius/app.bicep")
      return sourceUnavailable();
    const result = await reader.captureForAuthoring(...args);
    if (result.status !== "ok" || result.value.status !== "captured")
      return result;
    const snapshot = result.value.snapshot;
    const captured = await run(control, async () => {
      const location = unwrap(
        await reader.authoringLocation(snapshot, control)
      );
      const baseline: Record<string, string | null> = {};
      for (const input of snapshot.manifest.inputs)
        baseline[input.path] = input.contentHash;
      let names: string[] = [];
      try {
        names = await deps.files.readdir(join(location.rootPath, ".radius"));
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error;
      }
      for (const name of new Set([
        ...publishableFiles(names),
        ...CUSTOM_TYPE_STAGED_FILES
      ])) {
        const path = `.radius/${name}`;
        const file = await readSourceFile(
          deps.files,
          location.rootPath,
          path,
          deps.limits.maxFileBytes,
          control.cancellation
        );
        baseline[path] = file.status === "present" ? hash(file.bytes) : null;
      }
      originals.set(snapshot, {
        scope: structuredClone(scope),
        root: location.rootPath,
        baseline: Object.freeze(baseline)
      });
      return result.value;
    });
    if (captured.status !== "ok") {
      const cleanup = await reader.releaseSnapshot(snapshot);
      if (cleanup.status !== "ok")
        return "error" in captured ? sourceCleanupFailure(captured) : cleanup;
    }
    return captured;
  }
  async function prepareStaging(
    ...args: Parameters<DefinitionAuthoringSourcePort["prepareStaging"]>
  ): Promise<PortResult<StagingArea>> {
    const [scope, binding, control] = args;
    return run(control, async () => {
      const original = originals.get(binding.snapshot);
      if (
        !original ||
        scope.operation !== "definition.author" ||
        !scope.approvalRef ||
        scope.principalRef !== original.scope.principalRef ||
        scope.approvalRef !== original.scope.approvalRef ||
        scope.operationId !== binding.operationId ||
        !validHandle(binding.operationId) ||
        !validHandle(binding.actionId) ||
        !sameLifecycleData(scope.target, original.scope.target) ||
        !sameLifecycleData(scope.source, binding.snapshot.provenance)
      )
        throw new SourceAccessFault(portForbidden());
      unwrap(await reader.authoringLocation(binding.snapshot, control));
      checkSourceCancellation(control.cancellation);
      const stagingRef = deps.ids.next("revision");
      if (!validHandle(stagingRef))
        throw new SourceAccessFault(portFailure("PRECONDITION_FAILED"));
      const directory = machinery.beginStagedRun({
        radiusDir: join(original.root, ".radius"),
        runId: stagingRef
      });
      const area = Object.freeze({ stagingRef, ...binding });
      staging.set(area, {
        area,
        original,
        scope: structuredClone(scope),
        directory,
        active: new Set(),
        consumed: false,
        recovery: false
      });
      return area;
    });
  }
  async function inspectStagedOutputs(
    ...args: Parameters<DefinitionAuthoringSourcePort["inspectStagedOutputs"]>
  ): Promise<PortResult<StagedOutputs>> {
    const [area, refs, control] = args;
    return run(control, async () => {
      const record = owned(area);
      await authority(record, record.scope, control);
      if (
        !refs.length ||
        refs.length > 100 ||
        new Set(refs).size !== refs.length
      )
        throw new SourceAccessFault(portFailure("INVALID_REQUEST"));
      const names = refs.map((ref) => {
        const prefix = `${area.stagingRef}/`;
        if (!ref.startsWith(prefix))
          throw new SourceAccessFault(portForbidden());
        const name = ref.slice(prefix.length);
        if (
          validateSourcePath(name).status !== "ok" ||
          name.includes("/") ||
          !publishableFiles([name]).includes(name)
        )
          throw new SourceAccessFault(portForbidden());
        return name;
      });
      const listed = publishableFiles(
        await deps.files.readdir(record.directory)
      );
      if (
        !sameLifecycleData([...names].sort(), [...listed].sort()) ||
        REQUIRED_STAGED_FILES.some((name) => !names.includes(name))
      )
        throw new SourceAccessFault(portFailure("VALIDATION_FAILED"));
      const bytes = new Map<string, Uint8Array>();
      const outputs: DefinitionInput[] = [];
      let total = 0;
      for (const name of names) {
        const path = `.radius/${name}`;
        const file = await readSourceFile(
          deps.files,
          record.original.root,
          `.radius/${record.directory.split(/[\\/]/).at(-1)}/${name}`,
          deps.limits.maxFileBytes,
          control.cancellation
        );
        if (file.status !== "present")
          throw new SourceAccessFault(portFailure("VALIDATION_FAILED"));
        total += file.bytes.byteLength;
        if (total > deps.limits.maxTotalBytes)
          throw new SourceAccessFault(
            portUnavailable("VALIDATION_INCOMPLETE", {
              quality: "unknown",
              completeness: "partial",
              evidence: "source"
            })
          );
        bytes.set(path, file.bytes);
        outputs.push({
          path,
          kind:
            name === "app.bicep" ? "definition"
            : name === "bicepconfig.json" ? "configuration"
            : CUSTOM_TYPE_STAGED_FILES.includes(name) ? "custom-type"
            : (
              name.endsWith("-recipe.bicep") ||
              name === "custom-recipe-pack.bicep"
            ) ?
              "recipe"
            : "file",
          existed: true,
          contentHash: hash(file.bytes)
        });
      }
      const result: StagedOutputs = Object.freeze({
        staging: area,
        outputRefs: Object.freeze([...refs]),
        outputs: Object.freeze(outputs.map((input) => Object.freeze(input))),
        fingerprint: hash(JSON.stringify(outputs))
      });
      record.outputs = result;
      record.bytes = bytes;
      record.proposal = undefined;
      return result;
    });
  }
  async function captureProposal(
    outputs: StagedOutputs,
    control: RequestControl
  ): Promise<ReadResult<SourceCapture>> {
    return run(control, async () => {
      const record = owned(outputs.staging);
      if (record.outputs !== outputs || !record.bytes)
        throw new SourceAccessFault(portForbidden());
      const result = unwrap(
        await reader.captureOverlay(
          record.area.snapshot,
          record.bytes,
          control,
          new Map(outputs.outputs.map((input) => [input.path, input.kind]))
        )
      );
      if (result.status === "captured") {
        for (const output of outputs.outputs) {
          const input = result.snapshot.manifest.inputs.find(
            (input) => input.path === output.path
          );
          if (!sameLifecycleData(input, output)) {
            const cleanup = await reader.releaseSnapshot(result.snapshot);
            const failure = portFailure("EVIDENCE_MISMATCH");
            throw new SourceAccessFault(
              cleanup.status === "ok" ? failure : sourceCleanupFailure(failure)
            );
          }
        }
        record.proposal = result.snapshot;
      }
      return result;
    });
  }
  async function promote(
    request: PromotionRequest,
    control: RequestControl
  ): Promise<PromotionResult> {
    if (closed) return portCancelled("session_shutdown");
    let record: OwnedStaging | undefined;
    let key: string | undefined;
    try {
      record = owned(request.outputs.staging);
      const current = record;
      if (
        current.outputs !== request.outputs ||
        !current.proposal ||
        request.proposal.stagingRef !== current.area.stagingRef ||
        request.proposal.operationId !== current.area.operationId ||
        request.proposal.actionId !== current.area.actionId ||
        request.proposal.promotion !== "pending" ||
        request.proposal.originalFingerprint !==
          current.area.snapshot.manifest.fingerprint ||
        !sameLifecycleData(request.proposal.outputs, current.outputs.outputs)
      )
        throw new SourceAccessFault(portFailure("EVIDENCE_MISMATCH"));
      unwrap(
        compareEffectiveInputManifests(
          current.area.snapshot.manifest,
          request.expectedManifest
        )
      );
      const report = unwrap(
        verifyValidationReport(
          createValidationPolicy("authoring"),
          request.proposal.validation,
          {
            sourceFingerprint: current.area.snapshot.manifest.fingerprint,
            proposalFingerprint: current.proposal.manifest.fingerprint
          }
        )
      );
      if (report.status !== "passed")
        throw new SourceAccessFault(portFailure("VALIDATION_FAILED"));
      if (locks.has(current.original.root))
        throw new SourceAccessFault(portFailure("PRECONDITION_FAILED"));
      key = current.original.root;
      locks.add(key);
      const proposal = current.proposal;
      const validatedOutputs: Record<string, string> = {};
      const baseline: Record<string, string | null> = {};
      for (const output of current.outputs.outputs) {
        const name = output.path.slice(".radius/".length);
        const read = unwrap(
          await reader.readBytes(proposal, output.path, control)
        );
        validatedOutputs[name] = hash(read.bytes);
        baseline[name] = current.original.baseline[output.path] ?? null;
      }
      await authority(current, request.scope, control);
      const before = await collectSourceInputs(
        deps.files,
        current.original.root,
        current.area.snapshot.selection.definition,
        deps.limits,
        control.cancellation,
        "capture",
        true
      );
      const manifest = unwrap(
        buildEffectiveInputManifest(
          {
            definition: current.area.snapshot.selection.definition,
            inputs: before.inputs,
            closure: before.complete ? "complete" : "incomplete"
          },
          hash
        )
      );
      unwrap(
        compareEffectiveInputManifests(current.area.snapshot.manifest, manifest)
      );
      const controller = new AbortController();
      const abort = () => controller.abort();
      const unsubscribe = control.cancellation.onAbort(abort);
      shutdown.signal.addEventListener("abort", abort, { once: true });
      try {
        current.consumed = true;
        const result = await machinery.promoteStagedRun({
          radiusDir: join(current.original.root, ".radius"),
          stagingDir: current.directory,
          record: {
            baseline,
            sourceBaseline: current.original.baseline,
            inputFiles: current.area.snapshot.manifest.inputs.map(
              (input) => input.path
            )
          },
          validatedOutputs,
          stageInGit: false,
          signal: controller.signal,
          checkInputs: async () => {
            await authority(current, request.scope, control);
          }
        });
        if (result.status !== "promoted" || result.gitError)
          throw new SourceAccessFault(portFailure("PRECONDITION_FAILED"));
        return { status: "promoted", manifest: proposal.manifest };
      } finally {
        unsubscribe();
        shutdown.signal.removeEventListener("abort", abort);
      }
    } catch (error) {
      if (
        record &&
        error instanceof Error &&
        (("rollback" in error && error.rollback === "failed") ||
          ("retainStaging" in error && error.retainStaging === true))
      )
        record.recovery = true;
      const failure = errorResult(error);
      if (failure.status === "cancelled") return failure;
      if (
        error instanceof Error &&
        ("rollback" in error || "published" in error)
      )
        return {
          status: "failed",
          failure,
          rollback:
            record?.recovery ? "incomplete"
            : "rollback" in error && error.rollback === "restored" ? "restored"
            : "not_needed",
          diagnostics: [
            {
              message:
                "Promotion failed; recovery files are retained when restoration is incomplete.",
              truncated: false
            }
          ]
        };
      return { status: "refused", failure };
    } finally {
      if (key) locks.delete(key);
    }
  }
  async function releaseStaging(area: StagingArea): Promise<CleanupResult> {
    if (released.has(area)) return portSuccess({ status: "already_released" });
    const record = staging.get(area);
    if (!record) return sourceUnavailable();
    if (record.releasing) return record.releasing;
    if (record.recovery)
      return sourceCleanupFailure(portFailure("PRECONDITION_FAILED"));
    record.releasing = (async () => {
      await Promise.all([...record.active]);
      if (record.recovery)
        return sourceCleanupFailure(portFailure("PRECONDITION_FAILED"));
      try {
        machinery.abortStagedRun({
          radiusDir: join(record.original.root, ".radius"),
          stagingDir: record.directory
        });
        staging.delete(area);
        released.add(area);
        return portSuccess({ status: "released" as const });
      } catch {
        return sourceCleanupFailure(portFailure("PRECONDITION_FAILED"));
      }
    })();
    const result = await record.releasing;
    if (result.status !== "ok") record.releasing = undefined;
    return result;
  }
  return {
    capture: reader.capture,
    captureForAuthoring,
    prepareStaging,
    inspectStagedOutputs: (area, refs, control) =>
      trackArea(area, () => inspectStagedOutputs(area, refs, control)),
    captureProposal: (outputs, control) =>
      trackArea(outputs.staging, () => captureProposal(outputs, control)),
    promote: (request, control) =>
      trackArea(request.outputs.staging, () => promote(request, control)),
    readText: reader.readText,
    readBytes: reader.readBytes,
    async releaseSnapshot(snapshot) {
      const result = await reader.releaseSnapshot(snapshot);
      if (result.status === "ok") originals.delete(snapshot);
      return result;
    },
    releaseStaging,
    stagingLocation: (area, control) =>
      run(control, async () => {
        const record = owned(area);
        await authority(record, record.scope, control);
        return record.directory;
      }),
    async close() {
      closed = true;
      shutdown.abort();
      await Promise.all([...pending]);
      let failure: CleanupResult = portSuccess({ status: "released" });
      for (const area of staging.keys()) {
        const result = await releaseStaging(area);
        if (result.status !== "ok") failure = result;
      }
      const result = await reader.close();
      return failure.status !== "ok" ? failure : result;
    }
  };
}
