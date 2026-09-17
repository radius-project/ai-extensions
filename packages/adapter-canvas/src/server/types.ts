import type { Server as HttpServer } from "node:http";
import type { CanvasState } from "../shared.js";
import type { GraphLifecycleReader } from "../runtime/graph-reader.js";

export interface CanvasServerEntry {
  server: HttpServer;
  baseUrl: string;
  url: string;
  page: string;
  state: CanvasState;
  graphLifecycle?: GraphLifecycleReader;
}
