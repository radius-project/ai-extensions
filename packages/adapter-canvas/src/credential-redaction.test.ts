import { describe, expect, it } from "vitest";
import { redactCredentials } from "./credential-redaction.js";

describe("redactCredentials", () => {
  it("redacts opaque credentials supplied by a process boundary", () => {
    expect(
      redactCredentials("failed with opaque-fixture-token", [
        "  opaque-fixture-token  "
      ])
    ).toBe("failed with [REDACTED]");
  });

  it("does not redact incidental short values", () => {
    expect(
      redactCredentials("authentication token unavailable", ["token"])
    ).toBe("authentication token unavailable");
  });

  it.each([
    ["a classic GitHub token", "ghp_fixture_secret"],
    ["a fine-grained GitHub token", "github_pat_fixture_secret"],
    [
      "a JSON web token",
      "eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJmaXh0dXJlIn0.fixture_signature"
    ]
  ])("redacts %s by its recognizable shape", (_label, credential) => {
    expect(redactCredentials(`failure: ${credential}`)).toBe(
      "failure: [REDACTED]"
    );
  });

  it.each([
    ['{"accessToken":"secret-value"}', '{"accessToken":"[REDACTED]"}'],
    ["refresh_token=secret-value", "refresh_token=[REDACTED]"],
    ["client-secret: 'secret-value'", "client-secret: '[REDACTED]'"],
    ['federated_token="prefix secret suffix"', 'federated_token="[REDACTED]"'],
    ["password=secret-value", "password=[REDACTED]"]
  ])("redacts named credential output in %s", (value, expected) => {
    expect(redactCredentials(value)).toBe(expected);
  });

  it("preserves ordinary Azure identifiers and diagnostics", () => {
    const value =
      '{"tenantId":"00000000-0000-0000-0000-000000000001","message":"not found"}';
    expect(redactCredentials(value)).toBe(value);
  });
});
