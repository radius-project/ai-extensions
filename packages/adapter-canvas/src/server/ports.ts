import type {
  IncomingMessage,
  RequestListener,
  Server as HttpServer,
  ServerResponse
} from "node:http";
import type { CanvasState } from "../shared.js";
import type { CanvasServerEntry } from "./types.js";

export interface RequestHandlerFactoryInput {
  instanceId: string;
  instances: ReadonlyMap<string, CanvasServerEntry>;
  markActivity(): void;
}
export interface CanvasServerDependencies {
  createHttpServer(
    handler: (
      request: IncomingMessage,
      response: ServerResponse<IncomingMessage>
    ) => void
  ): HttpServer;
  createRequestHandler(input: RequestHandlerFactoryInput): RequestListener;
  createState(): CanvasState;
  defaultPage: string;
  now(): number;
  // Runs once per instance after the entry is registered, mirroring the
  // start-time side effects the legacy startServer performed after
  // servers.set: clearing the shutting-down flag and resuming recovered
  // verification monitors.
  onStarted?(instanceId: string, entry: CanvasServerEntry): void;
  // Fires once per stopped instance, after the entry leaves the container and
  // the socket close settles, so per-instance bookkeeping owned by the facade
  // can be released. Closing swallows its own failures, so a server that fails
  // to close still releases rather than leaking the entry.
  onStopped?(instanceId: string): void;
  preferredPort(instanceId: string): Promise<number>;
  prepareIdentity(): void;
}
