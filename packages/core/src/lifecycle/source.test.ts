import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { DefinitionInput, ResolvedSource } from "./contracts/common.js";
import type {
  CompleteInputManifest,
  EffectiveInputManifest,
  SourceSelection
} from "./ports.js";
import {
  buildEffectiveInputManifest,
  compareEffectiveInputManifests,
  validateSourcePath,
  validateSourceSelection,
  verifySourceExpectation
} from "./source.js";

function hash(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

const definition = ".radius/app.bicep";
function input(
  path: string,
  kind: DefinitionInput["kind"],
  content: string | null
): DefinitionInput {
  return {
    path,
    kind,
    existed: content !== null,
    contentHash: content === null ? null : hash(content)
  };
}
const inputs: readonly DefinitionInput[] = [
  input(definition, "definition", "module api './modules/api.bicep' = {}"),
  input(
    ".radius/modules/api.bicep",
    "module",
    "resource api 'Radius.Core/containers@1' = {}"
  ),
  input(".radius/settings.json", "file", '{"replicas":1}'),
  input(".radius/bicepconfig.json", "configuration", '{"extensions":{}}'),
  input(".radius/custom-types.yaml", "custom-type", "name: custom"),
  input(".radius/custom-types.tgz", "custom-type", "compiled extension bytes"),
  input(
    ".radius/custom-recipe.bicep",
    "recipe",
    "resource backend 'Microsoft.Storage/storageAccounts@1' = {}"
  ),
  input(".radius/local-overrides.json", "configuration", null)
];

function complete(
  entries: readonly DefinitionInput[] = inputs
): CompleteInputManifest {
  const result = buildEffectiveInputManifest(
    { definition, inputs: entries, closure: "complete" },
    hash
  );
  if (result.status !== "ok" || result.value.completeness !== "complete") {
    throw new Error("Fixture manifest must be complete");
  }
  return result.value;
}

const baseline = complete();
const selection: SourceSelection = {
  repo: "example/shop",
  definition,
  source: {
    kind: "workspace",
    workspaceRef: "workspace-1",
    branch: "feature/model",
    expectedFingerprint: baseline.fingerprint
  }
};
const resolved: ResolvedSource = {
  kind: "workspace",
  repo: selection.repo,
  workspaceRef: "workspace-1",
  branch: "feature/model",
  fingerprint: baseline.fingerprint,
  baseCommit: "a".repeat(40),
  resolvedAt: "2026-09-15T22:00:00Z"
};

describe("effective-input manifest policy", () => {
  it("hashes a stable complete manifest independently of input order without mutating captures", () => {
    const reversed = [...inputs].reverse();
    const before = structuredClone(reversed);
    const hasher = vi.fn(hash);
    const result = buildEffectiveInputManifest(
      { definition, inputs: reversed, closure: "complete" },
      hasher
    );
    expect(result).toEqual({ status: "ok", value: baseline });
    expect(reversed).toEqual(before);
    expect(hasher).toHaveBeenCalledOnce();
    expect(JSON.parse(hasher.mock.calls[0][0])).toEqual({
      version: "github-radius/effective-inputs/v1",
      definition,
      inputs: [...inputs].sort((left, right) =>
        left.path < right.path ? -1 : 1
      )
    });
    expect(baseline.inputs).not.toBe(inputs);
    expect(baseline.inputs[0]).not.toBe(inputs[0]);
  });

  it.each(inputs.filter((entry) => entry.existed))(
    "includes changes to $kind input $path in identity",
    (entry) => {
      const changed = complete(
        inputs.map((candidate) =>
          candidate.path === entry.path ?
            { ...candidate, contentHash: hash("changed bytes") }
          : candidate
        )
      );
      expect(changed.fingerprint).not.toBe(baseline.fingerprint);
      expect(compareEffectiveInputManifests(baseline, changed)).toMatchObject({
        status: "failed",
        error: { code: "SOURCE_CHANGED", retryable: false }
      });
    }
  );

  it("distinguishes new/deleted inputs, absent files and existing empty files", () => {
    const absent = input(".radius/new.json", "file", null);
    for (const entries of [
      [...inputs, input(".radius/new.json", "file", "{}")],
      inputs.filter((entry) => entry.path !== ".radius/modules/api.bicep"),
      inputs.map((entry) =>
        entry.path === ".radius/local-overrides.json" ?
          { ...entry, existed: true, contentHash: hash("") }
        : entry
      ),
      inputs.map((entry) =>
        entry.path === ".radius/modules/api.bicep" ?
          { ...entry, existed: false, contentHash: null }
        : entry
      ),
      [...inputs, absent]
    ]) {
      const current = complete(entries);
      expect(current.fingerprint).not.toBe(baseline.fingerprint);
      expect(compareEffectiveInputManifests(baseline, current)).toMatchObject({
        status: "failed",
        error: { code: "SOURCE_CHANGED" }
      });
    }
    expect(complete([input(definition, "definition", null)]).completeness).toBe(
      "complete"
    );
    expect(
      complete([input(definition, "definition", "")]).fingerprint
    ).not.toBe(complete([input(definition, "definition", null)]).fingerprint);
  });

  it("preserves exact-byte content hashes rather than applying display-oriented Bicep normalization", () => {
    const lf = complete([
      input(definition, "definition", "param name string\n")
    ]);
    const crlf = complete([
      input(definition, "definition", "param name string\r\n")
    ]);
    const whitespace = complete([
      input(definition, "definition", "param name string \n")
    ]);
    expect(
      new Set([lf.fingerprint, crlf.fingerprint, whitespace.fingerprint]).size
    ).toBe(3);
  });

  it("includes definition selection and input kind, and ignores non-contract capture metadata", () => {
    const entries = [
      ...inputs,
      input(
        ".radius/second.bicep",
        "definition",
        "resource app 'Radius.Core/applications@1' = {}"
      )
    ];
    const first = complete(entries);
    const second = buildEffectiveInputManifest(
      {
        definition: ".radius/second.bicep",
        inputs: entries,
        closure: "complete"
      },
      hash
    );
    expect(second.status).toBe("ok");
    if (second.status === "ok" && second.value.completeness === "complete") {
      expect(second.value.fingerprint).not.toBe(first.fingerprint);
    }
    expect(
      complete(
        inputs.map((entry) =>
          entry.kind === "recipe" ? { ...entry, kind: "module" } : entry
        )
      ).fingerprint
    ).not.toBe(baseline.fingerprint);
    const decorated = inputs.map((entry) => ({
      ...entry,
      capturedAt: "later",
      rawText: "not copied into manifest"
    }));
    expect(complete(decorated)).toEqual(baseline);
  });

  it.each([
    "",
    "/app.bicep",
    "../app.bicep",
    ".radius/../app.bicep",
    "./app.bicep",
    "C:\\app.bicep",
    "C:/app.bicep",
    "C:app.bicep",
    "\\\\host\\share\\app.bicep",
    ".radius\\app.bicep",
    "%2e%2e/app.bicep",
    "%252e%252e/app.bicep",
    "a//app.bicep",
    "app.bicep/",
    ".. /app.bicep",
    "app.bicep.",
    "app.bicep ",
    "app\u0000.bicep",
    "app.bicep\n",
    "CON",
    ".radius/NUL.txt",
    "COM1.bicep",
    "LPT9",
    "a".repeat(1025)
  ])(
    "rejects unsafe entry or effective-input path %j before hashing",
    (path) => {
      const hasher = vi.fn(hash);
      for (const candidate of [
        { definition: path, inputs, closure: "complete" },
        {
          definition,
          inputs: [...inputs, input(path, "file", "data")],
          closure: "complete"
        }
      ] as const) {
        expect(buildEffectiveInputManifest(candidate, hasher)).toMatchObject({
          status: "failed",
          error: { code: "INVALID_REQUEST" }
        });
      }
      expect(hasher).not.toHaveBeenCalled();
    }
  );

  it.each([
    { entries: [...inputs, inputs[0]] },
    {
      entries: [
        ...inputs,
        input(".RADIUS/APP.BICEP", "definition", "different")
      ]
    },
    {
      entries: [
        ...inputs,
        input(".radius/app.bicep", "module", "conflicting role")
      ]
    }
  ])(
    "rejects duplicate or case-colliding paths rather than silently deduplicating",
    ({ entries }) => {
      expect(
        buildEffectiveInputManifest(
          { definition, inputs: entries, closure: "complete" },
          hash
        )
      ).toMatchObject({ status: "failed", error: { code: "INVALID_REQUEST" } });
    }
  );

  it("accepts safe boundary-length paths and stable case-sensitive path identity", () => {
    expect(
      complete([...inputs, input("a".repeat(1024), "file", "")]).completeness
    ).toBe("complete");
    const renamed = complete(
      inputs.map((entry) =>
        entry.path === ".radius/settings.json" ?
          { ...entry, path: ".radius/Settings.json" }
        : entry
      )
    );
    expect(renamed.fingerprint).not.toBe(baseline.fingerprint);
  });

  it("rejects inconsistent absence/hash evidence and misclassified entry definitions", () => {
    for (const entries of [
      [input(definition, "module", "content")],
      [
        {
          ...input(definition, "definition", null),
          contentHash: hash("not absent")
        }
      ],
      [
        {
          ...input(definition, "definition", "content"),
          contentHash: "invalid"
        }
      ]
    ]) {
      expect(
        buildEffectiveInputManifest(
          { definition, inputs: entries, closure: "complete" },
          hash
        )
      ).toMatchObject({ status: "failed", error: { code: "INVALID_REQUEST" } });
    }
  });

  it.each([
    { definition, inputs, closure: "incomplete" },
    { definition, inputs: [], closure: "complete" },
    {
      definition,
      inputs: [
        {
          path: definition,
          kind: "definition",
          existed: true,
          contentHash: null
        }
      ],
      closure: "complete"
    },
    { definition, inputs: [], closure: "incomplete" }
  ] as const)(
    "does not fingerprint an unestablished input closure",
    (candidate) => {
      const hasher = vi.fn(hash);
      const result = buildEffectiveInputManifest(candidate, hasher);
      expect(result).toMatchObject({
        status: "ok",
        value: {
          completeness: "incomplete",
          definition,
          diagnostics: expect.any(Array)
        }
      });
      if (result.status === "ok") {
        expect(result.value).not.toHaveProperty("fingerprint");
      }
      expect(hasher).not.toHaveBeenCalled();
    }
  );

  it("reports broken or unavailable injected hashing without leaking raw errors", () => {
    expect(
      buildEffectiveInputManifest(
        { definition, inputs, closure: "complete" },
        () => "not-a-hash"
      )
    ).toMatchObject({
      status: "failed",
      error: { code: "PRECONDITION_FAILED" }
    });
    const result = buildEffectiveInputManifest(
      { definition, inputs, closure: "complete" },
      () => {
        throw new Error("untrusted implementation detail");
      }
    );
    expect(result).toMatchObject({
      status: "unavailable",
      error: { code: "SOURCE_UNAVAILABLE" }
    });
    expect(JSON.stringify(result)).not.toContain(
      "untrusted implementation detail"
    );
  });

  it("returns unchanged only for complete equivalent manifests, independent of ordering", () => {
    expect(
      compareEffectiveInputManifests(baseline, {
        ...baseline,
        inputs: [...baseline.inputs].reverse()
      })
    ).toEqual({
      status: "ok",
      value: { status: "unchanged", fingerprint: baseline.fingerprint }
    });
    const misleading = {
      ...baseline,
      inputs: baseline.inputs.map((entry) =>
        entry.path === definition ?
          { ...entry, contentHash: hash("changed") }
        : entry
      )
    };
    expect(compareEffectiveInputManifests(baseline, misleading)).toMatchObject({
      status: "failed",
      error: { code: "SOURCE_CHANGED" }
    });
    expect(
      compareEffectiveInputManifests(baseline, {
        ...baseline,
        fingerprint: hash("other")
      })
    ).toMatchObject({ status: "failed", error: { code: "SOURCE_CHANGED" } });
  });

  it("never treats incomplete or malformed manifest evidence as unchanged", () => {
    const incomplete: EffectiveInputManifest = {
      completeness: "incomplete",
      definition,
      inputs: [],
      diagnostics: []
    };
    for (const [before, after] of [
      [baseline, incomplete],
      [incomplete, baseline],
      [incomplete, incomplete]
    ] as const) {
      expect(compareEffectiveInputManifests(before, after)).toMatchObject({
        status: "unavailable",
        error: { code: "VALIDATION_INCOMPLETE" }
      });
    }
    for (const malformed of [
      { ...baseline, fingerprint: "bad" },
      { ...baseline, inputs: [...baseline.inputs, baseline.inputs[0]] }
    ]) {
      expect(compareEffectiveInputManifests(malformed, baseline)).toMatchObject(
        { status: "failed", error: { code: "INVALID_REQUEST" } }
      );
      expect(compareEffectiveInputManifests(baseline, malformed)).toMatchObject(
        { status: "failed", error: { code: "INVALID_REQUEST" } }
      );
    }
    expect(
      compareEffectiveInputManifests(baseline, { ...baseline, inputs: [] })
    ).toMatchObject({
      status: "unavailable",
      error: { code: "VALIDATION_INCOMPLETE" }
    });
  });

  it("honors cancellation before and after the injected hashing boundary", () => {
    const cancelled = { aborted: true };
    const hasher = vi.fn(hash);
    expect(
      buildEffectiveInputManifest(
        { definition, inputs, closure: "complete" },
        hasher,
        cancelled
      )
    ).toEqual({ status: "cancelled", reason: "request_cancelled" });
    expect(hasher).not.toHaveBeenCalled();
    const signal = { aborted: false };
    expect(
      buildEffectiveInputManifest(
        { definition, inputs, closure: "complete" },
        (canonical) => {
          signal.aborted = true;
          return hash(canonical);
        },
        signal
      )
    ).toEqual({ status: "cancelled", reason: "request_cancelled" });
    const cancelledHasher = { aborted: false };
    expect(
      buildEffectiveInputManifest(
        { definition, inputs, closure: "complete" },
        () => {
          cancelledHasher.aborted = true;
          throw new Error("Hashing cancelled");
        },
        cancelledHasher
      )
    ).toEqual({ status: "cancelled", reason: "request_cancelled" });
    expect(
      compareEffectiveInputManifests(baseline, baseline, cancelled)
    ).toEqual({ status: "cancelled", reason: "request_cancelled" });
    expect(
      verifySourceExpectation(selection, resolved, baseline, cancelled)
    ).toEqual({ status: "cancelled", reason: "request_cancelled" });
  });
});

describe("explicit source expectation policy", () => {
  it("provides lexical preflight before an adapter reads files or resolves Git refs", () => {
    expect(validateSourcePath(definition)).toEqual({
      status: "ok",
      value: definition
    });
    expect(validateSourcePath("../outside")).toMatchObject({
      status: "failed",
      error: { code: "INVALID_REQUEST" }
    });
    expect(validateSourceSelection(selection)).toEqual({
      status: "ok",
      value: undefined
    });
    expect(
      validateSourceSelection({ ...selection, definition: "C:\\outside" })
    ).toMatchObject({ status: "failed", error: { code: "INVALID_REQUEST" } });
    expect(validateSourceSelection(selection, { aborted: true })).toEqual({
      status: "cancelled",
      reason: "request_cancelled"
    });
  });
  it("matches a workspace by repository, handle, branch and effective inputs rather than its base commit", () => {
    expect(verifySourceExpectation(selection, resolved, baseline)).toEqual({
      status: "ok",
      value: { status: "matched", fingerprint: baseline.fingerprint }
    });
    expect(
      verifySourceExpectation(
        selection,
        { ...resolved, repo: "EXAMPLE/SHOP", baseCommit: "b".repeat(40) },
        baseline
      ).status
    ).toBe("ok");
  });

  it("preserves caller expectations and reports changed workspace inputs or branch", () => {
    const request = structuredClone(selection);
    for (const actual of [
      { ...resolved, branch: "main" },
      { ...resolved, fingerprint: hash("different") }
    ]) {
      const manifest = { ...baseline, fingerprint: actual.fingerprint };
      expect(verifySourceExpectation(request, actual, manifest)).toMatchObject({
        status: "failed",
        error: { code: "SOURCE_CHANGED" }
      });
    }
    expect(request).toEqual(selection);
  });

  it("rejects wrong repository/workspace identity and source-manifest inconsistencies", () => {
    for (const [actual, manifest] of [
      [{ ...resolved, repo: "other/shop" }, baseline],
      [{ ...resolved, workspaceRef: "workspace-2" }, baseline],
      [{ ...resolved, fingerprint: hash("different") }, baseline],
      [
        resolved,
        {
          ...baseline,
          definition: ".radius/other.bicep",
          inputs: [
            ...baseline.inputs,
            input(".radius/other.bicep", "definition", "")
          ]
        }
      ]
    ] as const) {
      expect(
        verifySourceExpectation(selection, actual, manifest)
      ).toMatchObject({
        status: "failed",
        error: { code: "EVIDENCE_MISMATCH" }
      });
    }
  });

  it("requires the exact Git commit and explicit ref without replacing expectations", () => {
    const gitSelection: SourceSelection = {
      ...selection,
      source: {
        kind: "git",
        ref: "feature/model",
        expectedCommit: "a".repeat(40)
      }
    };
    const gitResolved: ResolvedSource = {
      kind: "git",
      repo: selection.repo,
      ref: "feature/model",
      commit: "A".repeat(40),
      fingerprint: baseline.fingerprint,
      resolvedAt: resolved.resolvedAt
    };
    expect(
      verifySourceExpectation(gitSelection, gitResolved, baseline).status
    ).toBe("ok");
    expect(
      verifySourceExpectation(
        gitSelection,
        { ...gitResolved, commit: "b".repeat(40) },
        baseline
      )
    ).toMatchObject({ status: "failed", error: { code: "SOURCE_CHANGED" } });
    expect(
      verifySourceExpectation(
        gitSelection,
        { ...gitResolved, ref: "main" },
        baseline
      )
    ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
    expect(
      verifySourceExpectation(selection, gitResolved, baseline)
    ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
    expect(
      verifySourceExpectation(gitSelection, resolved, baseline)
    ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
    expect(gitSelection.source).toEqual({
      kind: "git",
      ref: "feature/model",
      expectedCommit: "a".repeat(40)
    });
    expect(
      verifySourceExpectation(
        {
          ...gitSelection,
          source: {
            kind: "git",
            ref: "feature/model",
            expectedCommit: "b".repeat(64)
          }
        },
        { ...gitResolved, commit: "B".repeat(64) },
        baseline
      ).status
    ).toBe("ok");
  });

  it("rejects malformed source expectations and never matches incomplete input evidence", () => {
    const badSelections: SourceSelection[] = [
      { ...selection, repo: "../shop" },
      { ...selection, definition: "../app.bicep" },
      {
        ...selection,
        source: {
          kind: "workspace",
          workspaceRef: "/outside",
          branch: "feature/model",
          expectedFingerprint: baseline.fingerprint
        }
      },
      {
        ...selection,
        source: {
          kind: "workspace",
          workspaceRef: "workspace-1",
          branch: "main",
          expectedFingerprint: ""
        }
      },
      {
        ...selection,
        source: { kind: "git", ref: "main~1", expectedCommit: "a".repeat(40) }
      },
      {
        ...selection,
        source: { kind: "git", ref: "main", expectedCommit: "short" }
      }
    ];
    for (const candidate of badSelections) {
      expect(
        verifySourceExpectation(candidate, resolved, baseline)
      ).toMatchObject({ status: "failed", error: { code: "INVALID_REQUEST" } });
    }
    expect(
      verifySourceExpectation(selection, resolved, {
        completeness: "incomplete",
        definition,
        inputs: [],
        diagnostics: []
      })
    ).toMatchObject({
      status: "unavailable",
      error: { code: "VALIDATION_INCOMPLETE" }
    });
    expect(
      verifySourceExpectation(
        selection,
        { ...resolved, fingerprint: "invalid" },
        baseline
      )
    ).toMatchObject({ status: "failed", error: { code: "INVALID_REQUEST" } });
  });

  it("rejects trailing-newline aliases in paths, hashes and expected or actual source identity", () => {
    const gitSelection: SourceSelection = {
      ...selection,
      source: {
        kind: "git",
        ref: "feature/model",
        expectedCommit: "a".repeat(40)
      }
    };
    const gitResolved: ResolvedSource = {
      kind: "git",
      repo: selection.repo,
      ref: "feature/model",
      commit: "a".repeat(40),
      fingerprint: baseline.fingerprint,
      resolvedAt: resolved.resolvedAt
    };
    const invalidSelections: SourceSelection[] = [
      { ...selection, repo: `${selection.repo}\n` },
      {
        ...selection,
        source: {
          kind: "workspace",
          workspaceRef: "workspace-1\n",
          branch: "feature/model",
          expectedFingerprint: baseline.fingerprint
        }
      },
      {
        ...selection,
        source: {
          kind: "workspace",
          workspaceRef: "workspace-1",
          branch: "feature/model\n",
          expectedFingerprint: baseline.fingerprint
        }
      },
      {
        ...selection,
        source: {
          kind: "workspace",
          workspaceRef: "workspace-1",
          branch: "feature/model",
          expectedFingerprint: `${baseline.fingerprint}\n`
        }
      },
      {
        ...gitSelection,
        source: {
          kind: "git",
          ref: "feature/model\n",
          expectedCommit: "a".repeat(40)
        }
      },
      {
        ...gitSelection,
        source: {
          kind: "git",
          ref: "feature/model",
          expectedCommit: `${"a".repeat(40)}\n`
        }
      }
    ];
    for (const candidate of invalidSelections) {
      expect(
        verifySourceExpectation(candidate, resolved, baseline)
      ).toMatchObject({ status: "failed", error: { code: "INVALID_REQUEST" } });
    }
    for (const actual of [
      { ...resolved, repo: `${resolved.repo}\n` },
      { ...resolved, workspaceRef: "workspace-1\n" },
      { ...resolved, branch: "feature/model\n" },
      { ...resolved, fingerprint: `${baseline.fingerprint}\n` },
      { ...gitResolved, ref: "feature/model\n" },
      { ...gitResolved, commit: `${gitResolved.commit}\n` }
    ]) {
      expect(
        verifySourceExpectation(selection, actual, baseline)
      ).toMatchObject({ status: "failed", error: { code: "INVALID_REQUEST" } });
    }
    expect(
      buildEffectiveInputManifest(
        {
          definition,
          closure: "complete",
          inputs: [{ ...inputs[0], contentHash: `${inputs[0].contentHash}\n` }]
        },
        hash
      )
    ).toMatchObject({ status: "failed", error: { code: "INVALID_REQUEST" } });
    expect(
      buildEffectiveInputManifest(
        { definition, inputs, closure: "complete" },
        () => `${baseline.fingerprint}\n`
      )
    ).toMatchObject({
      status: "failed",
      error: { code: "PRECONDITION_FAILED" }
    });
  });
});
