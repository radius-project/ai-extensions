import { describe, expect, it, vi } from "vitest";
import {
  createGitHubSourceReader,
  SourceAccessError,
  type GhApiResult,
  type ghApiJson
} from "./gh.js";

const filePath = "/repos/acme/app/contents/app.bicep?ref=feature%2Fmodel";
const treePath = "/repos/acme/app/git/trees/feature%2Fmodel?recursive=1";

function ok(json: unknown): GhApiResult {
  return { ok: true, status: 200, json, stderr: "" };
}

function failed(
  status: number | null,
  stderr = "Source access failed"
): GhApiResult {
  return { ok: false, status, json: null, stderr };
}

function fixture(responses: Record<string, GhApiResult>) {
  const request = vi.fn<typeof ghApiJson>(async (path) => {
    const response = responses[path];
    if (!response) throw new Error(`Unspecified request: ${path}`);
    return response;
  });
  return { reader: createGitHubSourceReader(request), request };
}

describe("GitHub source reads", () => {
  it.each(["", "extension radius\n", "é"])(
    "preserves decoded file contents %j",
    async (content) => {
      const { reader, request } = fixture({
        [filePath]: ok({
          type: "file",
          encoding: "base64",
          size: Buffer.byteLength(content),
          content: `${Buffer.from(content).toString("base64")}\n`
        })
      });
      expect(await reader.getContent(filePath, 1234)).toBe(content);
      expect(request).toHaveBeenCalledExactlyOnceWith(filePath, {
        timeout: 1234
      });
    }
  );

  it.each(
    [
      null,
      [],
      {},
      { type: "dir", encoding: "base64", content: "" },
      { type: "file", encoding: "none", content: "" },
      { type: "file", encoding: "base64", content: 7 },
      { type: "file", encoding: "base64", content: "", size: -1 },
      { type: "file", encoding: "base64", content: "", size: 1.5 },
      { type: "file", encoding: "base64", content: "", size: "0" },
      { type: "file", encoding: "base64", content: "not base64!", size: 1 },
      { type: "file", encoding: "base64", content: "Zh==", size: 1 }
    ].map((json) => ({ json }))
  )("rejects malformed file response $json", async ({ json }) => {
    const { reader } = fixture({ [filePath]: ok(json) });
    await expect(reader.getContent(filePath)).rejects.toBeInstanceOf(
      SourceAccessError
    );
  });

  it("rejects a partial file rather than passing it off as an empty model", async () => {
    const { reader } = fixture({
      [filePath]: ok({
        type: "file",
        encoding: "base64",
        content: "",
        size: 12
      })
    });
    await expect(reader.getContent(filePath)).rejects.toThrow(
      "Incomplete file contents response"
    );
  });

  it.each([401, 403, 429, 500, null])(
    "does not treat a %s failure as absence",
    async (status) => {
      const { reader, request } = fixture({
        [filePath]: failed(status, "Permission or network failure")
      });
      await expect(reader.getContent(filePath)).rejects.toMatchObject({
        name: "SourceAccessError",
        status,
        message: expect.stringContaining("Permission or network failure")
      });
      expect(request).toHaveBeenCalledTimes(1);
    }
  );

  it("preserves rejected dependency failures", async () => {
    const error = new Error("Process unavailable");
    const reader = createGitHubSourceReader(async () => {
      throw error;
    });
    await expect(reader.getContent(filePath)).rejects.toBe(error);
  });

  it.each(["getContent", "listNames"] as const)(
    "confirms absent paths before %s returns absence",
    async (method) => {
      const { reader, request } = fixture({
        [filePath]: failed(404),
        [treePath]: ok({
          truncated: false,
          tree: [{ type: "blob", path: "Dockerfile" }]
        })
      });
      expect(await reader[method](filePath)).toEqual(
        method === "getContent" ? null : []
      );
      expect(request).toHaveBeenLastCalledWith(treePath, { timeout: 15000 });
    }
  );

  it("resolves the default branch when an absent contents path has no ref", async () => {
    const path = "/repos/acme/app/contents/app.bicep";
    const { reader, request } = fixture({
      [path]: failed(404),
      "/repos/acme/app": ok({ default_branch: "release/model" }),
      "/repos/acme/app/git/trees/release%2Fmodel?recursive=1": ok({
        truncated: false,
        tree: []
      })
    });
    expect(await reader.getContent(path)).toBeNull();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each([
    failed(404),
    ok(null),
    ok({}),
    ok({ default_branch: 7 }),
    ok({ default_branch: "" })
  ])(
    "rejects unavailable or malformed default-branch metadata %j",
    async (metadata) => {
      const path = "/repos/acme/app/contents/app.bicep";
      const { reader } = fixture({
        [path]: failed(404),
        "/repos/acme/app": metadata
      });
      await expect(reader.getContent(path)).rejects.toThrow(
        "Could not establish the repository default branch"
      );
    }
  );

  it.each([401, 403, 404, null])(
    "rejects a hidden repository or unavailable branch (%s)",
    async (status) => {
      const { reader } = fixture({
        [filePath]: failed(404),
        [treePath]: failed(status)
      });
      await expect(reader.getContent(filePath)).rejects.toBeInstanceOf(
        SourceAccessError
      );
    }
  );

  it.each(["blob", "tree", "commit"])(
    "does not call a listed %s absent after contents returns 404",
    async (type) => {
      const { reader } = fixture({
        [filePath]: failed(404),
        [treePath]: ok({
          truncated: false,
          tree: [{ type, path: "app.bicep" }]
        })
      });
      await expect(reader.getContent(filePath)).rejects.toMatchObject({
        status: 404
      });
    }
  );

  it("does not infer absence from an unrecognized contents endpoint", async () => {
    const { reader } = fixture({ "/other": failed(404) });
    await expect(reader.getContent("/other")).rejects.toBeInstanceOf(
      SourceAccessError
    );
  });

  it("compares decoded repository paths when confirming absence", async () => {
    const path =
      "/repos/acme/app/contents/app%20model.bicep?ref=feature%2Fmodel";
    const { reader } = fixture({
      [path]: failed(404),
      [treePath]: ok({
        truncated: false,
        tree: [{ type: "blob", path: "app model.bicep" }]
      })
    });
    await expect(reader.getContent(path)).rejects.toMatchObject({
      status: 404
    });
  });

  it.each(["invalid%escape", "%2F"])(
    "rejects an invalid contents path %s rather than claiming absence",
    async (invalidPath) => {
      const path = `/repos/acme/app/contents/${invalidPath}?ref=feature%2Fmodel`;
      const { reader, request } = fixture({ [path]: failed(404) });
      await expect(reader.getContent(path)).rejects.toThrow(
        "Invalid repository contents path"
      );
      expect(request).toHaveBeenCalledTimes(1);
    }
  );

  it("does not claim a directory with a trailing slash is absent when the tree includes it", async () => {
    const path = "/repos/acme/app/contents/.radius/?ref=feature%2Fmodel";
    const { reader } = fixture({
      [path]: failed(404),
      [treePath]: ok({
        truncated: false,
        tree: [{ type: "tree", path: ".radius" }]
      })
    });
    await expect(reader.listNames(path)).rejects.toMatchObject({ status: 404 });
  });

  it.each(
    [[], [{ name: "app.bicep" }, { name: ".radius" }]].map((entries) => ({
      entries
    }))
  )("preserves successful directory listings $entries", async ({ entries }) => {
    const { reader } = fixture({ [filePath]: ok(entries) });
    expect(await reader.listNames(filePath)).toEqual(
      entries.map((entry) => entry.name)
    );
  });

  it.each(
    [null, {}, ["a"], [{ name: 3 }], [{ name: "" }], [{ name: "a" }, null]].map(
      (json) => ({ json })
    )
  )("rejects malformed directory listings $json", async ({ json }) => {
    const { reader } = fixture({ [filePath]: ok(json) });
    await expect(reader.listNames(filePath)).rejects.toThrow(
      "Invalid directory contents response"
    );
  });

  it("rejects unreadable directory listings", async () => {
    const { reader } = fixture({ [filePath]: failed(403) });
    await expect(reader.listNames(filePath)).rejects.toMatchObject({
      status: 403
    });
  });

  it("lists only files in a complete tree", async () => {
    const { reader, request } = fixture({
      [treePath]: ok({
        truncated: false,
        tree: [
          { type: "blob", path: "Dockerfile" },
          { type: "tree", path: "src" },
          { type: "commit", path: "submodule" }
        ]
      })
    });
    expect(await reader.treePaths("acme/app", "feature/model")).toEqual([
      "Dockerfile"
    ]);
    expect(request).toHaveBeenCalledExactlyOnceWith(treePath, {
      timeout: 30000
    });
  });

  it("preserves a confirmed empty tree", async () => {
    const { reader } = fixture({
      "/repos/acme/app/git/trees/main?recursive=1": ok({
        truncated: false,
        tree: []
      })
    });
    expect(await reader.treePaths("acme/app")).toEqual([]);
  });

  it.each(
    [
      null,
      [],
      {},
      { tree: [] },
      { truncated: "false", tree: [] },
      { truncated: true, tree: [{ type: "blob", path: "Dockerfile" }] },
      { truncated: false, tree: null },
      { truncated: false, tree: [null] },
      { truncated: false, tree: [{ path: 1, type: "blob" }] },
      { truncated: false, tree: [{ path: "", type: "blob" }] },
      { truncated: false, tree: [{ path: "Dockerfile", type: "invalid" }] }
    ].map((json) => ({ json }))
  )("rejects malformed or truncated trees $json", async ({ json }) => {
    const { reader } = fixture({ [treePath]: ok(json) });
    await expect(reader.treePaths("acme/app", "feature/model")).rejects.toThrow(
      "Invalid or incomplete repository tree"
    );
  });

  it("does not use a truncated tree to confirm a missing file", async () => {
    const { reader } = fixture({
      [filePath]: failed(404),
      [treePath]: ok({ truncated: true, tree: [] })
    });
    await expect(reader.getContent(filePath)).rejects.toThrow(
      "Invalid or incomplete repository tree"
    );
  });
});
