import { describe, expect, it, vi } from "vitest";
import { successfulSelectedGhExecutor } from "../test/support/server/selected-gh.js";
import type { SelectedGhExecutor } from "./gh.js";
import { createSelectedRepositoryReader } from "./selected-repository-reader.js";

const filePath = "/repos/fixture/app/contents/app.bicep?ref=feature%2Fmodel";

function fixture(value: unknown) {
  const run = vi.fn<SelectedGhExecutor["run"]>(async () => ({
    code: 0,
    stdout: JSON.stringify(value),
    stderr: ""
  }));
  const executor = successfulSelectedGhExecutor({ login: "fixture-user", run });
  return { reader: createSelectedRepositoryReader(executor), executor, run };
}

describe("selected repository reader", () => {
  it("reads text and binary bytes through the selected executor without changing the reference", async () => {
    const content = Buffer.from("resource app\n").toString("base64");
    const { reader, run } = fixture({
      type: "file",
      encoding: "base64",
      content: `${content}\n`
    });
    expect(await reader.getContent(filePath)).toBe("resource app\n");
    run.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify({
        type: "file",
        encoding: "base64",
        content: "AP8="
      }),
      stderr: ""
    });
    expect(await reader.getContentBytes(filePath)).toEqual(
      Buffer.from([0, 255])
    );
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ["api", filePath],
      ["api", filePath]
    ]);
  });

  it("does not mistake a present empty file for absence", async () => {
    const { reader } = fixture({
      type: "file",
      encoding: "base64",
      content: ""
    });
    expect(await reader.getContent(filePath)).toBe("");
    expect(await reader.getContentBytes(filePath)).toEqual(Buffer.alloc(0));
  });

  it("reports oversized binary artifacts and refuses unreadable text", async () => {
    const { reader } = fixture({ type: "file", encoding: "none" });
    expect(await reader.getContentBytes(filePath)).toEqual({ tooLarge: true });
    await expect(reader.getContent(filePath)).rejects.toThrow(
      "inline content limit"
    );
  });

  it("accepts only an explicit 404 as absence, never as an empty repository tree", async () => {
    const { reader, run } = fixture({});
    run.mockResolvedValue({ code: 1, stdout: "", stderr: "HTTP 404" });
    expect(await reader.getContent(filePath)).toBeNull();
    expect(await reader.getContentBytes(filePath)).toBeNull();
    expect(await reader.listNames(filePath)).toEqual([]);
    await expect(reader.treePaths("fixture/app", "missing")).rejects.toThrow(
      "HTTP 404"
    );
    expect(run).toHaveBeenCalledTimes(4);
  });

  it.each([
    { value: null },
    { value: [] },
    { value: false },
    { value: {} },
    { value: { type: "dir" } },
    { value: { type: "file", encoding: "utf8", content: "text" } },
    { value: { type: "file", encoding: "base64", content: false } },
    { value: { type: "file", encoding: "base64", content: "not/base64!" } }
  ])("refuses malformed file metadata: $value", async ({ value }) => {
    const { reader, run } = fixture(value);
    await expect(reader.getContent(filePath)).rejects.toThrow();
    expect(run).toHaveBeenCalledOnce();
  });

  it.each(["HTTP 403", "read timed out", ""])(
    "surfaces selected-account read failure without fallback: %s",
    async (stderr) => {
      const { reader, executor, run } = fixture({});
      executor.redact = (text) => text.replace("HTTP 403", "permission denied");
      run.mockResolvedValue({ code: 1, stdout: "", stderr });
      await expect(reader.getContent(filePath)).rejects.toThrow(
        stderr === "HTTP 403" ? "permission denied" : (
          stderr || "Could not read the selected repository."
        )
      );
      expect(run).toHaveBeenCalledOnce();
    }
  );

  it("refuses malformed JSON rather than treating it as absence", async () => {
    const { reader, run } = fixture({});
    run.mockResolvedValue({ code: 0, stdout: "{", stderr: "" });
    await expect(reader.getContent(filePath)).rejects.toThrow();
    expect(run).toHaveBeenCalledOnce();
  });

  it("returns directory names and preserves a proven empty directory", async () => {
    const { reader, run } = fixture([
      { name: "app.bicep" },
      { name: "recipes" }
    ]);
    expect(await reader.listNames("/repos/fixture/app/contents")).toEqual([
      "app.bicep",
      "recipes"
    ]);
    run.mockResolvedValueOnce({ code: 0, stdout: "[]", stderr: "" });
    expect(await reader.listNames("/repos/fixture/app/contents")).toEqual([]);
  });

  it.each([
    { value: {} },
    { value: [null] },
    { value: [{}] },
    { value: [{ name: 42 }] },
    { value: [{ name: "" }] }
  ])("rejects invalid directory metadata: $value", async ({ value }) => {
    const { reader } = fixture(value);
    await expect(
      reader.listNames("/repos/fixture/app/contents")
    ).rejects.toThrow();
  });

  it("returns only file paths from a complete tree on the exact encoded branch", async () => {
    const { reader, run } = fixture({
      truncated: false,
      tree: [
        { type: "blob", path: ".radius/app.bicep" },
        { type: "tree", path: ".radius" },
        { type: "commit", path: "submodule" }
      ]
    });
    expect(
      await reader.treePaths("fixture/app", "feature/model&validation")
    ).toEqual([".radius/app.bicep"]);
    expect(run).toHaveBeenCalledWith(
      [
        "api",
        "/repos/fixture/app/git/trees/feature%2Fmodel%26validation?recursive=1"
      ],
      { timeout: 15000 }
    );
  });

  it.each([
    { value: false },
    { value: { tree: [] } },
    { value: { truncated: true, tree: [] } },
    { value: { truncated: false } },
    { value: { truncated: false, tree: [null] } },
    { value: { truncated: false, tree: [{}] } },
    { value: { truncated: false, tree: [{ path: 42 }] } },
    { value: { truncated: false, tree: [{ path: "file", type: ["blob"] }] } },
    { value: { truncated: false, tree: [{ path: "", type: "blob" }] } },
    { value: { truncated: false, tree: [{ path: "file", type: "unknown" }] } }
  ])(
    "rejects incomplete or invalid tree metadata: $value",
    async ({ value }) => {
      const { reader } = fixture(value);
      await expect(reader.treePaths("fixture/app", "branch")).rejects.toThrow();
    }
  );

  it("refuses to read a tree without an explicit branch", async () => {
    const { reader, run } = fixture({});
    await expect(reader.treePaths("fixture/app", " ")).rejects.toThrow(
      "explicit repository branch"
    );
    expect(run).not.toHaveBeenCalled();
  });
});
