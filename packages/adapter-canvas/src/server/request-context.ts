import type { IncomingMessage, ServerResponse } from "node:http";
import type { CanvasState } from "../shared.js";
import type { CanvasServerEntry } from "./types.js";

export interface CanvasRequestContext {
  instanceId: string;
  request: IncomingMessage;
  response: ServerResponse<IncomingMessage>;
  url: URL;
  pathname: string;
  state: CanvasState;
  readTextBody(): Promise<string>;
  readJsonBody(options?: { emptyObject?: boolean }): Promise<unknown>;
  json(
    status: number,
    payload: unknown,
    headers?: Readonly<Record<string, string>>
  ): void;
  text(
    status: number,
    payload: string,
    headers?: Readonly<Record<string, string>>
  ): void;
}

export function createRequestContext(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  instanceId: string,
  instances: ReadonlyMap<string, CanvasServerEntry>
): CanvasRequestContext {
  const url = new URL(request.url || "/", "http://localhost");
  let body: Promise<string> | undefined;

  function readTextBody(): Promise<string> {
    body ??= (async () => {
      let value = "";
      for await (const chunk of request) value += chunk;
      return value;
    })();
    return body;
  }

  function write(
    status: number,
    payload: string,
    contentType: string,
    headers: Readonly<Record<string, string>>
  ): void {
    response.setHeader("Content-Type", contentType);
    for (const [name, value] of Object.entries(headers)) {
      response.setHeader(name, value);
    }
    response.writeHead(status);
    response.end(payload);
  }

  return {
    instanceId,
    request,
    response,
    url,
    pathname: url.pathname,
    state: instances.get(instanceId)?.state ?? {},
    readTextBody,
    async readJsonBody(options = {}) {
      const value = await readTextBody();
      return JSON.parse(!value && options.emptyObject ? "{}" : value);
    },
    json(status, payload, headers = {}) {
      write(status, JSON.stringify(payload), "application/json", headers);
    },
    text(status, payload, headers = {}) {
      write(status, payload, "text/plain; charset=utf-8", headers);
    }
  };
}

export function syncRequestedPage(
  entry: Pick<CanvasServerEntry, "page" | "state"> | undefined,
  requestedPage: string | null
): void {
  if (!entry || !requestedPage) return;
  entry.page = requestedPage;
  if (requestedPage === "graph") entry.state.activeGraphView = "graph";
  else if (requestedPage === "planned") entry.state.activeGraphView = "planned";
  else if (requestedPage === "graph-diff" || requestedPage === "graphDiff")
    entry.state.activeGraphView = "diff";
}
