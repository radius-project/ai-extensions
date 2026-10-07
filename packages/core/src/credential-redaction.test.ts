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

  it("ignores absent and blank credentials and redacts all occurrences at the opaque-value boundary", () => {
    expect(
      redactCredentials("abcdefghijk abcdefghijkl abcdefghijkl", [
        undefined,
        " ",
        "abcdefghijk",
        "abcdefghijkl"
      ])
    ).toBe("abcdefghijk [REDACTED] [REDACTED]");
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

  describe.each([0, 1, 2, 3])("with %i JSON escaping rounds", (rounds) => {
    it.each([
      "",
      "fixture-plain-value",
      'fixture-embedded"suffix',
      "fixture-back\\slash",
      "fixture-trailing\\",
      "fixture-line\nsuffix",
      'fixture-password="inner-value"'
    ])(
      "masks the entire named value %j and preserves its delimiters",
      (secret) => {
        const serialize = (value: string) => {
          let text = JSON.stringify({
            client_secret: value,
            tenantId: "synthetic-tenant"
          });
          for (let round = 0; round < rounds; round++)
            text = JSON.stringify(text);
          return text;
        };
        const expected = serialize("[REDACTED]");
        const result = redactCredentials(serialize(secret));
        expect(result).toBe(expected);
        expect(result).not.toContain("fixture-");
        expect(redactCredentials(result)).toBe(expected);
      }
    );
  });

  it.each([
    [
      String.raw`{\"client_secret\":\"fixture-value\"}`,
      String.raw`{\"client_secret\":\"[REDACTED]\"}`
    ],
    ["ACCESS-TOKEN = 'fixture-value'", "ACCESS-TOKEN = '[REDACTED]'"],
    ['refreshToken:\t""', 'refreshToken:\t"[REDACTED]"'],
    [String.raw`password=fixture\suffix`, "password=[REDACTED]"],
    [String.raw`password=\fixture`, "password=[REDACTED]"],
    [
      String.raw`client_secret=\"fixture-value\"`,
      String.raw`client_secret=\"[REDACTED]\"`
    ],
    [
      String.raw`client_secret=\"fixture-"wrong-level"-suffix\" message=ordinary`,
      String.raw`client_secret=\"[REDACTED]\" message=ordinary`
    ],
    [
      String.raw`password='fixture\'suffix' message=ordinary`,
      "password='[REDACTED]' message=ordinary"
    ],
    [
      'access_token="fixture-first", password=fixture-second, message=ordinary',
      'access_token="[REDACTED]", password=[REDACTED], message=ordinary'
    ],
    [
      String.raw`client_secret=\"fixture-opening` + "\nfixture-suffix",
      String.raw`client_secret=\"[REDACTED]`
    ],
    [
      'client_secret="fixture-opening\nfixture-suffix',
      'client_secret="[REDACTED]'
    ],
    ["password='fixture-opening", "password='[REDACTED]"],
    ["password=", "password="],
    ["password=, message=ordinary", "password=, message=ordinary"],
    ["password=   ", "password=   "],
    ["message=ordinary", "message=ordinary"]
  ])("preserves safe structure for %j", (input, expected) => {
    const result = redactCredentials(input);
    expect(result).toBe(expected);
    expect(result).not.toContain("fixture-");
    expect(redactCredentials(result)).toBe(expected);
  });
});
