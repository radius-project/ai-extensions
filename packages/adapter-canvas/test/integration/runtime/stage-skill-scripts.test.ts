import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it
} from "vitest";
import { hashAppBicep } from "../../../src/app-bicep-hash.js";
import { beginManagedRun } from "../../../src/app-model-staging.js";

// Runs the stage skill scripts as the agent does, in a git checkout, with fake
// Bicep and rad CLIs and a fake fetch from test/support/stage-skills.

const here = path.dirname(fileURLToPath(import.meta.url));
const SKILLS = path.resolve(here, "../../../../../extensions/radius/skills");
const FAKE_TOOLS = path.resolve(
  here,
  "../../support/stage-skills/fake-tools.mjs"
);
const MODEL = path.join(SKILLS, "radius-app-model/scripts/model.mjs");
const PLAN = path.join(SKILLS, "radius-app-plan/scripts/plan.mjs");
const COMPLETE = path.join(SKILLS, "radius-app-complete/scripts/complete.mjs");
const TYPES = path.join(SKILLS, "radius-app-model/scripts/types.mjs");
const RECIPE = path.join(SKILLS, "radius-app-complete/scripts/recipe.mjs");
const EXE = process.platform === "win32" ? ".exe" : "";
const API = "2025-08-01-preview";

const RAD_COMMIT = "a".repeat(40);
const PACK_COMMIT = "b".repeat(40);
const DEFAULTS_URL = `https://raw.githubusercontent.com/radius-project/radius/${RAD_COMMIT}/deploy/manifest/defaults.yaml`;
// The Radius release pins the azure-aks Recipe pack, which has Recipes for
// images, containers, and PostgreSQL.
const RECIPE_PACK_RESPONSES = {
  [DEFAULTS_URL]: [
    "recipePacks:",
    "  - name: azure-aks",
    "    repo: github.com/radius-project/resource-types-contrib",
    `    ref: ${PACK_COMMIT}`
  ].join("\n"),
  [`https://raw.githubusercontent.com/radius-project/resource-types-contrib/${PACK_COMMIT}/recipe-packs/azure-aks/azure-aks.bicep`]:
    [
      "resource pack 'Radius.Core/recipePacks@2025-08-01-preview' = {",
      "  name: 'azure-aks'",
      "  properties: {",
      "    recipes: {",
      "      'Radius.Compute/containerImages': {",
      "        kind: 'terraform'",
      "      }",
      "      'Radius.Compute/containers': {",
      "        kind: 'terraform'",
      "      }",
      "      'Radius.Data/postgreSqlDatabases': {",
      "        kind: 'bicep'",
      "      }",
      "    }",
      "  }",
      "}"
    ].join("\n")
};

const MISSING_CREDENTIALS =
  '(9,1) : Warning BCP035: The specified "object" declaration is missing the following required properties: "password", "username".';
const CUSTOM_TYPES = [
  "namespace: Radius.Resources",
  "types:",
  "  messageQueues:",
  "    apiVersions:",
  "      '2025-08-01-preview':",
  "        schema:",
  "          type: object",
  "          properties:",
  "            queue:",
  "              type: string"
].join("\n");
const CACHE = {
  type: `Radius.Data/redisCaches@${API}`,
  properties: { name: "cache", properties: {} },
  dependsOn: ["app"]
};

let suite = "";
let work = "";
let windowsNode = "";
let fakeBicep = "";
let fakeRad = "";

beforeAll(() => {
  suite = fs.mkdtempSync(path.join(os.tmpdir(), "stage-skill-scripts-"));

  if (process.platform === "win32") {
    // Windows runs only a real .exe, so each fake CLI there is a hard link to
    // this copy of Node. A copy covers a temp directory on another volume.
    windowsNode = path.join(suite, "node.exe");
    try {
      fs.linkSync(process.execPath, windowsNode);
    } catch {
      fs.copyFileSync(process.execPath, windowsNode);
    }
  }
  fakeBicep = fakeCli(path.join(suite, "bin"), "bicep");
  fakeRad = fakeCli(path.join(suite, "bin"), "rad");
});

afterAll(() => {
  fs.rmSync(suite, { recursive: true, force: true });
});

beforeEach(() => {
  work = fs.mkdtempSync(path.join(suite, "test-"));
  fs.mkdirSync(path.join(work, "home"));
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

/** A `bicep` or `rad` that fake-tools.mjs answers for. */
function fakeCli(dir: string, name: string): string {
  const file = path.join(dir, `${name}${EXE}`);

  fs.mkdirSync(dir, { recursive: true });

  if (process.platform === "win32") fs.linkSync(windowsNode, file);
  // A Node that loads its library from beside itself runs only in place.
  else fs.symlinkSync(process.execPath, file);

  return file;
}

function git(dir: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: path.join(work, "home", ".gitconfig")
      }
    }
  );

  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);

  return result.stdout.trim();
}

/** A one-commit checkout of contoso/shop: a web server that uses PostgreSQL. */
function createApp(): { dir: string; head: string } {
  const dir = path.join(work, "shop");

  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, "server.js"),
    "const db = connect(process.env.DATABASE_URL);\nlisten(3000);\n"
  );
  fs.writeFileSync(
    path.join(dir, "Dockerfile"),
    'FROM node:24-alpine\nCOPY server.js .\nCMD ["node", "server.js"]\n'
  );
  git(dir, "init", "-q");
  git(dir, "remote", "add", "origin", "https://github.com/contoso/shop.git");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "Add the shop");

  return { dir, head: git(dir, "rev-parse", "HEAD") };
}

function blob(commit: string, file: string, line: number): string {
  return `https://github.com/contoso/shop/blob/${commit}/${file}#L${line}`;
}

/**
 * The compiled model of the shop: an application, an image that the
 * repository builds, a container that runs it, and a database. `complete`
 * adds what Stage 3 adds: build platforms, the registry secret, and the
 * database credentials.
 */
function shopTemplate(
  head: string,
  { database = "postgres", complete = false } = {}
) {
  return {
    resources: {
      app: {
        type: `Radius.Core/applications@${API}`,
        properties: { name: "shop" }
      },
      ...(complete ?
        {
          registryCreds: {
            type: `Radius.Security/secrets@${API}`,
            properties: {
              name: "radius-ghcr-registry-creds",
              properties: {
                data: {
                  username: { value: "[parameters('registryUser')]" },
                  password: { value: "[parameters('registryPassword')]" }
                }
              }
            },
            dependsOn: ["app"]
          }
        }
      : {}),
      webImage: {
        type: `Radius.Compute/containerImages@${API}`,
        properties: {
          name: "web-image",
          properties: {
            build: {
              source: `git::https://github.com/contoso/shop.git?ref=${head}`,
              ...(complete ? { platforms: ["linux/amd64"] } : {})
            },
            codeReference: blob(head, "Dockerfile", 1)
          }
        },
        dependsOn: complete ? ["app", "registryCreds"] : ["app"]
      },
      web: {
        type: `Radius.Compute/containers@${API}`,
        properties: {
          name: "web",
          properties: {
            containers: {
              web: {
                image: "[reference('webImage').imageReference]",
                ports: { http: { containerPort: 3000 } }
              }
            },
            codeReference: blob(head, "server.js", 2)
          }
        },
        dependsOn: ["app", "webImage", "db"]
      },
      db: {
        type: `Radius.Data/postgreSqlDatabases@${API}`,
        properties: {
          name: "db",
          properties: {
            database,
            ...(complete ?
              { username: "myadmin", password: "[parameters('dbPassword')]" }
            : {}),
            codeReference: blob(head, "server.js", 1)
          }
        },
        dependsOn: ["app"]
      }
    }
  };
}

type Shop = ReturnType<typeof shopTemplate>;

/** A model with `edit` applied that a check must reject with `message`. */
interface Rejected {
  problem: string;
  edit?: (template: Shop, head: string) => void;
  stderr?: string[];
  message: string;
}

/** The shop with an orders queue of the custom type Radius.Resources/messageQueues. */
function shopWithQueue(head: string) {
  const { resources } = shopTemplate(head, { database: "shop" });

  return {
    resources: {
      ...resources,
      queue: {
        type: `Radius.Resources/messageQueues@${API}`,
        properties: {
          name: "orders",
          properties: {
            queue: "orders",
            codeReference: blob(head, "server.js", 1)
          }
        },
        dependsOn: ["app"]
      }
    }
  };
}

/** The compiled custom-recipe-pack.bicep, with one Recipe for messageQueues. */
function customRecipePack(source: string) {
  return {
    resources: {
      customRecipes: {
        type: `Radius.Core/recipePacks@${API}`,
        properties: {
          name: "custom-recipes",
          properties: {
            recipes: {
              "Radius.Resources/messageQueues": { kind: "bicep", source }
            }
          }
        }
      }
    }
  };
}

/** Writes a Bicep file that the fake Bicep compiles to `template` with `stderr`. */
function writeBicep(file: string, template: object, stderr: string[] = []) {
  const text = `extension radius\n\n// fake-bicep ${JSON.stringify({ template, stderr })}\n`;

  fs.writeFileSync(file, text);

  return text;
}

/**
 * Leaves `template` in .radius/ as the published model of an earlier stage,
 * with its origin record.
 */
function publishEarlierStage(
  app: { dir: string; head: string },
  template: object,
  origin: { stage: string; provider?: string }
): string {
  fs.mkdirSync(path.join(app.dir, ".radius"), { recursive: true });
  const model = writeBicep(
    path.join(app.dir, ".radius", "app.bicep"),
    template,
    [MISSING_CREDENTIALS]
  );

  fs.writeFileSync(
    path.join(app.dir, ".radius", "app.origin.json"),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      sourceCommit: app.head,
      radiusVersion: "0.62",
      appBicepHash: hashAppBicep(model),
      ...origin
    })
  );

  return model;
}

/** Commits the checkout, which moves HEAD past the commit that the model came from. */
function commitAll(dir: string): string {
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "Add the model");

  return git(dir, "rev-parse", "HEAD");
}

/** The files in .radius/ by name, without the staging directories. */
function published(dir: string): Record<string, string> {
  const radius = path.join(dir, ".radius");

  return Object.fromEntries(
    fs
      .readdirSync(radius)
      .filter((name) => !name.startsWith(".staging-"))
      .map((name) => [name, fs.readFileSync(path.join(radius, name), "utf8")])
  );
}

function stagingDirectories(dir: string): string[] {
  return fs
    .readdirSync(path.join(dir, ".radius"))
    .filter((name) => name.startsWith(".staging-"));
}

function origin(dir: string): unknown {
  return JSON.parse(published(dir)["app.origin.json"] ?? "null");
}

/** A gzipped ustar archive of JSON files, the form of a Bicep types package. */
function typesPackage(files: Record<string, unknown>): Buffer {
  const blocks = Object.entries(files).flatMap(([name, json]) => {
    const body = Buffer.from(JSON.stringify(json));
    const header = Buffer.alloc(512);

    header.write(name, 0);
    header.write(body.length.toString(8).padStart(11, "0"), 124);
    header.write(" ".repeat(8), 148);
    header.write("0", 156);
    header.write("ustar\u000000", 257);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0`, 148);

    return [header, body, Buffer.alloc((512 - (body.length % 512)) % 512)];
  });

  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

/** Puts the radius:0.62 types package, with one type, where bicep restore caches it. */
function cacheRadiusTypes(): void {
  const cache = path.join(
    ...[work, "home", ".bicep", "br", "biceptypes.azurecr.io"],
    ...["radius", "0.62$"]
  );

  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(
    path.join(cache, "types.tgz"),
    typesPackage({
      "index.json": {
        resources: {
          [`Radius.Data/redisCaches@${API}`]: { $ref: "radius/types.json#/3" }
        }
      },
      "radius/types.json": [
        { $type: "StringType" },
        {
          $type: "ObjectType",
          name: "RedisCacheProperties",
          properties: {
            host: {
              type: { $ref: "#/0" },
              flags: 2,
              description: "(Read Only) The host name of the cache."
            }
          }
        },
        {
          $type: "ObjectType",
          name: "Radius.Data/redisCaches",
          properties: {
            name: { type: { $ref: "#/0" }, flags: 1 },
            properties: { type: { $ref: "#/1" }, flags: 1 }
          }
        },
        {
          $type: "ResourceType",
          name: `Radius.Data/redisCaches@${API}`,
          body: { $ref: "#/2" }
        }
      ]
    })
  );
}

function runScript(
  script: string,
  args: string[],
  cwd: string,
  responses: Record<string, string | number> = RECIPE_PACK_RESPONSES
) {
  const home = path.join(work, "home");
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      BICEP: fakeBicep,
      RADIUS_RAD_BINARY: fakeRad,
      NODE_OPTIONS: `--import=${pathToFileURL(FAKE_TOOLS).href}`,
      FAKE_RAD_VERSION: JSON.stringify({
        release: "0.62.0",
        commit: RAD_COMMIT
      }),
      FAKE_FETCH_RESPONSES: JSON.stringify(responses)
    }
  });
  const output = result.stdout + result.stderr;

  return {
    status: result.status,
    output,
    // The staging directory that `begin` or a failed check prints.
    run: /^Staging directory: (.+)$/mu.exec(output)?.[1] ?? ""
  };
}

describe("shared helpers", () => {
  it("ships the same shared scripts in each skill", () => {
    const read = (skill: string, file: string) =>
      fs.readFileSync(path.join(SKILLS, skill, "scripts", file), "utf8");

    expect(read("radius-app-plan", "common.mjs")).toBe(
      read("radius-app-model", "common.mjs")
    );
    expect(read("radius-app-complete", "common.mjs")).toBe(
      read("radius-app-model", "common.mjs")
    );
    expect(read("radius-app-complete", "types.mjs")).toBe(
      read("radius-app-model", "types.mjs")
    );
  });

  it("finds rad and Bicep from the environment, then the managed copy, then PATH", () => {
    const home = path.join(work, "home");
    const managed = path.join(home, ".radius", "ai-extensions", "bin");
    const common = pathToFileURL(
      path.join(SKILLS, "radius-app-model/scripts/common.mjs")
    ).href;
    const lookUp = (tools: { BICEP?: string; RADIUS_RAD_BINARY?: string }) => {
      const inherited = Object.entries(process.env).filter(
        ([key]) =>
          !["PATH", "BICEP", "RADIUS_RAD_BINARY"].includes(key.toUpperCase())
      );
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import { findBicep, findRad } from ${JSON.stringify(common)};\nconsole.log(JSON.stringify([findRad(), findBicep()]));`
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...Object.fromEntries(inherited),
            ...tools,
            HOME: home,
            USERPROFILE: home,
            // PATH has a fake bicep and rad too, so each lookup shows that it wins over PATH.
            PATH: path.dirname(fakeBicep)
          }
        }
      );

      expect(result.status, result.stderr).toBe(0);

      return JSON.parse(result.stdout) as unknown;
    };
    const managedRad = fakeCli(managed, "rad");
    const managedBicep = fakeCli(managed, "bicep");

    expect(lookUp({ BICEP: fakeBicep, RADIUS_RAD_BINARY: fakeRad })).toEqual([
      fakeRad,
      fakeBicep
    ]);
    expect(lookUp({})).toEqual([managedRad, managedBicep]);

    fs.rmSync(managed, { recursive: true });

    expect(lookUp({})).toEqual(["rad", "bicep"]);
  });
});

describe("radius-app-model model.mjs", () => {
  const c = "c".repeat(40);
  const rejected: Rejected[] = [
    {
      problem: "a compile error",
      stderr: [
        '(3,9) : Error BCP057: The name "postgres" does not exist in the current context.'
      ],
      message: 'line 3: Error BCP057: The name "postgres" does not exist'
    },
    {
      problem: "an image with no tag",
      edit: (t) => {
        t.resources.web.properties.properties.containers.web.image =
          "ghcr.io/contoso/shop";
      },
      message: "image 'ghcr.io/contoso/shop' on web has no tag or digest"
    },
    {
      problem: "a source reference to another commit",
      edit: (t) => {
        t.resources.web.properties.properties.codeReference = blob(
          c,
          "server.js",
          2
        );
      },
      message: `codeReference uses ${c}, not the checked-out commit`
    },
    {
      problem: "a source reference to a missing file",
      edit: (t, head) => {
        t.resources.web.properties.properties.codeReference = blob(
          head,
          "missing.js",
          1
        );
      },
      message: "codeReference file missing.js does not exist"
    },
    {
      problem: "a source reference past the end of a file",
      edit: (t, head) => {
        t.resources.web.properties.properties.codeReference = blob(
          head,
          "server.js",
          9
        );
      },
      message: "codeReference line 9 is past the end of server.js (2 lines)"
    },
    {
      problem: "a build source in another repository",
      edit: (t, head) => {
        t.resources.webImage.properties.properties.build.source = `git::https://github.com/contoso/other.git?ref=${head}`;
      },
      message: "build.source is not this repository at the checked-out commit"
    },
    {
      problem: "a build source at another commit",
      edit: (t) => {
        t.resources.webImage.properties.properties.build.source = `git::https://github.com/contoso/shop.git?ref=${c}`;
      },
      message: "build.source is not this repository at the checked-out commit"
    },
    {
      problem: "a missing Dockerfile",
      edit: (t) => {
        Object.assign(t.resources.webImage.properties.properties.build, {
          dockerfile: "deploy/Dockerfile"
        });
      },
      message: "deploy/Dockerfile does not exist in the repository"
    }
  ];

  it.each(rejected)(
    "rejects $problem and leaves .radius/ unchanged",
    ({ edit, stderr, message }) => {
      const app = createApp();
      publishEarlierStage(app, shopTemplate(app.head), { stage: "model" });
      const before = published(app.dir);
      const begin = runScript(MODEL, ["begin"], app.dir);
      const model = shopTemplate(app.head);
      edit?.(model, app.head);
      writeBicep(path.join(begin.run, "app.bicep"), model, stderr);

      const check = runScript(MODEL, ["check", begin.run], app.dir);

      expect(check.status, check.output).toBe(1);
      expect(check.output).toContain(message);
      expect(published(app.dir)).toEqual(before);
    }
  );

  it.each([
    { pin: "0.61", recorded: "0.62" },
    { pin: "0.63", recorded: "0.63" },
    { pin: "latest", recorded: "latest" }
  ])(
    "records radius:$recorded for a radius:$pin pin, because rad 0.62 moves only older pins",
    ({ pin, recorded }) => {
      const app = createApp();
      publishEarlierStage(app, shopTemplate(app.head), { stage: "model" });
      fs.writeFileSync(
        path.join(app.dir, ".radius", "bicepconfig.json"),
        JSON.stringify({
          extensions: { radius: `br:biceptypes.azurecr.io/radius:${pin}` }
        })
      );
      const begin = runScript(MODEL, ["begin"], app.dir);

      const check = runScript(MODEL, ["check", begin.run], app.dir);

      expect(check.status, check.output).toBe(0);
      expect(origin(app.dir)).toMatchObject({ radiusVersion: recorded });
      expect(JSON.parse(published(app.dir)["bicepconfig.json"] ?? "")).toEqual({
        extensions: { radius: `br:biceptypes.azurecr.io/radius:${recorded}` }
      });
    }
  );
});

describe("staged runs", () => {
  it("publishes a passing run into .radius/ and stages it in git", () => {
    const app = createApp();
    const begin = runScript(MODEL, ["begin"], app.dir);
    const model = writeBicep(
      path.join(begin.run, "app.bicep"),
      shopTemplate(app.head),
      [MISSING_CREDENTIALS]
    );
    // A Windows checkout can add CRLF and trailing spaces, which the canvas ignores.
    const crlf = model.replaceAll("\n", " \r\n");
    fs.writeFileSync(path.join(begin.run, "app.bicep"), crlf);

    const check = runScript(MODEL, ["check", begin.run], app.dir);

    expect(check.status, check.output).toBe(0);
    expect(published(app.dir)["app.bicep"]).toBe(crlf);
    expect(origin(app.dir)).toMatchObject({
      sourceCommit: app.head,
      radiusVersion: "0.62",
      appBicepHash: hashAppBicep(model),
      stage: "model"
    });
    expect(stagingDirectories(app.dir)).toEqual([]);
    expect(git(app.dir, "diff", "--cached", "--name-only").split("\n")).toEqual(
      [
        ".radius/.gitignore",
        ".radius/app.bicep",
        ".radius/app.origin.json",
        ".radius/bicepconfig.json"
      ]
    );
  });

  it("stages an ignored kind of file, and leaves a user's .gitignore edit unstaged", () => {
    const app = createApp();
    fs.writeFileSync(path.join(app.dir, ".gitignore"), "*.tgz\n");
    fs.mkdirSync(path.join(app.dir, ".radius"));
    fs.writeFileSync(
      path.join(app.dir, ".radius", ".gitignore"),
      ".staging-*/\n"
    );
    const head = commitAll(app.dir);
    fs.appendFileSync(path.join(app.dir, ".radius", ".gitignore"), "*.log\n");
    const begin = runScript(MODEL, ["begin"], app.dir);
    writeBicep(path.join(begin.run, "app.bicep"), shopTemplate(head));
    fs.writeFileSync(path.join(begin.run, "custom-types.yaml"), CUSTOM_TYPES);

    const check = runScript(MODEL, ["check", begin.run], app.dir);

    expect(check.status, check.output).toBe(0);
    expect(git(app.dir, "diff", "--cached", "--name-only").split("\n")).toEqual(
      [
        ".radius/app.bicep",
        ".radius/app.origin.json",
        ".radius/bicepconfig.json",
        ".radius/custom-types.tgz",
        ".radius/custom-types.yaml"
      ]
    );
    expect(git(app.dir, "diff", "--name-only")).toBe(".radius/.gitignore");
  });

  it("puts every file back when a move fails, and publishes once the cause is gone", () => {
    const app = createApp();
    publishEarlierStage(app, shopTemplate(app.head), { stage: "model" });
    writeBicep(
      path.join(app.dir, ".radius", "custom-recipe-pack.bicep"),
      customRecipePack("ghcr.io/contoso/recipes/queues:1.0.0")
    );
    const before = published(app.dir);
    const begin = runScript(MODEL, ["begin"], app.dir);
    fs.rmSync(path.join(begin.run, "custom-recipe-pack.bicep"));
    // The publish moves each replaced or deleted file aside into the run's
    // .previous/ directory. A file cannot replace a non-empty directory on
    // any platform, so this blocks the last move, after the others succeed.
    const blocker = path.join(
      begin.run,
      ".previous",
      "custom-recipe-pack.bicep"
    );
    fs.mkdirSync(blocker, { recursive: true });
    fs.writeFileSync(path.join(blocker, "file"), "");

    const failed = runScript(MODEL, ["check", begin.run], app.dir);

    expect(failed.status, failed.output).toBe(1);
    expect(failed.output).toContain("Could not publish into");
    expect(published(app.dir)).toEqual(before);
    expect(fs.existsSync(begin.run)).toBe(true);

    fs.rmSync(blocker, { recursive: true });
    const check = runScript(MODEL, ["check", begin.run], app.dir);

    expect(check.status, check.output).toBe(0);
    expect(published(app.dir)).not.toHaveProperty("custom-recipe-pack.bicep");
    expect(stagingDirectories(app.dir)).toEqual([]);
  });

  it("refuses to publish over an edit to .radius/ after begin, and deletes the run", () => {
    const app = createApp();
    const earlier = publishEarlierStage(app, shopTemplate(app.head), {
      stage: "model"
    });
    const begin = runScript(MODEL, ["begin"], app.dir);
    writeBicep(path.join(begin.run, "app.bicep"), shopTemplate(app.head));
    const edited = `${earlier}// A hand edit\n`;
    fs.writeFileSync(path.join(app.dir, ".radius", "app.bicep"), edited);

    const check = runScript(MODEL, ["check", begin.run], app.dir);

    expect(check.status, check.output).toBe(1);
    expect(check.output).toContain(
      ".radius/app.bicep changed while this run was working"
    );
    expect(published(app.dir)["app.bicep"]).toBe(edited);
    expect(stagingDirectories(app.dir)).toEqual([]);
  });

  it("deletes the run on abort and leaves .radius/ unchanged", () => {
    const app = createApp();
    publishEarlierStage(app, shopTemplate(app.head), { stage: "model" });
    const before = published(app.dir);
    const begin = runScript(MODEL, ["begin"], app.dir);
    writeBicep(path.join(begin.run, "app.bicep"), shopTemplate(app.head));

    const abort = runScript(MODEL, ["abort", begin.run], app.dir);

    expect(abort.status, abort.output).toBe(0);
    expect(stagingDirectories(app.dir)).toEqual([]);
    expect(published(app.dir)).toEqual(before);
  });

  it("checks a run that the canvas started without publishing it, so the canvas publishes the checked copy", async () => {
    const app = createApp();
    const radius = path.join(app.dir, ".radius");
    publishEarlierStage(app, shopWithQueue(app.head), { stage: "model" });
    fs.writeFileSync(path.join(radius, "custom-types.yaml"), CUSTOM_TYPES);
    fs.writeFileSync(path.join(radius, "custom-types.tgz"), "extension");
    fs.writeFileSync(
      path.join(radius, "bicepconfig.json"),
      JSON.stringify({
        extensions: {
          radius: "br:biceptypes.azurecr.io/radius:0.62",
          customTypes: "./custom-types.tgz"
        }
      })
    );
    const head = commitAll(app.dir);
    const before = published(app.dir);
    const run = beginManagedRun(app.dir);
    fs.rmSync(path.join(run.stagingDir, "custom-types.yaml"));
    const model = writeBicep(
      path.join(run.stagingDir, "app.bicep"),
      shopTemplate(head, { database: "shop" })
    );

    // The name decides, so an agent's edit to run.json cannot make it publish.
    const record = path.join(run.stagingDir, "run.json");
    fs.writeFileSync(
      record,
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(record, "utf8")),
        publish: true
      })
    );
    const agent = runScript(MODEL, ["check", run.stagingDir], app.dir);

    expect(agent.status, agent.output).toBe(0);
    expect(agent.output).toContain(
      "the tool that started the run publishes it"
    );
    expect(agent.output).not.toContain("is published in .radius/");
    expect(published(app.dir)).toEqual(before);

    await run.validate(async (dir) => {
      const check = runScript(MODEL, ["check", dir], app.dir);
      if (check.status !== 0) throw new Error(check.output);
    });
    await expect(
      run.promote(
        async () => {},
        () => {}
      )
    ).resolves.toMatchObject({ gitError: "" });

    expect(Object.keys(published(app.dir)).sort()).toEqual([
      ".gitignore",
      "app.bicep",
      "app.origin.json",
      "bicepconfig.json"
    ]);
    expect(origin(app.dir)).toMatchObject({
      sourceCommit: head,
      appBicepHash: hashAppBicep(model),
      stage: "model"
    });
    expect(stagingDirectories(app.dir)).toEqual([]);
    expect(
      git(app.dir, "diff", "--cached", "--name-status").split("\n")
    ).toEqual([
      "A\t.radius/.gitignore",
      "M\t.radius/app.bicep",
      "M\t.radius/app.origin.json",
      "M\t.radius/bicepconfig.json",
      "D\t.radius/custom-types.tgz",
      "D\t.radius/custom-types.yaml"
    ]);
  });

  it("refuses to check a path that is not a staging directory", () => {
    const app = createApp();
    publishEarlierStage(app, shopTemplate(app.head), { stage: "model" });
    const before = published(app.dir);

    const check = runScript(
      MODEL,
      ["check", path.join(".radius", "app.bicep")],
      app.dir
    );

    expect(check.status, check.output).toBe(1);
    expect(check.output).toContain("Usage: node model.mjs begin");
    expect(published(app.dir)).toEqual(before);
  });
});

describe("custom types", () => {
  it("builds custom-types.yaml into a local extension, and fails the check when it does not build", () => {
    const app = createApp();
    const begin = runScript(MODEL, ["begin"], app.dir);
    const schema = path.join(begin.run, "custom-types.yaml");
    writeBicep(path.join(begin.run, "app.bicep"), shopWithQueue(app.head));
    fs.writeFileSync(
      schema,
      `${CUSTOM_TYPES}\n# fake-rad-error: messageQueues has no description.\n`
    );

    const failed = runScript(MODEL, ["check", begin.run], app.dir);

    expect(failed.status, failed.output).toBe(1);
    expect(failed.output).toContain(
      "custom-types.yaml does not compile into a Bicep extension: messageQueues has no description."
    );
    expect(published(app.dir)).toEqual({});

    fs.writeFileSync(schema, CUSTOM_TYPES);
    const check = runScript(MODEL, ["check", begin.run], app.dir);

    expect(check.status, check.output).toBe(0);
    const files = published(app.dir);
    expect(files["custom-types.yaml"]).toBe(CUSTOM_TYPES);
    // The fake rad writes the call that built the extension as the extension.
    expect(JSON.parse(files["custom-types.tgz"] ?? "")).toEqual([
      "bicep",
      "publish-extension",
      "--from-file",
      schema,
      "--target",
      path.join(begin.run, "custom-types.tgz"),
      "--force"
    ]);
    expect(JSON.parse(files["bicepconfig.json"] ?? "")).toMatchObject({
      extensions: { customTypes: "./custom-types.tgz" }
    });
  });

  it("removes the local extension when a run deletes custom-types.yaml", () => {
    const app = createApp();
    const radius = path.join(app.dir, ".radius");
    const extensions = { radius: "br:biceptypes.azurecr.io/radius:0.62" };
    publishEarlierStage(app, shopWithQueue(app.head), { stage: "model" });
    fs.writeFileSync(path.join(radius, "custom-types.yaml"), CUSTOM_TYPES);
    fs.writeFileSync(path.join(radius, "custom-types.tgz"), "extension");
    fs.writeFileSync(
      path.join(radius, "bicepconfig.json"),
      JSON.stringify({
        extensions: { ...extensions, customTypes: "./custom-types.tgz" }
      })
    );
    const begin = runScript(MODEL, ["begin"], app.dir);
    fs.rmSync(path.join(begin.run, "custom-types.yaml"));
    writeBicep(
      path.join(begin.run, "app.bicep"),
      shopTemplate(app.head, { database: "shop" })
    );

    const check = runScript(MODEL, ["check", begin.run], app.dir);

    expect(check.status, check.output).toBe(0);
    const files = published(app.dir);
    expect(Object.keys(files).sort()).toEqual([
      ".gitignore",
      "app.bicep",
      "app.origin.json",
      "bicepconfig.json"
    ]);
    expect(JSON.parse(files["bicepconfig.json"] ?? "")).toEqual({
      extensions
    });
  });
});

describe("radius-app-plan plan.mjs", () => {
  it("rejects a value that Azure limits, then publishes the plan once the value changes", () => {
    const app = createApp();
    publishEarlierStage(app, shopTemplate(app.head), { stage: "model" });
    commitAll(app.dir);

    const begin = runScript(PLAN, ["begin", "--provider", "azure"], app.dir);

    expect(begin.status, begin.output).toBe(1);
    expect(begin.output).toContain(
      "Radius.Data/postgreSqlDatabases db: Recipe found; database 'postgres' BREAKS THE RULE"
    );
    expect(origin(app.dir)).toMatchObject({ stage: "model" });

    const planned = writeBicep(
      path.join(begin.run, "app.bicep"),
      shopTemplate(app.head, { database: "shop" }),
      [MISSING_CREDENTIALS]
    );
    const check = runScript(
      PLAN,
      ["check", "--provider", "azure", begin.run],
      app.dir
    );

    expect(check.status, check.output).toBe(0);
    expect(origin(app.dir)).toMatchObject({
      sourceCommit: app.head,
      appBicepHash: hashAppBicep(planned),
      stage: "plan",
      provider: "azure"
    });
  });

  const rejected: Rejected[] = [
    {
      problem: "an added resource",
      edit: (t) => Object.assign(t.resources, { cache: CACHE }),
      message: "cache was added. Fix: remove it. Stage 2 adds no resources."
    },
    {
      problem: "a removed resource",
      edit: (t) => Reflect.deleteProperty(t.resources, "db"),
      message: "db was removed. Fix: restore it."
    },
    {
      problem: "a change beyond the value that Azure limits",
      edit: (t) => {
        t.resources.web.properties.properties.containers.web.ports.http.containerPort = 8080;
      },
      message: "web changed in more than the value that azure limits"
    }
  ];

  it.each(rejected)(
    "check rejects $problem and leaves .radius/ unchanged",
    ({ edit, message }) => {
      const app = createApp();
      publishEarlierStage(app, shopTemplate(app.head), { stage: "model" });
      const before = published(app.dir);
      const begin = runScript(PLAN, ["begin", "--provider", "azure"], app.dir);
      const planned = shopTemplate(app.head, { database: "shop" });
      edit?.(planned, app.head);
      writeBicep(path.join(begin.run, "app.bicep"), planned, [
        MISSING_CREDENTIALS
      ]);

      const check = runScript(
        PLAN,
        ["check", "--provider", "azure", begin.run],
        app.dir
      );

      expect(check.status, check.output).toBe(1);
      expect(check.output).toContain(message);
      expect(published(app.dir)).toEqual(before);
    }
  );

  it("fails when it cannot read the Recipe pack", () => {
    const app = createApp();
    publishEarlierStage(app, shopTemplate(app.head, { database: "shop" }), {
      stage: "model"
    });
    const before = published(app.dir);

    const begin = runScript(PLAN, ["begin", "--provider", "azure"], app.dir, {
      [DEFAULTS_URL]: 404
    });

    expect(begin.status, begin.output).toBe(1);
    expect(begin.output).toContain(
      `Could not read the azure-aks Recipe pack, so Recipes were not checked: ${DEFAULTS_URL} returned HTTP 404`
    );
    expect(published(app.dir)).toEqual(before);
  });

  it("requires a Recipe with a fixed version for each custom type", () => {
    const app = createApp();
    publishEarlierStage(app, shopWithQueue(app.head), { stage: "model" });
    const avm = "mcr.microsoft.com/bicep/avm/res/service-bus/namespace";

    const begin = runScript(PLAN, ["begin", "--provider", "azure"], app.dir);

    expect(begin.status, begin.output).toBe(1);
    expect(begin.output).toContain(
      "the custom type Radius.Resources/messageQueues has no Recipe"
    );

    const pack = path.join(begin.run, "custom-recipe-pack.bicep");
    writeBicep(pack, customRecipePack(`${avm}:latest`));
    const latest = runScript(
      PLAN,
      ["check", "--provider", "azure", begin.run],
      app.dir
    );

    expect(latest.status, latest.output).toBe(1);
    expect(latest.output).toContain(
      `the custom Recipe source '${avm}:latest' names no fixed version`
    );

    const pinned = writeBicep(pack, customRecipePack(`${avm}:0.16.2`));
    const check = runScript(
      PLAN,
      ["check", "--provider", "azure", begin.run],
      app.dir
    );

    expect(check.status, check.output).toBe(0);
    expect(published(app.dir)["custom-recipe-pack.bicep"]).toBe(pinned);
  });
});

describe("radius-app-complete complete.mjs", () => {
  it("rejects the planned model's warning, then publishes the complete stage with the planned provider", () => {
    const app = createApp();
    publishEarlierStage(app, shopTemplate(app.head, { database: "shop" }), {
      stage: "plan",
      provider: "azure"
    });
    commitAll(app.dir);

    const begin = runScript(COMPLETE, ["begin"], app.dir);

    expect(begin.status, begin.output).toBe(1);
    expect(begin.output).toContain("Warning BCP035");

    const completed = writeBicep(
      path.join(begin.run, "app.bicep"),
      shopTemplate(app.head, { database: "shop", complete: true })
    );
    const check = runScript(COMPLETE, ["check", begin.run], app.dir);

    expect(check.status, check.output).toBe(0);
    expect(origin(app.dir)).toMatchObject({
      sourceCommit: app.head,
      appBicepHash: hashAppBicep(completed),
      stage: "complete",
      provider: "azure"
    });
  });

  const rejected: Rejected[] = [
    {
      problem: "a warning",
      stderr: [
        '(1,7) : Warning no-unused-params: Parameter "adminEmail" is declared but never used.'
      ],
      message: "line 1: Warning no-unused-params"
    },
    {
      problem: "an added resource",
      edit: (t) => Object.assign(t.resources, { cache: CACHE }),
      message: "cache (Radius.Data/redisCaches) was added"
    },
    {
      problem: "a removed resource",
      edit: (t) => Reflect.deleteProperty(t.resources, "db"),
      message: "db was removed"
    },
    {
      problem: "a changed value",
      edit: (t) => {
        t.resources.db.properties.properties.database = "orders";
      },
      message: 'db: properties.database changed from "shop" to "orders"'
    },
    {
      problem: "an added port",
      edit: (t) =>
        Object.assign(
          t.resources.web.properties.properties.containers.web.ports,
          { metrics: { containerPort: 9090 } }
        ),
      message:
        "web: properties.containers.web.ports.metrics.containerPort was added as 9090"
    },
    {
      problem: "a new connection",
      edit: (t) => t.resources.webImage.dependsOn.push("db"),
      message: "New connection web-image -> db"
    },
    {
      problem: "a removed connection",
      edit: (t) => {
        t.resources.web.dependsOn = ["app", "webImage"];
      },
      message: "Connection web -> db is gone"
    },
    {
      problem: "an image with no build platforms",
      edit: (t) =>
        Reflect.deleteProperty(
          t.resources.webImage.properties.properties.build,
          "platforms"
        ),
      message: "webImage: build.platforms is missing"
    },
    {
      problem: "an image build with no registry secret",
      edit: (t) => Reflect.deleteProperty(t.resources, "registryCreds"),
      message:
        "has no Radius.Security/secrets resource named 'radius-ghcr-registry-creds'"
    },
    {
      problem: "an image that does not depend on the registry secret",
      edit: (t) => {
        t.resources.webImage.dependsOn = ["app"];
      },
      message:
        "webImage: does not depend on the radius-ghcr-registry-creds secret"
    },
    {
      problem: "a username that Azure forbids",
      edit: (t) => {
        t.resources.db.properties.properties.username = "admin";
      },
      message: "db: username 'admin' breaks the Azure rule"
    }
  ];

  it.each(rejected)(
    "check rejects $problem and leaves .radius/ unchanged",
    ({ edit, stderr, message }) => {
      const app = createApp();
      publishEarlierStage(app, shopTemplate(app.head, { database: "shop" }), {
        stage: "plan",
        provider: "azure"
      });
      const before = published(app.dir);
      const begin = runScript(COMPLETE, ["begin"], app.dir);
      const completed = shopTemplate(app.head, {
        database: "shop",
        complete: true
      });
      edit?.(completed, app.head);
      writeBicep(path.join(begin.run, "app.bicep"), completed, stderr);

      const check = runScript(COMPLETE, ["check", begin.run], app.dir);

      expect(check.status, check.output).toBe(1);
      expect(check.output).toContain(message);
      expect(published(app.dir)).toEqual(before);
    }
  );
});

describe("types.mjs and recipe.mjs", () => {
  it.each([
    {
      name: "types.mjs prints the card of a type",
      script: TYPES,
      args: ["Radius.Data/redisCaches"],
      status: 0,
      message: "host: string (read-only) - The host name of the cache."
    },
    {
      name: "types.mjs rejects a type that the extension does not have",
      script: TYPES,
      args: ["Radius.Data/mongoDatabases"],
      status: 1,
      message: "Radius.Data/mongoDatabases: not a type in this extension."
    },
    {
      name: "recipe.mjs prints the Recipe that the provider's pack has for a type",
      script: RECIPE,
      args: ["--provider", "azure", "Radius.Data/postgreSqlDatabases"],
      status: 0,
      message:
        "'Radius.Data/postgreSqlDatabases': {\n        kind: 'bicep'\n      }"
    },
    {
      name: "recipe.mjs reports a type that the provider's pack has no Recipe for",
      script: RECIPE,
      args: ["--provider", "azure", "Radius.Data/redisCaches"],
      status: 1,
      message:
        "Radius.Data/redisCaches: the azure-aks pack has no Recipe for this type."
    }
  ])("$name", ({ script, args, status, message }) => {
    const app = createApp();
    cacheRadiusTypes();

    const result = runScript(script, args, app.dir);

    expect(result.status, result.output).toBe(status);
    expect(result.output).toContain(message);
  });

  it("types.mjs writes nothing into .radius/, so a run that uses it still publishes", () => {
    const app = createApp();
    cacheRadiusTypes();
    const begin = runScript(MODEL, ["begin"], app.dir);

    const types = runScript(TYPES, [], app.dir);

    expect(types.status, types.output).toBe(0);
    expect(types.output).toContain(`Radius.Data/redisCaches@${API}`);
    expect(published(app.dir)).toEqual({});

    writeBicep(path.join(begin.run, "app.bicep"), shopTemplate(app.head));
    const check = runScript(MODEL, ["check", begin.run], app.dir);

    expect(check.status, check.output).toBe(0);
  });
});
