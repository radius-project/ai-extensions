import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

interface Suppression {
  line: number;
  directive: string;
  rules: string[];
}

interface Inspection {
  findings: string[];
  unavailable: string | null;
}

type FileReferences = { filePaths: string[] } | { error: string };

interface SecurityRulesModule {
  BICEP_CONFIG_FILE: string;
  SECURITY_RULES: readonly string[];
  decodeText(bytes: Buffer): string;
  parseBicepConfig(text: string): { config?: unknown; error?: string };
  configurationProblems(config: unknown): string[];
  securitySuppressions(source: string): Suppression[];
  fileReferencesRequest(app: string): string;
  parseFileReferencesResponse(output: Buffer): FileReferences | null;
  requestFileReferences(
    bicep: string,
    app: string,
    options?: { timeoutMs?: number }
  ): Promise<FileReferences>;
  readFileIfPresent(file: string): Buffer | null;
  inspectSecurityRules(
    filePaths: string[],
    options?: {
      stagingDir?: string | null;
      readFile?: (file: string) => Buffer | null;
    }
  ): Inspection;
}

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.."
);
const modulePath = path.join(
  root,
  "extensions",
  "radius",
  "skills",
  "radius-app-bicep",
  "scripts",
  "bicep-security-rules.mjs"
);
const fakeJsonRpcServer = path.join(
  root,
  "packages",
  "adapter-canvas",
  "test",
  "support",
  "fake-bicep-jsonrpc.mjs"
);
const rules = (await import(
  pathToFileURL(modulePath).href
)) as SecurityRulesModule;

const secureValueRule = "use-secure-value-for-secure-inputs";
const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "bicep-security-rules-")
  );
  temporaryDirectories.add(directory);
  return directory;
}

function ruleLevel(rule: string, level: unknown): object {
  return { analyzers: { core: { rules: { [rule]: { level } } } } };
}

function problemsFor(text: string): string[] {
  const parsed = rules.parseBicepConfig(text);
  expect(parsed.error).toBeUndefined();
  return rules.configurationProblems(parsed.config);
}

function frame(message: unknown): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

describe("security rule list", () => {
  it("protects the credential-safety rules the model relies on", () => {
    expect(rules.SECURITY_RULES).toEqual([
      "use-secure-value-for-secure-inputs",
      "secure-parameter-default",
      "secure-secrets-in-params",
      "outputs-should-not-contain-secrets",
      "secure-params-in-nested-deploy"
    ]);
    expect(Object.isFrozen(rules.SECURITY_RULES)).toBe(true);
    expect(rules.BICEP_CONFIG_FILE).toBe("bicepconfig.json");
  });
});

describe("parseBicepConfig", () => {
  it("parses plain JSON", () => {
    expect(rules.parseBicepConfig('{"a": 1}')).toEqual({ config: { a: 1 } });
  });

  it("ignores line and block comments the way Bicep does", () => {
    const text = [
      "// leading",
      "{",
      '  "a": /* inline */ 1, // trailing',
      "  /* multi",
      "     line */",
      '  "b": 2',
      "}",
      "// no newline at end"
    ].join("\n");

    expect(rules.parseBicepConfig(text)).toEqual({ config: { a: 1, b: 2 } });
  });

  it("ends a line comment at a bare carriage return, as Bicep does", () => {
    expect(rules.parseBicepConfig('{"a": 1 // c\r, "b": 2\n}')).toEqual({
      config: { a: 1, b: 2 }
    });
  });

  it("sees a setting hidden after a bare carriage return", () => {
    const text = `{"analyzers": {"core": {"rules": {"${secureValueRule}": {"level": "warning" // c\r, "level": "off"\n}}}}}`;

    expect(problemsFor(text)).toEqual([
      `analyzers.core.rules.${secureValueRule}.level is "off", which turns the rule off`
    ]);
  });

  it("keeps comment markers and escaped quotes inside strings", () => {
    const text = String.raw`{"url": "https://x/*y*/", "quote": "a\"//b"}`;

    expect(rules.parseBicepConfig(text)).toEqual({
      config: { url: "https://x/*y*/", quote: 'a"//b' }
    });
  });

  it("treats a comment as a separator rather than removing it outright", () => {
    expect(rules.parseBicepConfig("[1/**/2]").error).toBeTypeOf("string");
  });

  it("refuses an unterminated block comment", () => {
    expect(rules.parseBicepConfig('{"a": 1} /* open')).toEqual({
      error: "it has an unterminated comment"
    });
  });

  it.each([
    ["a trailing comma", '{"a": 1,}'],
    ["an empty file", ""],
    ["a truncated document", '{"analyzers":']
  ])("refuses %s", (_name, text) => {
    expect(rules.parseBicepConfig(text).error).toBeTypeOf("string");
  });
});

describe("configurationProblems", () => {
  it("accepts a configuration without an analyzers section", () => {
    expect(
      rules.configurationProblems({ extensions: { radius: "br:x" } })
    ).toEqual([]);
  });

  it.each([
    ["an array", []],
    ["null", null],
    ["a string", "x"]
  ])("refuses a configuration that is %s", (_name, config) => {
    expect(rules.configurationProblems(config)).toEqual([
      "the configuration is not a JSON object, so whether the security rules run cannot be established"
    ]);
  });

  it.each([
    [
      "analyzers",
      { analyzers: [] },
      "analyzers is not an object, so whether the security rules run cannot be established"
    ],
    [
      "analyzers.core",
      { analyzers: { core: "on" } },
      "analyzers.core is not an object, so whether the security rules run cannot be established"
    ],
    [
      "analyzers.core.rules",
      { analyzers: { core: { rules: null } } },
      "analyzers.core.rules is not an object, so whether the security rules run cannot be established"
    ]
  ])("refuses a non-object %s section", (_name, config, problem) => {
    expect(rules.configurationProblems(config)).toEqual([problem]);
  });

  it("accepts an explicitly enabled linter", () => {
    expect(
      rules.configurationProblems({ analyzers: { core: { enabled: true } } })
    ).toEqual([]);
  });

  it("refuses a disabled linter", () => {
    expect(
      rules.configurationProblems({ analyzers: { core: { enabled: false } } })
    ).toEqual([
      "analyzers.core.enabled is false, which turns off the Bicep linter and every security rule with it"
    ]);
  });

  it.each([["false"], [null], [0]])(
    "refuses a linter switch that is %j rather than true",
    (enabled) => {
      expect(
        rules.configurationProblems({ analyzers: { core: { enabled } } })
      ).toEqual([
        `analyzers.core.enabled is ${JSON.stringify(enabled)}, which is not true, so whether the linter runs cannot be established`
      ]);
    }
  );

  it.each([
    "use-secure-value-for-secure-inputs",
    "secure-parameter-default",
    "secure-secrets-in-params",
    "outputs-should-not-contain-secrets",
    "secure-params-in-nested-deploy"
  ])("refuses turning %s off and names it", (rule) => {
    expect(rules.configurationProblems(ruleLevel(rule, "off"))).toEqual([
      `analyzers.core.rules.${rule}.level is "off", which turns the rule off`
    ]);
  });

  it.each([["Off"], [" off "], ["OFF"]])(
    "reads %j as off, because Bicep ignores case and whitespace",
    (level) => {
      expect(
        rules.configurationProblems(ruleLevel(secureValueRule, level))
      ).toEqual([
        `analyzers.core.rules.${secureValueRule}.level is ${JSON.stringify(level)}, which turns the rule off`
      ]);
    }
  );

  it("refuses downgrading a rule to info, which never fails validation", () => {
    expect(
      rules.configurationProblems(ruleLevel(secureValueRule, "Info"))
    ).toEqual([
      `analyzers.core.rules.${secureValueRule}.level is "Info", which reports the rule's findings as notes that do not fail validation`
    ]);
  });

  // Bicep parses the level as an enum, so "0" also means "off". Only the two
  // levels that fail validation are accepted.
  it.each([["0"], ["bogus"], ["off, error"], [""]])(
    "refuses the unrecognized level %j",
    (level) => {
      expect(
        rules.configurationProblems(ruleLevel(secureValueRule, level))
      ).toEqual([
        `analyzers.core.rules.${secureValueRule}.level is ${JSON.stringify(level)}, which is not a level known to enforce the rule`
      ]);
    }
  );

  it.each([[null], [3], [true]])("refuses the non-string level %j", (level) => {
    expect(
      rules.configurationProblems(ruleLevel(secureValueRule, level))
    ).toEqual([
      `analyzers.core.rules.${secureValueRule}.level is ${JSON.stringify(level)}, which is not a level`
    ]);
  });

  it.each([["warning"], ["error"], [" Error "], ["WARNING"]])(
    "accepts the enforcing level %j",
    (level) => {
      expect(
        rules.configurationProblems(ruleLevel(secureValueRule, level))
      ).toEqual([]);
    }
  );

  it.each([[{}], [{ reason: "tracked" }]])(
    "accepts a security rule entry %j that leaves the level at its default",
    (entry) => {
      expect(
        rules.configurationProblems({
          analyzers: { core: { rules: { [secureValueRule]: entry } } }
        })
      ).toEqual([]);
    }
  );

  it("refuses a security rule entry that is not an object", () => {
    expect(
      rules.configurationProblems({
        analyzers: { core: { rules: { [secureValueRule]: "off" } } }
      })
    ).toEqual([
      `analyzers.core.rules.${secureValueRule} is not an object, so whether ${secureValueRule} runs cannot be established`
    ]);
  });

  it("keeps unrelated rules and settings the repository configured", () => {
    expect(
      rules.configurationProblems({
        analyzers: {
          core: {
            verbose: true,
            rules: {
              "no-unused-params": { level: "off" },
              "use-recent-api-versions": "off"
            }
          }
        }
      })
    ).toEqual([]);
  });

  it("reports every disabled security rule in one pass", () => {
    expect(
      rules.configurationProblems({
        analyzers: {
          core: {
            enabled: false,
            rules: {
              [secureValueRule]: { level: "off" },
              "secure-parameter-default": { level: "info" }
            }
          }
        }
      })
    ).toHaveLength(3);
  });

  // Bicep matches these keys case-sensitively today; matching them
  // case-insensitively keeps a more lenient compiler from reopening the gap.
  it("matches section, rule, and level keys regardless of case", () => {
    expect(
      rules.configurationProblems({
        Analyzers: {
          Core: {
            Enabled: false,
            Rules: { "Use-Secure-Value-For-Secure-Inputs": { Level: "off" } }
          }
        }
      })
    ).toEqual([
      "analyzers.core.enabled is false, which turns off the Bicep linter and every security rule with it",
      'analyzers.core.rules.Use-Secure-Value-For-Secure-Inputs.Level is "off", which turns the rule off'
    ]);
  });

  it("follows the last duplicate key, as Bicep does", () => {
    const off = `{"level": "off"}`;
    const error = `{"level": "error"}`;
    const configWith = (first: string, second: string) =>
      `{"analyzers": {"core": {"rules": {"${secureValueRule}": ${first}, "${secureValueRule}": ${second}}}}}`;

    expect(problemsFor(configWith(off, error))).toEqual([]);
    expect(problemsFor(configWith(error, off))).toHaveLength(1);
  });
});

describe("securitySuppressions", () => {
  it("finds a disable-next-line directive and its line", () => {
    const source = [
      "param password string",
      "resource s 'Radius.Security/secrets@2025-08-01-preview' = {",
      `  #disable-next-line ${secureValueRule}`,
      "  properties: {}",
      "}"
    ].join("\n");

    expect(rules.securitySuppressions(source)).toEqual([
      { line: 3, directive: "disable-next-line", rules: [secureValueRule] }
    ]);
  });

  it("finds a disable-diagnostics directive", () => {
    expect(
      rules.securitySuppressions(
        `#disable-diagnostics ${secureValueRule}\nparam x string`
      )
    ).toEqual([
      { line: 1, directive: "disable-diagnostics", rules: [secureValueRule] }
    ]);
  });

  it("names only the security rules among the directive's codes", () => {
    expect(
      rules.securitySuppressions(
        `\t#disable-next-line\tno-unused-params ${secureValueRule}  secure-parameter-default // why`
      )
    ).toEqual([
      {
        line: 1,
        directive: "disable-next-line",
        rules: [secureValueRule, "secure-parameter-default"]
      }
    ]);
  });

  it.each([
    ["a line comment", "// reason"],
    ["a block comment", "/* reason */"]
  ])(
    "ends the codes where %s starts, even without a space",
    (_name, comment) => {
      expect(
        rules.securitySuppressions(
          `#disable-next-line no-unused-params ${secureValueRule}${comment}`
        )[0]?.rules
      ).toEqual([secureValueRule]);
    }
  );

  // Each form was checked against Bicep 0.42.1: the rule is suppressed and the
  // file still compiles.
  it.each([
    [
      "a decorator right after the code",
      `#disable-next-line ${secureValueRule}@secure()`
    ],
    ["a code right after the keyword", `#disable-next-line${secureValueRule}`],
    [
      "a code right after the diagnostics keyword",
      `#disable-diagnostics${secureValueRule}`
    ],
    ["a suffix on the keyword", `#disable-next-linex ${secureValueRule}`]
  ])("reads a directive with %s the way Bicep does", (_name, source) => {
    expect(rules.securitySuppressions(source)[0]?.rules).toEqual([
      secureValueRule
    ]);
  });

  it.each([["|"], ["("], ["'"], ["."], ["é"]])(
    "ends the codes at %j and keeps the code before it",
    (terminator) => {
      expect(
        rules.securitySuppressions(
          `#disable-next-line ${secureValueRule}${terminator}secure-parameter-default`
        )[0]?.rules
      ).toEqual([secureValueRule]);
    }
  );

  it("lexes the text after the codes as code", () => {
    const multiline = "'''";
    expect(
      rules.securitySuppressions(
        `#disable-next-line ${secureValueRule}${multiline}\n#disable-next-line secure-parameter-default\n${multiline}`
      )
    ).toEqual([
      { line: 1, directive: "disable-next-line", rules: [secureValueRule] }
    ]);
  });

  it("ignores a rule named only in the directive's comment", () => {
    expect(
      rules.securitySuppressions(
        `#disable-next-line no-unused-params // ${secureValueRule}`
      )
    ).toEqual([]);
  });

  it("matches a rule code regardless of case", () => {
    expect(
      rules.securitySuppressions(
        "#disable-next-line Use-Secure-Value-For-Secure-Inputs"
      )[0]?.rules
    ).toEqual(["Use-Secure-Value-For-Secure-Inputs"]);
  });

  it.each([
    ["a bare carriage return", "\r"],
    ["a line feed", "\n"],
    ["a CRLF pair", "\r\n"]
  ])("counts %s as one line break", (_name, lineBreak) => {
    expect(
      rules.securitySuppressions(
        [
          "param a string",
          "param b string",
          `#disable-next-line ${secureValueRule}`
        ].join(lineBreak)
      )[0]?.line
    ).toBe(3);
  });

  it("counts lines across CRLF line endings", () => {
    expect(
      rules.securitySuppressions(
        `param a string\r\nparam b string\r\n#disable-next-line ${secureValueRule}\r\nparam c string`
      )[0]?.line
    ).toBe(3);
  });

  it.each([
    ["an unrelated rule", "#disable-next-line no-unused-params"],
    ["a directive with no codes", "#disable-next-line"],
    ["a restore directive", `#restore-diagnostics ${secureValueRule}`],
    [
      "a directive that is not the first token on its line",
      `  value: x #disable-next-line ${secureValueRule}`
    ],
    [
      "a directive inside a line comment",
      `// #disable-next-line ${secureValueRule}`
    ],
    [
      "a directive Bicep does not recognize",
      `#DISABLE-NEXT-LINE ${secureValueRule}`
    ],
    [
      "a code that only starts with a security rule's name",
      `#disable-next-line ${secureValueRule}2`
    ]
  ])("ignores %s", (_name, source) => {
    expect(rules.securitySuppressions(source)).toEqual([]);
  });

  // Each case was checked against Bicep 0.42.1: the directive-shaped line is
  // not a directive to the compiler, and the rule still reports.
  const directive = `#disable-diagnostics ${secureValueRule}`;
  it.each([
    ["a multiline string", `var s = '''\n${directive}\n'''`],
    ["a block comment", `/*\n${directive}\n*/`],
    [
      "a block comment opened after a directive's codes",
      `#disable-next-line no-unused-params /* note\n${directive}\n*/`
    ],
    ["a line after a block comment closes", `/* a\nb */ ${directive}`],
    [
      "a multiline string that holds an interpolation marker",
      `var s = '''\${\n${directive}\n'''`
    ],
    ["an unterminated block comment", `/*\n${directive}`],
    ["an unterminated multiline string", `var s = '''\n${directive}`]
  ])("ignores a directive inside %s", (_name, source) => {
    expect(rules.securitySuppressions(source)).toEqual([]);
  });

  it.each([
    ["an escaped quote", "var s = 'it\\'s'"],
    ["an escaped backslash before the closing quote", "var s = 'a\\\\'"],
    ["an escaped interpolation marker", "var s = 'a\\${b'"],
    ["comment markers inside a string", "var s = '/*'"],
    ["comment markers inside a multiline string", "var s = '''/*'''"],
    ["a quote inside a line comment", "// it's"],
    ["a quote inside a block comment", "/* it's */"],
    ["a multiline string closed by extra quotes", "var s = '''a''''''"],
    ["an interpolation holding a string", "var s = 'x${'y${'}'}'}z'"],
    ["an interpolation holding a multiline string", "var s = 'x${'''}'''}z'"],
    ["an interpolation holding braces", "var s = 'x${ {b: 2}.b }y'"],
    ["braces outside any string", "var o = {\n  a: {}\n}"],
    [
      "a single-line string left open at the line break",
      "var s = 'unterminated"
    ]
  ])("finds a directive on the line after %s", (_name, before) => {
    expect(rules.securitySuppressions(`${before}\n${directive}\n`)).toEqual([
      {
        line: before.split("\n").length + 1,
        directive: "disable-diagnostics",
        rules: [secureValueRule]
      }
    ]);
  });

  it("stops at the end of an unterminated string", () => {
    expect(rules.securitySuppressions("var s = 'open\\")).toEqual([]);
  });
});

describe("decodeText", () => {
  const text = "#disable-next-line é\n";

  it("reads UTF-8 with or without a byte-order mark", () => {
    expect(rules.decodeText(Buffer.from(text, "utf8"))).toBe(text);
    expect(
      rules.decodeText(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])
      )
    ).toBe(text);
  });

  it("reads UTF-16 little-endian after its byte-order mark", () => {
    expect(
      rules.decodeText(
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])
      )
    ).toBe(text);
  });

  it("reads UTF-16 big-endian and ignores a dangling final byte", () => {
    const bigEndian = Buffer.from(text, "utf16le").swap16();

    expect(
      rules.decodeText(
        Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian, Buffer.from([0])])
      )
    ).toBe(text);
  });

  it.each([
    ["little-endian", [0xff, 0xfe, 0, 0], true],
    ["big-endian", [0, 0, 0xfe, 0xff], false]
  ])("reads UTF-32 %s after its byte-order mark", (_name, mark, little) => {
    const codePoints = [..."#a😀"].map((character) => character.codePointAt(0));
    const units = Buffer.alloc(codePoints.length * 4 + 4);
    codePoints.forEach((codePoint = 0, index) => {
      if (little) units.writeUInt32LE(codePoint, index * 4);
      else units.writeUInt32BE(codePoint, index * 4);
    });
    // An out-of-range code point decodes to the replacement character, and a
    // trailing partial unit is ignored.
    if (little) units.writeUInt32LE(0x110000, codePoints.length * 4);
    else units.writeUInt32BE(0x110000, codePoints.length * 4);

    expect(
      rules.decodeText(
        Buffer.concat([Buffer.from(mark), units, Buffer.from([1, 2])])
      )
    ).toBe("#a😀\uFFFD");
  });
});

describe("fileReferencesRequest", () => {
  it("frames a getFileReferences request by byte length", () => {
    const app = path.join(path.sep, "wörk", "app.bicep");
    const request = rules.fileReferencesRequest(app);
    const [header, body] = request.split("\r\n\r\n");

    expect(header).toBe(`Content-Length: ${Buffer.byteLength(body)}`);
    expect(JSON.parse(body)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "bicep/getFileReferences",
      params: { path: app }
    });
  });
});

describe("parseFileReferencesResponse", () => {
  const filePaths = ["/w/app.bicep", "/w/bicepconfig.json"];
  const response = frame({ jsonrpc: "2.0", id: 1, result: { filePaths } });
  const parse = (text: string) =>
    rules.parseFileReferencesResponse(Buffer.from(text));

  it("returns the listed files", () => {
    expect(parse(response)).toEqual({ filePaths });
  });

  it("waits for the rest of a header or body", () => {
    expect(parse("Content-Length: 10")).toBeNull();
    expect(parse(response.slice(0, -1))).toBeNull();
  });

  it("measures the body in bytes rather than characters", () => {
    const wide = ["/wörk/app.bicep"];
    const text = frame({ jsonrpc: "2.0", id: 1, result: { filePaths: wide } });

    expect(parse(text)).toEqual({ filePaths: wide });
    expect(parse(text.slice(0, -1))).toBeNull();
  });

  it("skips notifications and other responses before its own", () => {
    const notification = frame({ jsonrpc: "2.0", method: "log", params: {} });
    const other = frame({ jsonrpc: "2.0", id: 2, result: {} });
    const unexpected = frame([1]);

    expect(parse(notification + other + unexpected + response)).toEqual({
      filePaths
    });
    expect(parse(notification)).toBeNull();
  });

  it("accepts header names in any case", () => {
    expect(parse(response.replace("Content-Length", "content-length"))).toEqual(
      { filePaths }
    );
  });

  it("reports a frame without a length", () => {
    expect(parse("Content-Type: x\r\n\r\n{}")).toEqual({
      error: "Bicep returned a JSON-RPC frame without a length"
    });
  });

  it("reports a frame that is not JSON", () => {
    expect(parse("Content-Length: 3\r\n\r\n{x}")).toEqual({
      error: "Bicep returned a JSON-RPC frame that is not JSON"
    });
  });

  it.each([
    [
      "the server's detail",
      { data: { message: " Could not find file. " }, message: "outer" },
      "Could not find file."
    ],
    ["the error message", { message: "Internal error" }, "Internal error"],
    [
      "a fallback for an empty error",
      { message: "  " },
      "Bicep could not list the files the compile reads"
    ],
    [
      "a fallback for a malformed error",
      null,
      "Bicep could not list the files the compile reads"
    ]
  ])("reports an error response with %s", (_name, error, expected) => {
    expect(parse(frame({ jsonrpc: "2.0", id: 1, error }))).toEqual({
      error: expected
    });
  });

  it.each([
    ["no result", {}],
    ["a list that is not an array", { result: { filePaths: "a" } }],
    ["a non-string entry", { result: { filePaths: ["a", 1] } }],
    ["an empty entry", { result: { filePaths: [""] } }]
  ])("reports a response with %s", (_name, fields) => {
    expect(parse(frame({ jsonrpc: "2.0", id: 1, ...fields }))).toEqual({
      error: "Bicep returned file references in an unexpected shape"
    });
  });
});

// These run the checker's real client against a stand-in server process, which
// Node runs as `<node> jsonrpc --stdio` from the model's directory.
describe("requestFileReferences", () => {
  function server(control?: object): string {
    const directory = temporaryDirectory();
    fs.writeFileSync(
      path.join(directory, "jsonrpc"),
      `import(${JSON.stringify(pathToFileURL(fakeJsonRpcServer).href)});\n`
    );
    if (control !== undefined) {
      fs.writeFileSync(
        path.join(directory, "jsonrpc.json"),
        JSON.stringify(control)
      );
    }
    return path.join(directory, "app.bicep");
  }

  it("returns the files the server lists and lets it exit", async () => {
    const app = server();
    fs.writeFileSync(path.join(path.dirname(app), "bicepconfig.json"), "{}");

    await expect(
      rules.requestFileReferences(process.execPath, app)
    ).resolves.toEqual({
      filePaths: [app, path.join(path.dirname(app), "bicepconfig.json")]
    });
  });

  it("skips a notification the server sends first", async () => {
    const app = server({ notify: true });

    await expect(
      rules.requestFileReferences(process.execPath, app)
    ).resolves.toEqual({ filePaths: [app] });
  });

  it("reports the server's error response", async () => {
    const app = server({ error: { message: "Could not find file." } });

    await expect(
      rules.requestFileReferences(process.execPath, app)
    ).resolves.toEqual({ error: "Could not find file." });
  });

  it("reports a malformed response", async () => {
    const app = server({ raw: "Content-Length: 3\r\n\r\n{x}" });

    await expect(
      rules.requestFileReferences(process.execPath, app)
    ).resolves.toEqual({
      error: "Bicep returned a JSON-RPC frame that is not JSON"
    });
  });

  it("reports what the server printed when it exits without answering", async () => {
    const app = server({ exitCode: 3, stderr: " restore failed \n" });

    await expect(
      rules.requestFileReferences(process.execPath, app)
    ).resolves.toEqual({ error: "restore failed" });
  });

  it("reports the exit status when the server says nothing", async () => {
    const app = server({ exitCode: 4 });

    await expect(
      rules.requestFileReferences(process.execPath, app)
    ).resolves.toEqual({
      error:
        "Bicep exited with status 4 without listing the files the compile reads"
    });
  });

  it("reports a partial response cut off by the server exiting", async () => {
    const app = server({ raw: "Content-Length: 50\r\n\r\n{", close: true });

    await expect(
      rules.requestFileReferences(process.execPath, app)
    ).resolves.toEqual({
      error:
        "Bicep exited with status 0 without listing the files the compile reads"
    });
  });

  it.runIf(process.platform !== "win32")(
    "reports the signal that ended the server",
    async () => {
      const app = server({ signal: "SIGTERM" });

      await expect(
        rules.requestFileReferences(process.execPath, app)
      ).resolves.toEqual({
        error:
          "Bicep exited with status null after receiving signal SIGTERM without listing the files the compile reads"
      });
    }
  );

  it("stops a server that never answers", async () => {
    const app = server({ hang: true });

    await expect(
      rules.requestFileReferences(process.execPath, app, { timeoutMs: 500 })
    ).resolves.toEqual({
      error: "Bicep did not list the files the compile reads within 500 ms"
    });
  });

  it("keeps a complete answer from a server that does not exit", async () => {
    const app = server({ linger: true });

    await expect(
      rules.requestFileReferences(process.execPath, app, { timeoutMs: 1_000 })
    ).resolves.toEqual({ filePaths: [app] });
  });

  it("ignores output that follows the answer", async () => {
    const app = server({ trailing: frame({ jsonrpc: "2.0", id: 1 }) });

    await expect(
      rules.requestFileReferences(process.execPath, app)
    ).resolves.toEqual({ filePaths: [app] });
  });

  // A request larger than a pipe buffer cannot be buffered whole, so a server
  // that exits without reading it always breaks the pipe mid-write.
  it("reports a server that exits before reading the request", async () => {
    const app = server({ exitAtStart: 5 });
    const longApp = path.join(path.dirname(app), "a".repeat(256 * 1024));

    await expect(
      rules.requestFileReferences(process.execPath, longApp)
    ).resolves.toEqual({
      error:
        "Bicep exited with status 5 without listing the files the compile reads"
    });
  });

  it("reports a Bicep executable that cannot be started", async () => {
    const app = server();
    const missing = path.join(path.dirname(app), "missing-bicep");

    const result = await rules.requestFileReferences(missing, app);

    expect(result).toEqual({ error: expect.stringContaining("ENOENT") });
  });
});

describe("readFileIfPresent", () => {
  it("reads a file", () => {
    const file = path.join(temporaryDirectory(), "bicepconfig.json");
    fs.writeFileSync(file, "{}");

    expect(rules.readFileIfPresent(file)?.toString()).toBe("{}");
  });

  it("returns null for a missing file", () => {
    expect(
      rules.readFileIfPresent(path.join(temporaryDirectory(), "missing.json"))
    ).toBeNull();
  });

  it("returns null for a directory", () => {
    const config = path.join(temporaryDirectory(), "bicepconfig.json");
    fs.mkdirSync(config);

    expect(rules.readFileIfPresent(config)).toBeNull();
  });

  it("returns null for a path beneath a file", () => {
    const file = path.join(temporaryDirectory(), "app.bicep");
    fs.writeFileSync(file, "");

    expect(
      rules.readFileIfPresent(path.join(file, "bicepconfig.json"))
    ).toBeNull();
  });

  it.runIf(process.platform !== "win32")(
    "throws for a file that exists but cannot be read",
    () => {
      const config = path.join(temporaryDirectory(), "bicepconfig.json");
      fs.symlinkSync(config, config);

      expect(() => rules.readFileIfPresent(config)).toThrow(/ELOOP/u);
    }
  );
});

describe("inspectSecurityRules", () => {
  // A synthetic, platform-neutral workspace: every path is absolute on the
  // running platform, and a file is readable only when the case lists it.
  const workspace = path.resolve(path.sep, "workspace", "repo");
  const radiusDir = path.join(workspace, ".radius");
  const stagingDir = path.join(radiusDir, ".staging-run");
  const stagedApp = path.join(stagingDir, "app.bicep");
  const stagedConfig = path.join(stagingDir, "bicepconfig.json");
  const offConfig = JSON.stringify(ruleLevel(secureValueRule, "off"));
  const remedy =
    "A security rule cannot be turned off or suppressed for a Radius application model: remove this so the rule runs, then fix what it reports in the model itself.";

  function fakeFiles(files: Record<string, string | Buffer>) {
    const reads: string[] = [];
    return {
      reads,
      readFile(file: string): Buffer | null {
        reads.push(file);
        if (!Object.hasOwn(files, file)) return null;
        const content = files[file];
        return typeof content === "string" ? Buffer.from(content) : content;
      }
    };
  }

  it("finds nothing when no file disables a rule", () => {
    const files = fakeFiles({
      [stagedApp]: "extension radius\n",
      [stagedConfig]: '{"extensions": {"radius": "br:x"}}'
    });

    expect(
      rules.inspectSecurityRules([stagedApp, stagedConfig], {
        stagingDir,
        readFile: files.readFile
      })
    ).toEqual({ findings: [], unavailable: null });
  });

  it("reports the staged configuration that turns a rule off", () => {
    const files = fakeFiles({ [stagedApp]: "", [stagedConfig]: offConfig });

    expect(
      rules.inspectSecurityRules([stagedApp, stagedConfig], {
        stagingDir,
        readFile: files.readFile
      })
    ).toEqual({
      findings: [
        `${stagedConfig}: error security-rule-disabled: analyzers.core.rules.${secureValueRule}.level is "off", which turns the rule off. ${remedy}`
      ],
      unavailable: null
    });
  });

  const inheritedAdvice = (config: string) =>
    `${config} is outside this modeling run's staging directory, and the staged model inherits it only because the run has no bicepconfig.json of its own: do not edit it in place, but give the run a staged bicepconfig.json without this setting, which takes precedence over it. show-radius-type.mjs writes one.`;
  const moduleAdvice = (file: string) =>
    `${file} belongs to a module outside this modeling run's staging directory, which the run cannot change: do not edit it, and do not try to repair it in the staged bicepconfig.json, which does not apply to that module. Stop referencing the module, or stop and report that it turns off a security rule.`;

  it("tells a run without its own configuration to stage one", () => {
    const config = path.join(radiusDir, "bicepconfig.json");
    const files = fakeFiles({ [stagedApp]: "", [config]: offConfig });

    const [finding] = rules.inspectSecurityRules([stagedApp, config], {
      stagingDir,
      readFile: files.readFile
    }).findings;

    expect(finding).toBe(
      `${config}: error security-rule-disabled: analyzers.core.rules.${secureValueRule}.level is "off", which turns the rule off. ${remedy} ${inheritedAdvice(config)}`
    );
  });

  it("picks the nearest listed configuration as the one the model inherits", () => {
    const repoConfig = path.join(workspace, "bicepconfig.json");
    const radiusConfig = path.join(radiusDir, "bicepconfig.json");
    const files = fakeFiles({
      [stagedApp]: "",
      [repoConfig]: offConfig,
      [radiusConfig]: offConfig
    });

    const findings = rules.inspectSecurityRules(
      [stagedApp, repoConfig, radiusConfig],
      { stagingDir, readFile: files.readFile }
    ).findings;

    expect(findings[0]).toContain(moduleAdvice(repoConfig));
    expect(findings[1]).toContain(inheritedAdvice(radiusConfig));
  });

  // Bicep applies a module's own configuration even when the staged model has
  // a clean one, so changing the staged configuration cannot clear it.
  it("tells the run not to repair a module outside it in the staged configuration", () => {
    const shared = path.join(workspace, "shared");
    const module = path.join(shared, "db.bicep");
    const moduleConfig = path.join(shared, "bicepconfig.json");
    const files = fakeFiles({
      [stagedApp]: "",
      [stagedConfig]: "{}",
      [module]: `#disable-next-line ${secureValueRule}\n`,
      [moduleConfig]: offConfig
    });

    expect(
      rules.inspectSecurityRules(
        [stagedApp, stagedConfig, module, moduleConfig],
        {
          stagingDir,
          readFile: files.readFile
        }
      ).findings
    ).toEqual([
      `${module}:1: error security-rule-suppressed: #disable-next-line suppresses ${secureValueRule}. ${remedy} ${moduleAdvice(module)}`,
      `${moduleConfig}: error security-rule-disabled: analyzers.core.rules.${secureValueRule}.level is "off", which turns the rule off. ${remedy} ${moduleAdvice(moduleConfig)}`
    ]);
  });

  it("treats an ancestor configuration as a module's once the run stages its own", () => {
    const radiusConfig = path.join(radiusDir, "bicepconfig.json");
    const files = fakeFiles({
      [stagedApp]: "",
      [stagedConfig]: "{}",
      [radiusConfig]: offConfig
    });

    const [finding] = rules.inspectSecurityRules(
      [stagedApp, stagedConfig, radiusConfig],
      { stagingDir, readFile: files.readFile }
    ).findings;

    expect(finding).toContain(moduleAdvice(radiusConfig));
  });

  it("omits the staging advice for a compile outside a modeling run", () => {
    const app = path.join(radiusDir, "app.bicep");
    const config = path.join(radiusDir, "bicepconfig.json");
    const files = fakeFiles({ [app]: "", [config]: offConfig });

    const [finding] = rules.inspectSecurityRules([app, config], {
      readFile: files.readFile
    }).findings;

    expect(finding).toBe(
      `${config}: error security-rule-disabled: analyzers.core.rules.${secureValueRule}.level is "off", which turns the rule off. ${remedy}`
    );
  });

  it("reports a directive in any source with its location", () => {
    const module = path.join(stagingDir, "modules", "db.txt");
    const files = fakeFiles({
      [stagedApp]: `extension radius\n#disable-next-line ${secureValueRule}\n`,
      [module]: "#disable-diagnostics secure-parameter-default\n"
    });

    expect(
      rules.inspectSecurityRules([stagedApp, module], {
        stagingDir,
        readFile: files.readFile
      }).findings
    ).toEqual([
      `${stagedApp}:2: error security-rule-suppressed: #disable-next-line suppresses ${secureValueRule}. ${remedy}`,
      `${module}:1: error security-rule-suppressed: #disable-diagnostics suppresses secure-parameter-default. ${remedy}`
    ]);
  });

  // Bicep's list does not say which files are loaded as data, so a data file
  // holding a directive naming a security rule is refused too. Telling data
  // from source by reading the model would reopen the bypasses this avoids.
  it("reads a listed data file as source", () => {
    const asset = path.join(stagingDir, "snippet.txt");
    const files = fakeFiles({
      [stagedApp]: "var s = loadTextContent('snippet.txt')\n",
      [asset]: `#disable-next-line ${secureValueRule}\n`
    });

    expect(
      rules.inspectSecurityRules([stagedApp, asset], {
        stagingDir,
        readFile: files.readFile
      }).findings
    ).toEqual([
      `${asset}:1: error security-rule-suppressed: #disable-next-line suppresses ${secureValueRule}. ${remedy}`
    ]);
  });

  it("reads a UTF-16 source the way the compiler does", () => {
    const files = fakeFiles({
      [stagedApp]: Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(`#disable-next-line ${secureValueRule}\n`, "utf16le")
      ])
    });

    expect(
      rules.inspectSecurityRules([stagedApp], {
        stagingDir,
        readFile: files.readFile
      }).findings
    ).toHaveLength(1);
  });

  it("recognizes a configuration file by name regardless of case", () => {
    const config = path.join(stagingDir, "BicepConfig.json");
    const files = fakeFiles({ [config]: offConfig });

    expect(
      rules.inspectSecurityRules([config], {
        stagingDir,
        readFile: files.readFile
      }).findings[0]
    ).toContain("security-rule-disabled");
  });

  it("reads a file Bicep lists twice only once", () => {
    const files = fakeFiles({ [stagedApp]: "", [stagedConfig]: offConfig });

    const { findings } = rules.inspectSecurityRules(
      [stagedApp, stagedConfig, stagedConfig],
      { stagingDir, readFile: files.readFile }
    );

    expect(findings).toHaveLength(1);
    expect(files.reads).toEqual([stagedApp, stagedConfig]);
  });

  it("skips a file that has disappeared since Bicep listed it", () => {
    const files = fakeFiles({});

    expect(
      rules.inspectSecurityRules([stagedApp, stagedConfig], {
        stagingDir,
        readFile: files.readFile
      })
    ).toEqual({ findings: [], unavailable: null });
  });

  it("reports a configuration that cannot be parsed", () => {
    const files = fakeFiles({ [stagedConfig]: '{"a": 1,}' });

    const [finding] = rules.inspectSecurityRules([stagedConfig], {
      stagingDir,
      readFile: files.readFile
    }).findings;

    expect(finding).toMatch(
      new RegExp(
        `^${escapeRegExp(stagedConfig)}: error bicep-config-invalid: the Bicep configuration could not be parsed \\(.+\\), so whether the security rules run cannot be established\\. Make it valid JSON; comments are allowed and trailing commas are not\\.$`,
        "u"
      )
    );
  });

  it("is unavailable when a file that exists cannot be read", () => {
    const result = rules.inspectSecurityRules([stagedApp, stagedConfig], {
      stagingDir,
      readFile(file) {
        if (file === stagedApp) {
          return Buffer.from(`#disable-next-line ${secureValueRule}\n`);
        }
        throw new Error("EACCES: permission denied");
      }
    });

    expect(result).toEqual({
      findings: [expect.stringContaining("security-rule-suppressed")],
      unavailable: `${stagedConfig}: EACCES: permission denied`
    });
  });

  it("reads the real filesystem by default", () => {
    const directory = temporaryDirectory();
    const config = path.join(directory, "bicepconfig.json");
    fs.writeFileSync(config, offConfig);

    const result = rules.inspectSecurityRules([config]);

    expect(result.unavailable).toBeNull();
    expect(result.findings).toHaveLength(1);
  });
});

// The stand-in server is shared by this suite and the checker suite, so its
// default answer is pinned here directly.
describe("stand-in Bicep JSON-RPC server", () => {
  it("lists the model alone when no configuration sits beside it", () => {
    const directory = temporaryDirectory();
    const app = path.join(directory, "app.bicep");

    const result = spawnSync(process.execPath, [fakeJsonRpcServer], {
      cwd: directory,
      encoding: "utf8",
      input: rules.fileReferencesRequest(app)
    });

    expect(result.status).toBe(0);
    expect(
      rules.parseFileReferencesResponse(Buffer.from(result.stdout))
    ).toEqual({ filePaths: [app] });
  });
});
