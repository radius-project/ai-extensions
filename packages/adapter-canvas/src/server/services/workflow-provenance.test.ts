import { describe, expect, it } from "vitest";
import {
  verifySetupBranchHead,
  verifyWorkflowProvenance,
  type BranchHeadState,
  type RepositoryFileState,
  type WorkflowProvenancePorts,
  type WorkflowProvenanceRecord
} from "./workflow-provenance.js";

// GitHub is a scripted fake that throws on anything the scenario did not model,
// so a verdict can never come from a call the test did not intend.

const BLOB = "b".repeat(40);
const DIGEST = "d".repeat(64);

function record(
  overrides: Partial<WorkflowProvenanceRecord> = {}
): WorkflowProvenanceRecord {
  return {
    path: ".github/workflows/radius-verify-credentials.yml",
    branch: "main",
    mode: "default_branch",
    commitSha: "c".repeat(40),
    blobSha: BLOB,
    contentSha256: DIGEST,
    previousBlobSha: null,
    ...overrides
  };
}

function ports(script: {
  files?: Record<string, RepositoryFileState>;
  heads?: Record<string, BranchHeadState>;
}): WorkflowProvenancePorts {
  return {
    readFile: ({ path, ref }) => {
      const state = script.files?.[`${ref}:${path}`];
      if (!state) throw new Error(`unscripted readFile ${ref}:${path}`);
      return Promise.resolve(state);
    },
    readBranchHead: ({ branch }) => {
      const state = script.heads?.[branch];
      if (!state) throw new Error(`unscripted readBranchHead ${branch}`);
      return Promise.resolve(state);
    }
  };
}

const present = (
  overrides: Partial<Extract<RepositoryFileState, { status: "present" }>> = {}
): RepositoryFileState => ({
  status: "present",
  blobSha: BLOB,
  contentSha256: DIGEST,
  ...overrides
});

const VERIFY_KEY =
  "main:.github/workflows/radius-verify-credentials.yml" as const;

// One saved record, verified against one scripted repository state. Only the
// pair a scenario is about differs, so the request is built once here.
function verifyOne(
  state: RepositoryFileState | null,
  overrides: Partial<WorkflowProvenanceRecord> = {}
) {
  return verifyWorkflowProvenance(
    { repo: "contoso/store", files: [record(overrides)] },
    ports(state ? { files: { [VERIFY_KEY]: state } } : {})
  );
}

describe("verifyWorkflowProvenance", () => {
  it("clears a file whose blob and content both still match", async () => {
    const verdict = await verifyOne(present());

    expect(verdict.blocked).toBe(false);
    expect(verdict.reasons).toEqual([]);
    // The verdict carries the record it came from, so a caller never has to
    // re-associate a parallel array with its inputs.
    expect(verdict.files).toEqual([
      { record: record(), state: "unchanged", detail: null }
    ]);
  });

  it("treats an absent file as already reverted rather than as a mismatch", async () => {
    const verdict = await verifyOne({ status: "absent" });

    expect(verdict.blocked).toBe(false);
    expect(verdict.files[0]?.state).toBe("already_absent");
  });

  it("blocks a file whose blob changed since Radius committed it", async () => {
    const verdict = await verifyOne(present({ blobSha: "e".repeat(40) }));

    expect(verdict.blocked).toBe(true);
    expect(verdict.files[0]?.state).toBe("changed");
    expect(verdict.reasons).toEqual([
      '".github/workflows/radius-verify-credentials.yml" on "main" has changed since Radius committed it, so Radius left it in place.'
    ]);
  });

  it("blocks a file whose contents changed even when the blob id matches", async () => {
    // A blob id that matches while the bytes do not can only come from a
    // rewritten or spoofed answer, so the second identity is checked too.
    const verdict = await verifyOne(present({ contentSha256: "f".repeat(64) }));

    expect(verdict.blocked).toBe(true);
    expect(verdict.reasons[0]).toContain(
      "no longer match what Radius committed"
    );
  });

  it("blocks a record that never saved an identity to compare", async () => {
    // No read is scripted: a record with nothing to compare must be refused
    // before GitHub is asked at all.
    const verdict = await verifyOne(null, {
      blobSha: null,
      contentSha256: null
    });

    expect(verdict.blocked).toBe(true);
    expect(verdict.files[0]?.state).toBe("unverifiable");
    expect(verdict.reasons[0]).toContain("did not save what it committed");
  });

  it("blocks a file GitHub could not be read for", async () => {
    const verdict = await verifyOne({
      status: "unreadable",
      detail: "HTTP 500"
    });

    expect(verdict.blocked).toBe(true);
    expect(verdict.files[0]?.state).toBe("unverifiable");
    expect(verdict.reasons[0]).toContain("HTTP 500");
  });

  it("blocks a file GitHub answered for with no comparable identity", async () => {
    const verdict = await verifyOne(
      present({ blobSha: null, contentSha256: null })
    );

    expect(verdict.blocked).toBe(true);
    expect(verdict.files[0]?.state).toBe("unverifiable");
    expect(verdict.reasons[0]).toContain("did not report an identity");
  });

  it("clears a file when only one identity is comparable and it matches", async () => {
    const verdict = await verifyOne(present({ contentSha256: null }), {
      contentSha256: null
    });

    expect(verdict.blocked).toBe(false);
    expect(verdict.files[0]?.state).toBe("unchanged");
  });

  it("reports one reason per blocking file and keeps the cleared ones", async () => {
    const verdict = await verifyWorkflowProvenance(
      {
        repo: "contoso/store",
        files: [
          record(),
          record({ path: ".github/workflows/radius-deploy.yml" })
        ]
      },
      ports({
        files: {
          [VERIFY_KEY]: present(),
          "main:.github/workflows/radius-deploy.yml": present({
            blobSha: "e".repeat(40)
          })
        }
      })
    );

    expect(verdict.files.map((entry) => entry.state)).toEqual([
      "unchanged",
      "changed"
    ]);
    expect(verdict.reasons).toHaveLength(1);
  });

  it("names a file with no saved branch without printing an empty one", async () => {
    const verdict = await verifyOne(null, {
      branch: "",
      blobSha: null,
      contentSha256: null
    });

    expect(verdict.reasons[0]).toBe(
      'Radius did not save what it committed for ".github/workflows/radius-verify-credentials.yml", so it cannot prove the file is unchanged.'
    );
  });

  it("clears an empty selection without asking GitHub anything", async () => {
    await expect(
      verifyWorkflowProvenance({ repo: "contoso/store", files: [] }, ports({}))
    ).resolves.toEqual({ files: [], blocked: false, reasons: [] });
  });
});

describe("verifySetupBranchHead", () => {
  it("clears a branch still pointing at the commit Radius left", async () => {
    await expect(
      verifySetupBranchHead(
        { repo: "contoso/store", branch: "radius/setup", headSha: "head-1" },
        ports({
          heads: { "radius/setup": { status: "present", sha: "head-1" } }
        })
      )
    ).resolves.toEqual({ state: "unchanged", detail: null });
  });

  it("refuses a branch that carries commits Radius did not write", async () => {
    const verdict = await verifySetupBranchHead(
      { repo: "contoso/store", branch: "radius/setup", headSha: "head-1" },
      ports({ heads: { "radius/setup": { status: "present", sha: "head-2" } } })
    );

    expect(verdict.state).toBe("moved");
    expect(verdict.detail).toContain("commits Radius did not write");
  });

  it("treats an absent branch as already gone", async () => {
    await expect(
      verifySetupBranchHead(
        { repo: "contoso/store", branch: "radius/setup", headSha: "head-1" },
        ports({ heads: { "radius/setup": { status: "absent" } } })
      )
    ).resolves.toEqual({ state: "already_absent", detail: null });
  });

  it.each([
    [
      "no branch was saved",
      { branch: "", headSha: "head-1" },
      "which branch it committed the workflows to"
    ],
    [
      "no head commit was saved",
      { branch: "radius/setup", headSha: null },
      "the commit it left at the head"
    ]
  ])("refuses when %s", async (_label, overrides, expected) => {
    const verdict = await verifySetupBranchHead(
      { repo: "contoso/store", ...overrides },
      ports({})
    );

    expect(verdict.state).toBe("unverifiable");
    expect(verdict.detail).toContain(expected);
  });

  it("refuses when GitHub could not be read", async () => {
    const verdict = await verifySetupBranchHead(
      { repo: "contoso/store", branch: "radius/setup", headSha: "head-1" },
      ports({
        heads: {
          "radius/setup": { status: "unreadable", detail: "HTTP 403" }
        }
      })
    );

    expect(verdict.state).toBe("unverifiable");
    expect(verdict.detail).toContain("HTTP 403");
  });
});
