import type { Server as HttpServer } from "node:http";
import type { CanvasState } from "../shared.js";
import type { WorkflowObservationScope } from "./services/workflow-observation-scope.js";

export interface CanvasServerEntry {
  server: HttpServer;
  baseUrl: string;
  url: string;
  page: string;
  state: CanvasState;
  observation?: WorkflowObservationScope;
}
