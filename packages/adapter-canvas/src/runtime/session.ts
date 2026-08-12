// The runtime session port + deferred holder.
//
// createRadiusCanvas/createRadiusTools/createRadiusExtension build their canvas,
// tool, and hook declarations (including the closures the SDK will later call)
// BEFORE the SDK session exists — joinSession() itself needs those declarations
// as input. A SessionHolder lets every closure reference `sessionHolder.get()`
// lazily: nothing reads the session until a handler actually runs, which is
// always after the production entry point has called `sessionHolder.set(...)`
// once joinSession resolves. Tests can `set()` a fake session up front and never
// touch joinSession at all.

export interface CanvasRpcOpenOptions {
  extensionId?: string;
  canvasId: string;
  instanceId: string;
  input?: Record<string, unknown>;
}

export interface SessionLogOptions {
  level?: "info" | "warning" | "error";
  ephemeral?: boolean;
}

// The slice of the SDK's joined-session object the runtime factories need.
// Intentionally structural/loose (rather than importing an SDK type) so a test
// fake only needs to implement the members actually used.
export interface SessionPort {
  workspacePath?: string;
  cwd?: string;
  log?(message: string, options?: SessionLogOptions): void | Promise<void>;
  send(message: unknown): unknown;
  rpc: {
    canvas: {
      open(options: CanvasRpcOpenOptions): Promise<unknown>;
    };
  };
  metadata?: { snapshot?: () => Promise<unknown> };
  // Additional SDK-defined members (teardown methods, Symbol.asyncDispose,
  // etc.) that the extension factory probes reflectively during shutdown.
  [key: string]: unknown;
}

export interface SessionHolder {
  get(): SessionPort;
  tryGet(): SessionPort | undefined;
  set(session: SessionPort): void;
}

export function createSessionHolder(): SessionHolder {
  let current: SessionPort | undefined;
  return {
    get(): SessionPort {
      if (!current) {
        throw new Error(
          "Radius runtime: session accessed before attachSession() was called."
        );
      }
      return current;
    },
    tryGet(): SessionPort | undefined {
      return current;
    },
    set(session: SessionPort): void {
      current = session;
    }
  };
}
