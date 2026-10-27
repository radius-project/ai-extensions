import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const installer: {
  installVerifiedCompiler(
    asset: { name: string; digest: string },
    directory: string,
    environmentFile: string,
    download: (url: string) => Promise<Response>
  ): Promise<string>;
} = await import(
  pathToFileURL(
    path.resolve(
      import.meta.dirname,
      "../../../../scripts/install-repair-test-compiler.mjs"
    )
  ).href
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
it.each(["valid", "checksum", "http", "existing"] as const)(
  "isolates the pinned compiler setup (%s)",
  async (scenario) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "repair-install-"));
    roots.push(root);
    const bytes = "test compiler bytes";
    const asset = {
      name: "compiler",
      digest: createHash("sha256").update(bytes).digest("hex")
    };
    const file = path.join(root, asset.name);
    const environment = path.join(root, "environment");
    fs.writeFileSync(environment, "EXISTING=retained\n");
    if (scenario === "existing") fs.writeFileSync(file, "preexisting compiler");
    const install = installer.installVerifiedCompiler(
      asset,
      root,
      environment,
      async (url) => {
        expect(url).toBe(
          "https://github.com/Azure/bicep/releases/download/v0.42.1/compiler"
        );
        return new Response(scenario === "checksum" ? "changed" : bytes, {
          status: scenario === "http" ? 503 : 200
        });
      }
    );
    if (scenario === "valid") {
      await expect(install).resolves.toBe(file);
      expect(fs.readFileSync(file, "utf8")).toBe(bytes);
      expect(fs.readFileSync(environment, "utf8")).toBe(
        `EXISTING=retained\nRADIUS_REPAIR_TEST_BICEP=${file}\n`
      );
      if (process.platform !== "win32")
        expect(fs.statSync(file).mode & 0o777).toBe(0o755);
    } else {
      await expect(install).rejects.toThrow(
        scenario === "http" ? "HTTP 503"
        : scenario === "checksum" ? "checksum mismatch"
        : "EEXIST"
      );
      expect(fs.readFileSync(environment, "utf8")).toBe("EXISTING=retained\n");
      if (scenario === "existing")
        expect(fs.readFileSync(file, "utf8")).toBe("preexisting compiler");
      else expect(fs.existsSync(file)).toBe(false);
    }
  }
);
