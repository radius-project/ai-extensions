import type { Server as HttpServer } from "node:http";
import type { CanvasState } from "../shared.js";

export interface CanvasServerEntry {
  server: HttpServer;
  baseUrl: string;
  url: string;
  page: string;
  state: CanvasState;
}
