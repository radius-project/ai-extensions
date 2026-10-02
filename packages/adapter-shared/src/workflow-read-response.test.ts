import { describe, expect, it, vi } from "vitest";
import {
  createWorkflowReadContext,
  createWorkflowReadCooldowns,
  type WorkflowReadTiming
} from "@radius-project/core";
import {
  parseWorkflowApiResponse,
  readWorkflowApi,
  readWorkflowApiWithPolicy
} from "./workflow-read-response.js";

function response(
  headers = "",
  body = "{}",
  status = 200,
  code: number | string = status >= 400 ? 1 : 0,
  stderr = ""
) {
  return parseWorkflowApiResponse(
    {
      code,
      stdout: `HTTP/2.0 ${status} Response\n${headers}\r\n${body}`,
      stderr
    },
    1234
  );
}

describe("workflow response metadata", () => {
  describe.each([403, 429])("rate-limit HTTP %s", (status) => {
    it.each([
      ["secondary rate limit", 5, "", "102", "missing-deadline", []],
      ["secondary rate limit", 0, "", "102", "missing-deadline", []],
      ["secondary rate limit", 0, "invalid", "102", "invalid-deadline", []],
      ["API rate limit exceeded", 0, "", "102", "ready", [3000]],
      ["secondary rate limit", 0, "4", "102", "ready", [4000]],
      ["secondary rate limit", 0, "2", "105", "ready", [6000]],
      ["secondary rate limit", 5, "2", "105", "ready", [2000]],
      ["secondary rate limit", 0, "2", "invalid", "invalid-deadline", []]
    ] as const)(
      "bounds %s with remaining=%s Retry-After=%s reset=%s",
      async (message, remaining, retryAfter, reset, decision, waits) => {
        let now = 0;
        const slept: number[] = [];
        const clock = {
          monotonic: () => now,
          wall: () => 100000 + now,
          jitter: () => 0,
          sleep: async (ms: number) => {
            slept.push(ms);
            now += ms;
          }
        };
        const context = createWorkflowReadContext({
          clock,
          cooldowns: createWorkflowReadCooldowns(clock.monotonic),
          timeout: 15000,
          stopped: () => false
        });
        let calls = 0;
        const runner = vi.fn(async () =>
          ++calls === 1 ?
            {
              code: 1,
              stdout: `HTTP/2 ${status}\nDate: Thu, 01 Jan 1970 00:01:40 GMT\nX-RateLimit-Remaining: ${remaining}\nX-RateLimit-Reset: ${reset}\n${retryAfter ? `Retry-After: ${retryAfter}\n` : ""}\n${JSON.stringify({ message })}`,
              stderr: ""
            }
          : { code: 0, stdout: "HTTP/2 200\n\n{}", stderr: "" }
        );
        const result = await readWorkflowApiWithPolicy(
          runner,
          "/repos/org/app/actions/runs/41",
          { timeout: 15000 },
          context,
          "run",
          15000
        );
        expect(result.decision).toEqual(
          decision === "ready" ?
            { state: "ready" }
          : { state: "deferred", reason: decision }
        );
        expect(slept).toEqual(waits);
        expect(calls).toBe(decision === "ready" ? 2 : 1);
      }
    );
  });

  it.each([
    ["elapsed", "timeout"],
    ["cancelled", "cancelled"],
    ["capacity", "deferred"]
  ] as const)(
    "reports unadmitted %s reads without invoking the runner",
    async (reason, unavailable) => {
      const clock = {
        monotonic: () => 0,
        wall: () => 1234,
        jitter: () => 0,
        sleep: () => {
          throw new Error("Unexpected wait");
        }
      };
      const cooldowns = createWorkflowReadCooldowns(clock.monotonic);
      if (reason === "capacity")
        for (let i = 0; i < 32; i++) cooldowns.acquire(`active-${i}`);
      const context = createWorkflowReadContext({
        clock,
        cooldowns,
        timeout: 1000,
        stopped: () => reason === "cancelled"
      });
      const runner = vi.fn(async () => {
        throw new Error("Unexpected GET");
      });
      const result = await readWorkflowApiWithPolicy(
        runner,
        "/repos/org/app/actions/runs/41",
        { timeout: 1000 },
        context,
        "run",
        reason === "elapsed" ? 0 : 1000
      );
      expect(result.metadata).toEqual({
        source: "unavailable",
        reason: unavailable
      });
      expect(result.decision).toMatchObject({ reason });
      expect(runner).not.toHaveBeenCalled();
    }
  );

  it("executes the real default-observer binding for an admitted GET", async () => {
    const clock = {
      monotonic: () => 0,
      wall: () => 1234,
      jitter: () => 0,
      sleep: () => {
        throw new Error("Unexpected wait");
      }
    };
    const context = createWorkflowReadContext({
      clock,
      cooldowns: createWorkflowReadCooldowns(clock.monotonic),
      timeout: 1000,
      stopped: () => false
    });
    const runner = vi.fn(async () => ({
      code: 0,
      stdout: "HTTP/2 200\n\n{}",
      stderr: ""
    }));
    expect(
      await readWorkflowApiWithPolicy(
        runner,
        "/repos/org/app/actions/runs/41",
        { timeout: 1000 },
        context,
        "run",
        1000
      )
    ).toMatchObject({
      ok: true,
      decision: { state: "ready" },
      metadata: { receivedAtEpochMilliseconds: 1234 }
    });
    expect(runner).toHaveBeenCalledExactlyOnceWith(
      ["api", "/repos/org/app/actions/runs/41", "--include", "--method", "GET"],
      { timeout: 1000 }
    );
  });
  it("uses the real status and receipt time without publishing arbitrary headers/body", () => {
    const parsed = response(
      "Authorization: fixture-private\r\nSet-Cookie: fixture-cookie\r\n",
      '{"message":"fixture-body"}',
      201
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: { message: "fixture-body" },
      metadata: {
        source: "gh-api-include",
        status: 201,
        receivedAtEpochMilliseconds: 1234,
        retryAfter: { state: "absent" },
        rateLimitRemaining: null
      }
    });
    expect(JSON.stringify(parsed.metadata)).not.toContain("fixture");
  });

  it.each([
    ["Retry-After: 0\r\n", { state: "delay", milliseconds: 0 }],
    ["retry-after: 60\r\n", { state: "delay", milliseconds: 60000 }],
    [
      "Retry-After: Mon, 28 Sep 2026 00:00:00 GMT\r\n",
      { state: "deadline", epochMilliseconds: 1790553600000 }
    ],
    ...[
      "",
      "-1",
      "1.5",
      "Infinity",
      "9007199254740992",
      "9007199254741",
      "120, 60",
      "not a date",
      "Tue, 28 Sep 2026 00:00:00 GMT"
    ].map((value): [string, WorkflowReadTiming] => [
      `Retry-After: ${value}\r\n`,
      { state: "invalid" }
    ]),
    ["Retry-After: 1\r\nRetry-After: 2\r\n", { state: "invalid" }]
  ])("preserves Retry-After provenance for %j", (headers, retryAfter) => {
    expect(response(headers).metadata).toMatchObject({ retryAfter });
  });

  it.each([
    [
      "X-RateLimit-Reset: 123\r\n",
      { state: "deadline", epochMilliseconds: 123000 }
    ],
    ["X-RateLimit-Reset: no\r\n", { state: "invalid" }],
    ["X-RateLimit-Reset: 9007199254741\r\n", { state: "invalid" }]
  ])(
    "normalizes reset seconds independently: %s",
    (headers, rateLimitReset) => {
      expect(response(headers).metadata).toMatchObject({ rateLimitReset });
    }
  );

  it("normalizes Date and remaining independently of rate classification", () => {
    expect(
      response(
        "Date: Mon, 28 Sep 2026 00:00:00 GMT\r\nX-RateLimit-Remaining: 0\r\n",
        "{}",
        403
      ).metadata
    ).toMatchObject({
      classification: "rate-limit",
      rateLimitRemaining: 0,
      serverDate: { state: "deadline", epochMilliseconds: 1790553600000 }
    });
    expect(
      response("Date: invalid\r\nX-RateLimit-Remaining: -1\r\n").metadata
    ).toMatchObject({
      serverDate: { state: "invalid" },
      rateLimitRemaining: null
    });
  });

  it.each([
    [401, "", "{}", "", "authorization"],
    [403, "", "{}", "", "authorization"],
    [403, "Retry-After: 2\r\n", "{}", "", "rate-limit"],
    [
      403,
      "Retry-After: Mon, 28 Sep 2026 00:00:00 GMT\r\n",
      "{}",
      "",
      "rate-limit"
    ],
    [403, "", '{"message":"secondary rate limit"}', "", "rate-limit"],
    [403, "", "{}", "API rate limit exceeded", "rate-limit"],
    [
      403,
      "Retry-After: 2\r\n",
      '{"message":"Resource protected by organization SAML enforcement"}',
      "",
      "authorization"
    ],
    [
      403,
      "X-GitHub-SSO: required\r\nRetry-After: 2\r\n",
      "{}",
      "",
      "authorization"
    ],
    [
      403,
      "Retry-After: 2\r\n",
      '{"message":"Resource not accessible by integration"}',
      "",
      "authorization"
    ],
    [429, "", "{}", "", "rate-limit"],
    [503, "", "{}", "", "other"]
  ])(
    "classifies framed HTTP %i without deriving timing from messages",
    (status, headers, body, stderr, classification) => {
      const result = response(headers, body, status, 1, stderr);
      expect(result.metadata).toMatchObject({ status, classification });
      expect(result.ok).toBe(false);
      expect(result.failure).toBe("command");
    }
  );

  it.each([
    "",
    "{}",
    "HTTP 429 Retry-After: 1",
    "HTTP/2 200\n",
    "HTTP/2 200\nBad header\r\n\r\n{}",
    "HTTP/2 200\n\u001b[1mRetry-After\u001b[0m: 3\r\n\r\n{}",
    "HTTP/1.1 100 Continue\r\n\r\nHTTP/2 200\r\n\r\n{}",
    "HTTP/2 200\nRetry-After: 1\r\n"
  ])("rejects unavailable or ambiguous framing %j", (stdout) => {
    expect(
      parseWorkflowApiResponse({ code: 0, stdout, stderr: "" }, 0)
    ).toMatchObject({
      ok: false,
      metadata: { source: "unavailable", reason: "invalid-response" },
      value: null
    });
  });

  it.each([
    "HTTP/1.0 200\n\n{}",
    "HTTP/1.1 200 OK\r\n\r\n{}",
    "HTTP/2 200\n\n{}",
    'HTTP/3 200\nLink: <https://example.test>; rel="next"\n\n{}'
  ])("accepts LF, CRLF and mixed response framing %j", (stdout) => {
    expect(
      parseWorkflowApiResponse({ code: 0, stdout, stderr: "" }, 0).ok
    ).toBe(true);
  });

  it.each([
    "not-json",
    "HTTP/2 403\nRetry-After: 5\n\n{}",
    "{}\nHTTP/2 200\n\n{}"
  ])("does not parse body text as headers: %j", (body) => {
    expect(response("", body)).toMatchObject({
      ok: false,
      failure: "json",
      metadata: { status: 200, retryAfter: { state: "absent" } }
    });
  });

  it.each(["null", "[]", '{"message":42}'])(
    "accepts JSON %s without inventing messages",
    (body) => {
      expect(response("", body)).toMatchObject({ ok: true, failure: null });
    }
  );

  it("never turns a failed process or authoritative error status into success", () => {
    expect(response("", "{}", 200, 1).ok).toBe(false);
    expect(response("", "{}", 403, 0).ok).toBe(false);
  });

  it.each([
    [1, "HTTP 401", 401, false],
    [1, "HTTP 403", 403, false],
    [1, "SAML enforcement", 403, false],
    [1, "HTTP 403 Retry-After: 5", null, false],
    [1, "HTTP 404", null, true],
    [0, "HTTP 401", null, false]
  ])(
    "retains unframed command auth evidence without fabricated response metadata",
    (code, stderr, commandAuthorizationStatus, commandMissing) => {
      expect(
        parseWorkflowApiResponse({ code, stderr, stdout: "" }, 0)
      ).toMatchObject({
        metadata: { source: "unavailable" },
        commandAuthorizationStatus,
        commandMissing
      });
    }
  );

  it("constructs only a GET and preserves runner exceptions", async () => {
    const options = { timeout: 15000 };
    expect(
      await readWorkflowApi(
        async (args, supplied) => {
          expect(args).toEqual([
            "api",
            "repos/org/app",
            "--include",
            "--method",
            "GET"
          ]);
          expect(supplied).toBe(options);
          return { code: 0, stdout: "HTTP/2 200\n\n{}", stderr: "" };
        },
        "repos/org/app",
        options,
        () => 9
      )
    ).toMatchObject({ metadata: { receivedAtEpochMilliseconds: 9 } });
    const error = new Error("runner unavailable");
    await expect(
      readWorkflowApi(() => Promise.reject(error), "repos/org/app", options)
    ).rejects.toBe(error);
  });
});
