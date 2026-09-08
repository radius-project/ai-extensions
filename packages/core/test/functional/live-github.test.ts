import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  DEFAULT_RETRY_DELAYS_MS,
  fetchExtensionFile,
  fetchGitHubText,
  githubApiHeaders
} from "../support/live-github.js";

// The opt-in live suites give each test 30s. A default budget that cannot
// finish inside it would fail the test before any retry or diagnostic lands.
const LIVE_TEST_TIMEOUT_MS = 30_000;

const URL_UNDER_TEST = "https://api.github.com/test";
const noDelay = async (): Promise<void> => {};
const noJitter = (): number => 0;

function spyOnBodyCancel(response: Response) {
  if (!response.body) {
    throw new Error("expected response body");
  }
  return vi.spyOn(response.body, "cancel");
}

// A 200 whose stream errors part-way models a connection that drops after the
// headers arrive, which is the failure mode a fetch-only retry boundary misses.
function responseWithFailingBody(message: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error(message));
      }
    })
  );
}

function respondInOrder(responses: readonly Response[]): {
  fetchImpl: typeof fetch;
  calls: () => number;
} {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    const response = responses[calls - 1];
    if (!response) {
      throw new Error(`unexpected fetch call ${calls}`);
    }
    return response;
  };
  return { fetchImpl, calls: () => calls };
}

function recordDelays(): {
  sleep: (milliseconds: number) => Promise<void>;
  delays: number[];
} {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    }
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("githubApiHeaders", () => {
  it("omits Authorization when no GITHUB_TOKEN is set", () => {
    vi.stubEnv("GITHUB_TOKEN", "");

    expect(githubApiHeaders("application/vnd.github.raw")).toEqual({
      Accept: "application/vnd.github.raw",
      "User-Agent": "radius-ai-extensions-live-tests",
      "X-GitHub-Api-Version": "2022-11-28"
    });
  });

  it("sends a bearer token when GITHUB_TOKEN is set", () => {
    vi.stubEnv("GITHUB_TOKEN", "  token-value  ");

    expect(githubApiHeaders("application/vnd.github+json")).toMatchObject({
      Accept: "application/vnd.github+json",
      Authorization: "Bearer token-value"
    });
  });
});

describe("fetchGitHubText", () => {
  it("exhausts its default budget well inside the live suite timeout", () => {
    const attempts = DEFAULT_RETRY_DELAYS_MS.length + 1;
    const maximumBackoffMs = DEFAULT_RETRY_DELAYS_MS.reduce(
      (total, delay) => total + delay * 1.5,
      0
    );
    const worstCaseMs =
      attempts * DEFAULT_ATTEMPT_TIMEOUT_MS + maximumBackoffMs;

    expect(worstCaseMs).toBeLessThan(LIVE_TEST_TIMEOUT_MS);
  });

  it("returns the body on the first attempt without sleeping", async () => {
    const { fetchImpl, calls } = respondInOrder([new Response("contents")]);
    const { sleep, delays } = recordDelays();

    const result = await fetchGitHubText(
      URL_UNDER_TEST,
      {},
      { fetchImpl, sleep, random: noJitter }
    );

    expect(result).toEqual({ text: "contents", attempts: 1 });
    expect(calls()).toBe(1);
    expect(delays).toEqual([]);
  });

  it.each([
    { status: 408, statusText: "Request Timeout" },
    { status: 429, statusText: "Too Many Requests" },
    { status: 500, statusText: "Internal Server Error" },
    { status: 599, statusText: "Network Connect Timeout Error" }
  ])(
    "retries transient $status responses and cancels their bodies",
    async ({ status, statusText }) => {
      const transient = new Response("try again", { status, statusText });
      const cancelBody = spyOnBodyCancel(transient);
      const { fetchImpl, calls } = respondInOrder([
        transient,
        new Response("contents")
      ]);
      const { sleep, delays } = recordDelays();

      const result = await fetchGitHubText(
        URL_UNDER_TEST,
        {},
        { fetchImpl, sleep, retryDelaysMs: [5, 10], random: noJitter }
      );

      expect(result).toEqual({ text: "contents", attempts: 2 });
      expect(calls()).toBe(2);
      expect(delays).toEqual([5]);
      expect(cancelBody).toHaveBeenCalledOnce();
    }
  );

  it("succeeds on the final attempt of the retry budget", async () => {
    const { fetchImpl, calls } = respondInOrder([
      new Response("busy", { status: 502, statusText: "Bad Gateway" }),
      new Response("busy", { status: 503, statusText: "Service Unavailable" }),
      new Response("contents")
    ]);
    const { sleep, delays } = recordDelays();

    const result = await fetchGitHubText(
      URL_UNDER_TEST,
      {},
      { fetchImpl, sleep, retryDelaysMs: [5, 10], random: noJitter }
    );

    expect(result).toEqual({ text: "contents", attempts: 3 });
    expect(calls()).toBe(3);
    expect(delays).toEqual([5, 10]);
  });

  it("stops as soon as a retry surfaces a permanent failure", async () => {
    const { fetchImpl, calls } = respondInOrder([
      new Response("busy", {
        status: 500,
        statusText: "Internal Server Error"
      }),
      new Response("missing", { status: 404, statusText: "Not Found" })
    ]);
    const { sleep, delays } = recordDelays();

    await expect(
      fetchGitHubText(
        URL_UNDER_TEST,
        {},
        { fetchImpl, sleep, retryDelaysMs: [5, 10], random: noJitter }
      )
    ).rejects.toThrow(
      `failed to fetch ${URL_UNDER_TEST} after 2 attempts: 404 Not Found`
    );
    expect(calls()).toBe(2);
    expect(delays).toEqual([5]);
  });

  it("reports every exhausted transient attempt and its delays", async () => {
    const responses = Array.from(
      { length: 3 },
      () =>
        new Response("still unavailable", {
          status: 500,
          statusText: "Internal Server Error"
        })
    );
    const cancelBodies = responses.map((response) => spyOnBodyCancel(response));
    const { fetchImpl, calls } = respondInOrder(responses);
    const { sleep, delays } = recordDelays();

    await expect(
      fetchGitHubText(
        URL_UNDER_TEST,
        {},
        { fetchImpl, sleep, retryDelaysMs: [5, 10], random: noJitter }
      )
    ).rejects.toThrow(
      `failed to fetch ${URL_UNDER_TEST} after 3 attempts: 500 Internal Server Error`
    );
    expect(calls()).toBe(3);
    expect(delays).toEqual([5, 10]);
    for (const cancelBody of cancelBodies) {
      expect(cancelBody).toHaveBeenCalledOnce();
    }
  });

  it("makes a single attempt when the retry budget is empty", async () => {
    const failure = new Error("network unavailable");
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      throw failure;
    };
    const { sleep, delays } = recordDelays();

    await expect(
      fetchGitHubText(
        URL_UNDER_TEST,
        {},
        { fetchImpl, sleep, retryDelaysMs: [], random: noJitter }
      )
    ).rejects.toMatchObject({
      message: `failed to fetch ${URL_UNDER_TEST} after 1 attempt: network unavailable`,
      cause: failure
    });
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it("backs off on the default schedule when no delays are configured", async () => {
    const { fetchImpl } = respondInOrder(
      Array.from(
        { length: 3 },
        () => new Response("busy", { status: 503, statusText: "Unavailable" })
      )
    );
    const { sleep, delays } = recordDelays();

    await expect(
      fetchGitHubText(
        URL_UNDER_TEST,
        {},
        { fetchImpl, sleep, random: noJitter }
      )
    ).rejects.toThrow("after 3 attempts: 503 Unavailable");
    expect(delays).toEqual([250, 1000]);
  });

  it("spreads retries with jitter so concurrent callers desynchronize", async () => {
    const { fetchImpl } = respondInOrder([
      new Response("busy", { status: 503, statusText: "Unavailable" }),
      new Response("contents")
    ]);
    const { sleep, delays } = recordDelays();

    await fetchGitHubText(
      URL_UNDER_TEST,
      {},
      { fetchImpl, sleep, retryDelaysMs: [100], random: () => 1 }
    );

    expect(delays).toEqual([150]);
  });

  it("applies bounded random jitter by default", async () => {
    const { fetchImpl } = respondInOrder([
      new Response("busy", { status: 503, statusText: "Unavailable" }),
      new Response("contents")
    ]);
    const { sleep, delays } = recordDelays();

    await fetchGitHubText(
      URL_UNDER_TEST,
      {},
      { fetchImpl, sleep, retryDelaysMs: [100] }
    );

    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[0]).toBeLessThanOrEqual(150);
  });

  it("falls back to the global fetch when no implementation is injected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("contents"))
    );

    const result = await fetchGitHubText(
      URL_UNDER_TEST,
      {},
      { sleep: noDelay, random: noJitter }
    );

    expect(result).toEqual({ text: "contents", attempts: 1 });
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it("sleeps for real when no sleep override is supplied", async () => {
    const { fetchImpl, calls } = respondInOrder([
      new Response("busy", { status: 503, statusText: "Unavailable" }),
      new Response("contents")
    ]);

    const result = await fetchGitHubText(
      URL_UNDER_TEST,
      {},
      { fetchImpl, retryDelaysMs: [1], random: noJitter }
    );

    expect(result.text).toBe("contents");
    expect(calls()).toBe(2);
  });

  it("keeps retrying when cancelling a transient response body fails", async () => {
    const transient = new Response("try again", {
      status: 503,
      statusText: "Service Unavailable"
    });
    spyOnBodyCancel(transient).mockRejectedValue(new Error("cleanup failed"));
    const { fetchImpl, calls } = respondInOrder([
      transient,
      new Response("contents")
    ]);

    const result = await fetchGitHubText(
      URL_UNDER_TEST,
      {},
      { fetchImpl, sleep: noDelay, random: noJitter }
    );

    expect(result.text).toBe("contents");
    expect(calls()).toBe(2);
  });

  describe("body reads", () => {
    it("retries a body that fails mid-stream", async () => {
      const { fetchImpl, calls } = respondInOrder([
        responseWithFailingBody("stream reset"),
        new Response("contents")
      ]);

      const result = await fetchGitHubText(
        URL_UNDER_TEST,
        {},
        { fetchImpl, sleep: noDelay, retryDelaysMs: [5], random: noJitter }
      );

      expect(result).toEqual({ text: "contents", attempts: 2 });
      expect(calls()).toBe(2);
    });

    it("reports a body that keeps failing with the attempt count", async () => {
      const { fetchImpl, calls } = respondInOrder([
        responseWithFailingBody("stream reset 1"),
        responseWithFailingBody("stream reset 2")
      ]);

      await expect(
        fetchGitHubText(
          URL_UNDER_TEST,
          {},
          { fetchImpl, sleep: noDelay, retryDelaysMs: [5], random: noJitter }
        )
      ).rejects.toThrow(
        `failed to fetch ${URL_UNDER_TEST} after 2 attempts: stream reset 2`
      );
      expect(calls()).toBe(2);
    });
  });

  describe("rate limits", () => {
    it("retries a rate-limited 403 and honours Retry-After over the backoff", async () => {
      const { fetchImpl, calls } = respondInOrder([
        new Response("slow down", {
          status: 403,
          statusText: "Forbidden",
          headers: { "retry-after": "1" }
        }),
        new Response("contents")
      ]);
      const { sleep, delays } = recordDelays();

      const result = await fetchGitHubText(
        URL_UNDER_TEST,
        {},
        { fetchImpl, sleep, retryDelaysMs: [5], random: noJitter }
      );

      expect(result).toEqual({ text: "contents", attempts: 2 });
      expect(calls()).toBe(2);
      expect(delays).toEqual([1000]);
    });

    it("keeps the configured backoff when it already exceeds Retry-After", async () => {
      const { fetchImpl } = respondInOrder([
        new Response("slow down", {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "retry-after": "0" }
        }),
        new Response("contents")
      ]);
      const { sleep, delays } = recordDelays();

      await fetchGitHubText(
        URL_UNDER_TEST,
        {},
        { fetchImpl, sleep, retryDelaysMs: [500], random: noJitter }
      );

      expect(delays).toEqual([500]);
    });

    it("does not retry a 403 that carries no rate-limit evidence", async () => {
      const { fetchImpl, calls } = respondInOrder([
        new Response("no access", { status: 403, statusText: "Forbidden" })
      ]);

      await expect(
        fetchGitHubText(
          URL_UNDER_TEST,
          {},
          { fetchImpl, sleep: noDelay, random: noJitter }
        )
      ).rejects.toThrow(
        `failed to fetch ${URL_UNDER_TEST} after 1 attempt: 403 Forbidden`
      );
      expect(calls()).toBe(1);
    });

    it("fails fast with the reset time when the primary rate limit is exhausted", async () => {
      const { fetchImpl, calls } = respondInOrder([
        new Response("no quota", {
          status: 403,
          statusText: "Forbidden",
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1700000000"
          }
        })
      ]);

      await expect(
        fetchGitHubText(
          URL_UNDER_TEST,
          {},
          { fetchImpl, sleep: noDelay, random: noJitter }
        )
      ).rejects.toThrow(
        `failed to fetch ${URL_UNDER_TEST} after 1 attempt: 403 Forbidden (rate limit exhausted until 2023-11-14T22:13:20.000Z)`
      );
      expect(calls()).toBe(1);
    });

    it.each([
      { label: "missing", headers: { "x-ratelimit-remaining": "0" } },
      {
        label: "non-numeric",
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "later" }
      },
      {
        label: "out of range",
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "99999999999999"
        }
      }
    ])(
      "fails fast without a reset time when the reset header is $label",
      async ({ headers }) => {
        const { fetchImpl } = respondInOrder([
          new Response("no quota", {
            status: 429,
            statusText: "Too Many Requests",
            headers
          })
        ]);

        await expect(
          fetchGitHubText(
            URL_UNDER_TEST,
            {},
            { fetchImpl, sleep: noDelay, random: noJitter }
          )
        ).rejects.toThrow(
          "after 1 attempt: 429 Too Many Requests (rate limit exhausted)"
        );
      }
    );

    it("fails fast when Retry-After exceeds the wait budget", async () => {
      const { fetchImpl, calls } = respondInOrder([
        new Response("slow down", {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "retry-after": "60" }
        })
      ]);

      await expect(
        fetchGitHubText(
          URL_UNDER_TEST,
          {},
          {
            fetchImpl,
            sleep: noDelay,
            maxRetryAfterMs: 15_000,
            random: noJitter
          }
        )
      ).rejects.toThrow(
        "after 1 attempt: 429 Too Many Requests (retry-after 60000ms exceeds the 15000ms budget)"
      );
      expect(calls()).toBe(1);
    });

    it.each([
      { status: 503, statusText: "Service Unavailable", header: "soon" },
      { status: 503, statusText: "Service Unavailable", header: "-5" },
      { status: 503, statusText: "Service Unavailable", header: "   " },
      { status: 429, statusText: "Too Many Requests", header: "soon" },
      { status: 429, statusText: "Too Many Requests", header: "-5" },
      { status: 429, statusText: "Too Many Requests", header: "   " },
      { status: 408, statusText: "Request Timeout", header: "soon" }
    ])(
      "ignores an unusable Retry-After '$header' on $status and backs off normally",
      async ({ status, statusText, header }) => {
        const { fetchImpl } = respondInOrder([
          new Response("busy", {
            status,
            statusText,
            headers: { "retry-after": header }
          }),
          new Response("contents")
        ]);
        const { sleep, delays } = recordDelays();

        const result = await fetchGitHubText(
          URL_UNDER_TEST,
          {},
          { fetchImpl, sleep, retryDelaysMs: [7], random: noJitter }
        );

        expect(result.text).toBe("contents");
        expect(delays).toEqual([7]);
      }
    );

    it.each(["soon", "-5", "   "])(
      "keeps a 403 permanent when Retry-After '%s' is unusable and quota remains",
      async (header) => {
        const { fetchImpl, calls } = respondInOrder([
          new Response("no access", {
            status: 403,
            statusText: "Forbidden",
            headers: { "retry-after": header, "x-ratelimit-remaining": "17" }
          })
        ]);

        await expect(
          fetchGitHubText(
            URL_UNDER_TEST,
            {},
            { fetchImpl, sleep: noDelay, random: noJitter }
          )
        ).rejects.toThrow(
          `failed to fetch ${URL_UNDER_TEST} after 1 attempt: 403 Forbidden`
        );
        expect(calls()).toBe(1);
      }
    );

    it("still reports exhausted quota when Retry-After is unusable", async () => {
      const { fetchImpl, calls } = respondInOrder([
        new Response("no quota", {
          status: 429,
          statusText: "Too Many Requests",
          headers: {
            "retry-after": "soon",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1700000000"
          }
        })
      ]);

      await expect(
        fetchGitHubText(
          URL_UNDER_TEST,
          {},
          { fetchImpl, sleep: noDelay, random: noJitter }
        )
      ).rejects.toThrow(
        "after 1 attempt: 429 Too Many Requests (rate limit exhausted until 2023-11-14T22:13:20.000Z)"
      );
      expect(calls()).toBe(1);
    });

    it("ignores an exhausted quota header on a plain server error", async () => {
      const { fetchImpl, calls } = respondInOrder([
        new Response("busy", {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "x-ratelimit-remaining": "0" }
        }),
        new Response("contents")
      ]);

      const result = await fetchGitHubText(
        URL_UNDER_TEST,
        {},
        { fetchImpl, sleep: noDelay, retryDelaysMs: [7], random: noJitter }
      );

      expect(result.text).toBe("contents");
      expect(calls()).toBe(2);
    });
  });

  describe("timeouts and cancellation", () => {
    it("retries an attempt that exceeds its own timeout", async () => {
      let calls = 0;
      const fetchImpl: typeof fetch = (_url, init) => {
        calls += 1;
        if (calls > 1) {
          return Promise.resolve(new Response("contents"));
        }
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(init.signal?.reason);
            },
            { once: true }
          );
        });
      };

      const result = await fetchGitHubText(
        URL_UNDER_TEST,
        {},
        {
          fetchImpl,
          sleep: noDelay,
          retryDelaysMs: [5],
          attemptTimeoutMs: 5,
          random: noJitter
        }
      );

      expect(result).toEqual({ text: "contents", attempts: 2 });
      expect(calls).toBe(2);
    });

    it("reports a terminal timeout with its deadline", async () => {
      const fetchImpl: typeof fetch = (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(init.signal?.reason);
            },
            { once: true }
          );
        });

      await expect(
        fetchGitHubText(
          URL_UNDER_TEST,
          {},
          {
            fetchImpl,
            sleep: noDelay,
            retryDelaysMs: [],
            attemptTimeoutMs: 5,
            random: noJitter
          }
        )
      ).rejects.toThrow(
        `failed to fetch ${URL_UNDER_TEST} after 1 attempt: timed out after 5ms`
      );
    });

    it("does not retry when the caller cancels mid-flight", async () => {
      const caller = new AbortController();
      let calls = 0;
      const fetchImpl: typeof fetch = (_url, init) =>
        new Promise((_resolve, reject) => {
          calls += 1;
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(init.signal?.reason);
            },
            { once: true }
          );
          caller.abort(new Error("caller stopped"));
        });

      await expect(
        fetchGitHubText(
          URL_UNDER_TEST,
          {},
          {
            fetchImpl,
            sleep: noDelay,
            retryDelaysMs: [5, 10],
            signal: caller.signal,
            random: noJitter
          }
        )
      ).rejects.toThrow(
        `failed to fetch ${URL_UNDER_TEST} after 1 attempt: cancelled by caller: caller stopped`
      );
      expect(calls).toBe(1);
    });

    it("fails immediately when the caller signal is already aborted", async () => {
      const caller = new AbortController();
      caller.abort(new Error("caller gave up"));
      let calls = 0;
      const fetchImpl: typeof fetch = async (_url, init) => {
        calls += 1;
        if (init?.signal?.aborted) {
          throw init.signal.reason;
        }
        return new Response("contents");
      };

      await expect(
        fetchGitHubText(
          URL_UNDER_TEST,
          {},
          {
            fetchImpl,
            sleep: noDelay,
            retryDelaysMs: [5],
            signal: caller.signal,
            random: noJitter
          }
        )
      ).rejects.toThrow("after 1 attempt: cancelled by caller: caller gave up");
      expect(calls).toBe(1);
    });

    it("describes a non-Error rejection", async () => {
      const fetchImpl: typeof fetch = async () => {
        throw "socket hang up";
      };

      await expect(
        fetchGitHubText(
          URL_UNDER_TEST,
          {},
          {
            fetchImpl,
            sleep: noDelay,
            retryDelaysMs: [],
            random: noJitter
          }
        )
      ).rejects.toThrow("after 1 attempt: socket hang up");
    });
  });
});

describe("fetchExtensionFile", () => {
  it("requests the raw contents API with an encoded ref", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    vi.stubEnv("GITHUB_TOKEN", "");
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response("template contents");
    };

    const contents = await fetchExtensionFile(
      "owner/repo",
      ".github/extension",
      "deploy.yml",
      "sha with space",
      { fetchImpl, sleep: noDelay, random: noJitter }
    );

    expect(contents).toBe("template contents");
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "https://api.github.com/repos/owner/repo/contents/.github/extension/deploy.yml?ref=sha%20with%20space"
    );
    expect(requests[0].init?.headers).toMatchObject({
      Accept: "application/vnd.github.raw"
    });
  });

  it("surfaces a missing template as a permanent failure", async () => {
    const missing = new Response("missing", {
      status: 404,
      statusText: "Not Found"
    });
    const cancelBody = spyOnBodyCancel(missing);
    const { fetchImpl, calls } = respondInOrder([missing]);

    await expect(
      fetchExtensionFile(
        "owner/repo",
        ".github/extension",
        "missing.yml",
        "main",
        { fetchImpl, sleep: noDelay, random: noJitter }
      )
    ).rejects.toThrow(
      "failed to fetch https://api.github.com/repos/owner/repo/contents/.github/extension/missing.yml?ref=main after 1 attempt: 404 Not Found"
    );
    expect(calls()).toBe(1);
    expect(cancelBody).toHaveBeenCalledOnce();
  });

  it("recovers from a transient upstream failure", async () => {
    const { fetchImpl, calls } = respondInOrder([
      new Response("try again", {
        status: 500,
        statusText: "Internal Server Error"
      }),
      new Response("template contents")
    ]);

    const contents = await fetchExtensionFile(
      "owner/repo",
      ".github/extension",
      "deploy.yml",
      "main",
      { fetchImpl, sleep: noDelay, retryDelaysMs: [5], random: noJitter }
    );

    expect(contents).toBe("template contents");
    expect(calls()).toBe(2);
  });
});
