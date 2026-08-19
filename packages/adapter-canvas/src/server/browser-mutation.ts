import type { IncomingMessage } from "node:http";

export function validateBrowserMutationRequest(input: {
  request: IncomingMessage;
  baseUrl: string;
  nonce: string;
}): boolean {
  if (!input.baseUrl || !input.nonce) return false;
  const expected = new URL(input.baseUrl);
  return (
    input.request.headers.host === expected.host &&
    input.request.headers.origin === expected.origin &&
    input.request.headers["sec-fetch-site"] === "same-origin" &&
    input.request.headers["x-radius-mutation-nonce"] === input.nonce
  );
}
