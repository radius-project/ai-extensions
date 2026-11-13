import { describe, it, expect } from "vitest";
import type { GitHub } from "../ports/index.js";
import { fetchBicepFromRepo, fetchBicepSelectionFromRepo } from "./repo.js";

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
  it.each([".radius/app.bicep", "app.bicep"])(
    "retains the selected path %s on a non-default branch",
    async (bicepPath) => {
      const gh = fakeGitHub({
        content: {
          [`/repos/acme/app/contents/${bicepPath}?ref=feature`]: "model"
        }
      });
      expect(
        await fetchBicepSelectionFromRepo(gh, "acme/app", "feature")
      ).toEqual({
        bicepPath,
        content: "model"
      });
    }
  );
  it("preserves managed-model precedence even when root content is identical", async () => {
    const gh = fakeGitHub({
      content: {
        "/repos/acme/app/contents/.radius/app.bicep?ref=main": "model",
        "/repos/acme/app/contents/app.bicep?ref=main": "model"
      }
    });
    expect(await fetchBicepSelectionFromRepo(gh, "acme/app")).toEqual({
      bicepPath: ".radius/app.bicep",
      content: "model"
    });
  });
  it("propagates unavailable source instead of claiming no model", async () => {
    const gh = fakeGitHub();
    gh.getContent = async () => {
      throw new Error("unavailable");
    };
    await expect(fetchBicepSelectionFromRepo(gh, "acme/app")).rejects.toThrow(
      "unavailable"
    );
  });
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
