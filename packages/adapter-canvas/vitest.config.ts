import { configDefaults, defineConfig } from "vitest/config";
import { TOOLCHAIN_CHECKS } from "./vitest.toolchain.config.js";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "test/ci/**/*.test.mjs",
      "test/ci/**/*.test.ts",
      "test/e2e/support/**/*.test.ts",
      "test/support/**/*.test.ts",
      "test/e2e-cloud/**/*.test.ts",
      "test/integration/runtime/**/*.test.ts",
      "test/integration/http/**/*.test.ts"
    ],
    exclude: [...configDefaults.exclude, ...TOOLCHAIN_CHECKS],
    environment: "node",
    testTimeout: 15_000
  }
});
