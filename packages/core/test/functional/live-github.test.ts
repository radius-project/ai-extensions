// Unit coverage for the retry/backoff behavior in the shared live-test GitHub
// fetch helper. The helper itself is test-only tooling (excluded from
// production coverage), but its retry branches are non-trivial enough to
// warrant a direct test independent of any live network access.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchExtensionFile } from "../support/live-github.js";

function response(status: number, body = ""): Response {
  return new Response(body, { status, statusText: `status ${status}` });
}

describe("fetchExtensionFile retry behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns the body on the first successful attempt", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(200, "content"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchExtensionFile(
      "owner/repo",
      "dir",
      "file.yml",
      "main"
    );

    expect(result).toBe("content");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on a transient 504 and succeeds on the next attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(504))
      .mockResolvedValueOnce(response(200, "content"));
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchExtensionFile("owner/repo", "dir", "file.yml", "main");
    await vi.runAllTimersAsync();

    expect(await promise).toBe("content");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails immediately on a non-retryable status without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchExtensionFile("owner/repo", "dir", "file.yml", "main")
    ).rejects.toThrow(/404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting retries on repeated transient errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(503));
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchExtensionFile("owner/repo", "dir", "file.yml", "main");
    const assertion = expect(promise).rejects.toThrow(/503/);
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries on a network-level fetch rejection", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network reset"))
      .mockResolvedValueOnce(response(200, "content"));
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchExtensionFile("owner/repo", "dir", "file.yml", "main");
    await vi.runAllTimersAsync();

    expect(await promise).toBe("content");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
