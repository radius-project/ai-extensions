import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPTS = ["awesome-copilot.mjs", "plugins.mjs"].map((name) => [
  name,
  fileURLToPath(new URL(`../../../../scripts/${name}`, import.meta.url))
]);

const MANIFEST = ".github/plugin/marketplace.json";
const DIST = "plugins/radius/dist";

const VERSION = "0.4.0";
const SHA = "0b331868a1c2d3e4f5061728394a5b6c7d8e9f01";

const temporaryRepositories = [];

const marketplace = (overrides = {}) => ({
  name: "radius-plugins",
  metadata: { description: "Radius plugins.", version: VERSION },
  owner: {
    name: "Radius",
    email: "radiuscoreteam@service.microsoft.com"
  },
  plugins: [
    {
      name: "radius",
      source: {
        source: "github",
        repo: "radius-project/ai-extensions",
        path: DIST,
        ref: "edge"
      },
      description: "Model, visualize, and deploy applications with Radius.",
      version: VERSION,
      repository: "https://github.com/radius-project/ai-extensions",
      license: "Apache-2.0",
      keywords: ["radius", "radapp", "bicep"]
    }
  ],
  ...overrides
});

const pluginManifest = (overrides = {}) => ({
  name: "radius",
  version: VERSION,
  description: "Model, visualize, and deploy applications with Radius.",
  license: "Apache-2.0",
  repository: "https://github.com/radius-project/ai-extensions",
  homepage: "https://radapp.io",
  ...overrides
});

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeRepository({ catalog = marketplace(), manifest } = {}) {
  const root = mkdtempSync(join(tmpdir(), "radius-awesome-"));
  temporaryRepositories.push(root);

  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, DIST), { recursive: true });
  mkdirSync(join(root, ".github", "plugin"), { recursive: true });

  // The scripts resolve the repository from their own location, so exercising
  // them against a fixture means copying them rather than running in place.
  for (const [name, source] of SCRIPTS) {
    copyFileSync(source, join(root, "scripts", name));
  }

  // The registry discovers a plugin by its directory, so the fixture needs the
  // tracked manifests beside the built dist it publishes from.
  writeJson(join(root, "plugins", "radius", "package.json"), {
    name: "radius",
    version: VERSION
  });
  writeJson(join(root, "plugins", "radius", "plugin.json"), {
    name: "radius",
    version: VERSION
  });
  writeFileSync(
    join(root, "plugins", "radius", "README.md"),
    "# Radius Plugin\n"
  );
  writeJson(join(root, MANIFEST), catalog);
  writeJson(join(root, DIST, "plugin.json"), manifest ?? pluginManifest());
  writeFileSync(join(root, DIST, "README.md"), "# Radius Plugin\n");

  return root;
}

function run(root, ...args) {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [join(root, "scripts", "awesome-copilot.mjs"), ...args],
    { cwd: root, encoding: "utf8" }
  );
  return { status, stdout: stdout.trim(), stderr };
}

function generate(root, ...args) {
  const result = run(root, "--out", "listing", "--sha", SHA, ...args);
  expect(result.status, result.stderr).toBe(0);
  return join(root, "listing");
}

function listFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(absolute));
    else found.push(absolute);
  }
  return found;
}

afterEach(() => {
  while (temporaryRepositories.length > 0) {
    rmSync(temporaryRepositories.pop(), { recursive: true, force: true });
  }
});

describe("scripts/awesome-copilot.mjs", () => {
  it("emits only the four files a manual awesome-copilot pull request needs", () => {
    const out = generate(writeRepository());

    const files = listFiles(out)
      .map((file) => relative(out, file).split(sep).join("/"))
      .sort();
    expect(files).toEqual([
      ".github/plugin/marketplace.json",
      "plugins/external.json",
      "plugins/radius/README.md",
      "plugins/radius/plugin.json"
    ]);
  });

  it("pins both source locators to the full commit SHA", () => {
    const out = generate(writeRepository());
    const [entry] = JSON.parse(
      readFileSync(join(out, "plugins", "external.json"), "utf8")
    );

    expect(entry.source).toEqual({
      source: "github",
      repo: "radius-project/ai-extensions",
      path: DIST,
      ref: SHA,
      sha: SHA
    });
  });

  it("derives every field awesome-copilot requires from the release manifests", () => {
    const out = generate(writeRepository());
    const [entry] = JSON.parse(
      readFileSync(join(out, "plugins", "external.json"), "utf8")
    );

    expect(entry).toMatchObject({
      name: "radius",
      description: "Model, visualize, and deploy applications with Radius.",
      version: VERSION,
      author: {
        name: "Radius",
        email: "radiuscoreteam@service.microsoft.com"
      },
      repository: "https://github.com/radius-project/ai-extensions",
      homepage: "https://radapp.io",
      license: "Apache-2.0",
      keywords: ["radius", "radapp", "bicep"]
    });
  });

  it("writes the entry in each file's own container shape", () => {
    const out = generate(writeRepository());
    const catalog = JSON.parse(readFileSync(join(out, MANIFEST), "utf8"));
    const external = JSON.parse(
      readFileSync(join(out, "plugins", "external.json"), "utf8")
    );

    expect(Array.isArray(external)).toBe(true);
    expect(catalog).toEqual({ plugins: external });
  });

  it("copies the released manifest and README verbatim", () => {
    const root = writeRepository();
    const out = generate(root);

    expect(
      readFileSync(join(out, "plugins", "radius", "plugin.json"), "utf8")
    ).toBe(readFileSync(join(root, DIST, "plugin.json"), "utf8"));
    expect(
      readFileSync(join(out, "plugins", "radius", "README.md"), "utf8")
    ).toBe("# Radius Plugin\n");
  });

  it("omits homepage when the plugin manifest declares none", () => {
    const manifest = pluginManifest();
    delete manifest.homepage;
    const out = generate(writeRepository({ manifest }));
    const [entry] = JSON.parse(
      readFileSync(join(out, "plugins", "external.json"), "utf8")
    );

    expect(entry).not.toHaveProperty("homepage");
  });

  it.each([
    ["a short SHA", "0b33186"],
    ["an uppercase SHA", SHA.toUpperCase()],
    ["a tag name", "radius/v0.4.0"]
  ])("refuses %s as the source locator", (_label, ref) => {
    const { status, stderr } = run(
      writeRepository(),
      "--out",
      "listing",
      "--sha",
      ref
    );

    expect(status).toBe(1);
    expect(stderr).toContain("full 40-character commit SHA");
  });

  it("requires an output directory", () => {
    const { status, stderr } = run(writeRepository(), "--sha", SHA);

    expect(status).toBe(1);
    expect(stderr).toContain("--out");
  });

  it("refuses to write anything when the catalog has no radius entry", () => {
    const root = writeRepository({ catalog: marketplace({ plugins: [] }) });
    const { status, stderr } = run(root, "--out", "listing", "--sha", SHA);

    expect(status).toBe(1);
    expect(stderr).toContain('no "radius" plugin entry');
    expect(existsSync(join(root, "listing"))).toBe(false);
  });

  it("rejects a catalog version that has drifted from the shipped manifest", () => {
    const root = writeRepository({
      manifest: pluginManifest({ version: "0.3.0" })
    });
    const { status, stderr } = run(root, "--out", "listing", "--sha", SHA);

    expect(status).toBe(1);
    expect(stderr).toContain("publishes 0.4.0");
    expect(stderr).toContain("ships 0.3.0");
  });

  it("rejects a repository URL that is not on github.com", () => {
    const catalog = marketplace();
    catalog.plugins[0].repository = "https://example.com/radius";
    const { status, stderr } = run(
      writeRepository({ catalog }),
      "--out",
      "listing",
      "--sha",
      SHA
    );

    expect(status).toBe(1);
    expect(stderr).toContain("https github.com URL");
  });

  it("rejects keywords awesome-copilot would reject", () => {
    const catalog = marketplace();
    catalog.plugins[0].keywords = ["Radius", "app modeling"];
    const { status, stderr } = run(
      writeRepository({ catalog }),
      "--out",
      "listing",
      "--sha",
      SHA
    );

    expect(status).toBe(1);
    expect(stderr).toContain("lowercase and hyphenated");
  });

  it("rejects more keywords than awesome-copilot accepts", () => {
    const catalog = marketplace();
    catalog.plugins[0].keywords = Array.from({ length: 11 }, (_, i) => `k${i}`);
    const { status, stderr } = run(
      writeRepository({ catalog }),
      "--out",
      "listing",
      "--sha",
      SHA
    );

    expect(status).toBe(1);
    expect(stderr).toContain("between 1 and 10 keywords");
  });

  it("rejects a catalog with no owner to attribute", () => {
    const catalog = marketplace();
    delete catalog.owner;
    const { status, stderr } = run(
      writeRepository({ catalog }),
      "--out",
      "listing",
      "--sha",
      SHA
    );

    expect(status).toBe(1);
    expect(stderr).toContain("owner.name");
  });

  it("rejects a plugin entry with no license", () => {
    const catalog = marketplace();
    delete catalog.plugins[0].license;
    const { status, stderr } = run(
      writeRepository({ catalog }),
      "--out",
      "listing",
      "--sha",
      SHA
    );

    expect(status).toBe(1);
    expect(stderr).toContain("no license");
  });

  it("rejects a source that does not name an owner/repo and a plugin root", () => {
    const catalog = marketplace();
    catalog.plugins[0].source.repo = "ai-extensions";
    const withBadRepo = run(
      writeRepository({ catalog }),
      "--out",
      "listing",
      "--sha",
      SHA
    );
    expect(withBadRepo.status).toBe(1);
    expect(withBadRepo.stderr).toContain('"owner/repo" form');

    const withoutPath = marketplace();
    delete withoutPath.plugins[0].source.path;
    const missingPath = run(
      writeRepository({ catalog: withoutPath }),
      "--out",
      "listing",
      "--sha",
      SHA
    );
    expect(missingPath.status).toBe(1);
    expect(missingPath.stderr).toContain("source.path is required");
  });

  it("rejects a catalog version that is not semver", () => {
    const catalog = marketplace();
    catalog.plugins[0].version = "0.4";
    const { status, stderr } = run(
      writeRepository({
        catalog,
        manifest: pluginManifest({ version: "0.4" })
      }),
      "--out",
      "listing",
      "--sha",
      SHA
    );

    expect(status).toBe(1);
    expect(stderr).toContain("not semver");
  });

  it("reports an unreadable manifest instead of writing a partial listing", () => {
    const root = writeRepository();
    writeFileSync(join(root, DIST, "plugin.json"), "{ not json");
    const { status, stderr } = run(root, "--out", "listing", "--sha", SHA);

    expect(status).toBe(1);
    expect(stderr).toContain("cannot read");
    expect(existsSync(join(root, "listing"))).toBe(false);
  });
});
