import { describe, expect, it } from "vitest";
import { proveGitHubEnvironmentCreated } from "./github-environment-provenance.js";

// The prover is pure: everything it decides comes from the preflight verdict,
// the PUT's own response body, and the clock reading taken before the write.

const PUT_STARTED_AT = Date.parse("2026-02-01T12:00:00.000Z");

function body(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

describe("proveGitHubEnvironmentCreated", () => {
  it("proves creation when the pre-create lookup found nothing", () => {
    expect(
      proveGitHubEnvironmentCreated({
        preflight: "created_candidate",
        putResponseBody: body({
          name: "dev",
          created_at: "2026-02-01T12:00:00.000Z",
          updated_at: "2026-02-01T12:00:00.000Z"
        }),
        putStartedAtMs: PUT_STARTED_AT
      })
    ).toEqual({ proven: true, detail: null });
  });

  it("refuses when the environment answered the pre-create lookup", () => {
    const proof = proveGitHubEnvironmentCreated({
      preflight: "reused",
      putResponseBody: body({ created_at: "2026-02-01T12:00:00.000Z" }),
      putStartedAtMs: PUT_STARTED_AT
    });
    expect(proof.proven).toBe(false);
    expect(proof.detail).toBe(
      "GitHub answered the pre-create lookup with the environment, so it existed before this setup ran."
    );
  });

  it("refuses when the pre-create lookup could not be classified", () => {
    const proof = proveGitHubEnvironmentCreated({
      preflight: null,
      putResponseBody: "",
      putStartedAtMs: PUT_STARTED_AT
    });
    expect(proof.proven).toBe(false);
    expect(proof.detail).toBe(
      "Radius could not read whether the environment existed before it was written, so it cannot claim to have created it."
    );
  });

  it("refuses when GitHub reports the environment predates this request", () => {
    const proof = proveGitHubEnvironmentCreated({
      preflight: "created_candidate",
      putResponseBody: body({
        created_at: "2026-01-20T09:30:00.000Z",
        updated_at: "2026-02-01T12:00:00.000Z"
      }),
      putStartedAtMs: PUT_STARTED_AT
    });
    expect(proof.proven).toBe(false);
    expect(proof.detail).toBe(
      "GitHub reports the environment was created at 2026-01-20T09:30:00.000Z, before this setup wrote to it, so Radius did not create it."
    );
  });

  it.each([
    ["a creation timestamp inside the skew tolerance", -60_000, true],
    ["a creation timestamp on the tolerance boundary", -120_000, true],
    ["a creation timestamp beyond the tolerance", -120_001, false],
    ["a creation timestamp GitHub reports as later", 5_000, true]
  ])("%s is %s", (_label, offsetMs, expected) => {
    expect(
      proveGitHubEnvironmentCreated({
        preflight: "created_candidate",
        putResponseBody: body({
          created_at: new Date(PUT_STARTED_AT + offsetMs).toISOString()
        }),
        putStartedAtMs: PUT_STARTED_AT
      }).proven
    ).toBe(expected);
  });

  it("honors an explicit tolerance, including zero", () => {
    const evidence = {
      preflight: "created_candidate" as const,
      putResponseBody: body({
        created_at: new Date(PUT_STARTED_AT - 1).toISOString()
      }),
      putStartedAtMs: PUT_STARTED_AT
    };
    expect(
      proveGitHubEnvironmentCreated({ ...evidence, toleranceMs: 0 }).proven
    ).toBe(false);
    expect(
      proveGitHubEnvironmentCreated({ ...evidence, toleranceMs: 10 }).proven
    ).toBe(true);
  });

  it("treats a negative tolerance as zero rather than inverting the check", () => {
    expect(
      proveGitHubEnvironmentCreated({
        preflight: "created_candidate",
        putResponseBody: body({
          created_at: new Date(PUT_STARTED_AT + 1).toISOString()
        }),
        putStartedAtMs: PUT_STARTED_AT,
        toleranceMs: -5_000
      }).proven
    ).toBe(true);
  });

  it("falls back to a non-finite tolerance's default", () => {
    expect(
      proveGitHubEnvironmentCreated({
        preflight: "created_candidate",
        putResponseBody: body({
          created_at: new Date(PUT_STARTED_AT - 119_000).toISOString()
        }),
        putStartedAtMs: PUT_STARTED_AT,
        toleranceMs: Number.NaN
      }).proven
    ).toBe(true);
  });

  it.each([
    ["an empty body", ""],
    ["a body that is not JSON", "not json at all"],
    ["a JSON array", "[]"],
    ["a JSON null", "null"],
    ["a body with no created_at", '{"name":"dev"}'],
    ["a non-string created_at", '{"created_at":17}'],
    ["an unparseable created_at", '{"created_at":"whenever"}']
  ])(
    "refuses promotion when the response carries %s",
    (_label, putResponseBody) => {
      const proof = proveGitHubEnvironmentCreated({
        preflight: "created_candidate",
        putResponseBody,
        putStartedAtMs: PUT_STARTED_AT
      });
      expect(proof.proven).toBe(false);
      expect(proof.detail).toBe(
        "GitHub did not report when the environment was created, so Radius cannot prove this request created it."
      );
    }
  );
});
