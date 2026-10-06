import { describe, expect, it } from "vitest";
import config from "../../../../vitest.config.js";

describe("root test scheduling", () => {
  it("limits Windows worker concurrency and retains defaults elsewhere", () => {
    expect(config).toHaveProperty(
      "test.maxWorkers",
      process.platform === "win32" ? 2 : undefined
    );
  });
});
