export interface ResourceOutput {
  id?: string;
  name?: string;
  type?: string;
  displayType?: string;
  deployStatus?: string;
  portalUrl?: string;
}

export interface ResourceConnection {
  id?: string;
  name?: string;
  direction?: string;
  diffStatus?: string;
}

/** Renderer capabilities supplied by modeled graph adapters, never inferred for live UCP. */
export interface GraphResource {
  id?: string;
  name?: string;
  type?: string;
  displayType?: string;
  icon?: string;
  codeReference?: string;
  definitionFile?: string;
  definitionLine?: number;
  diffStatus?: string;
  deployStatus?: string;
  deployMessage?: string;
  portalUrl?: string;
  provisioningState?: string;
  outputResources?: Array<ResourceOutput | null>;
  connections?: Array<ResourceConnection | null>;
}

export interface GraphContext {
  readonly connectionId: string;
  readonly plane: { readonly type: string; readonly name: string };
  readonly applicationId: string;
}

export interface LiveGraphResource {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly provider?: string;
  readonly provisioningState?: string;
  readonly connections: readonly {
    readonly id: string;
    readonly direction: "Outbound";
  }[];
}

/** Stable reason a live resource or connection was dropped during normalization. */
export type LiveGraphWarningCode =
  | "duplicate-resource"
  | "invalid-resource-id"
  | "invalid-connection"
  | "unresolved-connection";

/**
 * A recoverable live-graph problem. Hosts can filter or localize by `code`
 * and `severity` instead of parsing `message`, which is English display text.
 */
export interface LiveGraphWarning {
  readonly code: LiveGraphWarningCode;
  /** `info` for benign input noise; `warning` when data was dropped. */
  readonly severity: "info" | "warning";
  readonly message: string;
  /** The resource that owns the dropped record. */
  readonly resourceId: string;
}

export interface LiveGraph {
  readonly kind: "live";
  readonly context: GraphContext;
  readonly resources: readonly LiveGraphResource[];
  readonly warnings: readonly LiveGraphWarning[];
}

export interface ModeledGraph {
  readonly kind: "modeled" | "planned" | "deployed-projection" | "diff";
  readonly resources: readonly GraphResource[];
}

export type RadiusGraphData = LiveGraph | ModeledGraph;
