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

  describe.each([0, 1, 2, 3, 4, 6])(
    "with %i enclosing serialization rounds",
    (rounds) => {
      const serialize = (input: string) => {
        for (let round = 0; round < rounds; round++)
          input = JSON.stringify(input);
        return input;
      };

      it.each(["\n", "\t", "\r", " \r\n\t "])(
        "masks a value after legal JSON whitespace %j",
        (whitespace) => {
          const input = `{"client_secret":${whitespace}"fixture-secret","message":"ordinary"}`;
          const expected = serialize(
            input.replace("fixture-secret", "[REDACTED]")
          );

          const result = redactCredentials(serialize(input));
          expect(result).toBe(expected);
          expect(redactCredentials(result)).toBe(expected);
        }
      );

      it.each([
        [
          String.raw`password='fixture\'suffix' message=ordinary`,
          "password='[REDACTED]' message=ordinary"
        ],
        [
          String.raw`password='fixture\\' message=ordinary`,
          "password='[REDACTED]' message=ordinary"
        ],
        [String.raw`password='fixture\'suffix`, "password='[REDACTED]"],
        [
          String.raw`password='fixture\'suffix'&client_secret='fixture-next'&message=ordinary`,
          "password='[REDACTED]'&client_secret='[REDACTED]'&message=ordinary"
        ],
        [
          String.raw`{"password": 'fixture\'suffix', "message": "ordinary"}`,
          `{"password": '[REDACTED]', "message": "ordinary"}`
        ],
        [
          String.raw`password=fixture\nliteral message=ordinary`,
          "password=[REDACTED] message=ordinary"
        ],
        [
          "ordinary text with 'apostrophes' and \\n",
          "ordinary text with 'apostrophes' and \\n"
        ]
      ])("preserves safe boundaries in %j", (input, expected) => {
        // An unterminated credential consumes the enclosing string terminator.
        const serializedExpected = serialize(expected);
        const result = redactCredentials(serialize(input));
        expect(result).toBe(
          input === String.raw`password='fixture\'suffix` ?
            serializedExpected.slice(
              0,
              serializedExpected.indexOf("[REDACTED]") + "[REDACTED]".length
            )
          : serializedExpected
        );
        expect(redactCredentials(result)).toBe(result);
      });
    }
  );

  describe.each([0, 1, 2, 3, 4, 6])(
    "with %i serialization rounds inside framed diagnostics",
    (rounds) => {
      const serialize = (input: string) => {
        for (let round = 0; round < rounds; round++)
          input = JSON.stringify(input);
        return input;
      };
      const secret = String.raw`fixture\'suffix`;
      const raw = `password='${secret}' message=ordinary url=https://example.invalid/status`;
      const safe = raw.replace(secret, "[REDACTED]");

      it.each(["Error: ", "build\tstep\t2026-10-07T12:00:00Z Error: "])(
        "masks the complete apostrophe-delimited value after %j",
        (prefix) => {
          const expected = prefix + serialize(safe);
          const result = redactCredentials(prefix + serialize(raw));
          expect(result).toBe(expected);
          expect(redactCredentials(result)).toBe(expected);
        }
      );

      it.each(["message", "password"])(
        "handles a %s JSON field containing apostrophe-delimited text",
        (key) => {
          const input = JSON.stringify({ [key]: raw, note: "ordinary" });
          const expected = serialize(
            JSON.stringify({
              [key]: key === "password" ? "[REDACTED]" : safe,
              note: "ordinary"
            })
          );
          const result = redactCredentials("##[error] " + serialize(input));
          expect(result).toBe("##[error] " + expected);
          expect(redactCredentials(result)).toBe(result);
        }
      );

      it.each(["\n", "\t", "\r", " \r\n\t "])(
        "skips encoded whitespace %j only before an actual quoted value",
        (whitespace) => {
          const input = `password=${whitespace}'fixturesecretvalue' ok`;
          const expected =
            "Error: " +
            serialize(input.replace("fixturesecretvalue", "[REDACTED]"));
          expect(redactCredentials("Error: " + serialize(input))).toBe(
            expected
          );
        }
      );

      it("keeps separate quote contexts for adjacent serialization depths", () => {
        const input =
          serialize(raw) +
          " next: " +
          JSON.stringify(JSON.stringify(raw)) +
          " " +
          String.raw`"note" password=\nfixturesecret url=https://example.invalid/status`;
        const expected =
          serialize(safe) +
          " next: " +
          JSON.stringify(JSON.stringify(safe)) +
          ' "note" password=[REDACTED] url=https://example.invalid/status';
        expect(redactCredentials(input)).toBe(expected);
      });

      it("conservatively masks an unterminated credential in a framed string", () => {
        const input = "Error: " + serialize(`password='${secret}`);
        const expected = "Error: " + serialize("password='[REDACTED]");
        const result = redactCredentials(input);
        expect(result).toBe(
          expected.slice(
            0,
            expected.indexOf("[REDACTED]") + "[REDACTED]".length
          )
        );
        expect(redactCredentials(result)).toBe(result);
      });

      it("includes encoded whitespace in an unquoted credential rather than treating it as a delimiter", () => {
        const input = "Error: " + serialize("password=\nfixturesecretvalue ok");
        const expected =
          "Error: " +
          serialize(
            rounds === 0 ? "password=\n[REDACTED] ok" : "password=[REDACTED] ok"
          );
        expect(redactCredentials(input)).toBe(expected);
      });
    }
  );

  it("ends an incomplete inner quote context at the enclosing terminator", () => {
    const prefix = "Error: " + JSON.stringify('ordinary "unterminated') + " ";
    const input = prefix + String.raw`password='fixture\'suffix' ok`;
    const expected = prefix + "password='[REDACTED]' ok";
    expect(redactCredentials(input)).toBe(expected);
    expect(redactCredentials(expected)).toBe(expected);
  });

  describe.each(["\n", "\r\n", "\r"])(
    "with independent log lines separated by %j",
    (newline) => {
      it.each([0, 1, 2, 3, 4, 6])(
        "does not carry an earlier unbalanced quote into %i serialization rounds",
        (rounds) => {
          const serialize = (text: string): string => {
            for (let round = 0; round < rounds; round++)
              text = JSON.stringify(text);
            return text;
          };
          for (const earlier of [
            `Deploy\tRun\tError: unexpected token '"'`,
            `Deploy\tRun\tError: unexpected token '""'`
          ]) {
            const prefix = earlier + newline + "Deploy\tRun\tError: ";
            const diagnostic = String.raw`password='fixture\'suffixsecret' message=ordinary`;
            const whitespace =
              "password=\n\t'fixturesecretvalue' message=ordinary";
            const input =
              prefix +
              serialize(diagnostic) +
              newline +
              "Deploy\tRun\tError: " +
              serialize(whitespace) +
              newline +
              "Deploy\tRun\tError: " +
              serialize(diagnostic);
            const expected =
              prefix +
              serialize("password='[REDACTED]' message=ordinary") +
              newline +
              "Deploy\tRun\tError: " +
              serialize("password=\n\t'[REDACTED]' message=ordinary") +
              newline +
              "Deploy\tRun\tError: " +
              serialize("password='[REDACTED]' message=ordinary");
            const result = redactCredentials(input);
            expect(result).toBe(expected);
            expect(redactCredentials(result)).toBe(result);
          }
        }
      );

      it("clears enclosing context when a masked opaque value crosses a raw line boundary", () => {
        const prefix = "Error: \"password='fixture" + newline + "suffix' ";
        const diagnostic = JSON.stringify(
          String.raw`password='fixture\'suffixsecret' message=ordinary`
        );
        expect(redactCredentials(prefix + diagnostic)).toBe(
          "Error: \"password='[REDACTED]' " +
            JSON.stringify("password='[REDACTED]' message=ordinary")
        );
      });
    }
  );

  it.each(["", '"', '"ordinary"', String.raw`"note" password=\nfixturesecret`])(
    "does not confuse closed or incomplete ordinary quotes with serialization in %j",
    (input) => {
      expect(redactCredentials(input)).toBe(
        input.includes("password=") ? '"note" password=[REDACTED]' : input
      );
    }
  );

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
