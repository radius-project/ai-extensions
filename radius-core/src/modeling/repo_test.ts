import { describe, it, expect } from "vitest";
import type { GitHub } from "../ports/index.js";
import {
  discoverSourceCodeRefs,
  fetchBicepFromRepo,
  generateBicepFromRepo,
} from "./repo.js";

interface FakeConfig {
  content?: Record<string, string | null>;
  tree?: Record<string, string[]>;
}

function fakeGitHub(cfg: FakeConfig = {}): GitHub {
  return {
    async getContent(apiPath: string) {
      return cfg.content?.[apiPath] ?? null;
    },
    async listNames() {
      return [];
    },
    async treePaths(repo: string, branch: string) {
      return cfg.tree?.[`${repo}@${branch}`] ?? [];
    },
  };
}

describe("fetchBicepFromRepo", () => {
  it("prefers .radius/app.bicep when present", async () => {
    const gh = fakeGitHub({
      content: {
        "/repos/acme/app/contents/.radius/app.bicep?ref=main": "extension radius\n",
      },
    });
    expect(await fetchBicepFromRepo(gh, "acme/app")).toBe("extension radius\n");
  });

  it("falls back to root app.bicep when .radius is absent", async () => {
    const gh = fakeGitHub({
      content: {
        "/repos/acme/app/contents/app.bicep?ref=main": "root bicep",
      },
    });
    expect(await fetchBicepFromRepo(gh, "acme/app")).toBe("root bicep");
  });

  it("honors a non-default branch", async () => {
    const gh = fakeGitHub({
      content: {
        "/repos/acme/app/contents/.radius/app.bicep?ref=dev": "dev bicep",
      },
    });
    expect(await fetchBicepFromRepo(gh, "acme/app", "dev")).toBe("dev bicep");
  });

  it("returns null when no bicep file exists", async () => {
    const gh = fakeGitHub();
    expect(await fetchBicepFromRepo(gh, "acme/app")).toBeNull();
  });
});

describe("generateBicepFromRepo", () => {
  it("returns null when the repo tree is empty", async () => {
    const gh = fakeGitHub();
    expect(await generateBicepFromRepo(gh, "acme/app")).toBeNull();
  });

  it("generates a single-container app when only a Dockerfile is present", async () => {
    const gh = fakeGitHub({
      tree: { "acme/app@main": ["Dockerfile", "server.js"] },
    });
    const bicep = await generateBicepFromRepo(gh, "acme/app");
    expect(bicep).toContain("extension radius");
    expect(bicep).toContain("param environment string");
    expect(bicep).toContain("param application string");
    expect(bicep).toContain("Radius.Compute/containers@2025-08-01-preview");
    // No database detected -> no password param / database resource.
    expect(bicep).not.toContain("Radius.Data/");
    expect(bicep).not.toContain("param password string");
  });

  it("emits a database resource and connection from a compose file", async () => {
    const compose = `services:
  api:
    build: ./api
    ports:
      - "3000:3000"
    depends_on:
      - db
  db:
    image: mysql:8.0
`;
    const gh = fakeGitHub({
      tree: { "acme/shop@main": ["docker-compose.yml", "api/Dockerfile"] },
      content: { "/repos/acme/shop/contents/docker-compose.yml?ref=main": compose },
    });
    const bicep = await generateBicepFromRepo(gh, "acme/shop");
    expect(bicep).toContain("Radius.Data/mySqlDatabases@2025-08-01-preview");
    expect(bicep).toContain("@secure()\nparam password string");
    expect(bicep).toContain("version: '8.0'");
    // The api container depends on the db, so it gets a connection + env vars.
    expect(bicep).toContain("connections:");
    expect(bicep).toContain("source: database.id");
    expect(bicep).toContain("MYSQL_HOST");
  });

  it("detects infrastructure from package.json dependencies", async () => {
    const pkg = JSON.stringify({
      dependencies: { redis: "^4.0.0", mongoose: "^7.0.0" },
    });
    const gh = fakeGitHub({
      tree: { "acme/svc@main": ["package.json", "Dockerfile"] },
      content: { "/repos/acme/svc/contents/package.json?ref=main": pkg },
    });
    const bicep = await generateBicepFromRepo(gh, "acme/svc");
    expect(bicep).toContain("Radius.Data/redisCaches@2025-08-01-preview");
    expect(bicep).toContain("Radius.Data/mongoDatabases@2025-08-01-preview");
    expect(bicep).toContain("REDIS_HOST");
  });
});

describe("discoverSourceCodeRefs", () => {
  it("returns resources unchanged when the tree is empty", async () => {
    const gh = fakeGitHub();
    const resources = [{ name: "db", type: "Radius.Data/mySqlDatabases" }];
    const result = await discoverSourceCodeRefs(gh, resources, [], "acme/app", "main");
    expect(result).toBe(resources);
    expect(result[0].codeReference).toBeUndefined();
  });

  it("attaches a codeReference for a database matched by filename", async () => {
    const gh = fakeGitHub();
    const resources = [{ name: "db", type: "Radius.Data/mySqlDatabases" }];
    const tree = ["src/db.js", "src/index.js"];
    const result = await discoverSourceCodeRefs(gh, resources, tree, "acme/app", "main");
    expect(result[0].codeReference).toContain("src/db.js");
  });

  it("pinpoints the initialization line via content patterns", async () => {
    const gh = fakeGitHub({
      content: {
        "/repos/acme/app/contents/src/db.js?ref=main":
          "const x = 1;\nconst pool = mysql.createPool({});\n",
      },
    });
    const resources = [{ name: "db", type: "Radius.Data/mySqlDatabases" }];
    const tree = ["src/db.js"];
    const result = await discoverSourceCodeRefs(gh, resources, tree, "acme/app", "main");
    expect(result[0].codeReference).toBe("src/db.js#L2");
  });

  it("skips test/spec files when choosing a match", async () => {
    const gh = fakeGitHub();
    const resources = [{ name: "cache", type: "Radius.Data/redisCaches" }];
    const tree = ["src/redis.test.js", "src/redis.js"];
    const result = await discoverSourceCodeRefs(gh, resources, tree, "acme/app", "main");
    expect(result[0].codeReference).toContain("src/redis.js");
    expect(result[0].codeReference).not.toContain("test");
  });

  it("leaves resources with an existing codeReference untouched", async () => {
    const gh = fakeGitHub();
    const resources = [
      { name: "db", type: "Radius.Data/mySqlDatabases", codeReference: "existing.js" },
    ];
    const tree = ["src/db.js"];
    const result = await discoverSourceCodeRefs(gh, resources, tree, "acme/app", "main");
    expect(result[0].codeReference).toBe("existing.js");
  });

  it("does nothing for resource types that map to no category", async () => {
    const gh = fakeGitHub();
    const resources = [{ name: "gw", type: "Radius.Networking/gateways" }];
    const tree = ["src/db.js"];
    const result = await discoverSourceCodeRefs(gh, resources, tree, "acme/app", "main");
    expect(result[0].codeReference).toBeUndefined();
  });
});
