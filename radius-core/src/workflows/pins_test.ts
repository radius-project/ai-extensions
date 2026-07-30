import { describe, expect, it } from "vitest";
import {
  classifyPin,
  comparePins,
  describePlan,
  pinActionRefs,
  readActionPins,
} from "./pins.js";
import {
  REPO_RADIUS_PINSET,
  validatePinset,
  type Pinset,
} from "./pinset.js";

const OLD_SHA = "1111111111111111111111111111111111111111";
const NEW_SHA = "2222222222222222222222222222222222222222";
const OFF_LEDGER_SHA = "3333333333333333333333333333333333333333";

// A two-entry pinset: one repo-wide entry (the monorepo shape upstream ships
// today) plus one exact-path entry, so path precedence is exercised.
const PINSET: Pinset = {
  actions: {
    "radius-project/radius": {
      repo: "radius-project/radius",
      path: "",
      version: "v0.61.0",
      sha: NEW_SHA,
    },
    "radius-project/other/.github/actions/special": {
      repo: "radius-project/other",
      path: ".github/actions/special",
      version: "v9.9.9",
      sha: NEW_SHA,
    },
  },
  templateSource: {
    repo: "radius-project/radius",
    path: ".github/extension",
    version: "v0.61.0",
    sha: NEW_SHA,
  },
  ledger: {
    "radius-project/radius": [
      { version: "v0.60.0", sha: OLD_SHA },
      { version: "v0.61.0", sha: NEW_SHA },
    ],
    "radius-project/other": [{ version: "v9.9.9", sha: NEW_SHA }],
  },
};

const WORKFLOW = `name: deploy
on:
  workflow_dispatch:

jobs:
  azure:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4
      - name: Set up control plane
        uses: radius-project/radius/.github/extension/actions/setup-control-plane@main
      - name: Run rad commands
        uses: radius-project/radius/.github/extension/actions/run-rad-commands@main
`;

describe("readActionPins", () => {
  it("reads every external reference with its line number", () => {
    const pins = readActionPins(WORKFLOW);

    expect(pins).toEqual([
      {
        target: "actions/checkout",
        repo: "actions/checkout",
        path: "",
        ref: "34e114876b0b11c390a56381ad16ebd13914f8d5",
        version: "v4",
        line: 10,
      },
      {
        target: "radius-project/radius/.github/extension/actions/setup-control-plane",
        repo: "radius-project/radius",
        path: ".github/extension/actions/setup-control-plane",
        ref: "main",
        version: "",
        line: 12,
      },
      {
        target: "radius-project/radius/.github/extension/actions/run-rad-commands",
        repo: "radius-project/radius",
        path: ".github/extension/actions/run-rad-commands",
        ref: "main",
        version: "",
        line: 14,
      },
    ]);
  });

  it("skips local and docker references, which carry no upstream ref", () => {
    const dispatcher = [
      "jobs:",
      "  azure:",
      "    uses: ./.github/workflows/run-rad-commands-azure.yml",
      "  aws:",
      "    uses: ../shared/deploy.yml",
      "  image:",
      "    uses: docker://alpine@sha256:abc",
    ].join("\n");

    expect(readActionPins(dispatcher)).toEqual([]);
  });

  it("reads list items, quoted values and odd indentation", () => {
    const yaml = [
      "      - uses: radius-project/radius/a@main",
      "        uses: 'radius-project/radius/b@main'",
      '   uses:   "radius-project/radius/c@main"   # v1',
    ].join("\n");

    expect(readActionPins(yaml).map((p) => [p.path, p.ref, p.version])).toEqual([
      ["a", "main", ""],
      ["b", "main", ""],
      ["c", "main", "v1"],
    ]);
  });

  it("ignores a `uses` that is not a key or has no ref", () => {
    const yaml = ["# uses: owner/repo@main", "    name: uses: something", "    uses: owner/repo"].join("\n");

    expect(readActionPins(yaml)).toEqual([]);
  });
});

describe("pinActionRefs", () => {
  it("pins governed references and leaves third-party ones untouched", () => {
    const pinned = pinActionRefs(WORKFLOW, PINSET);

    expect(pinned).toContain(
      `uses: radius-project/radius/.github/extension/actions/setup-control-plane@${NEW_SHA} # v0.61.0`,
    );
    expect(pinned).toContain(
      `uses: radius-project/radius/.github/extension/actions/run-rad-commands@${NEW_SHA} # v0.61.0`,
    );
    expect(pinned).toContain(
      "uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4",
    );
  });

  // Guards against re-serializing the YAML: a parse/emit round-trip reindents,
  // drops blank lines and drops a leading `---`, turning a two-ref change into
  // an unreviewable whole-file diff.
  it("changes only the reference lines and preserves the line count", () => {
    const before = WORKFLOW.split("\n");
    const after = pinActionRefs(WORKFLOW, PINSET).split("\n");

    expect(after).toHaveLength(before.length);
    const changed = before.flatMap((line, i) => (line === after[i] ? [] : [i + 1]));
    expect(changed).toEqual([12, 14]);
  });

  it("preserves indentation, list markers and quoting style", () => {
    const yaml = [
      "      - uses: radius-project/radius/a@main",
      "        uses: 'radius-project/radius/b@v1'",
      '  uses:   "radius-project/radius/c@main" # stale',
    ].join("\n");

    expect(pinActionRefs(yaml, PINSET).split("\n")).toEqual([
      `      - uses: radius-project/radius/a@${NEW_SHA} # v0.61.0`,
      `        uses: 'radius-project/radius/b@${NEW_SHA}' # v0.61.0`,
      `  uses:   "radius-project/radius/c@${NEW_SHA}" # v0.61.0`,
    ]);
  });

  it("prefers an exact path entry over the repo-wide one", () => {
    const yaml = "    uses: radius-project/other/.github/actions/special@main";

    expect(pinActionRefs(yaml, PINSET)).toBe(
      `    uses: radius-project/other/.github/actions/special@${NEW_SHA} # v9.9.9`,
    );
  });

  it("leaves a repo with no pinset entry alone", () => {
    const yaml = "    uses: radius-project/other/.github/actions/plain@main";

    expect(pinActionRefs(yaml, PINSET)).toBe(yaml);
  });

  it("is idempotent", () => {
    const once = pinActionRefs(WORKFLOW, PINSET);

    expect(pinActionRefs(once, PINSET)).toBe(once);
  });

  it("rewrites an unfilled placeholder ref", () => {
    const yaml = "    uses: radius-project/radius/a@{{RADIUS_REF}}";

    expect(pinActionRefs(yaml, PINSET)).toBe(
      `    uses: radius-project/radius/a@${NEW_SHA} # v0.61.0`,
    );
  });

  it("round-trips through readActionPins", () => {
    const pins = readActionPins(pinActionRefs(WORKFLOW, PINSET));

    expect(pins.filter((p) => p.repo === "radius-project/radius")).toEqual([
      expect.objectContaining({ ref: NEW_SHA, version: "v0.61.0", line: 12 }),
      expect.objectContaining({ ref: NEW_SHA, version: "v0.61.0", line: 14 }),
    ]);
  });
});

describe("classifyPin", () => {
  const pin = PINSET.actions["radius-project/radius"];
  const committed = (ref: string) => ({
    target: "radius-project/radius/a",
    repo: "radius-project/radius",
    path: "a",
    ref,
    version: "",
    line: 1,
  });

  it("matches the required SHA", () => {
    expect(classifyPin(committed(NEW_SHA), pin, PINSET)).toBe("current");
  });

  it("flags an earlier ledger entry as outdated", () => {
    expect(classifyPin(committed(OLD_SHA), pin, PINSET)).toBe("outdated");
  });

  it("flags a mutable ref as unpinned", () => {
    expect(classifyPin(committed("main"), pin, PINSET)).toBe("unpinned");
    expect(classifyPin(committed("v0.60.0"), pin, PINSET)).toBe("unpinned");
  });

  // An unrecognised SHA must fail towards prompting; treating it as "ahead"
  // would let a hand-edited ref silently suppress the check.
  it("treats a SHA that was never shipped as unknown, not ahead", () => {
    expect(classifyPin(committed(OFF_LEDGER_SHA), pin, PINSET)).toBe("unknown");
  });

  it("leaves a newer ledger entry alone", () => {
    const older = { ...pin, sha: OLD_SHA, version: "v0.60.0" };

    expect(classifyPin(committed(NEW_SHA), older, PINSET)).toBe("ahead");
  });
});

describe("comparePins", () => {
  const pinnedWorkflow = pinActionRefs(WORKFLOW, PINSET);

  it("reports no work when every governed pin is current", () => {
    expect(comparePins({ "a.yml": pinnedWorkflow }, PINSET)).toEqual({
      status: "current",
      files: [],
    });
  });

  it("reports the files and references that would change", () => {
    const plan = comparePins({ "a.yml": WORKFLOW, "b.yml": pinnedWorkflow }, PINSET);

    expect(plan.status).toBe("outdated");
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0].path).toBe("a.yml");
    expect(plan.files[0].changes).toEqual([
      expect.objectContaining({
        repo: "radius-project/radius",
        status: "unpinned",
        from: { ref: "main", version: "", line: 12 },
        to: { sha: NEW_SHA, version: "v0.61.0" },
      }),
      expect.objectContaining({ status: "unpinned", from: { ref: "main", version: "", line: 14 } }),
    ]);
  });

  it("ignores absent and empty files, which environment creation owns", () => {
    expect(comparePins({ "missing.yml": "" }, PINSET).status).toBe("current");
  });

  it("never proposes a downgrade", () => {
    const older: Pinset = {
      ...PINSET,
      actions: {
        "radius-project/radius": { ...PINSET.actions["radius-project/radius"], sha: OLD_SHA, version: "v0.60.0" },
      },
    };

    expect(comparePins({ "a.yml": pinnedWorkflow }, older).status).toBe("current");
  });

  it("summarises a plan one line per change", () => {
    const plan = comparePins({ "a.yml": WORKFLOW }, PINSET);

    expect(describePlan(plan)).toEqual([
      "a.yml",
      "  radius-project/radius/.github/extension/actions/setup-control-plane: main -> v0.61.0 (unpinned)",
      "  radius-project/radius/.github/extension/actions/run-rad-commands: main -> v0.61.0 (unpinned)",
    ]);
  });
});

describe("REPO_RADIUS_PINSET", () => {
  it("is well formed", () => {
    expect(validatePinset(REPO_RADIUS_PINSET)).toEqual([]);
  });

  it("pins the shipped workflow templates to a commit, not a branch", () => {
    expect(REPO_RADIUS_PINSET.templateSource.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(REPO_RADIUS_PINSET.actions["radius-project/radius"].path).toBe("");
  });
});
