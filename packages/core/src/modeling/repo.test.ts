import { describe, it, expect, vi } from "vitest";
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

  it("preserves an empty standard model instead of falling back to the root", async () => {
    const gh = fakeGitHub();
    gh.getContent = vi.fn().mockResolvedValue("");
    expect(await fetchBicepFromRepo(gh, "acme/app")).toBe("");
    expect(gh.getContent).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])(
    "propagates a source access failure at lookup %i",
    async (lookup) => {
      const gh = fakeGitHub();
      const error = new Error("Repository access denied");
      const getContent = vi.fn<GitHub["getContent"]>();
      if (lookup === 1) getContent.mockResolvedValueOnce(null);
      getContent.mockRejectedValue(error);
      gh.getContent = getContent;

      await expect(fetchBicepFromRepo(gh, "acme/app")).rejects.toBe(error);
      expect(getContent).toHaveBeenCalledTimes(lookup + 1);
    }
  );

  it("encodes branch names in both source lookups", async () => {
    const gh = fakeGitHub();
    gh.getContent = vi.fn().mockResolvedValue(null);
    await fetchBicepFromRepo(gh, "acme/app", "feature/model&other=value");
    expect(gh.getContent).toHaveBeenNthCalledWith(
      1,
      "/repos/acme/app/contents/.radius/app.bicep?ref=feature%2Fmodel%26other%3Dvalue"
    );
    expect(gh.getContent).toHaveBeenNthCalledWith(
      2,
      "/repos/acme/app/contents/app.bicep?ref=feature%2Fmodel%26other%3Dvalue"
    );
  });
});
