import type { ResourceIdSegment } from "./resource-id.js";
import type { ResourceList } from "./resources.js";

export interface RadiusQueryContext {
  readonly connectionId: string;
  readonly plane: ResourceIdSegment;
}

export interface RadiusQueryRequest extends RadiusQueryContext {
  readonly method: "GET" | "POST";
  /** UCP path including the API prefix and encoded api-version query. */
  readonly path: string;
  readonly signal?: AbortSignal;
}

/** The host owns authentication, HTTP status errors, decoding and timeouts. */
export interface RadiusQueryPort {
  request<T>(request: RadiusQueryRequest): Promise<T>;
}

export interface QueryOptions {
  readonly signal?: AbortSignal;
}

export interface ResourceListOptions extends QueryOptions {
  readonly resourceType?: string;
  readonly resourceGroup?: string;
}

export interface QueryFailure {
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly error: unknown;
}

/** Partial inventory is explicit. All failed operations reject instead. */
export interface QueryResult<
  T = Record<string, unknown>
> extends ResourceList<T> {
  readonly complete: boolean;
  readonly errors: readonly QueryFailure[];
}
