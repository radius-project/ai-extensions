import { describe, expect, it } from "vitest";
import { buildOidcSubject } from "./oidc-subject.js";

describe("buildOidcSubject", () => {
  const base = {
    repoFullName: "octo-org/octo-repo",
    ownerId: 111,
    repoId: 222,
    suffix: "environment:production",
  };

  // ─── default (use_default = true) ────────────────────────────────────────────

  describe("default subject", () => {
    it("builds the mutable default format", () => {
      const subject = buildOidcSubject({
        ...base,
        subjectConfig: { useDefault: true },
      });
      expect(subject).toBe("repo:octo-org/octo-repo:environment:production");
    });

    it("treats a null subjectConfig as mutable default", () => {
      const subject = buildOidcSubject({ ...base, subjectConfig: null });
      expect(subject).toBe("repo:octo-org/octo-repo:environment:production");
    });

    it("treats a missing subjectConfig as mutable default", () => {
      const subject = buildOidcSubject(base);
      expect(subject).toBe("repo:octo-org/octo-repo:environment:production");
    });

    it("builds the immutable default format with numeric ids", () => {
      const subject = buildOidcSubject({
        ...base,
        subjectConfig: { useDefault: true, useImmutableSubject: true },
      });
      expect(subject).toBe(
        "repo:octo-org@111/octo-repo@222:environment:production",
      );
    });

    it("accepts string-typed numeric ids for the immutable default", () => {
      const subject = buildOidcSubject({
        repoFullName: "octo-org/octo-repo",
        ownerId: "111",
        repoId: "222",
        suffix: "environment:dev",
        subjectConfig: { useDefault: true, useImmutableSubject: true },
      });
      expect(subject).toBe("repo:octo-org@111/octo-repo@222:environment:dev");
    });

    it("throws for immutable default when the owner id is missing", () => {
      expect(() =>
        buildOidcSubject({
          repoFullName: "octo-org/octo-repo",
          repoId: 222,
          suffix: "environment:production",
          subjectConfig: { useDefault: true, useImmutableSubject: true },
        }),
      ).toThrow(/numeric owner id/);
    });

    it("throws for immutable default when the repo id is missing", () => {
      expect(() =>
        buildOidcSubject({
          repoFullName: "octo-org/octo-repo",
          ownerId: 111,
          suffix: "environment:production",
          subjectConfig: { useDefault: true, useImmutableSubject: true },
        }),
      ).toThrow(/numeric repository id/);
    });
  });

  // ─── custom (use_default = false) ────────────────────────────────────────────

  describe("custom subject (use_default=false)", () => {
    it("maps the repository claim to the canonical full name", () => {
      const subject = buildOidcSubject({
        ...base,
        subjectConfig: { useDefault: false, includeClaimKeys: ["repository"] },
      });
      expect(subject).toBe("repository:octo-org/octo-repo");
    });

    it("maps repository_id to the numeric repo id", () => {
      const subject = buildOidcSubject({
        ...base,
        subjectConfig: { useDefault: false, includeClaimKeys: ["repository_id"] },
      });
      expect(subject).toBe("repository_id:222");
    });

    it("maps repository_owner_id to the numeric owner id", () => {
      const subject = buildOidcSubject({
        ...base,
        subjectConfig: {
          useDefault: false,
          includeClaimKeys: ["repository_owner_id"],
        },
      });
      expect(subject).toBe("repository_owner_id:111");
    });

    it("maps repository_owner to the owner login", () => {
      const subject = buildOidcSubject({
        ...base,
        subjectConfig: {
          useDefault: false,
          includeClaimKeys: ["repository_owner"],
        },
      });
      expect(subject).toBe("repository_owner:octo-org");
    });

    it("maps the context claim to the suffix", () => {
      const subject = buildOidcSubject({
        ...base,
        subjectConfig: { useDefault: false, includeClaimKeys: ["context"] },
      });
      expect(subject).toBe("environment:production");
    });

    it("maps the repo short-form claim", () => {
      const subject = buildOidcSubject({
        ...base,
        subjectConfig: { useDefault: false, includeClaimKeys: ["repo"] },
      });
      expect(subject).toBe("repo:octo-org/octo-repo");
    });

    it("joins multiple claim keys in order", () => {
      const subject = buildOidcSubject({
        ...base,
        subjectConfig: {
          useDefault: false,
          includeClaimKeys: ["repository", "repository_id", "context"],
        },
      });
      expect(subject).toBe(
        "repository:octo-org/octo-repo:repository_id:222:environment:production",
      );
    });

    it("supports a ref-style context suffix", () => {
      const subject = buildOidcSubject({
        repoFullName: "octo-org/octo-repo",
        ownerId: 111,
        repoId: 222,
        suffix: "ref:refs/heads/main",
        subjectConfig: {
          useDefault: false,
          includeClaimKeys: ["repository_owner_id", "context"],
        },
      });
      expect(subject).toBe(
        "repository_owner_id:111:ref:refs/heads/main",
      );
    });

    it("throws with the key name on an unknown claim key", () => {
      expect(() =>
        buildOidcSubject({
          ...base,
          subjectConfig: {
            useDefault: false,
            includeClaimKeys: ["repository", "job_workflow_ref"],
          },
        }),
      ).toThrow(/job_workflow_ref/);
    });

    it("throws when use_default=false but no claim keys are provided", () => {
      expect(() =>
        buildOidcSubject({
          ...base,
          subjectConfig: { useDefault: false, includeClaimKeys: [] },
        }),
      ).toThrow(/no claim keys/);
    });

    it("throws when a required id is missing for repository_id", () => {
      expect(() =>
        buildOidcSubject({
          repoFullName: "octo-org/octo-repo",
          suffix: "environment:production",
          subjectConfig: {
            useDefault: false,
            includeClaimKeys: ["repository_id"],
          },
        }),
      ).toThrow(/numeric repository id/);
    });

    it("throws when a required id is missing for repository_owner_id", () => {
      expect(() =>
        buildOidcSubject({
          repoFullName: "octo-org/octo-repo",
          suffix: "environment:production",
          subjectConfig: {
            useDefault: false,
            includeClaimKeys: ["repository_owner_id"],
          },
        }),
      ).toThrow(/numeric owner id/);
    });
  });

  // ─── input validation ────────────────────────────────────────────────────────

  describe("repoFullName validation", () => {
    it("throws for a non owner/repo value", () => {
      expect(() =>
        buildOidcSubject({ ...base, repoFullName: "not-a-slug" }),
      ).toThrow(/owner\/repo/);
    });

    it("throws for an empty repo full name", () => {
      expect(() => buildOidcSubject({ ...base, repoFullName: "" })).toThrow(
        /owner\/repo/,
      );
    });

    it("throws for a three-segment path", () => {
      expect(() =>
        buildOidcSubject({ ...base, repoFullName: "a/b/c" }),
      ).toThrow(/owner\/repo/);
    });
  });
});
