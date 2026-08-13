import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const https = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("node:https", () => ({ default: https }));

import { ensureVendorScripts } from "./vendor.js";

describe("vendor asset warm-up", () => {
  it("is idle on import and shares one in-flight load across concurrent callers", async () => {
    expect(https.get).not.toHaveBeenCalled();
    https.get.mockImplementation(
      (
        _url: string,
        _options: unknown,
        callback: (
          response: EventEmitter & {
            statusCode: number;
            headers: Record<string, string>;
            resume: () => void;
          }
        ) => void
      ) => {
        const request = new EventEmitter();
        queueMicrotask(() => {
          const response = Object.assign(new EventEmitter(), {
            statusCode: 200,
            headers: {},
            resume: vi.fn()
          });
          callback(response);
          response.emit("data", Buffer.from("asset"));
          response.emit("end");
        });
        return request;
      }
    );

    await Promise.all([ensureVendorScripts(), ensureVendorScripts()]);

    // React, ReactDOM, React Flow, dagre, and the React Flow stylesheet.
    expect(https.get).toHaveBeenCalledTimes(5);
    await ensureVendorScripts();
    expect(https.get).toHaveBeenCalledTimes(5);
  });
});
