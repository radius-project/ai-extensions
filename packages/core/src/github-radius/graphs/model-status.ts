import {
  APP_ORIGIN_REPO_PATH,
  APP_ORIGIN_ROOT_PATH,
  evaluateAppModelFreshness,
  evaluateAppSource,
  parseAppOrigin
} from "../../modeling/index.js";
import type {
  AppModelFreshness,
  AppSourceEvaluation
} from "../../modeling/index.js";
import type { GraphDefinition, GraphSource } from "./pipeline.js";

export interface AppModelStatus {
  repo: string;
  branch: string;
  refreshable: boolean;
  freshness: AppModelFreshness;
}

export function graphSourceBranch(source: GraphSource): string {
  return source.kind === "workspace" ? source.branch : source.ref;
}

export interface AppModelStatusPorts {
  readDefinition(source: GraphSource): Promise<GraphDefinition>;
  readFile(source: GraphSource, path: string): Promise<string | null>;
  listPaths(source: GraphSource): Promise<string[] | null>;
  workspaceHeadCommit(path: string): Promise<string>;
  workspaceSourceChangedSince(
    path: string,
    commit: string
  ): Promise<boolean | undefined>;
  workspaceModelRecoverable(path: string): Promise<boolean | undefined>;
  generatorVersion(): string;
  hashAppBicep(content: string): string;
}

export interface AppModelStatusReader {
  evaluateSource(source: GraphSource): Promise<AppSourceEvaluation>;
  resolveStatus(source: GraphSource): Promise<AppModelStatus>;
}

export function evaluateGraphSource(
  paths: string[] | null
): AppSourceEvaluation {
  return paths?.length === 0 ?
      { status: "none", dockerfiles: [] }
    : evaluateAppSource(paths);
}

/** Reads evidence from one source. Failed evidence is never a missing model. */
export function createAppModelStatusReader(
  ports: AppModelStatusPorts
): AppModelStatusReader {
  async function readOrigin(source: GraphSource): Promise<string | null> {
    for (const path of [APP_ORIGIN_REPO_PATH, APP_ORIGIN_ROOT_PATH]) {
      const text = await ports.readFile(source, path);
      if (text !== null) return text;
    }
    return null;
  }

  return {
    async evaluateSource(source: GraphSource): Promise<AppSourceEvaluation> {
      return evaluateGraphSource(await ports.listPaths(source));
    },
    async resolveStatus(source: GraphSource): Promise<AppModelStatus> {
      const model = await ports.readDefinition(source);
      const [originText, headCommit] = await Promise.all([
        readOrigin(source),
        source.kind === "workspace" ?
          ports.workspaceHeadCommit(source.workspacePath).catch(() => "")
        : Promise.resolve("")
      ]);
      const recordedCommit = parseAppOrigin(originText)?.sourceCommit;
      const sourceChanged =
        source.kind === "workspace" && recordedCommit ?
          await ports
            .workspaceSourceChangedSince(source.workspacePath, recordedCommit)
            .catch(() => undefined)
        : undefined;
      const modelRecoverable =
        source.kind === "workspace" && !recordedCommit ?
          await ports
            .workspaceModelRecoverable(source.workspacePath)
            .catch(() => undefined)
        : undefined;
      return {
        repo: source.repo,
        branch: graphSourceBranch(source),
        refreshable: source.kind === "workspace" && model.content !== null,
        freshness: evaluateAppModelFreshness({
          model: model.content,
          originText,
          headCommit,
          sourceChanged,
          modelRecoverable,
          generatorVersion: ports.generatorVersion(),
          hashAppBicep: ports.hashAppBicep
        })
      };
    }
  };
}
