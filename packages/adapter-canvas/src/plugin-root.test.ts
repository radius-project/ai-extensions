import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePluginRoot } from "./plugin-root.js";

describe("resolvePluginRoot", () => {
  it("resolves the plugin root from a canonical Copilot extension directory", () => {
    const pluginRoot = path.join(path.parse(process.cwd()).root, "plugin");
    const moduleDirectory = path.join(
      pluginRoot,
      "com.github.copilot",
      "extensions",
      "radius"
    );

    expect(resolvePluginRoot(moduleDirectory)).toBe(pluginRoot);
  });

  it("keeps a directly loaded development extension directory", () => {
    const moduleDirectory = path.join(
      path.parse(process.cwd()).root,
      "home",
      ".copilot",
      "extensions",
      "radius"
    );

    expect(resolvePluginRoot(moduleDirectory)).toBe(moduleDirectory);
  });
});
