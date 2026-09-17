import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import {
  buildEffectiveInputManifest,
  compareEffectiveInputManifests,
  handleSchema,
  commitSchema,
  portAbsent,
  portCancelled,
  portFailure,
  portForbidden,
  portSuccess,
  portUnavailable,
  validateSourcePath,
  validateSourceSelection,
  verifySourceExpectation,
  type AuthorizedScope,
  type CapturedText,
  type CapturedBytes,
  type CleanupResult,
  type ClockPort,
  type DefinitionInput,
  type IdPort,
  type PortAbsent,
  type PortCancelled,
  type PortError,
  type PortResult,
  type ReadResult,
  type RequestControl,
  type ResolvedSource,
  type SourceAccessPort,
  type SourceCapture,
  type SourceOperation,
  type SourceSelection,
  type SourceSnapshot
} from "@radius-project/core/lifecycle";
import {
  collectSourceInputs,
  type SourceCaptureLimits
} from "./source-access-closure.js";
import {
  canonicalSourceRoot,
  checkSourceCancellation,
  confined,
  nodeSourceFileSystem,
  readSourceFile,
  sourceUnavailable,
  sourceCleanupFailure,
  SourceAccessFault,
  writeSourceFile,
  type SourceFileSystem
} from "./source-access-files.js";

export { nodeSourceFileSystem };
export type {
  SourceFileSystem,
  SourceReadHandle
} from "./source-access-files.js";
export type { SourceCaptureLimits } from "./source-access-closure.js";

export interface AuthorizedWorkspaceLocation {
  readonly kind: "workspace";
  readonly repo: string;
  readonly workspaceRef: string;
  readonly rootPath: string;
}
export interface AuthorizedRemoteSource {
  readonly kind: "git";
  readonly repo: string;
  readonly accessRef: string;
}
export type AuthorizedSourceLocation =
  AuthorizedWorkspaceLocation | AuthorizedRemoteSource;
export interface SourceAuthorityPort {
  resolve(
    scope: AuthorizedScope<SourceOperation>,
    selection: SourceSelection,
    control: RequestControl
  ): Promise<ReadResult<AuthorizedSourceLocation>>;
}
export interface SourceGitPort {
  workspaceState(
    root: string,
    control: RequestControl
  ): Promise<PortResult<{ readonly branch: string; readonly commit: string }>>;
  resolveCommit(
    source: AuthorizedRemoteSource,
    ref: string,
    control: RequestControl
  ): Promise<ReadResult<string>>;
  /** Materialize only this commit beneath destination. Do not embed credentials or use a mutable ref. */
  materializeCommit(
    source: AuthorizedRemoteSource,
    commit: string,
    destination: string,
    control: RequestControl
  ): Promise<PortResult<void>>;
  readCommit(
    root: string,
    control: RequestControl
  ): Promise<PortResult<string>>;
}
export interface SourceReadDependencies {
  storageRoot: string;
  files: SourceFileSystem;
  authority: SourceAuthorityPort;
  git: SourceGitPort;
  clock: Pick<ClockPort, "now">;
  ids: Pick<IdPort, "next">;
  limits: SourceCaptureLimits;
}
/** Deliberately excludes discovery, staging and promotion until their owning services exist. */
export interface SourceReadAdapter extends Pick<
  SourceAccessPort,
  "capture" | "readText" | "readBytes" | "releaseSnapshot"
> {
  close(): Promise<CleanupResult>;
}
/** Adapter-private capabilities; never serialize locations or accept caller-created snapshots. */
export interface SourceAuthoringReadAdapter extends SourceReadAdapter {
  captureForAuthoring(
    scope: AuthorizedScope<"definition.author">,
    selection: SourceSelection,
    control: RequestControl
  ): Promise<ReadResult<SourceCapture>>;
  captureOverlay(
    snapshot: SourceSnapshot,
    outputs: ReadonlyMap<string, Uint8Array>,
    control: RequestControl,
    kinds?: ReadonlyMap<string, DefinitionInput["kind"]>
  ): Promise<ReadResult<SourceCapture>>;
  authoringLocation(
    snapshot: SourceSnapshot,
    control: RequestControl
  ): Promise<ReadResult<AuthorizedWorkspaceLocation>>;
}
interface OwnedSnapshot {
  readonly snapshot: SourceSnapshot;
  readonly scope: AuthorizedScope<SourceOperation>;
  readonly location: AuthorizedSourceLocation;
  readonly directory: string;
  readonly root: string;
  readonly readers: Set<Promise<unknown>>;
  releasing?: Promise<CleanupResult>;
}
type Stopped = PortError | PortCancelled | PortAbsent;
function unwrap<T>(result: ReadResult<T>): T {
  if (result.status !== "ok") throw new SourceAccessFault(result);
  return result.value;
}
function stopped(error: unknown): Stopped {
  return error instanceof SourceAccessFault ?
      error.result
    : sourceUnavailable();
}
function cleanupFailure(primary?: Stopped): PortError {
  if (primary && "error" in primary) {
    return sourceCleanupFailure(primary);
  }
  return sourceCleanupFailure(portFailure("PRECONDITION_FAILED"));
}
function hash(bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function freezeSnapshot(snapshot: SourceSnapshot): SourceSnapshot {
  Object.freeze(snapshot.selection.source);
  Object.freeze(snapshot.selection);
  for (const input of snapshot.manifest.inputs) Object.freeze(input);
  Object.freeze(snapshot.manifest.inputs);
  Object.freeze(snapshot.manifest);
  Object.freeze(snapshot.provenance);
  return Object.freeze(snapshot);
}

export function createSourceReadAdapter(
  dependencies: SourceReadDependencies
): SourceAuthoringReadAdapter {
  const methods = [
    dependencies?.files?.realpath,
    dependencies?.files?.lstat,
    dependencies?.files?.readdir,
    dependencies?.files?.open,
    dependencies?.files?.mkdir,
    dependencies?.files?.write,
    dependencies?.files?.remove,
    dependencies?.authority?.resolve,
    dependencies?.git?.workspaceState,
    dependencies?.git?.resolveCommit,
    dependencies?.git?.materializeCommit,
    dependencies?.git?.readCommit,
    dependencies?.clock?.now,
    dependencies?.ids?.next
  ];
  if (
    methods.some((method) => typeof method !== "function") ||
    !dependencies.limits ||
    ![
      dependencies.limits.maxFiles,
      dependencies.limits.maxFileBytes,
      dependencies.limits.maxTotalBytes
    ].every((value) => Number.isSafeInteger(value) && value > 0) ||
    !isAbsolute(dependencies.storageRoot)
  ) {
    throw new TypeError(
      "Source read adapter requires explicit filesystem, authority, Git, clock, IDs, limits and absolute storage root."
    );
  }
  const { files, authority, git, clock, ids, storageRoot } = dependencies;
  const limits = Object.freeze({ ...dependencies.limits });
  const handles = new RegExp(handleSchema.pattern, "u");
  const commits = new RegExp(commitSchema.pattern, "u");
  function nextId(): string {
    const id = ids.next("revision");
    if (id.length > handleSchema.maxLength || handles.exec(id)?.[0] !== id)
      throw new SourceAccessFault(portFailure("PRECONDITION_FAILED"));
    return id;
  }
  const contextId = nextId();
  const snapshots = new Map<string, OwnedSnapshot>();
  const released = new WeakSet<object>();
  const pending = new Set<Promise<unknown>>();
  const shutdown = new AbortController();
  let contextDirectory: string | undefined;
  let creatingContext: Promise<string> | undefined;
  let closing: Promise<CleanupResult> | undefined;
  let disposed = false;

  async function directory(): Promise<string> {
    if (!creatingContext) {
      creatingContext = (async () => {
        const storage = await canonicalSourceRoot(files, storageRoot);
        const path = join(storage, `source-${hash(contextId).slice(7)}`);
        await files.mkdir(path);
        contextDirectory = path;
        return path;
      })();
    }
    return creatingContext;
  }
  async function run<T>(
    request: RequestControl,
    action: (control: RequestControl) => Promise<T>
  ): Promise<ReadResult<T>> {
    if (shutdown.signal.aborted) return portCancelled("session_shutdown");
    const controller = new AbortController();
    const abort = () => controller.abort();
    const unsubscribe = request.cancellation.onAbort(abort);
    if (request.cancellation.aborted) abort();
    shutdown.signal.addEventListener("abort", abort, { once: true });
    const control: RequestControl = {
      requestId: request.requestId,
      cancellation: {
        get aborted() {
          return controller.signal.aborted;
        },
        onAbort(listener) {
          if (controller.signal.aborted) listener();
          else
            controller.signal.addEventListener("abort", listener, {
              once: true
            });
          return () => controller.signal.removeEventListener("abort", listener);
        }
      }
    };
    const work = (async (): Promise<ReadResult<T>> => {
      try {
        checkSourceCancellation(control.cancellation);
        return portSuccess(await action(control));
      } catch (error) {
        const result = stopped(error);
        return result.status === "cancelled" && shutdown.signal.aborted ?
            portCancelled("session_shutdown")
          : result;
      } finally {
        unsubscribe();
        shutdown.signal.removeEventListener("abort", abort);
      }
    })();
    pending.add(work);
    try {
      return await work;
    } finally {
      pending.delete(work);
    }
  }
  function validateLocation(
    location: AuthorizedSourceLocation,
    selection: SourceSelection
  ): void {
    if (
      location.repo.toLowerCase() !== selection.repo.toLowerCase() ||
      location.kind !== selection.source.kind ||
      (location.kind === "workspace" &&
        selection.source.kind === "workspace" &&
        location.workspaceRef !== selection.source.workspaceRef)
    ) {
      throw new SourceAccessFault(portFailure("EVIDENCE_MISMATCH"));
    }
  }
  async function authorized(
    scope: AuthorizedScope<SourceOperation>,
    selection: SourceSelection,
    control: RequestControl
  ): Promise<AuthorizedSourceLocation> {
    unwrap(validateSourceSelection(selection, control.cancellation));
    if (scope.target.repo.toLowerCase() !== selection.repo.toLowerCase())
      throw new SourceAccessFault(portForbidden());
    const location = structuredClone(
      unwrap(
        await authority.resolve(
          structuredClone(scope),
          structuredClone(selection),
          control
        )
      )
    );
    validateLocation(location, selection);
    return location.kind === "workspace" ?
        {
          ...location,
          rootPath: await canonicalSourceRoot(files, location.rootPath)
        }
      : location;
  }
  function exactCommit(expected: string, actual: string): void {
    if (commits.exec(actual)?.[0] !== actual)
      throw new SourceAccessFault(portFailure("EVIDENCE_MISMATCH"));
    if (expected.toLowerCase() !== actual.toLowerCase())
      throw new SourceAccessFault(portFailure("SOURCE_CHANGED"));
  }
  function absent() {
    return portAbsent({
      quality: "current",
      evidence: "source",
      completeness: "complete",
      observedAt: clock.now()
    });
  }

  async function capture(
    scope: AuthorizedScope<SourceOperation>,
    selection: SourceSelection,
    request: RequestControl,
    authoring = false
  ): Promise<ReadResult<SourceCapture>> {
    return run(request, async (control) => {
      scope = structuredClone(scope);
      selection = structuredClone(selection);
      let operationDirectory: string | undefined;
      let retained = false;
      const result = await (async (): Promise<SourceCapture> => {
        const location = await authorized(scope, selection, control);
        if (
          authoring &&
          (scope.operation !== "definition.author" ||
            location.kind !== "workspace")
        )
          throw new SourceAccessFault(portForbidden());
        let root: string;
        let actualCommit: string;
        let branch: string | undefined;
        if (
          location.kind === "workspace" &&
          selection.source.kind === "workspace"
        ) {
          root = location.rootPath;
          const storage = await canonicalSourceRoot(files, storageRoot);
          if (confined(root, storage) || confined(storage, root))
            throw new SourceAccessFault(portFailure("PRECONDITION_FAILED"));
          const state = unwrap(await git.workspaceState(root, control));
          if (state.branch !== selection.source.branch)
            throw new SourceAccessFault(portFailure("SOURCE_CHANGED"));
          actualCommit = state.commit;
          exactCommit(actualCommit, actualCommit);
          branch = state.branch;
        } else if (location.kind === "git" && selection.source.kind === "git") {
          actualCommit = unwrap(
            await git.resolveCommit(location, selection.source.ref, control)
          );
          exactCommit(selection.source.expectedCommit, actualCommit);
          root = "";
        } else {
          throw new SourceAccessFault(portFailure("EVIDENCE_MISMATCH"));
        }
        checkSourceCancellation(control.cancellation);
        const id = nextId();
        const snapshotRef = `source-${hash(`${contextId}\0${id}`).slice(7)}`;
        operationDirectory = join(await directory(), hash(id).slice(7));
        // Never clean a path until this invocation has exclusively created it.
        const candidate = operationDirectory;
        operationDirectory = undefined;
        await files.mkdir(candidate);
        operationDirectory = candidate;
        if (location.kind === "git") {
          root = join(operationDirectory, "remote");
          await files.mkdir(root);
          unwrap(
            await git.materializeCommit(location, actualCommit, root, control)
          );
          exactCommit(
            actualCommit,
            unwrap(await git.readCommit(root, control))
          );
          root = await canonicalSourceRoot(files, root);
        }
        const original = await collectSourceInputs(
          files,
          root,
          selection.definition,
          limits,
          control.cancellation,
          "capture",
          authoring
        );
        if (!original.definitionPresent && !authoring)
          throw new SourceAccessFault(absent());
        const manifest = unwrap(
          buildEffectiveInputManifest(
            {
              definition: selection.definition,
              inputs: original.inputs,
              closure: original.complete ? "complete" : "incomplete"
            },
            hash,
            control.cancellation
          )
        );
        if (manifest.completeness === "incomplete")
          return { status: "incomplete", manifest };
        const copyRoot = join(operationDirectory, "snapshot");
        await files.mkdir(copyRoot);
        for (const [path, bytes] of original.bytes) {
          checkSourceCancellation(control.cancellation);
          await writeSourceFile(files, copyRoot, path, bytes);
        }
        const copied = await collectSourceInputs(
          files,
          copyRoot,
          selection.definition,
          limits,
          control.cancellation,
          "capture",
          authoring
        );
        const copiedManifest = unwrap(
          buildEffectiveInputManifest(
            {
              definition: selection.definition,
              inputs: copied.inputs,
              closure: copied.complete ? "complete" : "incomplete"
            },
            hash,
            control.cancellation
          )
        );
        unwrap(
          compareEffectiveInputManifests(
            manifest,
            copiedManifest,
            control.cancellation
          )
        );
        const current = await collectSourceInputs(
          files,
          root,
          selection.definition,
          limits,
          control.cancellation,
          "capture",
          authoring
        );
        const currentManifest = unwrap(
          buildEffectiveInputManifest(
            {
              definition: selection.definition,
              inputs: current.inputs,
              closure: current.complete ? "complete" : "incomplete"
            },
            hash,
            control.cancellation
          )
        );
        unwrap(
          compareEffectiveInputManifests(
            manifest,
            currentManifest,
            control.cancellation
          )
        );
        const finalLocation = await authorized(scope, selection, control);
        if (location.kind === "workspace") {
          if (
            finalLocation.kind !== "workspace" ||
            finalLocation.rootPath !== location.rootPath
          )
            throw new SourceAccessFault(portFailure("SOURCE_CHANGED"));
          const currentState = unwrap(await git.workspaceState(root, control));
          if (currentState.branch !== branch)
            throw new SourceAccessFault(portFailure("SOURCE_CHANGED"));
          exactCommit(actualCommit, currentState.commit);
        } else {
          exactCommit(
            actualCommit,
            unwrap(await git.readCommit(root, control))
          );
          await files.remove(root);
        }
        const provenance: ResolvedSource =
          selection.source.kind === "workspace" ?
            {
              kind: "workspace",
              repo: selection.repo,
              workspaceRef: selection.source.workspaceRef,
              branch: selection.source.branch,
              baseCommit: actualCommit,
              fingerprint: manifest.fingerprint,
              resolvedAt: clock.now()
            }
          : {
              kind: "git",
              repo: selection.repo,
              ref: selection.source.ref,
              commit: actualCommit,
              fingerprint: manifest.fingerprint,
              resolvedAt: clock.now()
            };
        unwrap(
          verifySourceExpectation(
            selection,
            provenance,
            manifest,
            control.cancellation
          )
        );
        checkSourceCancellation(control.cancellation);
        const snapshot = freezeSnapshot({
          snapshotRef,
          selection: structuredClone(selection),
          provenance,
          manifest
        });
        snapshots.set(snapshotRef, {
          snapshot,
          scope: structuredClone(scope),
          location,
          directory: operationDirectory,
          root: copyRoot,
          readers: new Set()
        });
        retained = true;
        return { status: "captured", snapshot };
      })().then(
        (value) => ({ ok: true, value }) as const,
        (error: unknown) => ({ ok: false, error }) as const
      );
      if (operationDirectory && !retained) {
        try {
          await files.remove(operationDirectory);
        } catch {
          throw new SourceAccessFault(
            cleanupFailure(result.ok ? undefined : stopped(result.error))
          );
        }
      }
      if (!result.ok) throw result.error;
      return result.value;
    });
  }
  async function authoringLocation(
    snapshot: SourceSnapshot,
    request: RequestControl
  ): Promise<ReadResult<AuthorizedWorkspaceLocation>> {
    return run(request, async (control) => {
      const record = snapshots.get(snapshot.snapshotRef);
      if (
        !record ||
        record.snapshot !== snapshot ||
        record.releasing ||
        record.scope.operation !== "definition.author"
      )
        throw new SourceAccessFault(sourceUnavailable());
      const location = await authorized(
        record.scope,
        snapshot.selection,
        control
      );
      if (
        location.kind !== "workspace" ||
        record.location.kind !== "workspace" ||
        location.rootPath !== record.location.rootPath
      )
        throw new SourceAccessFault(portForbidden());
      const state = unwrap(
        await git.workspaceState(location.rootPath, control)
      );
      if (
        snapshot.provenance.kind !== "workspace" ||
        state.branch !== snapshot.provenance.branch ||
        state.commit !== snapshot.provenance.baseCommit
      )
        throw new SourceAccessFault(portFailure("SOURCE_CHANGED"));
      return location;
    });
  }
  async function captureOverlay(
    snapshot: SourceSnapshot,
    outputs: ReadonlyMap<string, Uint8Array>,
    request: RequestControl,
    kinds: ReadonlyMap<string, DefinitionInput["kind"]> = new Map()
  ): Promise<ReadResult<SourceCapture>> {
    const owned = snapshots.get(snapshot.snapshotRef);
    const work = run(request, async (control): Promise<SourceCapture> => {
      unwrap(await authoringLocation(snapshot, control));
      if (!owned || owned.snapshot !== snapshot || owned.releasing)
        throw new SourceAccessFault(sourceUnavailable());
      const proposed = new Map(
        [...outputs].map(([path, bytes]) => [path, new Uint8Array(bytes)])
      );
      if (proposed.size === 0 || proposed.size > limits.maxFiles)
        throw new SourceAccessFault(portFailure("INVALID_REQUEST"));
      const id = nextId();
      const operationDirectory = join(await directory(), hash(id).slice(7));
      await files.mkdir(operationDirectory);
      let retained = false;
      const result = await (async (): Promise<SourceCapture> => {
        const copyRoot = join(operationDirectory, "snapshot");
        await files.mkdir(copyRoot);
        let total = 0;
        for (const input of snapshot.manifest.inputs) {
          if (!input.existed || proposed.has(input.path)) continue;
          const captured = unwrap(
            await readBytes(snapshot, input.path, control)
          );
          total += captured.bytes.byteLength;
          await writeSourceFile(files, copyRoot, input.path, captured.bytes);
        }
        for (const [path, bytes] of proposed) {
          total += bytes.byteLength;
          if (
            bytes.byteLength > limits.maxFileBytes ||
            total > limits.maxTotalBytes
          )
            throw new SourceAccessFault(
              portUnavailable("VALIDATION_INCOMPLETE", {
                quality: "unknown",
                completeness: "partial",
                evidence: "source"
              })
            );
          await writeSourceFile(files, copyRoot, path, bytes);
        }
        const collected = await collectSourceInputs(
          files,
          copyRoot,
          snapshot.selection.definition,
          limits,
          control.cancellation
        );
        const inputs = new Map(
          collected.inputs.map((input) => [input.path, input])
        );
        let closureComplete = collected.complete;
        for (const path of proposed.keys()) {
          if (
            path === snapshot.selection.definition ||
            !path.endsWith(".bicep")
          )
            continue;
          const extra = await collectSourceInputs(
            files,
            copyRoot,
            path,
            limits,
            control.cancellation
          );
          closureComplete = closureComplete && extra.complete;
          for (const input of extra.inputs) {
            if (!inputs.has(input.path))
              inputs.set(
                input.path,
                input.path === path ?
                  { ...input, kind: kinds.get(path) ?? "recipe" }
                : input
              );
          }
        }
        for (const [path, bytes] of proposed) {
          if (!inputs.has(path))
            inputs.set(path, {
              path,
              kind: kinds.get(path) ?? "file",
              existed: true,
              contentHash: hash(bytes)
            });
        }
        // Dependencies outside the original owned closure cannot acquire a retrospective baseline.
        const complete =
          closureComplete &&
          inputs.size <= limits.maxFiles &&
          [...inputs.values()].every(
            (input) =>
              proposed.has(input.path) ||
              snapshot.manifest.inputs.some(
                (original) => original.path === input.path
              )
          );
        const manifest = unwrap(
          buildEffectiveInputManifest(
            {
              definition: snapshot.selection.definition,
              inputs: [...inputs.values()],
              closure: complete ? "complete" : "incomplete"
            },
            hash,
            control.cancellation
          )
        );
        if (manifest.completeness === "incomplete")
          return { status: "incomplete", manifest };
        const proposal = freezeSnapshot({
          snapshotRef: `source-${hash(`${contextId}\0${id}`).slice(7)}`,
          selection: structuredClone(snapshot.selection),
          provenance: {
            ...snapshot.provenance,
            fingerprint: manifest.fingerprint
          },
          manifest
        });
        checkSourceCancellation(control.cancellation);
        snapshots.set(proposal.snapshotRef, {
          snapshot: proposal,
          scope: owned.scope,
          location: owned.location,
          directory: operationDirectory,
          root: copyRoot,
          readers: new Set()
        });
        retained = true;
        return { status: "captured", snapshot: proposal };
      })().then(
        (value) => ({ ok: true, value }) as const,
        (error: unknown) => ({ ok: false, error }) as const
      );
      if (!retained) {
        try {
          await files.remove(operationDirectory);
        } catch {
          throw new SourceAccessFault(
            cleanupFailure(result.ok ? undefined : stopped(result.error))
          );
        }
      }
      if (!result.ok) throw result.error;
      return result.value;
    });
    owned?.readers.add(work);
    try {
      return await work;
    } finally {
      owned?.readers.delete(work);
    }
  }
  async function readBytes(
    snapshot: SourceSnapshot,
    path: string,
    request: RequestControl
  ): Promise<ReadResult<CapturedBytes>> {
    const record = snapshots.get(snapshot.snapshotRef);
    const work = run(request, async (control) => {
      if (!record || record.snapshot !== snapshot || record.releasing)
        throw new SourceAccessFault(sourceUnavailable());
      unwrap(validateSourcePath(path));
      const input = record.snapshot.manifest.inputs.find(
        (entry) => entry.path === path
      );
      if (!input) throw new SourceAccessFault(portForbidden());
      const location = await authorized(
        record.scope,
        record.snapshot.selection,
        control
      );
      if (
        record.location.kind === "workspace" &&
        (location.kind !== "workspace" ||
          location.rootPath !== record.location.rootPath)
      ) {
        throw new SourceAccessFault(portFailure("EVIDENCE_MISMATCH"));
      }
      if (!input.existed) throw new SourceAccessFault(absent());
      const file = await readSourceFile(
        files,
        record.root,
        path,
        limits.maxFileBytes,
        control.cancellation
      );
      if (file.status === "absent" || hash(file.bytes) !== input.contentHash)
        throw new SourceAccessFault(portFailure("SOURCE_CHANGED"));
      checkSourceCancellation(control.cancellation);
      return { input: { ...input }, bytes: new Uint8Array(file.bytes) };
    });
    record?.readers.add(work);
    try {
      return await work;
    } finally {
      record?.readers.delete(work);
    }
  }
  async function readText(
    snapshot: SourceSnapshot,
    path: string,
    request: RequestControl
  ): Promise<ReadResult<CapturedText>> {
    const result = await readBytes(snapshot, path, request);
    if (request.cancellation.aborted) return portCancelled("request_cancelled");
    if (result.status !== "ok") return result;
    try {
      return portSuccess({
        input: result.value.input,
        text: new TextDecoder("utf-8", { fatal: true }).decode(
          result.value.bytes
        )
      });
    } catch {
      return portUnavailable("CAPABILITY_UNAVAILABLE", {
        quality: "unknown",
        evidence: "source",
        completeness: "partial",
        limitation: "The captured input is not UTF-8 text."
      });
    }
  }
  async function releaseSnapshot(
    snapshot: SourceSnapshot
  ): Promise<CleanupResult> {
    if (released.has(snapshot))
      return portSuccess({ status: "already_released" });
    const record = snapshots.get(snapshot.snapshotRef);
    if (!record || record.snapshot !== snapshot) return sourceUnavailable();
    if (record.releasing) return record.releasing;
    const release = (async (): Promise<CleanupResult> => {
      await Promise.all([...record.readers]);
      try {
        await files.remove(record.directory);
        snapshots.delete(snapshot.snapshotRef);
        released.add(snapshot);
        return portSuccess({ status: "released" });
      } catch {
        return cleanupFailure();
      }
    })();
    record.releasing = release;
    const result = await release;
    if (result.status !== "ok") record.releasing = undefined;
    return result;
  }
  async function close(): Promise<CleanupResult> {
    if (disposed) return portSuccess({ status: "already_released" });
    if (closing) return closing;
    shutdown.abort();
    closing = (async (): Promise<CleanupResult> => {
      await Promise.all([...pending]);
      await Promise.all(
        [...snapshots.values()].flatMap((record) =>
          record.releasing ? [record.releasing] : []
        )
      );
      try {
        if (contextDirectory) await files.remove(contextDirectory);
      } catch {
        return cleanupFailure();
      }
      for (const record of snapshots.values()) released.add(record.snapshot);
      snapshots.clear();
      disposed = true;
      return portSuccess({ status: "released" });
    })();
    const result = await closing;
    closing = undefined;
    return result;
  }
  return {
    capture: (scope, selection, control) => capture(scope, selection, control),
    captureForAuthoring: (scope, selection, control) =>
      capture(scope, selection, control, true),
    captureOverlay,
    authoringLocation,
    readText,
    readBytes,
    releaseSnapshot,
    close
  };
}
