import { describe, expect, it } from "vitest";
import {
  buildOidcSubject,
  buildEnvironmentSuffix,
  buildFederatedCredentialName
} from "./oidc-subject.js";

describe("buildOidcSubject", () => {
  const base = {
    repoFullName: "octo-org/octo-repo",
    ownerId: 111,
    repoId: 222,
    suffix: "environment:production"
  };

  // ─── default (use_default = true) ────────────────────────────────────────────

  describe("default subject", () => {
    it("builds the mutable default format", () => {
      const subject = buildOidcSubject({
        ...base,
        subjectConfig: { useDefault: true }
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
        subjectConfig: { useDefault: true, useImmutableSubject: true }
      });
      expect(subject).toBe(
        "repo:octo-org@111/octo-repo@222:environment:production"
      );
    });

    it("prefers an explicit sub_claim_prefix for the immutable default", () => {
      const subject = buildOidcSubject({
        ...base,
        subjectConfig: {
          useDefault: true,
          useImmutableSubject: true,
          subClaimPrefix: "repo:octo-org@999/octo-repo@888"
        }
      });
      expect(subject).toBe(
        "repo:octo-org@999/octo-repo@888:environment:production"
      );
    });

    it("accepts string-typed numeric ids for the immutable default", () => {
      const subject = buildOidcSubject({
        repoFullName: "octo-org/octo-repo",
        ownerId: "111",
        repoId: "222",
        suffix: "environment:dev",
        subjectConfig: { useDefault: true, useImmutableSubject: true }
      });
      expect(subject).toBe("repo:octo-org@111/octo-repo@222:environment:dev");
    });

    it("throws for immutable default when the owner id is missing", () => {
      expect(() =>
        buildOidcSubject({
          repoFullName: "octo-org/octo-repo",
          repoId: 222,
          suffix: "environment:production",
          subjectConfig: { useDefault: true, useImmutableSubject: true }
        })
      ).toThrow(/numeric owner id/);
    });

    it("throws for immutable default when the repo id is missing", () => {
      expect(() =>
        buildOidcSubject({
          repoFullName: "octo-org/octo-repo",
          ownerId: 111,
          suffix: "environment:production",
          subjectConfig: { useDefault: true, useImmutableSubject: true }
        })
      ).toThrow(/numeric repository id/);
    });
  });

  // ─── custom (use_default = false) ────────────────────────────────────────────

  describe("custom subject (use_default=false)", () => {
    it("maps the mutable repository claim to the canonical full name", () => {
      const subject = buildOidcSubject({
        ...base,
        subjectConfig: {
          useDefault: false,
          useImmutableSubject: false,
          includeClaimKeys: ["repository"]
        }
      });
      expect(subject).toBe("repository:octo-org/octo-repo");
    });

    it("maps the immutable repository claim to the owner@id/repo@id form", () => {
      const subject = buildOidcSubject({
        ...base,
        subjectConfig: {
          useDefault: false,
          useImmutableSubject: true,
          includeClaimKeys: ["repository"]
        }
      });
      expect(subject).toBe("repository:octo-org@111/octo-repo@222");
    });

    it("prefers sub_claim_prefix for an immutable repository claim", () => {
      const subject = buildOidcSubject({
        ...base,
        subjectConfig: {
          useDefault: false,
          useImmutableSubject: true,
          subClaimPrefix: "repo:octo-org@5/octo-repo@6",
          includeClaimKeys: ["repository"]
        }
      });
      expect(subject).toBe("repository:octo-org@5/octo-repo@6");
    });

    it("throws when a repository claim needs an undetermined immutability decision", () => {
      expect(() =>
        buildOidcSubject({
          ...base,
          subjectConfig: { useDefault: false, includeClaimKeys: ["repository"] }
        })
      ).toThrow(/immutable/);
    });

    it("maps repository_id to the numeric repo id", () => {
      const subject = buildOidcSubject({
        ...base,
        subjectConfig: {
          useDefault: false,
          includeClaimKeys: ["repository_id"]
        }
      });
      expect(subject).toBe("repository_id:222");
    });

    it("maps repository_owner_id to the numeric owner id", () => {
      const subject = buildOidcSubject({
        ...base,
        subjectConfig: {
          useDefault: false,
          includeClaimKeys: ["repository_owner_id"]
        }
      });
      expect(subject).toBe("repository_owner_id:111");
    });

    it("maps repository_owner to the owner login", () => {
      const subject = buildOidcSubject({
        ...base,
        subjectConfig: {
          useDefault: false,
          includeClaimKeys: ["repository_owner"]
        }
      });
      expect(subject).toBe("repository_owner:octo-org");
    });

    it("maps the context claim to the suffix", () => {
      const subject = buildOidcSubject({
        ...base,
        subjectConfig: { useDefault: false, includeClaimKeys: ["context"] }
      });
      expect(subject).toBe("environment:production");
    });

    it("maps the environment claim to the suffix", () => {
      const subject = buildOidcSubject({
        ...base,
        suffix: buildEnvironmentSuffix("dev"),
        subjectConfig: { useDefault: false, includeClaimKeys: ["environment"] }
      });
      expect(subject).toBe("environment:dev");
    });

    it("maps the mutable repo short-form claim", () => {
      const subject = buildOidcSubject({
        ...base,
        subjectConfig: {
          useDefault: false,
          useImmutableSubject: false,
          includeClaimKeys: ["repo"]
        }
      });
      expect(subject).toBe("repo:octo-org/octo-repo");
    });

    it("maps the immutable repo short-form claim", () => {
      const subject = buildOidcSubject({
        ...base,
        subjectConfig: {
          useDefault: false,
          useImmutableSubject: true,
          includeClaimKeys: ["repo"]
        }
      });
      expect(subject).toBe("repo:octo-org@111/octo-repo@222");
    });

    it("joins multiple claim keys in order", () => {
      const subject = buildOidcSubject({
        ...base,
        subjectConfig: {
          useDefault: false,
          useImmutableSubject: false,
          includeClaimKeys: ["repository", "repository_id", "context"]
        }
      });
      expect(subject).toBe(
        "repository:octo-org/octo-repo:repository_id:222:environment:production"
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
          includeClaimKeys: ["repository_owner_id", "context"]
        }
      });
      expect(subject).toBe("repository_owner_id:111:ref:refs/heads/main");
    });

    it("throws with the key name and actionable recourse on an unknown claim key", () => {
      expect(() =>
        buildOidcSubject({
          ...base,
          subjectConfig: {
            useDefault: false,
            useImmutableSubject: false,
            includeClaimKeys: ["repository", "job_workflow_ref"]
          }
        })
      ).toThrow(/job_workflow_ref/);
      // Message names the org-level customization and points at the follow-up.
      expect(() =>
        buildOidcSubject({
          ...base,
          subjectConfig: {
            useDefault: false,
            useImmutableSubject: false,
            includeClaimKeys: ["repository", "job_workflow_ref"]
          }
        })
      ).toThrow(/customize the subject claims[\s\S]*issues\/185/);
    });

    it("lists every unmapped claim key in one error", () => {
      let message = "";
      try {
        buildOidcSubject({
          ...base,
          subjectConfig: {
            useDefault: false,
            useImmutableSubject: false,
            includeClaimKeys: [
              "actor",
              "job_workflow_ref",
              "runner_environment"
            ]
          }
        });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain('"actor"');
      expect(message).toContain('"job_workflow_ref"');
      expect(message).toContain('"runner_environment"');
    });

    it("throws when use_default=false but no claim keys are provided", () => {
      expect(() =>
        buildOidcSubject({
          ...base,
          subjectConfig: { useDefault: false, includeClaimKeys: [] }
        })
      ).toThrow(/no claim keys/);
    });

    it("throws when a required id is missing for repository_id", () => {
      expect(() =>
        buildOidcSubject({
          repoFullName: "octo-org/octo-repo",
          suffix: "environment:production",
          subjectConfig: {
            useDefault: false,
            includeClaimKeys: ["repository_id"]
          }
        })
      ).toThrow(/numeric repository id/);
    });

    it("throws when a required id is missing for repository_owner_id", () => {
      expect(() =>
        buildOidcSubject({
          repoFullName: "octo-org/octo-repo",
          suffix: "environment:production",
          subjectConfig: {
            useDefault: false,
            includeClaimKeys: ["repository_owner_id"]
          }
        })
      ).toThrow(/numeric owner id/);
    });
  });

  // ─── input validation ────────────────────────────────────────────────────────

  describe("repoFullName validation", () => {
    it("throws for a non owner/repo value", () => {
      expect(() =>
        buildOidcSubject({ ...base, repoFullName: "not-a-slug" })
      ).toThrow(/owner\/repo/);
    });

    it("throws for an empty repo full name", () => {
      expect(() => buildOidcSubject({ ...base, repoFullName: "" })).toThrow(
        /owner\/repo/
      );
    });

    it("throws for a three-segment path", () => {
      expect(() =>
        buildOidcSubject({ ...base, repoFullName: "a/b/c" })
      ).toThrow(/owner\/repo/);
    });
  });
});

describe("buildEnvironmentSuffix", () => {
  it("prefixes environment: and leaves a plain name intact", () => {
    expect(buildEnvironmentSuffix("production")).toBe("environment:production");
  });

  it("encodes a colon in the environment name as %3A", () => {
    expect(buildEnvironmentSuffix("prod:west")).toBe("environment:prod%3Awest");
  });

  it("encodes multiple colons", () => {
    expect(buildEnvironmentSuffix("a:b:c")).toBe("environment:a%3Ab%3Ac");
  });
});

describe("buildFederatedCredentialName", () => {
  it("builds a sanitized github-owner-repo-env name", () => {
    expect(
      buildFederatedCredentialName({
        repoFullName: "octo-org/octo-repo",
        envName: "production"
      })
    ).toBe("github-octo-org-octo-repo-production");
  });

  it("appends a variant when provided", () => {
    expect(
      buildFederatedCredentialName({
        repoFullName: "octo-org/octo-repo",
        envName: "dev",
        variant: "immutable"
      })
    ).toBe("github-octo-org-octo-repo-dev-immutable");
  });

  it("replaces disallowed characters (e.g. colon) with a hyphen", () => {
    expect(
      buildFederatedCredentialName({
        repoFullName: "octo-org/octo-repo",
        envName: "prod:west"
      })
    ).toBe("github-octo-org-octo-repo-prod-west");
  });

  it("truncates to <=120 characters without a trailing hyphen", () => {
    const name = buildFederatedCredentialName({
      repoFullName: "octo-org/octo-repo",
      envName: "e".repeat(200),
      variant: "immutable"
    });
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith("-")).toBe(false);
  });

  it("keeps the mutable/immutable pair distinct and variant-terminated under truncation", () => {
    const common = {
      repoFullName: "octo-org/octo-repo",
      envName: "e".repeat(200)
    };
    const mutable = buildFederatedCredentialName({
      ...common,
      variant: "mutable"
    });
    const immutable = buildFederatedCredentialName({
      ...common,
      variant: "immutable"
    });

    // Distinct — the collision bug produced identical truncated names.
    expect(mutable).not.toBe(immutable);
    // Both within Azure's 120-char limit.
    expect(mutable.length).toBeLessThanOrEqual(120);
    expect(immutable.length).toBeLessThanOrEqual(120);
    // The full variant always survives truncation.
    expect(mutable.endsWith("-mutable")).toBe(true);
    expect(immutable.endsWith("-immutable")).toBe(true);
    // No leading/trailing hyphen, valid charset.
    for (const name of [mutable, immutable]) {
      expect(name.startsWith("-")).toBe(false);
      expect(name.endsWith("-")).toBe(false);
      expect(/^[A-Za-z0-9_-]+$/.test(name)).toBe(true);
    }
  });

  it("stays distinct with a long repo name plus a long env", () => {
    const common = {
      repoFullName: `octo-org/${"r".repeat(100)}`,
      envName: "e".repeat(50)
    };
    const mutable = buildFederatedCredentialName({
      ...common,
      variant: "mutable"
    });
    const immutable = buildFederatedCredentialName({
      ...common,
      variant: "immutable"
    });
    expect(mutable).not.toBe(immutable);
    expect(mutable.length).toBeLessThanOrEqual(120);
    expect(immutable.length).toBeLessThanOrEqual(120);
    expect(mutable.endsWith("-mutable")).toBe(true);
    expect(immutable.endsWith("-immutable")).toBe(true);
  });
});
