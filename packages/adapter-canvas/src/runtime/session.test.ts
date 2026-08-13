import { describe, expect, it } from "vitest";
import { createSessionHolder } from "./session.js";

describe("runtime session holder", () => {
  it("rejects access before attachment and exposes the attached session", () => {
    const holder = createSessionHolder();
    const session = {
      send: () => undefined,
      rpc: { canvas: { open: async () => ({}) } }
    };

    expect(holder.tryGet()).toBeUndefined();
    expect(() => holder.get()).toThrow(
      "Radius runtime: session accessed before attachSession() was called."
    );

    holder.set(session);
    expect(holder.tryGet()).toBe(session);
    expect(holder.get()).toBe(session);
  });
});
