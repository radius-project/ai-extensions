import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createRequestContext } from "../request-context.js";
import { runSetupHttpHandler } from "./setup-http-failure.js";
import type { CanvasRequestContext } from "../request-context.js";

const servers = new Set<ReturnType<typeof createServer>>();
afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
  servers.clear();
});

async function invoke(work: (context: CanvasRequestContext) => Promise<void>) {
  const diagnostics: { code: string; message: string }[] = [];
  const server = createServer((request, response) => {
    const context = createRequestContext(request, response, "test", new Map());
    void runSetupHttpHandler(
      context,
      () => work(context),
      (value) => {
        diagnostics.push(value);
      }
    );
  });
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  return { diagnostics, response: fetch(`http://127.0.0.1:${address.port}`) };
}

describe("setup HTTP failure boundary", () => {
  it("preserves successful response headers and body without diagnostics", async () => {
    const test = await invoke(async (context) => {
      context.json(202, { reconciling: true });
    });
    const response = await test.response;
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ reconciling: true });
    expect(test.diagnostics).toEqual([]);
  });

  it.each([new Error("private provider detail"), "non-error rejection"])(
    "reports a rejected handler without leaking its detail: %s",
    async (error) => {
      const test = await invoke(async () => {
        throw error;
      });
      const response = await test.response;
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        code: "setup-handler-failed",
        error:
          "Setup could not finish reporting its outcome. Inspect the operation before retrying."
      });
      expect(test.diagnostics).toEqual([
        {
          code: "setup-handler-failed",
          message: error instanceof Error ? error.message : error
        }
      ]);
    }
  );

  it("does not answer twice after the response ended", async () => {
    const test = await invoke(async (context) => {
      context.json(200, { completed: true });
      throw new Error("late failure");
    });
    const response = await test.response;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ completed: true });
    expect(test.diagnostics).toHaveLength(1);
  });

  it.each(["headers", "destroyed"])(
    "closes an incomplete %s response instead of rewriting it",
    async (phase) => {
      const test = await invoke(async ({ response }) => {
        if (phase === "headers") response.writeHead(200);
        else response.destroy();
        throw new Error("incomplete response");
      });
      await expect(test.response).rejects.toThrow();
      expect(test.diagnostics).toHaveLength(1);
    }
  );
});
