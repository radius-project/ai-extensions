import { describe, expect, it } from "vitest";
import { requestFit } from "./fit.js";

const OPTIONS = { padding: 0.18 };

describe("requestFit", () => {
  it("does nothing before the flow instance exists", () => {
    expect(() => requestFit(null, OPTIONS)).not.toThrow();
  });

  it("asks the instance to fit with the given options", () => {
    const calls: { padding: number }[] = [];
    requestFit(
      {
        fitView(options) {
          calls.push(options);
          return Promise.resolve(true);
        }
      },
      OPTIONS
    );
    expect(calls).toEqual([OPTIONS]);
  });

  it("observes an asynchronous rejection instead of leaking it", async () => {
    let rejected: Promise<boolean> | undefined;
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      requestFit(
        {
          fitView() {
            rejected = Promise.reject(new Error("viewport unavailable"));
            return rejected;
          }
        },
        OPTIONS
      );
      await expect(rejected).rejects.toThrow("viewport unavailable");
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("contains a synchronous failure", () => {
    expect(() =>
      requestFit(
        {
          fitView() {
            throw new Error("viewport unavailable");
          }
        },
        OPTIONS
      )
    ).not.toThrow();
  });
});
