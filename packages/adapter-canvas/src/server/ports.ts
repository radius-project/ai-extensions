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
  preferredPort(instanceId: string): Promise<number>;
  prepareIdentity(): void;
}
