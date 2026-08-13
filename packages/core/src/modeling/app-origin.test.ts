import { describe, expect, it } from "vitest";
import {
  APP_ORIGIN_REPO_PATH,
  evaluateAppModelFreshness,
  normalizeAppBicep,
  parseAppOrigin,
  serializeAppOrigin,
  type AppOrigin
} from "./app-origin.js";

// The real SHA-256 hasher lives in the adapter, because this package is
// compiled for the browser and cannot import `node:crypto`. Core only compares
// the values it is given, so a deterministic stand-in over the same
// normalization exercises exactly the behavior core owns.
function hashAppBicep(content: string): string {
  return `test:${normalizeAppBicep(content)}`;
}

const MODEL =
  "resource app 'Radius.Core/applications@2025-08-01-preview' = {}\n";

function origin(overrides: Partial<AppOrigin> = {}): AppOrigin {
  return {
    generatedAt: "2026-08-10T23:29:00Z",
    sourceCommit: "a".repeat(40),
    skillVersion: "0.1.0-edge-20260811053232",
    appBicepHash: hashAppBicep(MODEL),
    ...overrides
  };
}

describe("normalizeAppBicep", () => {
  it("treats checkout line-ending and trailing-whitespace differences as identical", () => {
    expect(normalizeAppBicep("a\r\nb  \n\n")).toBe("a\nb");
  });

  it("preserves meaningful indentation and interior blank lines", () => {
    expect(normalizeAppBicep("a\n\n  b\n")).toBe("a\n\n  b");
  });
});

describe("parseAppOrigin", () => {
  it("accepts a complete record", () => {
    expect(parseAppOrigin(serializeAppOrigin(origin()))).toEqual(origin());
  });

  it("trims surrounding whitespace from every field", () => {
    const parsed = parseAppOrigin(
      JSON.stringify({
        generatedAt: " 2026-08-10T23:29:00Z ",
        sourceCommit: " abc ",
        skillVersion: " 0.1.0 ",
        appBicepHash: " sha256:xyz "
      })
    );

    expect(parsed).toEqual({
      generatedAt: "2026-08-10T23:29:00Z",
      sourceCommit: "abc",
      skillVersion: "0.1.0",
      appBicepHash: "sha256:xyz"
    });
  });

  it.each([
    ["a non-string", 42],
    ["an empty string", "   "],
    ["malformed JSON", "{"],
    ["a JSON array", "[]"],
    ["a JSON null", "null"],
    ["a JSON scalar", '"origin"']
  ])("rejects %s", (_label, input) => {
    expect(parseAppOrigin(input)).toBeNull();
  });

  it.each(["generatedAt", "sourceCommit", "appBicepHash"] as const)(
    "rejects a record missing %s",
    (field) => {
      const fields: Record<string, unknown> = { ...origin() };
      delete fields[field];

      expect(parseAppOrigin(JSON.stringify(fields))).toBeNull();
    }
  );

  it("accepts a record whose generator version could not be resolved", () => {
    expect(
      parseAppOrigin(JSON.stringify(origin({ skillVersion: "" })))
    ).toMatchObject({ skillVersion: "" });
  });

  it("rejects a record whose load-bearing field is blank or the wrong type", () => {
    expect(
      parseAppOrigin(JSON.stringify(origin({ sourceCommit: "  " })))
    ).toBeNull();
    expect(
      parseAppOrigin(JSON.stringify({ ...origin(), appBicepHash: 3 }))
    ).toBeNull();
  });

  it("degrades a malformed generator version to unknown instead of voiding the record", () => {
    expect(
      parseAppOrigin(JSON.stringify({ ...origin(), skillVersion: 3 }))
    ).toMatchObject({ skillVersion: "" });
  });
});

describe("serializeAppOrigin", () => {
  it("writes canonical key order with a trailing newline", () => {
    expect(serializeAppOrigin(origin())).toBe(
      `{\n  "generatedAt": "2026-08-10T23:29:00Z",\n  "sourceCommit": "${"a".repeat(
        40
      )}",\n  "skillVersion": "0.1.0-edge-20260811053232",\n  "appBicepHash": "${hashAppBicep(
        MODEL
      )}"\n}\n`
    );
  });

  it("is independent of the input object's key order", () => {
    const reordered = {
      appBicepHash: origin().appBicepHash,
      skillVersion: origin().skillVersion,
      sourceCommit: origin().sourceCommit,
      generatedAt: origin().generatedAt
    };

    expect(serializeAppOrigin(reordered)).toBe(serializeAppOrigin(origin()));
  });

  it("round-trips through the parser", () => {
    expect(parseAppOrigin(serializeAppOrigin(origin()))).toEqual(origin());
  });
});

describe("evaluateAppModelFreshness", () => {
  const current = {
    headCommit: "a".repeat(40),
    generatorVersion: "0.1.0-edge-20260811053232",
    hashAppBicep
  };

  it("reports a missing model as neither stale nor confirmable", () => {
    const result = evaluateAppModelFreshness({
      ...current,
      model: null,
      originText: null
    });

    expect(result.status).toBe("missing");
    expect(result.stale).toBe(false);
    expect(result.requiresConfirmation).toBe(false);
    expect(result.origin).toBeNull();
  });

  it("treats a whitespace-only model as missing", () => {
    expect(
      evaluateAppModelFreshness({ ...current, model: "  \n", originText: null })
        .status
    ).toBe("missing");
  });

  it("reports an up-to-date model", () => {
    const result = evaluateAppModelFreshness({
      ...current,
      model: MODEL,
      originText: serializeAppOrigin(origin())
    });

    expect(result.status).toBe("up-to-date");
    expect(result.stale).toBe(false);
    expect(result.requiresConfirmation).toBe(false);
    expect(result.origin).toEqual(origin());
  });

  it("requires confirmation for a model with no origin", () => {
    const result = evaluateAppModelFreshness({
      ...current,
      model: MODEL,
      originText: null
    });

    expect(result.status).toBe("unrecorded");
    expect(result.stale).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.reason).toContain(APP_ORIGIN_REPO_PATH);
  });

  it("requires confirmation for a model with an unparseable origin", () => {
    expect(
      evaluateAppModelFreshness({
        ...current,
        model: MODEL,
        originText: "{ not json"
      }).status
    ).toBe("unrecorded");
  });

  it("requires confirmation when the model was edited after generation", () => {
    const result = evaluateAppModelFreshness({
      ...current,
      model: `${MODEL}// hand edit\n`,
      originText: serializeAppOrigin(origin())
    });

    expect(result.status).toBe("edited");
    expect(result.stale).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
  });

  it("does not call a line-ending-only difference an edit", () => {
    expect(
      evaluateAppModelFreshness({
        ...current,
        model: MODEL.replace(/\n/gu, "\r\n"),
        originText: serializeAppOrigin(origin())
      }).status
    ).toBe("up-to-date");
  });

  it("reports source drift when the branch moved past the recorded commit", () => {
    const result = evaluateAppModelFreshness({
      ...current,
      headCommit: "b".repeat(40),
      model: MODEL,
      originText: serializeAppOrigin(origin())
    });

    expect(result.status).toBe("source-changed");
    expect(result.stale).toBe(true);
    expect(result.requiresConfirmation).toBe(false);
    expect(result.reason).toContain("b".repeat(40));
  });

  it("prefers an explicit source answer over head-commit equality", () => {
    // Committing the generated model advances the head past the commit the
    // model recorded, but nothing outside the model changed. The caller says
    // so, and that answer wins over the SHA mismatch. Without this, every
    // committed model would report itself stale on the very next open.
    const result = evaluateAppModelFreshness({
      ...current,
      headCommit: "b".repeat(40),
      sourceChanged: false,
      model: MODEL,
      originText: serializeAppOrigin(origin())
    });

    expect(result.status).toBe("up-to-date");
    expect(result.stale).toBe(false);
  });

  it("reports drift on an explicit source answer even when the head matches", () => {
    const result = evaluateAppModelFreshness({
      ...current,
      sourceChanged: true,
      model: MODEL,
      originText: serializeAppOrigin(origin())
    });

    expect(result.status).toBe("source-changed");
    expect(result.reason).toContain("a".repeat(40));
  });

  it("states the drift without naming a head commit it could not resolve", () => {
    const result = evaluateAppModelFreshness({
      ...current,
      headCommit: "",
      sourceChanged: true,
      model: MODEL,
      originText: serializeAppOrigin(origin())
    });

    expect(result.status).toBe("source-changed");
    expect(result.reason).toContain("the source has changed since");
    expect(result.reason).not.toContain("the branch is now at");
  });

  it("falls back to head equality when no source answer is available", () => {
    // Documents the coarse remote-branch behavior: any commit reads as drift
    // there, because nothing can inspect what actually changed.
    expect(
      evaluateAppModelFreshness({
        ...current,
        headCommit: "b".repeat(40),
        sourceChanged: undefined,
        model: MODEL,
        originText: serializeAppOrigin(origin())
      }).status
    ).toBe("source-changed");
  });

  it("skips the generator check when the record records no version", () => {
    const result = evaluateAppModelFreshness({
      ...current,
      generatorVersion: "9.9.9",
      model: MODEL,
      originText: serializeAppOrigin(origin({ skillVersion: "" }))
    });

    expect(result.status).toBe("up-to-date");
  });

  it("reports a generator change when the source is unchanged", () => {
    const result = evaluateAppModelFreshness({
      ...current,
      generatorVersion: "0.1.0-edge-20260901000000",
      model: MODEL,
      originText: serializeAppOrigin(origin())
    });

    expect(result.status).toBe("generator-changed");
    expect(result.stale).toBe(true);
    expect(result.reason).toContain("0.1.0-edge-20260901000000");
  });

  it("prefers the edit signal over source and generator drift", () => {
    expect(
      evaluateAppModelFreshness({
        hashAppBicep,
        headCommit: "b".repeat(40),
        generatorVersion: "9.9.9",
        model: `${MODEL}// hand edit\n`,
        originText: serializeAppOrigin(origin())
      }).status
    ).toBe("edited");
  });

  it.each([
    ["an unresolvable head commit", { headCommit: "" }],
    ["an absent head commit", { headCommit: null }],
    ["an unresolvable generator version", { generatorVersion: "  " }],
    ["an absent generator version", { generatorVersion: undefined }]
  ])("fails open on %s", (_label, unknownFact) => {
    const result = evaluateAppModelFreshness({
      ...current,
      ...unknownFact,
      model: MODEL,
      originText: serializeAppOrigin(origin())
    });

    expect(result.status).toBe("up-to-date");
    expect(result.stale).toBe(false);
  });
});
