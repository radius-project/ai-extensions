import { describe, expect, it } from "vitest";
import {
  APP_ORIGIN_REPO_PATH,
  evaluateAppModelFreshness,
  freshnessIdentity,
  normalizeAppBicep,
  parseAppOrigin,
  stagesBeforeDeploy,
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
    radiusVersion: "0.60",
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
    expect(parseAppOrigin(JSON.stringify(origin()))).toEqual(origin());
  });

  it("reads the stage and provider that a stage skill records", () => {
    expect(
      parseAppOrigin(
        JSON.stringify({ ...origin(), stage: "plan", provider: "azure" })
      )
    ).toEqual(origin({ stage: "plan", provider: "azure" }));
  });

  it.each([
    ["an unknown stage", { stage: "deploy" }],
    ["a stage that is not a string", { stage: 2 }],
    ["a blank provider", { provider: " " }]
  ])("drops %s instead of voiding the record", (_label, fields) => {
    expect(parseAppOrigin(JSON.stringify({ ...origin(), ...fields }))).toEqual(
      origin()
    );
  });

  it("ignores the skillVersion that older records carry", () => {
    expect(
      parseAppOrigin(JSON.stringify({ ...origin(), skillVersion: "0.1.0" }))
    ).toEqual(origin());
  });

  it("trims surrounding whitespace from every field", () => {
    const parsed = parseAppOrigin(
      JSON.stringify({
        generatedAt: " 2026-08-10T23:29:00Z ",
        sourceCommit: " abc ",
        radiusVersion: " 0.60 ",
        appBicepHash: " sha256:xyz ",
        provider: " azure "
      })
    );

    expect(parsed).toEqual({
      generatedAt: "2026-08-10T23:29:00Z",
      sourceCommit: "abc",
      radiusVersion: "0.60",
      appBicepHash: "sha256:xyz",
      provider: "azure"
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

  it("rejects a record whose load-bearing field is blank or the wrong type", () => {
    expect(
      parseAppOrigin(JSON.stringify(origin({ sourceCommit: "  " })))
    ).toBeNull();
    expect(
      parseAppOrigin(JSON.stringify({ ...origin(), appBicepHash: 3 }))
    ).toBeNull();
  });

  // Every record written before the field existed lacks it. Those models must
  // still parse, with the Radius version unknown rather than the record void.
  it("reads a record written before radiusVersion existed as an unknown Radius version", () => {
    const fields: Record<string, unknown> = { ...origin() };
    delete fields.radiusVersion;

    expect(parseAppOrigin(JSON.stringify(fields))).toEqual(
      origin({ radiusVersion: "" })
    );
  });

  it.each([
    ["blank", "  "],
    ["not a string", 60]
  ])(
    "degrades a %s Radius version to unknown instead of voiding the record",
    (_label, radiusVersion) => {
      expect(
        parseAppOrigin(JSON.stringify({ ...origin(), radiusVersion }))
      ).toMatchObject({ radiusVersion: "" });
    }
  );
});

describe("freshnessIdentity", () => {
  const base = {
    status: "unrecorded" as const,
    stale: true,
    requiresConfirmation: false,
    reason: "r",
    appBicepHash: "sha256:one",
    origin: null
  };

  // Two verdicts that call for different actions must never share a key, or the
  // second one is silently treated as already reported.
  it("separates an unrecorded model that is safe to replace from one that is not", () => {
    expect(freshnessIdentity(base)).not.toBe(
      freshnessIdentity({ ...base, requiresConfirmation: true })
    );
  });

  it("separates two different unrecorded models", () => {
    expect(freshnessIdentity(base)).not.toBe(
      freshnessIdentity({ ...base, appBicepHash: "sha256:two" })
    );
  });

  it("is stable for the same verdict about the same model", () => {
    expect(freshnessIdentity(base)).toBe(freshnessIdentity({ ...base }));
  });

  // A recorded model is identified by its record, so its own bytes add nothing.
  // Leaving them out keeps a regeneration that reproduces identical content from
  // reading as new evidence.
  it("ignores the fingerprint when a record supplies the identity", () => {
    const recorded = {
      ...base,
      status: "source-changed" as const,
      origin: {
        generatedAt: "2026-08-11T05:32:32.000Z",
        sourceCommit: "a".repeat(40),
        radiusVersion: "0.60",
        appBicepHash: "sha256:recorded"
      }
    };

    expect(freshnessIdentity(recorded)).toBe(
      freshnessIdentity({ ...recorded, appBicepHash: "sha256:different" })
    );
  });

  // A model regenerated for one Radius upgrade records the new version, so the
  // next upgrade has to read as new evidence and be asked about again.
  it("separates records saved with different Radius versions", () => {
    const recorded = {
      ...base,
      status: "radius-version-changed" as const,
      origin: {
        generatedAt: "2026-08-11T05:32:32.000Z",
        sourceCommit: "a".repeat(40),
        radiusVersion: "0.60",
        appBicepHash: "sha256:recorded"
      }
    };

    expect(freshnessIdentity(recorded)).not.toBe(
      freshnessIdentity({
        ...recorded,
        origin: { ...recorded.origin, radiusVersion: "0.61" }
      })
    );
  });
});

describe("evaluateAppModelFreshness", () => {
  const current = {
    headCommit: "a".repeat(40),
    radiusVersion: "0.60",
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
      originText: JSON.stringify(origin())
    });

    expect(result.status).toBe("up-to-date");
    expect(result.stale).toBe(false);
    expect(result.requiresConfirmation).toBe(false);
    expect(result.origin).toEqual(origin());
  });

  it("regenerates without confirmation a recoverable model with no origin", () => {
    const result = evaluateAppModelFreshness({
      ...current,
      model: MODEL,
      originText: null,
      modelRecoverable: true
    });

    expect(result.status).toBe("unrecorded");
    expect(result.stale).toBe(true);
    expect(result.requiresConfirmation).toBe(false);
    expect(result.reason).toContain(APP_ORIGIN_REPO_PATH);
  });

  // Without a record we cannot tell whether anyone edited the model, so the
  // question that decides the overwrite is whether git can give it back.
  it("requires confirmation for a model with no origin git cannot restore", () => {
    const result = evaluateAppModelFreshness({
      ...current,
      model: MODEL,
      originText: null,
      modelRecoverable: false
    });

    expect(result.status).toBe("unrecorded");
    expect(result.stale).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.reason).toContain("exists nowhere else");
  });

  // Both cases ask, but they are not the same fact. Reporting the file as
  // untracked when git was simply unreachable claims something we never
  // established.
  it("does not claim a model is untracked when git could not answer", () => {
    const result = evaluateAppModelFreshness({
      ...current,
      model: MODEL,
      originText: null,
      modelRecoverable: undefined
    });

    expect(result.status).toBe("unrecorded");
    expect(result.requiresConfirmation).toBe(true);
    expect(result.reason).toContain("Git could not say");
    expect(result.reason).not.toContain("is untracked");
  });

  it("regenerates without confirmation a model with an unparseable origin", () => {
    const result = evaluateAppModelFreshness({
      ...current,
      model: MODEL,
      originText: "{ not json",
      modelRecoverable: true
    });

    expect(result.status).toBe("unrecorded");
    expect(result.requiresConfirmation).toBe(false);
  });

  // An edit on its own is not a reason to regenerate. The source and the
  // Radius version still match, so the model describes the current source, and
  // reporting it would ask the user to justify their own edit on every open.
  it("leaves a hand edit alone when nothing else calls for a regeneration", () => {
    const result = evaluateAppModelFreshness({
      ...current,
      model: `${MODEL}// hand edit\n`,
      originText: JSON.stringify(origin())
    });

    expect(result.status).toBe("up-to-date");
    expect(result.stale).toBe(false);
    expect(result.requiresConfirmation).toBe(false);
    expect(result.reason).toContain("edited after it was generated");
  });

  it("requires confirmation when a hand-edited model also needs regenerating", () => {
    const result = evaluateAppModelFreshness({
      ...current,
      sourceChanged: true,
      model: `${MODEL}// hand edit\n`,
      originText: JSON.stringify(origin())
    });

    expect(result.status).toBe("manually-edited");
    expect(result.stale).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.reason).toContain("uncommitted source changes");
    expect(result.reason).toContain("would discard those edits");
  });

  it("does not call a line-ending-only difference an edit", () => {
    expect(
      evaluateAppModelFreshness({
        ...current,
        model: MODEL.replace(/\n/gu, "\r\n"),
        originText: JSON.stringify(origin())
      }).status
    ).toBe("up-to-date");
  });

  it("reports source drift when the branch moved past the recorded commit", () => {
    const result = evaluateAppModelFreshness({
      ...current,
      headCommit: "b".repeat(40),
      model: MODEL,
      originText: JSON.stringify(origin())
    });

    expect(result.status).toBe("source-changed");
    expect(result.stale).toBe(true);
    expect(result.requiresConfirmation).toBe(false);
    expect(result.reason).toContain(
      `but the source has changed since (the branch is now at ${"b".repeat(40)})`
    );
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
      originText: JSON.stringify(origin())
    });

    expect(result.status).toBe("up-to-date");
    expect(result.stale).toBe(false);
  });

  it("reports drift on an explicit source answer even when the head matches", () => {
    const result = evaluateAppModelFreshness({
      ...current,
      sourceChanged: true,
      model: MODEL,
      originText: JSON.stringify(origin())
    });

    expect(result.status).toBe("source-changed");
    expect(result.reason).toBe(
      `The model was generated from commit ${"a".repeat(40)}, but the working tree has uncommitted source changes, so it may no longer describe the current source.`
    );
  });

  it("states the drift without naming a head commit it could not resolve", () => {
    const result = evaluateAppModelFreshness({
      ...current,
      headCommit: "",
      sourceChanged: true,
      model: MODEL,
      originText: JSON.stringify(origin())
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
        originText: JSON.stringify(origin())
      }).status
    ).toBe("source-changed");
  });

  it("prefers the edit signal over source drift", () => {
    expect(
      evaluateAppModelFreshness({
        hashAppBicep,
        headCommit: "b".repeat(40),
        model: `${MODEL}// hand edit\n`,
        originText: JSON.stringify(origin())
      }).status
    ).toBe("manually-edited");
  });

  it.each([
    ["an unresolvable head commit", { headCommit: "" }],
    ["an absent head commit", { headCommit: null }]
  ])("fails open on %s", (_label, unknownFact) => {
    const result = evaluateAppModelFreshness({
      ...current,
      ...unknownFact,
      model: MODEL,
      originText: JSON.stringify(origin())
    });

    expect(result.status).toBe("up-to-date");
    expect(result.stale).toBe(false);
  });

  it("reports a Radius version change when the installed CLI is newer", () => {
    const result = evaluateAppModelFreshness({
      ...current,
      radiusVersion: "0.61",
      model: MODEL,
      originText: JSON.stringify(origin())
    });

    expect(result.status).toBe("radius-version-changed");
    expect(result.stale).toBe(true);
    expect(result.requiresConfirmation).toBe(false);
    expect(result.reason).toBe(
      "The model was generated with Radius 0.60, but the installed Radius CLI uses 0.61, so it may no longer compile."
    );
  });

  it("requires confirmation when a hand-edited model also needs a newer Radius version", () => {
    const result = evaluateAppModelFreshness({
      ...current,
      radiusVersion: "0.61",
      model: `${MODEL}// hand edit\n`,
      originText: JSON.stringify(origin())
    });

    expect(result.status).toBe("manually-edited");
    expect(result.requiresConfirmation).toBe(true);
    expect(result.reason).toContain("the installed Radius CLI uses 0.61");
  });

  it("reports a source change ahead of a Radius version change", () => {
    expect(
      evaluateAppModelFreshness({
        ...current,
        sourceChanged: true,
        radiusVersion: "0.61",
        model: MODEL,
        originText: JSON.stringify(origin())
      }).status
    ).toBe("source-changed");
  });

  // A teammate on an older plugin cannot regenerate this model, and if they
  // could, it would move the model back to older types for everyone else. So it
  // is reported, never refreshed, even when something else drifted too.
  it.each([
    ["nothing else changed", {}, MODEL],
    ["the source also changed", { sourceChanged: true }, MODEL],
    ["the model was also edited", { sourceChanged: true }, `${MODEL}// edit\n`]
  ])(
    "reports an older installed CLI without asking for a refresh when %s",
    (_label, otherDrift, model) => {
      const result = evaluateAppModelFreshness({
        ...current,
        ...otherDrift,
        radiusVersion: "0.59",
        model,
        originText: JSON.stringify(origin())
      });

      expect(result.status).toBe("radius-cli-outdated");
      expect(result.stale).toBe(false);
      expect(result.requiresConfirmation).toBe(false);
      expect(result.reason).toBe(
        "The model was generated with Radius 0.60, but the installed Radius CLI uses the older 0.59. Update the Radius plugin to keep working with this model."
      );
    }
  );

  it.each([
    ["the record saved no Radius version", "", "0.61"],
    ["the installed CLI version is unknown", "0.60", ""],
    ["the record saved an edge version", "latest", "0.61"],
    ["the installed CLI is an edge build", "0.60", "latest"],
    ["the installed CLI version is not a Radius version", "0.60", "main"]
  ])("skips the Radius version check when %s", (_label, saved, installed) => {
    const result = evaluateAppModelFreshness({
      ...current,
      radiusVersion: installed,
      model: MODEL,
      originText: JSON.stringify(origin({ radiusVersion: saved }))
    });

    expect(result.status).toBe("up-to-date");
    expect(result.stale).toBe(false);
  });

  it("fails open when no Radius version is supplied at all", () => {
    expect(
      evaluateAppModelFreshness({
        ...current,
        radiusVersion: undefined,
        model: MODEL,
        originText: JSON.stringify(origin())
      }).status
    ).toBe("up-to-date");
  });
});

describe("stagesBeforeDeploy", () => {
  const hash = hashAppBicep(MODEL);

  it.each([
    ["a Stage 1 model", { stage: "model" }, "azure", ["plan", "complete"]],
    [
      "a model planned for another provider",
      { stage: "complete", provider: "aws" },
      "azure",
      ["plan", "complete"]
    ],
    [
      "a completed model that was never planned",
      { stage: "complete" },
      "azure",
      ["plan", "complete"]
    ],
    [
      "a planned model",
      { stage: "plan", provider: "azure" },
      "azure",
      ["complete"]
    ],
    [
      "a Stage 1 model for a provider that Stage 2 cannot plan",
      { stage: "model" },
      "aws",
      ["complete"]
    ],
    [
      "a completed model",
      { stage: "complete", provider: "azure" },
      "azure",
      []
    ],
    [
      "a completed model for a provider that Stage 2 cannot plan",
      { stage: "complete", provider: "azure" },
      "aws",
      []
    ],
    ["a record from the single-stage skill", {}, "azure", []]
  ] as const)("asks %s for %j", (_label, fields, provider, stages) => {
    expect(stagesBeforeDeploy(origin(fields), hash, provider)).toEqual(stages);
  });

  it("deploys a model with no record as it is", () => {
    expect(stagesBeforeDeploy(null, hash, "azure")).toEqual([]);
  });

  it("deploys an edited model as it is", () => {
    expect(
      stagesBeforeDeploy(origin({ stage: "model" }), "sha256:edited", "azure")
    ).toEqual([]);
  });
});
