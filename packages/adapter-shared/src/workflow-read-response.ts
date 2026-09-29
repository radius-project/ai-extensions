import type {
  WorkflowReadTiming,
  WorkflowResponseMetadata
} from "@radius-project/core";
import type {
  WorkflowCommandResult,
  WorkflowReadOptions,
  WorkflowRunner
} from "./workflow-reads.js";

export interface WorkflowApiResponse {
  metadata: WorkflowResponseMetadata;
  value: unknown;
  nextLink: string | null;
  ok: boolean;
  failure: "response" | "command" | "json" | null;
  commandAuthorizationFailure: boolean;
  commandAuthorizationStatus: 401 | 403 | null;
  commandMissing: boolean;
  diagnostic: string;
}

const absent: WorkflowReadTiming = { state: "absent" };
const invalid: WorkflowReadTiming = { state: "invalid" };
const HTTP_DATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

function integer(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function dateTiming(value: string): WorkflowReadTiming {
  const parsed = Date.parse(value);
  return (
      HTTP_DATE.test(value) &&
        Number.isSafeInteger(parsed) &&
        new Date(parsed).toUTCString() === value
    ) ?
      { state: "deadline", epochMilliseconds: parsed }
    : invalid;
}

function timing(
  value: string | undefined,
  kind: "retry" | "reset" | "date"
): WorkflowReadTiming {
  if (value === undefined) return absent;
  if (kind === "date") return dateTiming(value);
  const seconds = integer(value);
  if (seconds === null) return kind === "retry" ? dateTiming(value) : invalid;
  const milliseconds = seconds * 1000;
  if (!Number.isSafeInteger(milliseconds)) return invalid;
  return kind === "retry" ?
      { state: "delay", milliseconds }
    : { state: "deadline", epochMilliseconds: milliseconds };
}

function message(value: unknown): string {
  return (
      value !== null &&
        typeof value === "object" &&
        "message" in value &&
        typeof value.message === "string"
    ) ?
      value.message
    : "";
}

export function parseWorkflowApiResponse(
  result: WorkflowCommandResult,
  receivedAtEpochMilliseconds: number
): WorkflowApiResponse {
  const commandAuthorizationFailure =
    Number(result.code) !== 0 &&
    /HTTP 40[13]\b|\bForbidden\b/i.test(result.stderr);
  const commandRateLimited =
    /HTTP 429|Retry-After:|X-RateLimit-Remaining:\s*0|secondary rate limit|(?:API|primary) rate limit (?:exceeded|reached)/i.test(
      result.stderr
    );
  const commandAuthorizationStatus =
    Number(result.code) === 0 ? null
    : /HTTP 401\b/i.test(result.stderr) ? 401
    : (
      !commandRateLimited &&
      /HTTP 403\b|SAML enforcement|grant your OAuth token access/i.test(
        result.stderr
      )
    ) ?
      403
    : null;
  const commandMissing =
    Number(result.code) !== 0 && /HTTP 404\b/i.test(result.stderr);
  const unavailable = (): WorkflowApiResponse => ({
    metadata: { source: "unavailable", reason: "invalid-response" },
    value: null,
    nextLink: null,
    ok: false,
    failure: "response",
    commandAuthorizationFailure,
    commandAuthorizationStatus,
    commandMissing,
    diagnostic: result.stderr.trim()
  });
  const match =
    /^HTTP\/(?:1\.[01]|2(?:\.0)?|3(?:\.0)?) ([2-5]\d{2})(?: [^\r\n]*)?\r?\n/.exec(
      result.stdout
    );
  if (!match) return unavailable();
  const headers = new Map<string, string>();
  const rest = result.stdout.slice(match[0].length);
  const end = /\r?\n\r?\n/.exec(rest);
  // An empty header section starts with its own terminating newline.
  const empty = /^\r?\n/.exec(rest);
  let headerText = "";
  let body: string;
  if (empty) body = rest.slice(empty[0].length);
  else if (end) {
    headerText = rest.slice(0, end.index);
    body = rest.slice(end.index + end[0].length);
  } else return unavailable();
  for (const line of headerText ? headerText.split(/\r?\n/) : []) {
    const header = /^([!#$%&'*+.^_`|~\w-]+):[ \t]*([^\r\n]*)$/.exec(line);
    if (!header) return unavailable();
    const name = header[1].toLowerCase();
    const value = header[2].trim();
    headers.set(
      name,
      headers.has(name) ? `${headers.get(name)}, ${value}` : value
    );
  }
  let value: unknown;
  let validJson = true;
  try {
    value = JSON.parse(body);
  } catch {
    value = null;
    validJson = false;
  }
  const status = Number(match[1]);
  const retryAfter = timing(headers.get("retry-after"), "retry");
  const remaining = headers.get("x-ratelimit-remaining");
  const rateLimitRemaining =
    remaining === undefined ? null : integer(remaining);
  const detail = `${result.stderr}\n${message(value)}`;
  const explicitAuthorization =
    /SAML enforcement|grant your OAuth token access|resource not accessible by|insufficient permission|permission denied/i.test(
      detail
    ) || headers.has("x-github-sso");
  const rateLimited =
    status === 429 ||
    (status === 403 &&
      (rateLimitRemaining === 0 ||
        retryAfter.state === "delay" ||
        retryAfter.state === "deadline" ||
        /secondary rate limit|(?:API|primary) rate limit (?:exceeded|reached)/i.test(
          detail
        )));
  return {
    metadata: {
      source: "gh-api-include",
      status,
      receivedAtEpochMilliseconds,
      retryAfter,
      rateLimitReset: timing(headers.get("x-ratelimit-reset"), "reset"),
      serverDate: timing(headers.get("date"), "date"),
      rateLimitRemaining,
      classification:
        status === 401 || (status === 403 && explicitAuthorization) ?
          "authorization"
        : rateLimited ? "rate-limit"
        : status === 403 ? "authorization"
        : "other"
    },
    value,
    nextLink: headers.get("link") ?? null,
    ok: Number(result.code) === 0 && status < 300 && validJson,
    failure:
      Number(result.code) !== 0 || status >= 300 ? "command"
      : !validJson ? "json"
      : null,
    commandAuthorizationFailure,
    commandAuthorizationStatus,
    commandMissing,
    diagnostic: result.stderr.trim()
  };
}

export async function readWorkflowApi(
  run: WorkflowRunner,
  endpoint: string,
  options: WorkflowReadOptions,
  now: () => number = Date.now
): Promise<WorkflowApiResponse> {
  const result = await run(
    ["api", endpoint, "--include", "--method", "GET"],
    options
  );
  return parseWorkflowApiResponse(result, now());
}
