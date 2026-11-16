/** A selected source is independent of whether its definition can be read. */
export interface GraphSourceIdentity {
  kind: "workspace" | "github";
  repo: string;
  ref: string;
  definitionPath: string;
  revision?: string;
  workspacePath?: string;
}

export type GraphSourceRead =
  | { status: "present"; source: GraphSourceIdentity; content: string }
  | { status: "absent"; source: GraphSourceIdentity }
  | {
      status: "unavailable";
      source: GraphSourceIdentity;
      diagnostic: string;
    };

export type PresentGraphSource = Extract<
  GraphSourceRead,
  { status: "present" }
>;

export class GraphSourceError extends Error {
  constructor(
    public readonly code: "unavailable" | "empty" | "invalid-artifact",
    message: string,
    public readonly source: GraphSourceIdentity,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "GraphSourceError";
  }
}
