import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { vi } from "vitest";
import { createRequestContext } from "../../src/server/request-context.js";

export function graphRouteContext(path: string) {
  const socket = new Socket();
  const request = new IncomingMessage(socket);
  request.url = path;
  request.method = "GET";
  const response = new ServerResponse(request);
  const chunks: string[] = [];
  const write = vi.spyOn(response, "write").mockImplementation((chunk) => {
    if (typeof chunk === "string") chunks.push(chunk);
    return true;
  });
  const end = vi.spyOn(response, "end").mockImplementation((chunk) => {
    if (typeof chunk === "string") chunks.push(chunk);
    return response;
  });
  return {
    context: createRequestContext(request, response, "graph-test", new Map()),
    response,
    write,
    end,
    body: () => chunks.join(""),
    close: () => {
      write.mockRestore();
      end.mockRestore();
      socket.destroy();
    }
  };
}
