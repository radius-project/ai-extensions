import { describe, expect, it } from "vitest";
import { deterministicProviderUuid } from "./provider-uuid.js";

describe("provider mutation identity", () => {
  it("builds stable provider UUIDs with UUID v5 bits", () => {
    const first = deterministicProviderUuid("op_test:role:scope");
    expect(first).toBe(deterministicProviderUuid("op_test:role:scope"));
    expect(first).not.toBe(deterministicProviderUuid("op_test:role:other"));
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
  it("retains persisted deterministic role assignment identities", () => {
    expect(deterministicProviderUuid("")).toBe(
      "e3b0c442-98fc-5c14-9afb-f4c8996fb924"
    );
    expect(deterministicProviderUuid("abc")).toBe(
      "ba7816bf-8f01-5fea-8141-40de5dae2223"
    );
    expect(deterministicProviderUuid("operation\0principal\0role\0scope")).toBe(
      deterministicProviderUuid("operation\0principal\0role\0scope")
    );
    expect(
      deterministicProviderUuid("another-operation\0principal\0role\0scope")
    ).not.toBe(deterministicProviderUuid("operation\0principal\0role\0scope"));
  });
});
