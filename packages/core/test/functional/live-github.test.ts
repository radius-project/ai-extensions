import { describe, expect, it, vi } from "vitest";
import {
  fetchExtensionFile,
  fetchGitHubWithRetry
} from "../support/live-github.js";

const noDelay = async (): Promise<void> => {};

function spyOnBodyCancel(response: Response) {
  if (!response.body) {
    throw new Error("expected response body");
  }
  return vi.spyOn(response.body, "cancel");
}

describe("live GitHub test support", () => {
  it.each([
    { status: 408, statusText: "Request Timeout" },
    { status: 429, statusText: "Too Many Requests" },
    { status: 500, statusText: "Internal Server Error" }
  ])(
    "retries transient GitHub $status responses before returning a successful response",
    async ({ status, statusText }) => {
      let calls = 0;
      const delays: number[] = [];
      const responses = [
        new Response("try again", {
          status,
          statusText
        }),
        new Response("contents")
      ];
      const cancelBody = spyOnBodyCancel(responses[0]);
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
      expect(cancelBody).toHaveBeenCalledOnce();
    }
  );

  it("returns the file contents when the first content fetch attempt succeeds", async () => {
    let calls = 0;
    const delays: number[] = [];
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response("template contents");
    };

    const contents = await fetchExtensionFile(
      "owner/repo",
      ".github/extension",
      "deploy.yml",
      "main",
      {
        fetchImpl,
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        }
      }
    );

    expect(contents).toBe("template contents");
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it("continues retrying when transient response cleanup fails", async () => {
    let calls = 0;
    const transientResponse = new Response("try again", {
      status: 503,
      statusText: "Service Unavailable"
    });
    spyOnBodyCancel(transientResponse).mockRejectedValue(
      new Error("cleanup failed")
    );
    const responses = [transientResponse, new Response("template contents")];
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return responses[calls - 1];
    };

    const result = await fetchGitHubWithRetry(
      "https://api.github.com/test",
      {},
      {
        fetchImpl,
        sleep: noDelay
      }
    );

    expect(await result.response.text()).toBe("template contents");
    expect(calls).toBe(2);
  });

  it("retries a rejected fetch before returning a later successful response", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("network reset");
      }
      return new Response("template contents");
    };

    const contents = await fetchExtensionFile(
      "owner/repo",
      ".github/extension",
      "deploy.yml",
      "main",
      {
        fetchImpl,
        sleep: noDelay,
        retryDelaysMs: [5, 10]
      }
    );

    expect(contents).toBe("template contents");
    expect(calls).toBe(2);
  });

  it("does not retry permanent GitHub content fetch responses", async () => {
    let calls = 0;
    const missingResponse = new Response("missing", {
      status: 404,
      statusText: "Not Found"
    });
    const cancelBody = spyOnBodyCancel(missingResponse);
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return missingResponse;
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
    expect(cancelBody).toHaveBeenCalledOnce();
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
    ).rejects.toThrow(
      "failed to fetch https://api.github.com/test after 3 attempts: network failure 3"
    );
    expect(calls).toBe(3);
  });

  it("reports one attempt and preserves the cause when retries are disabled", async () => {
    const failure = new Error("network unavailable");
    const fetchImpl: typeof fetch = async () => {
      throw failure;
    };

    await expect(
      fetchGitHubWithRetry(
        "https://api.github.com/test",
        {},
        {
          fetchImpl,
          sleep: noDelay,
          retryDelaysMs: []
        }
      )
    ).rejects.toMatchObject({
      message:
        "failed to fetch https://api.github.com/test after 1 attempt: network unavailable",
      cause: failure
    });
  });

  it("reports terminal transient content fetch responses with the retry count", async () => {
    let calls = 0;
    const unavailableResponses = Array.from(
      { length: 3 },
      () =>
        new Response("still unavailable", {
          status: 500,
          statusText: "Internal Server Error"
        })
    );
    const cancelBodies = unavailableResponses.map((response) =>
      spyOnBodyCancel(response)
    );
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return unavailableResponses[calls - 1];
    };

    await expect(
      fetchExtensionFile(
        "owner/repo",
        ".github/extension",
        "delete-aws.yml",
        "sha with space",
        {
          fetchImpl,
          sleep: noDelay,
          retryDelaysMs: [5, 10]
        }
      )
    ).rejects.toThrow(
      "failed to fetch https://api.github.com/repos/owner/repo/contents/.github/extension/delete-aws.yml?ref=sha%20with%20space after 3 attempts: 500 Internal Server Error"
    );
    expect(calls).toBe(3);
    for (const cancelBody of cancelBodies) {
      expect(cancelBody).toHaveBeenCalledOnce();
    }
  });
});
