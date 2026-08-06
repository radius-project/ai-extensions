import { describe, it, expect } from "vitest";
import type { GitHub } from "../ports/index.js";
import { fetchBicepFromRepo } from "./repo.js";

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
    }
  };
}

describe("fetchBicepFromRepo", () => {
  it("prefers .radius/app.bicep when present", async () => {
    const gh = fakeGitHub({
      content: {
        "/repos/acme/app/contents/.radius/app.bicep?ref=main":
          "extension radius\n"
      }
    });
    expect(await fetchBicepFromRepo(gh, "acme/app")).toBe("extension radius\n");
  });

  it("falls back to root app.bicep when .radius is absent", async () => {
    const gh = fakeGitHub({
      content: {
        "/repos/acme/app/contents/app.bicep?ref=main": "root bicep"
      }
    });
    expect(await fetchBicepFromRepo(gh, "acme/app")).toBe("root bicep");
  });

  it("honors a non-default branch", async () => {
    const gh = fakeGitHub({
      content: {
        "/repos/acme/app/contents/.radius/app.bicep?ref=dev": "dev bicep"
      }
    });
    expect(await fetchBicepFromRepo(gh, "acme/app", "dev")).toBe("dev bicep");
  });

  it("returns null when no bicep file exists", async () => {
    const gh = fakeGitHub();
    expect(await fetchBicepFromRepo(gh, "acme/app")).toBeNull();
  });
});
