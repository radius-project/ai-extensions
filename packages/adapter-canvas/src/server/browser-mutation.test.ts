import { describe, expect, it } from "vitest";
import { validateBrowserMutationRequest } from "./browser-mutation.js";
import type { IncomingMessage } from "node:http";

function request(headers: IncomingMessage["headers"]): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("browser mutation validation", () => {
  const validHeaders = {
    host: "127.0.0.1:45123",
    origin: "http://127.0.0.1:45123",
    "sec-fetch-site": "same-origin",
    "x-radius-mutation-nonce": "browser-nonce"
  };

  it("accepts only an exact same-origin loopback request with the instance nonce", () => {
    expect(
      validateBrowserMutationRequest({
        request: request(validHeaders),
        baseUrl: "http://127.0.0.1:45123",
        nonce: "browser-nonce"
      })
    ).toBe(true);
  });

  it.each([
    ["missing base URL", "", "browser-nonce"],
    ["missing nonce configuration", "http://127.0.0.1:45123", ""]
  ])("fails closed for %s", (_label, baseUrl, nonce) => {
    expect(
      validateBrowserMutationRequest({
        request: request(validHeaders),
        baseUrl,
        nonce
      })
    ).toBe(false);
  });

  it.each([
    ["missing host", { ...validHeaders, host: undefined }],
    ["wrong host", { ...validHeaders, host: "localhost:45123" }],
    ["missing origin", { ...validHeaders, origin: undefined }],
    ["cross origin", { ...validHeaders, origin: "https://example.test" }],
    [
      "missing fetch metadata",
      { ...validHeaders, "sec-fetch-site": undefined }
    ],
    ["cross site", { ...validHeaders, "sec-fetch-site": "cross-site" }],
    [
      "missing nonce",
      { ...validHeaders, "x-radius-mutation-nonce": undefined }
    ],
    ["wrong nonce", { ...validHeaders, "x-radius-mutation-nonce": "other" }]
  ])("rejects %s", (_label, headers) => {
    expect(
      validateBrowserMutationRequest({
        request: request(headers),
        baseUrl: "http://127.0.0.1:45123",
        nonce: "browser-nonce"
      })
    ).toBe(false);
  });
});
