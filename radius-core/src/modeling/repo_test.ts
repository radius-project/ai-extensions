import { describe, it, expect } from "vitest";
import type { GitHub } from "../ports/index.js";
import {
  discoverSourceCodeRefs,
  fetchBicepFromRepo,
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
