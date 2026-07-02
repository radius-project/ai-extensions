import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  discoverSourceCodeRefs,
  fetchBicepFromRepo,
  generateBicepFromRepo,
} from "./repo.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGh(overrides: Partial<{ getContent: any; treePaths: any }> = {}) {
  return {
    getContent: overrides.getContent ?? vi.fn().mockResolvedValue(null),
    listNames: vi.fn().mockResolvedValue([]),
    treePaths: overrides.treePaths ?? vi.fn().mockResolvedValue([]),
  };
}

// ---------------------------------------------------------------------------
// discoverSourceCodeRefs
// ---------------------------------------------------------------------------

describe("discoverSourceCodeRefs", () => {
  it("returns resources unchanged when tree is empty", async () => {
    const gh = makeGh();
    const resources = [{ name: "api", type: "Radius.Compute/containers" }];
    const result = await discoverSourceCodeRefs(gh, resources, [], "owner/repo", "main");
    expect(result).toEqual(resources);
  });

  it("returns resources unchanged when tree is null/undefined", async () => {
    const gh = makeGh();
    const resources = [{ name: "api", type: "Radius.Compute/containers" }];
    const result = await discoverSourceCodeRefs(gh, resources, null, "owner/repo", "main");
    expect(result).toEqual(resources);
  });

  it("skips resources that already have a codeReference", async () => {
    const gh = makeGh();
    const resources = [
      { name: "db", type: "Radius.Data/mySqlDatabases", codeReference: "existing/ref.ts" },
    ];
    const tree = ["src/db.ts"];
    const result = await discoverSourceCodeRefs(gh, resources, tree, "owner/repo", "main");
    expect(result[0].codeReference).toBe("existing/ref.ts");
  });

  it("assigns codeReference for a mysql resource matching a file pattern", async () => {
    const gh = makeGh({
      getContent: vi.fn().mockResolvedValue("import mysql from 'mysql2';\nconst pool = createPool({});"),
    });
    const resources = [{ name: "db", type: "Radius.Data/mySqlDatabases" }];
    const tree = ["src/database.ts", "src/index.ts"];
    const result = await discoverSourceCodeRefs(gh, resources, tree, "owner/repo", "main");
    expect(result[0].codeReference).toContain("src/database.ts");
  });

  it("assigns codeReference for a redis resource", async () => {
    const gh = makeGh({
      getContent: vi.fn().mockResolvedValue(null),
    });
    const resources = [{ name: "cache", type: "Radius.Data/redisCaches" }];
    const tree = ["src/redis.ts"];
    const result = await discoverSourceCodeRefs(gh, resources, tree, "owner/repo", "main");
    expect(result[0].codeReference).toContain("src/redis.ts");
  });

  it("assigns codeReference for a container matching a Dockerfile", async () => {
    const gh = makeGh({
      getContent: vi.fn().mockResolvedValue(null),
    });
    const resources = [{ name: "api", type: "Radius.Compute/containers" }];
    const tree = ["api/Dockerfile", "src/index.ts"];
    const result = await discoverSourceCodeRefs(gh, resources, tree, "owner/repo", "main");
    expect(result[0].codeReference).toBeDefined();
  });

  it("prefers Dockerfile matching the container service name", async () => {
    const gh = makeGh({
      getContent: vi.fn().mockResolvedValue(null),
    });
    const resources = [{ name: "frontend", type: "Radius.Compute/containers" }];
    const tree = ["backend/Dockerfile", "frontend/Dockerfile"];
    const result = await discoverSourceCodeRefs(gh, resources, tree, "owner/repo", "main");
    expect(result[0].codeReference).toBe("frontend/Dockerfile");
  });

  it("falls back to content-based search when no filename matches", async () => {
    const gh = makeGh({
      getContent: vi.fn().mockImplementation((path: string) => {
        if (path.includes("utils.ts")) return Promise.resolve("const client = new Redis();\nclient.connect();");
        return Promise.resolve(null);
      }),
    });
    const resources = [{ name: "cache", type: "Radius.Data/redisCaches" }];
    const tree = ["src/utils.ts", "src/app.ts"];
    const result = await discoverSourceCodeRefs(gh, resources, tree, "owner/repo", "main");
    // Should find via content pattern
    expect(result[0].codeReference).toContain("src/utils.ts");
    expect(result[0].codeReference).toContain("#L");
  });

  it("does not assign codeReference for unknown resource types", async () => {
    const gh = makeGh();
    const resources = [{ name: "svc", type: "UnknownProvider/unknownType" }];
    const tree = ["src/app.ts"];
    const result = await discoverSourceCodeRefs(gh, resources, tree, "owner/repo", "main");
    expect(result[0].codeReference).toBeUndefined();
  });

  it("skips test files and node_modules paths", async () => {
    const gh = makeGh({
      getContent: vi.fn().mockResolvedValue("createPool({})"),
    });
    const resources = [{ name: "db", type: "Radius.Data/mySqlDatabases" }];
    const tree = ["node_modules/mysql2/index.js", "src/db.spec.ts", "src/database.ts"];
    const result = await discoverSourceCodeRefs(gh, resources, tree, "owner/repo", "main");
    expect(result[0].codeReference).toContain("src/database.ts");
    expect(result[0].codeReference).not.toContain("node_modules");
    expect(result[0].codeReference).not.toContain("spec");
  });

  it("respects fetch budget and does not make unlimited API calls", async () => {
    const getContent = vi.fn().mockResolvedValue(null);
    const gh = makeGh({ getContent });
    const resources = [{ name: "cache", type: "Radius.Data/redisCaches" }];
    // Large tree with many source files
    const tree = Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`);
    await discoverSourceCodeRefs(gh, resources, tree, "owner/repo", "main");
    // Budget is 25 so at most 25 fetches
    expect(getContent.mock.calls.length).toBeLessThanOrEqual(25);
  });
});

// ---------------------------------------------------------------------------
// fetchBicepFromRepo
// ---------------------------------------------------------------------------

describe("fetchBicepFromRepo", () => {
  it("returns .radius/app.bicep content if it exists", async () => {
    const gh = makeGh({
      getContent: vi.fn().mockImplementation((path: string) => {
        if (path.includes(".radius/app.bicep")) return Promise.resolve("extension radius\n");
        return Promise.resolve(null);
      }),
    });
    const result = await fetchBicepFromRepo(gh, "owner/repo", "main");
    expect(result).toBe("extension radius\n");
  });

  it("falls back to root app.bicep when .radius/app.bicep is absent", async () => {
    const gh = makeGh({
      getContent: vi.fn().mockImplementation((path: string) => {
        if (path.includes(".radius/app.bicep")) return Promise.resolve(null);
        if (path.includes("app.bicep")) return Promise.resolve("extension radius\nparam env string\n");
        return Promise.resolve(null);
      }),
    });
    const result = await fetchBicepFromRepo(gh, "owner/repo", "main");
    expect(result).toBe("extension radius\nparam env string\n");
  });

  it("returns null when no bicep file exists", async () => {
    const gh = makeGh({
      getContent: vi.fn().mockResolvedValue(null),
    });
    const result = await fetchBicepFromRepo(gh, "owner/repo", "main");
    expect(result).toBeNull();
  });

  it("uses 'main' as default branch when not specified", async () => {
    const getContent = vi.fn().mockResolvedValue(null);
    const gh = makeGh({ getContent });
    await fetchBicepFromRepo(gh, "owner/repo");
    expect(getContent).toHaveBeenCalledWith(
      expect.stringContaining("ref=main"),
    );
  });

  it("uses a custom branch when specified", async () => {
    const getContent = vi.fn().mockResolvedValue(null);
    const gh = makeGh({ getContent });
    await fetchBicepFromRepo(gh, "owner/repo", "develop");
    expect(getContent).toHaveBeenCalledWith(
      expect.stringContaining("ref=develop"),
    );
  });
});

// ---------------------------------------------------------------------------
// generateBicepFromRepo
// ---------------------------------------------------------------------------

describe("generateBicepFromRepo", () => {
  it("returns null when repo tree is empty", async () => {
    const gh = makeGh({ treePaths: vi.fn().mockResolvedValue([]) });
    const result = await generateBicepFromRepo(gh, "owner/repo", "main");
    expect(result).toBeNull();
  });

  it("returns null when treePaths returns null", async () => {
    const gh = makeGh({ treePaths: vi.fn().mockResolvedValue(null) });
    const result = await generateBicepFromRepo(gh, "owner/repo", "main");
    expect(result).toBeNull();
  });

  it("generates bicep with a container resource for a simple Dockerfile repo", async () => {
    const gh = makeGh({
      treePaths: vi.fn().mockResolvedValue(["Dockerfile", "src/index.ts", "package.json"]),
      getContent: vi.fn().mockResolvedValue(null),
    });
    const result = await generateBicepFromRepo(gh, "owner/my-app", "main");
    expect(result).toContain("extension radius");
    expect(result).toContain("Radius.Compute/containers");
    expect(result).toContain("param environment string");
    expect(result).toContain("param application string");
    expect(result).toContain("param image string");
  });

  it("generates a MySQL database resource from a compose file", async () => {
    const composeYaml = `services:
  app:
    build: .
    ports:
      - "3000:3000"
    depends_on:
      - db
  db:
    image: mysql:8.0
    environment:
      MYSQL_DATABASE: mydb
`;
    const gh = makeGh({
      treePaths: vi.fn().mockResolvedValue(["docker-compose.yml", "Dockerfile", "src/app.ts"]),
      getContent: vi.fn().mockImplementation((path: string) => {
        if (path.includes("docker-compose.yml")) return Promise.resolve(composeYaml);
        return Promise.resolve(null);
      }),
    });
    const result = await generateBicepFromRepo(gh, "owner/my-app", "main");
    expect(result).toContain("Radius.Data/mySqlDatabases");
    expect(result).toContain("Radius.Security/secrets");
    expect(result).toContain("@secure()");
    expect(result).toContain("param password string");
  });

  it("generates a Redis resource from a compose file", async () => {
    const composeYaml = `services:
  api:
    build: .
    ports:
      - "8080:8080"
  redis:
    image: redis:7
`;
    const gh = makeGh({
      treePaths: vi.fn().mockResolvedValue(["docker-compose.yml", "Dockerfile"]),
      getContent: vi.fn().mockImplementation((path: string) => {
        if (path.includes("docker-compose.yml")) return Promise.resolve(composeYaml);
        return Promise.resolve(null);
      }),
    });
    const result = await generateBicepFromRepo(gh, "owner/my-app", "main");
    expect(result).toContain("Radius.Data/redisCaches");
  });

  it("generates a RabbitMQ resource from a compose file", async () => {
    const composeYaml = `services:
  worker:
    build: .
  rabbitmq:
    image: rabbitmq:3-management
`;
    const gh = makeGh({
      treePaths: vi.fn().mockResolvedValue(["docker-compose.yml", "Dockerfile"]),
      getContent: vi.fn().mockImplementation((path: string) => {
        if (path.includes("docker-compose.yml")) return Promise.resolve(composeYaml);
        return Promise.resolve(null);
      }),
    });
    const result = await generateBicepFromRepo(gh, "owner/my-app", "main");
    expect(result).toContain("Radius.Messaging/rabbitMQQueues");
  });

  it("generates a MongoDB resource from a compose file", async () => {
    const composeYaml = `services:
  api:
    build: .
  mongo:
    image: mongo:6
`;
    const gh = makeGh({
      treePaths: vi.fn().mockResolvedValue(["docker-compose.yml", "Dockerfile"]),
      getContent: vi.fn().mockImplementation((path: string) => {
        if (path.includes("docker-compose.yml")) return Promise.resolve(composeYaml);
        return Promise.resolve(null);
      }),
    });
    const result = await generateBicepFromRepo(gh, "owner/my-app", "main");
    expect(result).toContain("Radius.Data/mongoDatabases");
  });

  it("detects redis from package.json dependencies when no compose file", async () => {
    const pkgJson = JSON.stringify({
      name: "my-app",
      dependencies: { express: "^4.18.0", ioredis: "^5.0.0" },
    });
    const gh = makeGh({
      treePaths: vi.fn().mockResolvedValue(["package.json", "Dockerfile", "src/index.ts"]),
      getContent: vi.fn().mockImplementation((path: string) => {
        if (path.includes("package.json")) return Promise.resolve(pkgJson);
        return Promise.resolve(null);
      }),
    });
    const result = await generateBicepFromRepo(gh, "owner/my-app", "main");
    expect(result).toContain("Radius.Data/redisCaches");
  });

  it("detects postgres from package.json dependencies", async () => {
    const pkgJson = JSON.stringify({
      name: "my-app",
      dependencies: { pg: "^8.0.0" },
    });
    const gh = makeGh({
      treePaths: vi.fn().mockResolvedValue(["package.json", "Dockerfile", "src/index.ts"]),
      getContent: vi.fn().mockImplementation((path: string) => {
        if (path.includes("package.json")) return Promise.resolve(pkgJson);
        return Promise.resolve(null);
      }),
    });
    const result = await generateBicepFromRepo(gh, "owner/my-app", "main");
    expect(result).toContain("Radius.Data/postgreSqlDatabases");
  });

  it("creates a single-service app when no compose or dockerfiles found", async () => {
    const gh = makeGh({
      treePaths: vi.fn().mockResolvedValue(["src/index.ts", "package.json"]),
      getContent: vi.fn().mockResolvedValue(null),
    });
    const result = await generateBicepFromRepo(gh, "owner/my-app", "main");
    expect(result).toContain("Radius.Compute/containers");
    expect(result).toContain("my-app");
  });

  it("generates multiple container resources from multiple Dockerfiles", async () => {
    const gh = makeGh({
      treePaths: vi.fn().mockResolvedValue(["frontend/Dockerfile", "backend/Dockerfile", "src/app.ts"]),
      getContent: vi.fn().mockResolvedValue(null),
    });
    const result = await generateBicepFromRepo(gh, "owner/my-app", "main");
    expect(result).toContain("Radius.Compute/containers");
    // Should have at least two container resources
    const containerMatches = result!.match(/Radius\.Compute\/containers/g);
    expect(containerMatches!.length).toBeGreaterThanOrEqual(2);
  });

  it("uses 'main' as default branch", async () => {
    const treePaths = vi.fn().mockResolvedValue(["Dockerfile"]);
    const gh = makeGh({ treePaths, getContent: vi.fn().mockResolvedValue(null) });
    await generateBicepFromRepo(gh, "owner/repo");
    expect(treePaths).toHaveBeenCalledWith("owner/repo", "main");
  });

  it("passes a custom branch to treePaths", async () => {
    const treePaths = vi.fn().mockResolvedValue(["Dockerfile"]);
    const gh = makeGh({ treePaths, getContent: vi.fn().mockResolvedValue(null) });
    await generateBicepFromRepo(gh, "owner/repo", "feature-branch");
    expect(treePaths).toHaveBeenCalledWith("owner/repo", "feature-branch");
  });
});
