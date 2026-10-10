import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODELING_CASES } from "./modeling-cases.js";
import { createModelingEvaluation } from "./modeling-evaluation.js";
import { startEvaluationServer } from "./mcp-server.js";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));

async function server() {
  return startEvaluationServer(
    createModelingEvaluation(MODELING_CASES[0], root, root, {
      skill: "fixture skill",
      runtimeContract: "fixture contract"
    })
  );
}

describe("headless evaluation MCP transport", () => {
  it("initializes and runs a decision through real loopback HTTP", async () => {
    const host = await server();
    try {
      const rpc = async (method: string, params = {}) => {
        const response = await fetch(host.url, {
          method: "POST",
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
        });
        expect(response.status).toBe(200);
        return response.json();
      };
      expect((await rpc("initialize")).result.capabilities).toEqual({
        tools: {}
      });
      expect((await rpc("tools/list")).result.tools).toHaveLength(3);
      expect((await rpc("ping")).result).toEqual({});
      const initialized = await fetch(host.url, {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized"
        })
      });
      expect(initialized.status).toBe(202);
      for (const name of ["radius_generate_app", "resolve_modeling_evidence"]) {
        const result = await rpc("tools/call", { name, arguments: {} });
        expect(result.result.isError).toBeUndefined();
        expect(result.result.content[0].type).toBe("text");
      }
      const result = await rpc("tools/call", {
        name: "submit_modeling_decision",
        arguments: { status: "ready", blocker: "none", reason: "fixture" }
      });
      expect(JSON.parse(result.result.content[0].text)).toEqual({
        recorded: true
      });
    } finally {
      await host.close();
    }
    await expect(fetch(host.url)).rejects.toThrow();
  });

  it("surfaces tool errors without a success-shaped result", async () => {
    const host = await server();
    try {
      const response = await fetch(host.url, {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "tool-error",
          method: "tools/call",
          params: { name: "submit_modeling_decision", arguments: {} }
        })
      });
      const body = await response.json();
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toContain("Read the skill");
    } finally {
      await host.close();
    }
  });

  it("rejects malformed protocol input and oversized bodies", async () => {
    const host = await server();
    try {
      expect((await fetch(host.url)).status).toBe(405);
      expect(
        (await fetch(host.url.replace("/mcp", "/other"), { method: "POST" }))
          .status
      ).toBe(404);
      for (const body of [
        "{",
        "null",
        "[]",
        JSON.stringify({ jsonrpc: "1.0", method: "ping", id: 1 }),
        JSON.stringify({ jsonrpc: "2.0", method: "ping", id: null }),
        JSON.stringify({ jsonrpc: "2.0", method: "unknown", id: 1 }),
        JSON.stringify({ jsonrpc: "2.0", method: "unexpected-notification" }),
        JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 1 }),
        JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 1,
          params: {}
        })
      ]) {
        const response = await fetch(host.url, { method: "POST", body });
        expect(response.status).toBe(400);
        expect((await response.json()).error.code).toBe(-32600);
      }
      const ping = JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 });
      for (const size of [65535, 65536]) {
        const response = await fetch(host.url, {
          method: "POST",
          body: ping.padEnd(size)
        });
        expect(response.status).toBe(200);
        expect((await response.json()).result).toEqual({});
      }
      expect(
        (await fetch(host.url, { method: "POST", body: "x".repeat(65537) }))
          .status
      ).toBe(413);
    } finally {
      await host.close();
    }
  });
});
