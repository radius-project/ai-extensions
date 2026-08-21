import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CONCURRENT_EDIT_MESSAGE,
  CUSTOM_TYPE_STAGED_FILES,
  REQUIRED_STAGED_FILES,
  STAGING_DIR_PREFIX,
  STAGING_IGNORE_PATTERN,
  STAGING_RUN_RECORD,
  evaluateStagedRun,
  isStagingDirName,
  publishableFiles,
  requiredStagedFiles,
  sanitizeRunId,
  stagingDirName
} from "./app-staging.js";
import { normalizeAppBicep } from "./app-origin.js";

// The hasher core injects. Identical to the adapter's, which is what the
// promote script re-implements.
function hashAppBicep(content: string): string {
  return `sha256:${createHash("sha256").update(normalizeAppBicep(content), "utf8").digest("hex")}`;
}

const MODEL =
  "resource app 'Radius.Core/applications@2025-08-01-preview' = {}\n";

function origin(model = MODEL): string {
  return JSON.stringify({
    generatedAt: "2026-08-20T00:00:00.000Z",
    sourceCommit: "a".repeat(40),
    skillVersion: "1.0.0",
    appBicepHash: hashAppBicep(model)
  });
}

function stagedRun(
  overrides: Partial<Parameters<typeof evaluateStagedRun>[0]> = {}
) {
  return evaluateStagedRun({
    stagedFiles: [...REQUIRED_STAGED_FILES, STAGING_RUN_RECORD],
    appBicep: MODEL,
    originText: origin(),
    record: { baseline: {} },
    currentHashes: {},
    hashAppBicep,
    ...overrides
  });
}

describe("staging directory names", () => {
  it("prefixes a sanitized run id", () => {
    expect(stagingDirName("run-42")).toBe(`${STAGING_DIR_PREFIX}run-42`);
  });

  it.each([
    ["../escape", "escape"],
    ["a/b", "a-b"],
    ["..", ""],
    [".hidden", "hidden"],
    ["ok_ID.9", "ok_ID.9"]
  ])("sanitizes %s to %s", (input, expected) => {
    expect(sanitizeRunId(input)).toBe(expected);
  });

  it("truncates a very long run id", () => {
    expect(sanitizeRunId("x".repeat(200))).toHaveLength(64);
  });

  it("treats a non-string run id as empty", () => {
    expect(sanitizeRunId(42)).toBe("");
  });

  it("falls back to a fixed name when the id sanitizes away", () => {
    expect(stagingDirName("///")).toBe(`${STAGING_DIR_PREFIX}run`);
  });

  it.each([
    [`${STAGING_DIR_PREFIX}abc`, true],
    [STAGING_DIR_PREFIX, false],
    ["app.bicep", false],
    [42, false]
  ])("recognizes %s as a staging directory: %s", (name, expected) => {
    expect(isStagingDirName(name)).toBe(expected);
  });

  it("ignores staging directories only", () => {
    expect(STAGING_IGNORE_PATTERN).toBe(`${STAGING_DIR_PREFIX}*/`);
  });
});

describe("requiredStagedFiles", () => {
  it("requires the base set when no custom type was generated", () => {
    expect(requiredStagedFiles(["app.bicep"])).toEqual([
      ...REQUIRED_STAGED_FILES
    ]);
  });

  it.each(CUSTOM_TYPE_STAGED_FILES)(
    "requires both custom-type files once %s appears",
    (file) => {
      expect(requiredStagedFiles([file])).toEqual([
        ...REQUIRED_STAGED_FILES,
        ...CUSTOM_TYPE_STAGED_FILES
      ]);
    }
  );

  it("ignores a missing or non-string listing", () => {
    expect(requiredStagedFiles(null)).toEqual([...REQUIRED_STAGED_FILES]);
    expect(requiredStagedFiles([42, null])).toEqual([...REQUIRED_STAGED_FILES]);
  });
});

describe("publishableFiles", () => {
  it("publishes the known supporting artifacts after the required set", () => {
    expect(
      publishableFiles([
        "custom-recipe-pack.bicep",
        ...REQUIRED_STAGED_FILES,
        ...CUSTOM_TYPE_STAGED_FILES,
        "widget-recipe.bicep",
        STAGING_RUN_RECORD
      ])
    ).toEqual([
      ...REQUIRED_STAGED_FILES,
      ...CUSTOM_TYPE_STAGED_FILES,
      "custom-recipe-pack.bicep",
      "widget-recipe.bicep"
    ]);
  });

  // The staging directory is written by an agent, so being present is not
  // enough to be published into the repository and staged in git.
  it.each([
    STAGING_RUN_RECORD,
    "notes.md",
    ".env",
    "scratch.bicep",
    "app.bicep.published-backup",
    "Widget-Recipe.bicep"
  ])("does not publish %s", (name) => {
    expect(publishableFiles([...REQUIRED_STAGED_FILES, name])).toEqual([
      ...REQUIRED_STAGED_FILES
    ]);
  });

  it("returns the required set for a missing listing", () => {
    expect(publishableFiles(undefined)).toEqual([...REQUIRED_STAGED_FILES]);
  });
});

describe("evaluateStagedRun", () => {
  it("publishes a complete, compiled run over an empty .radius", () => {
    const result = stagedRun();
    expect(result.status).toBe("ready");
    expect(result.publishable).toBe(true);
    expect(result.files).toEqual([...REQUIRED_STAGED_FILES]);
  });

  it("publishes over an untouched existing model", () => {
    const previous = hashAppBicep(
      "resource old 'Radius.Core/applications@2025-08-01-preview' = {}\n"
    );
    const result = stagedRun({
      record: { baseline: { "app.bicep": previous } },
      currentHashes: { "app.bicep": previous }
    });
    expect(result.status).toBe("ready");
  });

  // Without the run record there is no evidence of what `.radius/` held when
  // the run started, so a directory an agent assembled by hand — skipping
  // `--begin` entirely — cannot publish.
  it("refuses a staged run that never went through --begin", () => {
    const result = stagedRun({ record: null });
    expect(result.status).toBe("unrecorded");
    expect(result.publishable).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.reason).toContain("--begin");
  });

  it("refuses a run whose supporting file changed during the run", () => {
    const result = stagedRun({
      record: { baseline: { "bicepconfig.json": "sha256:before" } },
      currentHashes: { "bicepconfig.json": "sha256:after" }
    });
    expect(result.status).toBe("concurrent-edit");
    expect(result.reason).toContain(".radius/bicepconfig.json");
  });

  // A file this run does not publish is not this run's business, even if it
  // changed while the run was going.
  it("ignores a change to a file this run would not publish", () => {
    const result = stagedRun({
      record: { baseline: { "custom-types.yaml": null } },
      currentHashes: { "custom-types.yaml": "sha256:appeared" }
    });
    expect(result.status).toBe("ready");
  });

  it.each(REQUIRED_STAGED_FILES)("refuses a run missing %s", (missing) => {
    const result = stagedRun({
      stagedFiles: REQUIRED_STAGED_FILES.filter((file) => file !== missing)
    });
    expect(result.status).toBe("incomplete");
    expect(result.publishable).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.reason).toContain(missing);
  });

  it("refuses a custom-type run whose published package never arrived", () => {
    const result = stagedRun({
      stagedFiles: [...REQUIRED_STAGED_FILES, "custom-types.yaml"]
    });
    expect(result.status).toBe("incomplete");
    expect(result.reason).toContain("custom-types.tgz");
  });

  it("publishes a complete custom-type run", () => {
    const result = stagedRun({
      stagedFiles: [...REQUIRED_STAGED_FILES, ...CUSTOM_TYPE_STAGED_FILES]
    });
    expect(result.status).toBe("ready");
    expect(result.files).toEqual([
      ...REQUIRED_STAGED_FILES,
      ...CUSTOM_TYPE_STAGED_FILES
    ]);
  });

  it.each([["" as const], [null], [undefined], ["   "]])(
    "refuses an empty staged model (%s)",
    (appBicep) => {
      const result = stagedRun({ appBicep });
      expect(result.status).toBe("incomplete");
      expect(result.reason).toContain("empty");
    }
  );

  it.each([
    ["a missing record", null],
    ["blank text", "   "],
    ["malformed JSON", "{"],
    ["a JSON array", "[]"],
    ["a non-object", '"nope"'],
    ["a record with no hash", '{"generatedAt":"now"}'],
    ["a record with a blank hash", '{"appBicepHash":"  "}']
  ])("refuses a run whose origin record is %s", (_label, originText) => {
    const result = stagedRun({ originText });
    expect(result.status).toBe("unverified");
    expect(result.publishable).toBe(false);
  });

  // The origin record is only written after the Bicep checker passes, so a
  // record that does not describe the staged model is the same evidence as no
  // record at all: these bytes were never proven to compile.
  it("refuses a run whose model changed after it was recorded", () => {
    const result = stagedRun({ originText: origin("something else\n") });
    expect(result.status).toBe("unverified");
    expect(result.reason).toContain("Bicep checker");
  });

  it("refuses when the model on disk changed during the run", () => {
    const result = stagedRun({
      record: { baseline: { "app.bicep": hashAppBicep("as it was\n") } },
      currentHashes: { "app.bicep": hashAppBicep("hand edited\n") }
    });
    expect(result.status).toBe("concurrent-edit");
    expect(result.publishable).toBe(false);
    expect(result.reason).toBe(CONCURRENT_EDIT_MESSAGE);
    expect(result.reason).toContain("intact");
  });

  it("refuses when a model appeared during a run that started with none", () => {
    const result = stagedRun({
      record: { baseline: { "app.bicep": null } },
      currentHashes: { "app.bicep": hashAppBicep("written mid-run\n") }
    });
    expect(result.status).toBe("concurrent-edit");
  });

  it("refuses when the model the run started from was deleted", () => {
    const result = stagedRun({
      record: { baseline: { "app.bicep": hashAppBicep(MODEL) } },
      currentHashes: {}
    });
    expect(result.status).toBe("concurrent-edit");
  });

  it("names every file that changed", () => {
    const result = stagedRun({
      record: {
        baseline: { "app.bicep": "sha256:a", "bicepconfig.json": "sha256:b" }
      },
      currentHashes: { "app.bicep": "sha256:x", "bicepconfig.json": "sha256:y" }
    });
    expect(result.reason).toContain(".radius/app.bicep");
    expect(result.reason).toContain(".radius/bicepconfig.json");
  });

  it("refuses a run with no listing at all", () => {
    const result = stagedRun({ stagedFiles: null, record: { baseline: {} } });
    expect(result.status).toBe("incomplete");
    expect(result.reason).toContain("app.bicep");
  });

  it("checks completeness before validity and validity before the edit check", () => {
    const result = stagedRun({
      stagedFiles: ["app.bicep"],
      originText: null,
      record: { baseline: { "app.bicep": "sha256:a" } },
      currentHashes: { "app.bicep": "sha256:b" }
    });
    expect(result.status).toBe("incomplete");
  });
});
