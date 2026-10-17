import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { createModelingEvaluation } from "./modeling-evaluation.js";

export async function startEvaluationServer(
  evaluation: ReturnType<typeof createModelingEvaluation>
) {
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(405).end();
      return;
    }
    if (request.url !== "/mcp" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    let id: string | number | null = null;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > 64 * 1024) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(buffer);
      }
      const message: unknown = JSON.parse(
        Buffer.concat(chunks).toString("utf8")
      );
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        throw new Error("Expected a JSON-RPC object.");
      }
      const data = message as Record<string, unknown>;
      if (data.jsonrpc !== "2.0" || typeof data.method !== "string") {
        throw new Error("Expected a JSON-RPC 2.0 method.");
      }
      if (!("id" in data)) {
        if (data.method !== "notifications/initialized") {
          throw new Error("Unsupported notification.");
        }
        response.writeHead(202).end();
        return;
      }
      if (typeof data.id !== "string" && typeof data.id !== "number") {
        throw new Error("Expected a string or numeric request id.");
      }
      id = data.id;
      let result: unknown;
      if (data.method === "initialize") {
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "radius-modeling-eval", version: "0.1.0" }
        };
      } else if (data.method === "tools/list") {
        result = { tools: evaluation.tools };
      } else if (data.method === "ping") {
        result = {};
      } else if (data.method === "tools/call") {
        if (!data.params || typeof data.params !== "object") {
          throw new Error("Expected tool parameters.");
        }
        const params = data.params as Record<string, unknown>;
        if (typeof params.name !== "string") {
          throw new Error("Expected a tool name.");
        }
        try {
          result = {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  evaluation.call(params.name, params.arguments ?? {})
                )
              }
            ]
          };
        } catch (error) {
          result = {
            isError: true,
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error)
              }
            ]
          };
        }
      } else {
        throw new Error(`Unsupported method: ${data.method}`);
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    } catch (error) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32600,
            message: error instanceof Error ? error.message : String(error)
          }
        })
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  };
}
