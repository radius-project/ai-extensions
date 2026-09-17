import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { LIFECYCLE_API_VERSION } from "./index.js";

const IMPORT_PROBE = `
  import { registerHooks } from "node:module";
  const sourceRoot = new URL("./src/", import.meta.url).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const sourceSpecifier =
        context.parentURL?.startsWith(sourceRoot) &&
        specifier.startsWith(".") && specifier.endsWith(".js")
          ? specifier.slice(0, -3) + ".ts"
          : specifier;
      const resolved = nextResolve(sourceSpecifier, context);
      if (!resolved.url.startsWith(sourceRoot)) {
        throw new Error("Unexpected lifecycle dependency: " + specifier);
      }
      return resolved;
    }
  });
  const lifecycle = await import(process.argv[1]);
  process.stdout.write(JSON.stringify({
    apiVersion: lifecycle.LIFECYCLE_API_VERSION
  }));
`;

function probeImport(specifier: string): string {
  return execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", IMPORT_PROBE, specifier],
    {
      cwd: new URL("../../", import.meta.url),
      encoding: "utf8",
      env: {},
      stdio: "pipe",
      timeout: 5_000
    }
  );
}

describe("@radius-project/core/lifecycle", () => {
  it("declares the lifecycle version independently of resource schemas", () => {
    expect(LIFECYCLE_API_VERSION).toBe("github-radius/v1");
  });

  it("loads the public versioned entry without host or external dependencies", () => {
    const output = probeImport("@radius-project/core/lifecycle");
    expect(JSON.parse(output)).toEqual({ apiVersion: "github-radius/v1" });
  });

  it.each(["node:fs", "node:http", "node:https"])(
    "rejects %s in the isolated import probe",
    (specifier) => {
      expect(() => probeImport(specifier)).toThrow(
        `Unexpected lifecycle dependency: ${specifier}`
      );
    }
  );
});
