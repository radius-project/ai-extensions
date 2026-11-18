import type { GraphSourceRead } from "../graph-source.js";
import {
  evaluateAppModelFreshness,
  parseAppOrigin,
  type AppModelFreshness
} from "./app-origin.js";
import {
  ambiguousAppSourceBrief,
  type AppSourceEvaluation
} from "./app-source.js";

interface ModelStatus {
  refreshable: boolean;
  freshness: AppModelFreshness;
}

export function appAuthoringRequired(
  statuses: readonly ModelStatus[]
): boolean {
  return (
    statuses.length > 0 &&
    statuses.every(({ freshness }) => freshness.status === "missing")
  );
}

export function findAppModelRefresh<T extends ModelStatus>(
  statuses: readonly T[]
): { kind: "confirmation" | "refresh"; model: T } | undefined {
  const present = statuses.filter(
    ({ freshness }) => freshness.status !== "missing"
  );
  const unverified = present.find(
    ({ refreshable, freshness }) =>
      refreshable && freshness.requiresConfirmation
  );
  if (unverified) return { kind: "confirmation", model: unverified };
  const stale = present.find(
    ({ refreshable, freshness }) => refreshable && freshness.stale
  );
  return stale ? { kind: "refresh", model: stale } : undefined;
}

export function hasModelableSource(
  sources: readonly (AppSourceEvaluation | null)[]
): boolean {
  return sources.some((source) => source?.status !== "none");
}

export async function prepareAppAuthoring(reads: {
  evaluate(): Promise<AppSourceEvaluation | null>;
  listPaths(): Promise<string[] | null>;
  explicitlySelectedDirectory(): boolean;
}): Promise<{ kind: "unsupported" } | { kind: "handoff"; brief?: string }> {
  const source = await reads.evaluate();
  if (!hasModelableSource([source])) return { kind: "unsupported" };
  if (source?.status !== "ambiguous") return { kind: "handoff" };
  const listing = await reads.listPaths();
  if (reads.explicitlySelectedDirectory()) return { kind: "handoff" };
  return {
    kind: "handoff",
    brief: ambiguousAppSourceBrief(source, listing) ?? undefined
  };
}

export type AppModelObservation =
  | { kind: "missing" }
  | { kind: "unreadable"; diagnostic: string }
  | { kind: "invalid" }
  | {
      kind: "present";
      verification: "verified" | "unverified";
      freshness: AppModelFreshness;
    }
  | { kind: "present"; verification: "unchecked" };

export function observeAppModel(
  read: GraphSourceRead,
  freshness?: AppModelFreshness
): AppModelObservation {
  if (read.status === "unavailable")
    return { kind: "unreadable", diagnostic: read.diagnostic };
  if (read.status === "absent") return { kind: "missing" };
  if (!read.content.trim()) return { kind: "invalid" };
  if (!freshness) return { kind: "present", verification: "unchecked" };
  const verified =
    freshness.status === "up-to-date" &&
    !freshness.requiresConfirmation &&
    Boolean(freshness.origin?.appBicepHash) &&
    freshness.origin?.appBicepHash === freshness.appBicepHash;
  return {
    kind: "present",
    verification: verified ? "verified" : "unverified",
    freshness
  };
}

export interface AppModelEvidenceReads {
  assertSource(): Promise<void>;
  origin(): Promise<string | null>;
  headCommit(): Promise<string>;
  sourceChangedSince(commit: string): Promise<boolean | undefined>;
  modelRecoverable(): Promise<boolean | undefined>;
  generatorVersion(): string;
  radiusVersion(): Promise<string>;
  hashAppBicep(content: string): string;
}

export async function readAppModelEvidence(
  read: GraphSourceRead,
  ports: AppModelEvidenceReads
): Promise<{ freshness: AppModelFreshness; observation: AppModelObservation }> {
  await ports.assertSource();
  if (read.status === "unavailable") throw new Error(read.diagnostic);
  const model = read.status === "present" ? read.content : null;
  if (model !== null && !model.trim()) {
    throw new Error(
      `Application definition ${read.source.definitionPath} is empty.`
    );
  }
  const workspace = read.source.kind === "workspace";
  async function workspaceProbe<T>(probe: () => Promise<T>): Promise<T> {
    await ports.assertSource();
    const result = await probe();
    await ports.assertSource();
    return result;
  }
  const originText = await ports.origin().catch(async (error: unknown) => {
    await ports.assertSource();
    throw error;
  });
  const headCommit = workspace ? await workspaceProbe(ports.headCommit) : "";
  const origin = parseAppOrigin(originText);
  const commit = origin?.sourceCommit;
  // The head may have moved because the model itself was committed; ask the
  // workspace whether application source has actually changed since the origin.
  const sourceChanged =
    workspace && commit ?
      await workspaceProbe(() => ports.sourceChangedSince(commit))
    : undefined;
  const modelRecoverable =
    workspace && !commit ?
      await workspaceProbe(ports.modelRecoverable)
    : undefined;
  const radiusVersion =
    origin?.radiusVersion ? await ports.radiusVersion() : "";
  await ports.assertSource();
  const freshness = evaluateAppModelFreshness({
    model,
    originText,
    headCommit,
    sourceChanged,
    modelRecoverable,
    generatorVersion: ports.generatorVersion(),
    radiusVersion,
    hashAppBicep: ports.hashAppBicep
  });
  return { freshness, observation: observeAppModel(read, freshness) };
}

export interface AppModelFailureReads {
  current(): boolean;
  readModel(): Promise<GraphSourceRead>;
  baseline?: string;
  readSourceRevision(): Promise<string>;
}

export async function inspectAppModelFailure(
  reads: AppModelFailureReads
): Promise<
  | { kind: "stale" }
  | { kind: "model-present" }
  | { kind: "recordable"; sourceRevision: string }
> {
  const model = observeAppModel(await reads.readModel());
  if (!reads.current()) return { kind: "stale" };
  if (model.kind === "unreadable") throw new Error(model.diagnostic);
  if (model.kind === "present") return { kind: "model-present" };
  const sourceRevision = reads.baseline || (await reads.readSourceRevision());
  return reads.current() ?
      { kind: "recordable", sourceRevision }
    : { kind: "stale" };
}
