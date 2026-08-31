import { describe, expect, it } from "vitest";
import { requireSuccessfulJsonResponse, ServerResponseError } from "./http.js";
import {
  jsonResponse,
  textResponse
} from "../../test/support/browser/fakes.js";

describe("browser HTTP responses", () => {
  it("returns a successful JSON payload", async () => {
    await expect(
      requireSuccessfulJsonResponse(
        jsonResponse({ value: 1 }),
        "Request failed."
      )
    ).resolves.toEqual({ value: 1 });
  });

  it.each([
    [
      "a server-provided error",
      jsonResponse({ error: "Repository access was denied." }, false, 403),
      "Repository access was denied."
    ],
    [
      "an error carried by a legacy successful response",
      jsonResponse({ error: "Credential lookup failed." }),
      "Credential lookup failed."
    ],
    [
      "an HTTP response without an error",
      jsonResponse({}, false, 503),
      "Request failed."
    ],
    [
      "a malformed JSON response",
      textResponse("<html>Unavailable</html>", false, 502),
      "Request failed."
    ]
  ])(
    "throws a safe response error for %s",
    async (_name, response, expected) => {
      const failure = requireSuccessfulJsonResponse(
        response,
        "Request failed."
      );
      await expect(failure).rejects.toEqual(new ServerResponseError(expected));
    }
  );
});
