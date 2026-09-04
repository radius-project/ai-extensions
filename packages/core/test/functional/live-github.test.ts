import { describe, expect, it } from "vitest";
import {
  fetchExtensionFile,
  fetchGitHubWithRetry
} from "../support/live-github.js";

const noDelay = async (): Promise<void> => {};

describe("live GitHub test support", () => {
  it("retries transient GitHub responses before returning a successful response", async () => {
    let calls = 0;
    const delays: number[] = [];
    const responses = [
      new Response("try again", {
        status: 500,
        statusText: "Internal Server Error"
      }),
      new Response("contents")
    ];
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return responses[calls - 1];
    };

    const result = await fetchGitHubWithRetry(
      "https://api.github.com/test",
      {
        headers: {}
      },
      {
        fetchImpl,
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
        retryDelaysMs: [5, 10]
      }
    );

    expect(await result.response.text()).toBe("contents");
    expect(result.attempts).toBe(2);
    expect(calls).toBe(2);
    expect(delays).toEqual([5]);
  });

  it("does not retry permanent GitHub content fetch responses", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response("missing", {
        status: 404,
        statusText: "Not Found"
      });
    };

    await expect(
      fetchExtensionFile(
        "owner/repo",
        ".github/extension",
        "missing.yml",
        "main",
        {
          fetchImpl,
          sleep: noDelay
        }
      )
    ).rejects.toThrow(
      "failed to fetch https://api.github.com/repos/owner/repo/contents/.github/extension/missing.yml?ref=main after 1 attempt: 404 Not Found"
    );
    expect(calls).toBe(1);
  });

  it("returns permanent GitHub responses without consuming the retry budget", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("missing", {
        status: 404,
        statusText: "Not Found"
      });

    const result = await fetchGitHubWithRetry(
      "https://api.github.com/test",
      {
        headers: {}
      },
      {
        fetchImpl,
        sleep: noDelay
      }
    );
    expect(result.response.status).toBe(404);
    expect(result.attempts).toBe(1);
    expect(result.attempts).toBe(1);
  });

  it("retries rejected fetches before surfacing the final rejection", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      throw new Error(`network failure ${calls}`);
    };

    await expect(
      fetchGitHubWithRetry(
        "https://api.github.com/test",
        {
          headers: {}
        },
        {
          fetchImpl,
          sleep: noDelay,
          retryDelaysMs: [5, 10]
        }
      )
    ).rejects.toThrow("network failure 3");
    expect(calls).toBe(3);
  });

  it("reports terminal transient content fetch responses with the retry count", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response("still unavailable", {
        status: 500,
        statusText: "Internal Server Error"
      });
    };

    await expect(
      fetchExtensionFile(
        "owner/repo",
        ".github/extension",
        "delete-aws.yml",
        "sha with slash",
        {
          fetchImpl,
          sleep: noDelay,
          retryDelaysMs: [5, 10]
        }
      )
    ).rejects.toThrow(
      "failed to fetch https://api.github.com/repos/owner/repo/contents/.github/extension/delete-aws.yml?ref=sha%20with%20slash after 3 attempts: 500 Internal Server Error"
    );
    expect(calls).toBe(3);
  });
});
