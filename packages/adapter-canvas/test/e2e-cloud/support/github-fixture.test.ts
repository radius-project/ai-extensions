import { describe, expect, it } from "vitest";
import {
  createFakeFixturePorts,
  type FakeCommandStub,
  type FakeFixturePorts
} from "./fake-cloud-commands.js";
import {
  acquireFixtureLease,
  cloneFixtureAtBaseline,
  collectGitHubLeakedState,
  fixtureLeaseOwner,
  reclaimGitHubEnvironment,
  reclaimGitHubRunState,
  requireProbeEnvironmentAbsent,
  unwindAll,
  type GitHubFixtureRepository,
  type GitHubRunState,
  type ReclaimLedger,
  type UnwindStep
} from "./github-fixture.js";

const REPOSITORY = "fixture-owner/fixture-repo";
const BRANCH = "main";
const BASELINE = "a".repeat(40);
const BASELINE_TREE = "b".repeat(40);
const LEASE_COMMIT = "c".repeat(40);
const WORKSPACE = "/tmp/radtest-workspace";
const ENVIRONMENT = "radtest-run0000000a";
const STATE_PACKAGE =
  "ghcr.io/fixture-owner/fixture-repo-radius-state-radtest-run0000000a-a6da9329f444";
const RUN: GitHubRunState = {
  environmentName: ENVIRONMENT,
  statePackage: STATE_PACKAGE
};

// Spelled out rather than rebuilt from the fixture's own helpers, so a change to
// the paths it queries surfaces as an unstubbed command instead of silently
// following the test along.
const ENVIRONMENT_PATH = `repos/${REPOSITORY}/environments/${ENVIRONMENT}`;
const DEPLOYMENTS_PATH = `repos/${REPOSITORY}/deployments?environment=${ENVIRONMENT}&per_page=100`;
const ENVIRONMENTS_LIST_PATH = `repos/${REPOSITORY}/environments?per_page=100`;
const COMMITS_PATH = `repos/${REPOSITORY}/commits/${BRANCH}`;
const MATCHING_REFS_PATH = `repos/${REPOSITORY}/git/matching-refs/heads/radius/setup-`;
const PULLS_PATH = `repos/${REPOSITORY}/pulls?state=open&per_page=100`;
const DEFAULT_REF_PATH = `repos/${REPOSITORY}/git/refs/heads/${BRANCH}`;
const LEASE_REF = "refs/heads/radius/cloud-e2e-lease";
const LEASE_REF_PATH = `repos/${REPOSITORY}/git/${LEASE_REF}`;
const PACKAGE_PATH =
  "orgs/fixture-owner/packages/container/fixture-repo-radius-state-radtest-run0000000a-a6da9329f444";
const USER_PACKAGE_PATH =
  "users/fixture-owner/packages/container/fixture-repo-radius-state-radtest-run0000000a-a6da9329f444";

const NOT_FOUND = {
  code: 1,
  stderr: "gh: Not Found (HTTP 404)"
} as const;

const pullPages = (...pages: readonly unknown[][]): string =>
  JSON.stringify(pages);

const environmentPages = (names: readonly string[]): string =>
  JSON.stringify([
    {
      total_count: names.length,
      environments: names.map((name) => ({ name }))
    }
  ]);

const failing = (
  tool: FakeCommandStub["tool"],
  match: readonly string[],
  stderr: string
): FakeCommandStub => ({ tool, match, respond: { code: 2, stderr } });

/** Every GitHub command a healthy run issues, all answering "clean". */
function baselineStubs(): FakeCommandStub[] {
  return [
    {
      tool: "gh",
      match: ["api", "--method", "POST", `repos/${REPOSITORY}/git/refs`],
      respond: {}
    },
    {
      tool: "gh",
      match: ["api", "--method", "DELETE", LEASE_REF_PATH],
      respond: {}
    },
    {
      tool: "gh",
      match: ["api", `repos/${REPOSITORY}/git/commits/${BASELINE}`],
      respond: { stdout: BASELINE_TREE }
    },
    {
      tool: "gh",
      match: ["api", "--method", "POST", `repos/${REPOSITORY}/git/commits`],
      respond: { stdout: LEASE_COMMIT }
    },
    {
      tool: "gh",
      match: ["api", "--method", "PATCH", LEASE_REF_PATH],
      respond: {}
    },
    { tool: "gh", match: ["repo", "clone"], respond: {} },
    { tool: "git", match: ["reset", "--hard"], respond: {} },
    {
      tool: "gh",
      match: ["api", "--paginate", "--slurp", DEPLOYMENTS_PATH],
      respond: { stdout: "[[]]" }
    },
    { tool: "gh", match: ["api", ENVIRONMENT_PATH], respond: NOT_FOUND },
    {
      tool: "gh",
      match: ["api", "--paginate", "--slurp", ENVIRONMENTS_LIST_PATH],
      respond: { stdout: environmentPages([]) }
    },
    {
      tool: "gh-package",
      match: ["api", "users/fixture-owner", "--jq", ".type"],
      respond: { stdout: "Organization" }
    },
    { tool: "gh-package", match: ["api", PACKAGE_PATH], respond: NOT_FOUND },
    { tool: "gh", match: ["api", COMMITS_PATH], respond: { stdout: BASELINE } },
    {
      tool: "gh",
      match: ["api", MATCHING_REFS_PATH],
      respond: { stdout: "[]" }
    },
    {
      tool: "gh",
      match: ["api", PULLS_PATH],
      respond: { stdout: pullPages([]) }
    }
  ];
}

interface Harness {
  readonly fake: FakeFixturePorts;
  readonly fixture: GitHubFixtureRepository;
}

function createHarness(
  overrides: readonly FakeCommandStub[] = [],
  portOptions: Parameters<typeof createFakeFixturePorts>[0] = {}
): Harness {
  const fake = createFakeFixturePorts({
    workspaceDir: WORKSPACE,
    ...portOptions,
    stubs: [...overrides, ...baselineStubs()]
  });
  return {
    fake,
    fixture: {
      commands: fake.ports.commands,
      repository: REPOSITORY,
      defaultBranch: BRANCH,
      baselineSha: BASELINE
    }
  };
}

function newLedger(failures: string[] = []): ReclaimLedger {
  return { reclaimed: [], failures };
}

async function reclaimRunState(
  overrides: readonly FakeCommandStub[] = [],
  ledger = newLedger()
): Promise<Harness & { readonly ledger: ReclaimLedger }> {
  const harness = createHarness(overrides);
  await reclaimGitHubRunState(ledger, harness.fixture, RUN);
  return { ...harness, ledger };
}

async function collect(overrides: readonly FakeCommandStub[] = []) {
  const { fixture } = createHarness(overrides);
  return collectGitHubLeakedState(fixture, RUN);
}

describe("fixtureLeaseOwner", () => {
  it("binds the lease to a trimmed GitHub Actions run id", () => {
    expect(fixtureLeaseOwner(" 123456 ")).toEqual({
      runId: "123456",
      message: "Radius Cloud E2E lease\n\ncloud-e2e-owner-run-id:123456"
    });
  });

  it.each([undefined, "", "   "])(
    "treats run id %j as a local run with no owner",
    (githubRunId) => {
      expect(fixtureLeaseOwner(githubRunId)).toBeUndefined();
    }
  );

  it.each(["0", "local", "12.5"])(
    "rejects unverifiable GitHub Actions run id %j",
    (githubRunId) => {
      expect(() => fixtureLeaseOwner(githubRunId)).toThrow(
        "must be a positive integer"
      );
    }
  );
});

describe("acquireFixtureLease", () => {
  it("creates the lease at the baseline and records its release", async () => {
    const { fake, fixture } = createHarness();
    const unwind: UnwindStep[] = [];

    await acquireFixtureLease(fixture, undefined, unwind);

    expect(fake.commands.commandLines("gh")).toEqual([
      `api --method POST repos/${REPOSITORY}/git/refs -f ref=${LEASE_REF} -f sha=${BASELINE}`
    ]);
    expect(unwind.map((step) => step.describe)).toEqual([
      `release repository lease ${LEASE_REF}`
    ]);
    await expect(unwindAll(unwind)).resolves.toEqual([]);
    expect(fake.commands.commandLines("gh").at(-1)).toBe(
      `api --method DELETE ${LEASE_REF_PATH}`
    );
  });

  it("marks a CI lease with its owning run", async () => {
    const { fake, fixture } = createHarness();

    await acquireFixtureLease(fixture, fixtureLeaseOwner("123456"), []);

    expect(fake.commands.commandLines("gh")).toEqual([
      `api --method POST repos/${REPOSITORY}/git/refs -f ref=${LEASE_REF} -f sha=${BASELINE}`,
      `api repos/${REPOSITORY}/git/commits/${BASELINE} --jq .tree.sha`,
      `api --method POST repos/${REPOSITORY}/git/commits -f message=Radius Cloud E2E lease\n\ncloud-e2e-owner-run-id:123456 -f tree=${BASELINE_TREE} -F parents[]=${BASELINE} --jq .sha`,
      `api --method PATCH ${LEASE_REF_PATH} -f sha=${LEASE_COMMIT}`
    ]);
  });

  it("records nothing to release when the lease is already held", async () => {
    const { fixture } = createHarness([
      failing(
        "gh",
        ["api", "--method", "POST", `repos/${REPOSITORY}/git/refs`],
        "Reference already exists"
      )
    ]);
    const unwind: UnwindStep[] = [];

    await expect(
      acquireFixtureLease(fixture, undefined, unwind)
    ).rejects.toThrow(/Reference already exists/);
    expect(unwind).toEqual([]);
  });

  it.each([
    [
      "owner marker commit",
      failing(
        "gh",
        ["api", "--method", "POST", `repos/${REPOSITORY}/git/commits`],
        "commit rejected"
      ),
      "commit rejected"
    ],
    [
      "baseline tree lookup",
      {
        tool: "gh" as const,
        match: ["api", `repos/${REPOSITORY}/git/commits/${BASELINE}`],
        respond: { stdout: "not-an-object-id" }
      },
      "baseline tree lookup returned an invalid Git object id"
    ],
    [
      "marker commit response",
      {
        tool: "gh" as const,
        match: ["api", "--method", "POST", `repos/${REPOSITORY}/git/commits`],
        respond: { stdout: "not-an-object-id" }
      },
      "lease marker creation returned an invalid Git object id"
    ],
    [
      "marker ref update",
      failing("gh", ["api", "--method", "PATCH", LEASE_REF_PATH], "conflict"),
      "conflict"
    ]
  ])(
    "keeps the lease release after a failed %s",
    async (_label, override, expected) => {
      const { fake, fixture } = createHarness([override]);
      const unwind: UnwindStep[] = [];

      await expect(
        acquireFixtureLease(fixture, fixtureLeaseOwner("123456"), unwind)
      ).rejects.toThrow(expected);
      await unwindAll(unwind);
      expect(fake.commands.commandLines("gh").at(-1)).toBe(
        `api --method DELETE ${LEASE_REF_PATH}`
      );
    }
  );
});

describe("cloneFixtureAtBaseline", () => {
  it("clones into a fresh workspace pinned to the baseline", async () => {
    const { fake, fixture } = createHarness();
    const unwind: UnwindStep[] = [];

    await expect(
      cloneFixtureAtBaseline(fake.ports, fixture, "radtest-canvas-x", unwind)
    ).resolves.toBe(WORKSPACE);

    expect(fake.commands.calls).toEqual([
      {
        tool: "gh",
        args: ["repo", "clone", REPOSITORY, WORKSPACE],
        cwd: undefined
      },
      { tool: "git", args: ["reset", "--hard", BASELINE], cwd: WORKSPACE }
    ]);
    await unwindAll(unwind);
    expect(fake.removed).toEqual([WORKSPACE]);
  });

  it.each([
    [
      "clone",
      failing("gh", ["repo", "clone"], "repository not found"),
      "repository not found"
    ],
    [
      "baseline reset",
      failing("git", ["reset", "--hard"], "unknown revision"),
      "unknown revision"
    ]
  ])(
    "keeps the workspace removal after a failed %s",
    async (_label, override, expected) => {
      const { fake, fixture } = createHarness([override]);
      const unwind: UnwindStep[] = [];

      await expect(
        cloneFixtureAtBaseline(fake.ports, fixture, "radtest-canvas-x", unwind)
      ).rejects.toThrow(expected);
      await unwindAll(unwind);
      expect(fake.removed).toEqual([WORKSPACE]);
    }
  );

  it("records nothing when the workspace directory cannot be made", async () => {
    const { fake, fixture } = createHarness([], {
      makeWorkspaceDir: () => Promise.reject(new Error("ENOSPC"))
    });
    const unwind: UnwindStep[] = [];

    await expect(
      cloneFixtureAtBaseline(fake.ports, fixture, "radtest-canvas-x", unwind)
    ).rejects.toThrow("ENOSPC");
    expect(unwind).toEqual([]);
    expect(fake.commands.calls).toEqual([]);
  });
});

describe("unwindAll", () => {
  it("runs every step in reverse order and reports each failure", async () => {
    const order: string[] = [];
    const steps: UnwindStep[] = [
      {
        describe: "first",
        run: () => {
          order.push("first");
          return Promise.resolve();
        }
      },
      {
        describe: "second",
        run: () => {
          order.push("second");
          return Promise.reject(new Error("locked"));
        }
      },
      {
        describe: "third",
        run: () => {
          order.push("third");
          return Promise.reject(new Error("busy"));
        }
      }
    ];

    await expect(unwindAll(steps)).resolves.toEqual([
      "third: busy",
      "second: locked"
    ]);
    expect(order).toEqual(["third", "second", "first"]);
    expect(steps).toEqual([]);
  });
});

describe("collectGitHubLeakedState", () => {
  it("finds nothing when the repository is clean", async () => {
    await expect(collect()).resolves.toEqual([]);
  });

  // The run's own environment name is unique, so only the full listing can
  // see an environment an earlier run leaked. The wizard refuses to create an
  // environment in a namespace a listed one owns, which hung run 39901220095
  // for the whole test timeout.
  it("reports a GitHub environment an earlier run leaked", async () => {
    const findings = await collect([
      {
        tool: "gh",
        match: ["api", "--paginate", "--slurp", ENVIRONMENTS_LIST_PATH],
        respond: {
          stdout: environmentPages([
            "radtest-ecdb9f66c276",
            "radtest-aws-ecdb9f66c276",
            "production",
            ENVIRONMENT
          ])
        }
      }
    ]);

    // Both clouds share the fixture's default branch, so an AWS leftover
    // blocks an Azure run too.
    expect(findings).toEqual([
      `GitHub environment "radtest-ecdb9f66c276" in ${REPOSITORY} from an earlier run ` +
        "(the product refuses to create an environment in a namespace another environment owns)",
      `GitHub environment "radtest-aws-ecdb9f66c276" in ${REPOSITORY} from an earlier run ` +
        "(the product refuses to create an environment in a namespace another environment owns)"
    ]);
  });

  it("fails closed when the GitHub environment listing fails", async () => {
    await expect(
      collect([
        {
          tool: "gh",
          match: ["api", "--paginate", "--slurp", ENVIRONMENTS_LIST_PATH],
          respond: { code: 1, stderr: "gh: Forbidden (HTTP 403)" }
        }
      ])
    ).rejects.toThrow(
      /Listing GitHub environments in fixture-owner\/fixture-repo/
    );
  });

  it("fails closed when the GitHub environment listing is empty", async () => {
    await expect(
      collect([
        {
          tool: "gh",
          match: ["api", "--paginate", "--slurp", ENVIRONMENTS_LIST_PATH],
          respond: { stdout: "" }
        }
      ])
    ).rejects.toThrow("returned an empty response instead of JSON");
  });

  it("reports a leaked GitHub environment", async () => {
    await expect(
      collect([
        {
          tool: "gh",
          match: ["api", ENVIRONMENT_PATH],
          respond: { stdout: '{"name":"radtest"}' }
        }
      ])
    ).resolves.toEqual([
      `GitHub environment "${ENVIRONMENT}" in ${REPOSITORY}`
    ]);
  });

  it("reports a leaked GHCR state package", async () => {
    await expect(
      collect([
        {
          tool: "gh-package",
          match: ["api", PACKAGE_PATH],
          respond: {
            stdout: JSON.stringify({
              visibility: "private",
              repository: { full_name: REPOSITORY }
            })
          }
        }
      ])
    ).resolves.toEqual([
      `GHCR state package "${STATE_PACKAGE}" (private visibility, linked to "${REPOSITORY}")`
    ]);
  });

  it("names unknown visibility and a missing repository link", async () => {
    await expect(
      collect([
        {
          tool: "gh-package",
          match: ["api", PACKAGE_PATH],
          respond: { stdout: "{}" }
        }
      ])
    ).resolves.toEqual([
      `GHCR state package "${STATE_PACKAGE}" (unknown visibility, linked to "(no repository)")`
    ]);
  });

  it("fails when the GHCR state package cannot be probed", async () => {
    await expect(
      collect([failing("gh-package", ["api", PACKAGE_PATH], "HTTP 403")])
    ).rejects.toThrow(/read GHCR package .*HTTP 403/);
  });

  it("uses the user package endpoint for a user-owned fixture repository", async () => {
    const { fake, fixture } = createHarness([
      {
        tool: "gh-package",
        match: ["api", "users/fixture-owner", "--jq", ".type"],
        respond: { stdout: "User" },
        times: 1
      },
      {
        tool: "gh-package",
        match: ["api", USER_PACKAGE_PATH],
        respond: NOT_FOUND
      }
    ]);

    await expect(collectGitHubLeakedState(fixture, RUN)).resolves.toEqual([]);
    expect(fake.commands.commandLines("gh-package")).toContain(
      `api ${USER_PACKAGE_PATH}`
    );
  });

  it.each(["Enterprise", ""])(
    "rejects unsupported package-owner type %j",
    async (type) => {
      await expect(
        collect([
          {
            tool: "gh-package",
            match: ["api", "users/fixture-owner", "--jq", ".type"],
            respond: { stdout: type },
            times: 1
          }
        ])
      ).rejects.toThrow(`unsupported type "${type || "(empty)"}"`);
    }
  );

  it.each([
    ["invalid JSON", "{not-json", /returned invalid JSON/],
    ["a non-object response", "[]", /returned a non-object response/]
  ])("rejects %s from the package API", async (_label, stdout, expected) => {
    await expect(
      collect([
        {
          tool: "gh-package",
          match: ["api", PACKAGE_PATH],
          respond: { stdout }
        }
      ])
    ).rejects.toThrow(expected);
  });

  it.each([
    [
      "a non-404 failure",
      { code: 1, stderr: "HTTP 401: Bad credentials" },
      /Could not probe GitHub environment .* gh exited 1: HTTP 401: Bad credentials/
    ],
    [
      "execFile's empty-stream failure message",
      { code: 1, stderr: `Command failed: gh api ${ENVIRONMENT_PATH}\n` },
      /Could not probe GitHub environment .* Command failed: gh api repos\//
    ],
    [
      "a failure gh wrote to stdout",
      { code: 1, stdout: '{"message":"Server Error"}' },
      /Could not probe GitHub environment .* gh exited 1: \{"message":"Server Error"\}/
    ]
  ])(
    "refuses to read %s from the environment probe as absence",
    async (_label, respond, expected) => {
      await expect(
        collect([{ tool: "gh", match: ["api", ENVIRONMENT_PATH], respond }])
      ).rejects.toThrow(expected);
    }
  );

  it("reports a default branch that has moved off the pinned baseline", async () => {
    await expect(
      collect([
        {
          tool: "gh",
          match: ["api", COMMITS_PATH],
          respond: { stdout: `${"b".repeat(40)}\n` }
        }
      ])
    ).resolves.toEqual([
      `${REPOSITORY}@${BRANCH} is at ${"b".repeat(40)}, not the pinned baseline ${BASELINE} ` +
        "(a previous run committed workflow files to the default branch)"
    ]);
  });

  it("accepts a default branch head that differs only by casing or whitespace", async () => {
    await expect(
      collect([
        {
          tool: "gh",
          match: ["api", COMMITS_PATH],
          respond: { stdout: `  ${BASELINE.toUpperCase()}\n` }
        }
      ])
    ).resolves.toEqual([]);
  });

  it("fails when the default branch head cannot be read at all", async () => {
    await expect(
      collect([
        { tool: "gh", match: ["api", COMMITS_PATH], respond: { stdout: "  " } }
      ])
    ).rejects.toThrow(/returned no commit SHA/);
  });

  // The product falls back to a pull request when its token lacks `workflow`
  // scope, which leaves the default branch pristine. Without these two probes
  // that path reports a clean slate while leaking a branch and a pull request.
  it("reports a leaked workflow fallback branch even though the default branch is clean", async () => {
    await expect(
      collect([
        {
          tool: "gh",
          match: ["api", MATCHING_REFS_PATH],
          respond: {
            stdout: JSON.stringify([
              { ref: "refs/heads/radius/setup-radtest-abc-workflows-1a2b" }
            ])
          }
        }
      ])
    ).resolves.toEqual([
      `workflow fallback branch "radius/setup-radtest-abc-workflows-1a2b" in ${REPOSITORY}`
    ]);
  });

  it("reports every leaked open pull request across pages", async () => {
    await expect(
      collect([
        {
          tool: "gh",
          match: ["api", PULLS_PATH],
          respond: {
            stdout: pullPages(
              [
                {
                  number: 7,
                  title: "Add Radius workflows",
                  head: { ref: "radius/setup-radtest-abc-workflows-1a2b" }
                }
              ],
              [
                {
                  number: 8,
                  title: "Second page",
                  head: { ref: "radius/setup-second" }
                }
              ]
            )
          }
        }
      ])
    ).resolves.toEqual([
      `open pull request #7 ("Add Radius workflows", head "radius/setup-radtest-abc-workflows-1a2b") in ${REPOSITORY}`,
      `open pull request #8 ("Second page", head "radius/setup-second") in ${REPOSITORY}`
    ]);
  });

  it("reports placeholders when an open pull request omits optional details", async () => {
    await expect(
      collect([
        {
          tool: "gh",
          match: ["api", PULLS_PATH],
          respond: { stdout: pullPages([{ number: 7 }]) }
        }
      ])
    ).resolves.toEqual([
      `open pull request #7 ("(untitled)", head "(unknown)") in ${REPOSITORY}`
    ]);
  });

  it.each([
    ["a missing number", undefined],
    ["a non-integer number", 1.5],
    ["a non-positive number", 0]
  ])("rejects an open pull request with %s", async (_label, number) => {
    await expect(
      collect([
        {
          tool: "gh",
          match: ["api", PULLS_PATH],
          respond: { stdout: pullPages([{ number }]) }
        }
      ])
    ).rejects.toThrow(/open pull requests .* no usable "number"/);
  });

  it("rejects an empty successful pull-request response", async () => {
    await expect(
      collect([
        { tool: "gh", match: ["api", PULLS_PATH], respond: { stdout: "" } }
      ])
    ).rejects.toThrow(/open pull requests .* empty response instead of JSON/);
  });

  it("rejects a paginated pull-request response whose page is not an array", async () => {
    await expect(
      collect([
        {
          tool: "gh",
          match: ["api", PULLS_PATH],
          respond: { stdout: JSON.stringify([{ number: 7 }]) }
        }
      ])
    ).rejects.toThrow(/open pull requests .* page 0 with JSON type "object"/);
  });

  it("rejects a fallback branch entry with no ref", async () => {
    await expect(
      collect([
        {
          tool: "gh",
          match: ["api", MATCHING_REFS_PATH],
          respond: { stdout: "[{}]" }
        }
      ])
    ).rejects.toThrow(/matching-refs .* no usable "ref"/);
  });
});

describe("requireProbeEnvironmentAbsent", () => {
  const probeName = "radtest-orphan?probe";
  const probePath = `repos/${REPOSITORY}/environments/${encodeURIComponent(probeName)}`;

  it("accepts an environment GitHub reports absent", async () => {
    const { fake, fixture } = createHarness([
      { tool: "gh", match: ["api", probePath], respond: NOT_FOUND }
    ]);

    await expect(
      requireProbeEnvironmentAbsent(fixture, RUN, probeName)
    ).resolves.toBeUndefined();
    expect(fake.commands.commandLines("gh")).toEqual([`api ${probePath}`]);
  });

  it.each(["", " ", ENVIRONMENT])(
    "refuses an unsafe probe target %j before asking GitHub",
    async (name) => {
      const { fake, fixture } = createHarness();

      await expect(
        requireProbeEnvironmentAbsent(fixture, RUN, name)
      ).rejects.toThrow("Probe cleanup needs");
      expect(fake.commands.calls).toEqual([]);
    }
  );

  it.each([
    [{ code: 0, stdout: "{}" }, "Refusing to register pre-existing"],
    [{ code: 1, stderr: "Forbidden (HTTP 403)" }, "Forbidden (HTTP 403)"],
    [{ code: 1, stdout: "rate limit exceeded" }, "rate limit exceeded"],
    [
      { code: 1, stderr: "Not Found while resolving host" },
      "Could not verify probe environment"
    ]
  ])(
    "refuses a pre-existing or unreadable environment: %j",
    async (respond, expected) => {
      const { fixture } = createHarness([
        { tool: "gh", match: ["api", probePath], respond }
      ]);

      await expect(
        requireProbeEnvironmentAbsent(fixture, RUN, probeName)
      ).rejects.toThrow(expected);
    }
  );
});

describe("reclaimGitHubEnvironment", () => {
  const deactivate = (id: number): FakeCommandStub => ({
    tool: "gh",
    match: [
      "api",
      "--method",
      "POST",
      `repos/${REPOSITORY}/deployments/${id}/statuses`
    ],
    respond: {}
  });
  const deleteRecord = (id: number): FakeCommandStub => ({
    tool: "gh",
    match: [
      "api",
      "--method",
      "DELETE",
      `repos/${REPOSITORY}/deployments/${id}`
    ],
    respond: {}
  });

  async function reclaim(overrides: readonly FakeCommandStub[]) {
    const harness = createHarness(overrides);
    const ledger = newLedger();
    await reclaimGitHubEnvironment(
      ledger,
      harness.fixture,
      ENVIRONMENT,
      `GitHub environment ${ENVIRONMENT}`
    );
    return { ...harness, ledger };
  }

  it("deactivates then deletes every deployment record page before deleting the environment", async () => {
    const { fake, ledger } = await reclaim([
      {
        tool: "gh",
        match: ["api", "--paginate", "--slurp", DEPLOYMENTS_PATH],
        // Two pages: an environment can accumulate more records than a
        // single page holds, and stopping at the first would strand the rest.
        respond: { stdout: '[[{"id":41}],[{"id":42}]]' }
      },
      deactivate(41),
      deleteRecord(41),
      deactivate(42),
      deleteRecord(42),
      {
        tool: "gh",
        match: ["api", ENVIRONMENT_PATH],
        respond: { stdout: "{}" },
        times: 1
      },
      {
        tool: "gh",
        match: ["api", "--method", "DELETE", ENVIRONMENT_PATH],
        respond: {}
      }
    ]);

    // GitHub refuses to delete an active deployment, and a record whose job
    // never reported a status is active, so the deactivation has to come
    // first or the delete is rejected.
    expect(fake.commands.commandLines("gh")).toEqual([
      `api --paginate --slurp ${DEPLOYMENTS_PATH}`,
      `api --method POST repos/${REPOSITORY}/deployments/41/statuses -f state=inactive`,
      `api --method DELETE repos/${REPOSITORY}/deployments/41`,
      `api --method POST repos/${REPOSITORY}/deployments/42/statuses -f state=inactive`,
      `api --method DELETE repos/${REPOSITORY}/deployments/42`,
      `api ${ENVIRONMENT_PATH}`,
      `api --method DELETE ${ENVIRONMENT_PATH}`
    ]);
    expect(ledger).toEqual({
      reclaimed: [
        `2 GitHub deployment record(s) for ${ENVIRONMENT}`,
        `GitHub environment ${ENVIRONMENT}`
      ],
      failures: []
    });
  });

  it("reclaims nothing for an absent environment with no records", async () => {
    const { ledger } = await reclaim([]);

    expect(ledger).toEqual({ reclaimed: [], failures: [] });
  });

  it.each([
    [
      "an unreadable listing",
      { code: 1, stderr: "HTTP 403: Forbidden" },
      /probe GitHub deployment records for radtest-run0000000a: .*HTTP 403/s
    ],
    [
      "an empty listing",
      { stdout: "" },
      /probe GitHub deployment records .* empty response instead of JSON/s
    ],
    [
      "a listing that is not an array",
      { stdout: '{"bad":"response"}' },
      /probe GitHub deployment records .*JSON object where a JSON array was expected/s
    ],
    [
      "a page that is not an array",
      { stdout: '[{"id":41}]' },
      /probe GitHub deployment records .*page 0 with JSON type "object"/s
    ],
    [
      "a record with no numeric id",
      { stdout: '[[{"environment":"radtest"}]]' },
      /probe GitHub deployment records for radtest-run0000000a: .*no usable numeric "id"/s
    ]
  ])(
    "preserves the environment after %s instead of assuming no records",
    async (_label, respond, expected) => {
      const { fake, ledger } = await reclaim([
        {
          tool: "gh",
          match: ["api", "--paginate", "--slurp", DEPLOYMENTS_PATH],
          respond
        }
      ]);

      expect(ledger.failures[0]).toMatch(expected);
      expect(ledger.failures.at(-1)).toContain(
        `preserve GitHub environment ${ENVIRONMENT}`
      );
      expect(fake.commands.commandLines("gh")).not.toContain(
        `api ${ENVIRONMENT_PATH}`
      );
    }
  );

  // A deployment record names its environment but outlives it, so deleting
  // the environment while a record survives strands that record behind a
  // name nothing will ever match again -- the exact leak this step exists to
  // prevent.
  it.each([
    [
      "deactivation",
      [
        "api",
        "--method",
        "POST",
        `repos/${REPOSITORY}/deployments/41/statuses`
      ],
      "POST deployments/41/statuses"
    ],
    [
      "delete",
      ["api", "--method", "DELETE", `repos/${REPOSITORY}/deployments/41`],
      "DELETE deployments/41"
    ]
  ])(
    "preserves the environment when a deployment record %s fails",
    async (_label, match, context) => {
      const { fake, ledger } = await reclaim([
        {
          tool: "gh",
          match: ["api", "--paginate", "--slurp", DEPLOYMENTS_PATH],
          respond: { stdout: '[[{"id":41}]]' }
        },
        failing(
          "gh",
          match,
          "HTTP 403: Resource not accessible by integration"
        ),
        deactivate(41)
      ]);

      expect(ledger.failures).toEqual([
        expect.stringContaining(
          `1 GitHub deployment record(s) for ${ENVIRONMENT}: gh api ${context}`
        ),
        expect.stringContaining(`preserve GitHub environment ${ENVIRONMENT}`)
      ]);
      expect(
        fake.commands
          .commandLines("gh")
          .some((line) => line.includes(`environments/${ENVIRONMENT}`))
      ).toBe(false);
    }
  );

  it.each([
    [
      "stderr",
      { code: 1, stderr: "HTTP 403: Forbidden" },
      /probe GitHub environment .* gh exited 1: HTTP 403: Forbidden/
    ],
    [
      "stdout",
      { code: 1, stdout: '{"message":"Bad gateway"}' },
      /probe GitHub environment .* gh exited 1: \{"message":"Bad gateway"\}/
    ]
  ])(
    "records an unreadable environment probe reported on %s",
    async (_label, respond, expected) => {
      const { ledger } = await reclaim([
        { tool: "gh", match: ["api", ENVIRONMENT_PATH], respond }
      ]);

      expect(ledger.failures).toEqual([expect.stringMatching(expected)]);
    }
  );

  it("records a failing environment deletion", async () => {
    const { ledger } = await reclaim([
      {
        tool: "gh",
        match: ["api", ENVIRONMENT_PATH],
        respond: { stdout: "{}" },
        times: 1
      },
      failing("gh", ["api", "--method", "DELETE", ENVIRONMENT_PATH], "HTTP 403")
    ]);

    expect(ledger.failures).toEqual([
      expect.stringMatching(
        new RegExp(`GitHub environment ${ENVIRONMENT}: .*HTTP 403`)
      )
    ]);
  });

  it("accepts an environment removed between the read and the delete", async () => {
    const { ledger } = await reclaim([
      {
        tool: "gh",
        match: ["api", ENVIRONMENT_PATH],
        respond: { stdout: "{}" },
        times: 1
      },
      {
        tool: "gh",
        match: ["api", "--method", "DELETE", ENVIRONMENT_PATH],
        respond: NOT_FOUND
      }
    ]);

    expect(ledger).toEqual({
      reclaimed: [`GitHub environment ${ENVIRONMENT}`],
      failures: []
    });
  });
});

describe("reclaimGitHubRunState", () => {
  const visiblePackage = (
    body: Record<string, unknown>,
    times?: number
  ): FakeCommandStub => ({
    tool: "gh-package",
    match: ["api", PACKAGE_PATH],
    respond: { stdout: JSON.stringify(body) },
    ...(times === undefined ? {} : { times })
  });

  it("reclaims nothing and writes nothing when the repository is clean", async () => {
    const { fake, ledger } = await reclaimRunState();

    expect(ledger).toEqual({ reclaimed: [], failures: [] });
    expect(
      fake.commands.calls.some(
        (call) => call.args.includes("DELETE") || call.args.includes("PATCH")
      )
    ).toBe(false);
  });

  it("closes fallback pull requests, deletes fallback branches, and resets the default branch", async () => {
    const { fake, ledger } = await reclaimRunState([
      {
        tool: "gh",
        match: ["api", PULLS_PATH],
        respond: {
          stdout: pullPages([
            {
              number: 9,
              title: "Stale setup",
              head: { ref: "radius/setup-a" }
            },
            {
              number: 10,
              title: "Human change",
              head: { ref: "feature/human" }
            }
          ])
        }
      },
      {
        tool: "gh",
        match: ["api", "--method", "PATCH", `repos/${REPOSITORY}/pulls/9`],
        respond: {}
      },
      {
        tool: "gh",
        match: ["api", MATCHING_REFS_PATH],
        respond: { stdout: '[{"ref":"refs/heads/radius/setup-a"}]' }
      },
      {
        tool: "gh",
        match: [
          "api",
          "--method",
          "DELETE",
          `repos/${REPOSITORY}/git/refs/heads/radius/setup-a`
        ],
        respond: {}
      },
      {
        tool: "gh",
        match: ["api", COMMITS_PATH],
        respond: { stdout: "e".repeat(40) }
      },
      {
        tool: "gh",
        match: ["api", "--method", "PATCH", DEFAULT_REF_PATH],
        respond: {}
      }
    ]);

    expect(ledger).toEqual({
      reclaimed: [
        "pull request #9",
        "branch radius/setup-a",
        `${BRANCH} reset to ${BASELINE}`
      ],
      failures: []
    });
    const lines = fake.commands.commandLines("gh");
    // Pull requests close before their head branches go, so cleanup never
    // relies on GitHub changing pull-request state as a side effect.
    expect(
      lines.indexOf(
        `api --method PATCH repos/${REPOSITORY}/pulls/9 -f state=closed`
      )
    ).toBeLessThan(
      lines.indexOf(
        `api --method DELETE repos/${REPOSITORY}/git/refs/heads/radius/setup-a`
      )
    );
    expect(lines.some((line) => line.includes("pulls/10"))).toBe(false);
    expect(lines.at(-1)).toBe(
      `api --method PATCH ${DEFAULT_REF_PATH} -f sha=${BASELINE} -F force=true`
    );
  });

  it("leaves the default branch where it is when an earlier step already failed", async () => {
    const { fake, ledger } = await reclaimRunState(
      [
        {
          tool: "gh",
          match: ["api", COMMITS_PATH],
          respond: { stdout: "e".repeat(40) }
        }
      ],
      newLedger(["Radius application demo: workflow failed"])
    );

    expect(ledger.failures).toEqual([
      "Radius application demo: workflow failed"
    ]);
    expect(fake.commands.commandLines("gh")).not.toContain(
      `api ${COMMITS_PATH} --jq .sha`
    );
    expect(
      fake.commands.commandLines("gh").some((line) => line.includes("PATCH"))
    ).toBe(false);
  });

  it("keeps reclaiming after a deployment record fails, but keeps the default branch", async () => {
    const { fake, ledger } = await reclaimRunState([
      {
        tool: "gh",
        match: ["api", "--paginate", "--slurp", DEPLOYMENTS_PATH],
        respond: { stdout: '[[{"id":41}]]' }
      },
      failing(
        "gh",
        [
          "api",
          "--method",
          "POST",
          `repos/${REPOSITORY}/deployments/41/statuses`
        ],
        "HTTP 403"
      ),
      {
        tool: "gh",
        match: ["api", COMMITS_PATH],
        respond: { stdout: "e".repeat(40) }
      }
    ]);

    expect(ledger.failures.at(-1)).toContain(
      `preserve GitHub environment ${ENVIRONMENT}`
    );
    expect(fake.commands.commandLines("gh-package")).toContain(
      `api ${PACKAGE_PATH}`
    );
    expect(
      fake.commands
        .commandLines("gh")
        .some((line) => line.includes(`PATCH ${DEFAULT_REF_PATH}`))
    ).toBe(false);
  });

  it.each([
    [
      "not private or internal",
      { visibility: "public", repository: { full_name: REPOSITORY } },
      /refuse GHCR state package .* visibility is "public"/
    ],
    [
      "of unknown visibility",
      { repository: { full_name: REPOSITORY } },
      /refuse GHCR state package .* visibility is "unknown"/
    ],
    [
      "linked to another repository",
      { visibility: "private", repository: { full_name: "other/repository" } },
      /linked to "other\/repository", not "fixture-owner\/fixture-repo"/
    ],
    [
      "not linked to a repository",
      { visibility: "private" },
      /refuse GHCR state package .* it is not linked to a repository/
    ]
  ])("refuses to delete a package %s", async (_label, body, expected) => {
    const { fake, ledger } = await reclaimRunState([visiblePackage(body)]);

    expect(ledger.failures).toEqual([expect.stringMatching(expected)]);
    expect(
      fake.commands
        .commandLines("gh-package")
        .some((line) => line.includes("--method DELETE"))
    ).toBe(false);
  });

  it("deletes a private package linked to the fixture repository, whatever its casing", async () => {
    const { fake, ledger } = await reclaimRunState([
      visiblePackage(
        {
          visibility: "private",
          repository: { full_name: REPOSITORY.toUpperCase() }
        },
        1
      ),
      {
        tool: "gh-package",
        match: ["api", "--method", "DELETE", PACKAGE_PATH],
        respond: {}
      }
    ]);

    expect(ledger.reclaimed).toEqual([`GHCR state package ${STATE_PACKAGE}`]);
    expect(fake.commands.commandLines("gh-package")).toContain(
      `api --method DELETE ${PACKAGE_PATH}`
    );
  });

  it("records a failing GHCR state package deletion", async () => {
    const { ledger } = await reclaimRunState([
      visiblePackage(
        { visibility: "internal", repository: { full_name: REPOSITORY } },
        1
      ),
      failing(
        "gh-package",
        ["api", "--method", "DELETE", PACKAGE_PATH],
        "HTTP 403"
      )
    ]);

    expect(ledger.failures).toEqual([
      expect.stringMatching(/GHCR state package .*HTTP 403/)
    ]);
  });

  it("accepts a GHCR state package that disappeared before deletion", async () => {
    const { ledger } = await reclaimRunState([
      visiblePackage(
        { visibility: "internal", repository: { full_name: REPOSITORY } },
        1
      ),
      {
        tool: "gh-package",
        match: ["api", "--method", "DELETE", PACKAGE_PATH],
        respond: NOT_FOUND
      }
    ]);

    expect(ledger).toEqual({
      reclaimed: [`GHCR state package ${STATE_PACKAGE}`],
      failures: []
    });
  });

  it("rejects a delete 404 when the GHCR state package is still readable", async () => {
    const { ledger } = await reclaimRunState([
      {
        tool: "gh-package",
        match: ["api", "--method", "DELETE", PACKAGE_PATH],
        respond: NOT_FOUND
      },
      visiblePackage(
        { visibility: "internal", repository: { full_name: REPOSITORY } },
        2
      )
    ]);

    expect(ledger.failures).toEqual([
      expect.stringMatching(
        /returned HTTP 404, but the package is still readable.*does not have effective delete access/s
      )
    ]);
  });

  it("records an unreadable GHCR state package probe and continues cleanup", async () => {
    const { fake, ledger } = await reclaimRunState([
      failing("gh-package", ["api", PACKAGE_PATH], "HTTP 502"),
      {
        tool: "gh",
        match: ["api", MATCHING_REFS_PATH],
        respond: { stdout: '[{"ref":"refs/heads/radius/setup-a"}]' }
      },
      { tool: "gh", match: ["api", "--method", "DELETE"], respond: {} }
    ]);

    expect(ledger).toEqual({
      reclaimed: ["branch radius/setup-a"],
      failures: [expect.stringMatching(/probe GHCR state package .*HTTP 502/)]
    });
    expect(fake.commands.commandLines("gh")).toContain(
      `api --method DELETE repos/${REPOSITORY}/git/refs/heads/radius/setup-a`
    );
  });

  it.each([
    [
      "branch listing",
      failing("gh", ["api", MATCHING_REFS_PATH], "HTTP 500"),
      /list workflow fallback branches: .*HTTP 500/
    ],
    [
      "pull-request listing",
      failing("gh", ["api", PULLS_PATH], "HTTP 500"),
      /list open pull requests: .*HTTP 500/
    ],
    [
      "default branch read",
      failing("gh", ["api", COMMITS_PATH], "HTTP 502"),
      new RegExp(`read ${BRANCH} head: .*HTTP 502`)
    ]
  ])("records a failing %s", async (_label, override, expected) => {
    const { ledger } = await reclaimRunState([override]);

    expect(ledger.failures).toEqual([expect.stringMatching(expected)]);
  });

  it("records a failing pull-request close and keeps the default branch", async () => {
    const { fake, ledger } = await reclaimRunState([
      {
        tool: "gh",
        match: ["api", PULLS_PATH],
        respond: {
          stdout: pullPages([
            {
              number: 9,
              title: "Stale setup",
              head: { ref: "radius/setup-deleted" }
            }
          ])
        }
      },
      failing(
        "gh",
        ["api", "--method", "PATCH", `repos/${REPOSITORY}/pulls/9`],
        "HTTP 403"
      ),
      {
        tool: "gh",
        match: ["api", COMMITS_PATH],
        respond: { stdout: "e".repeat(40) }
      },
      { tool: "gh", match: ["api", "--method", "PATCH"], respond: {} }
    ]);

    expect(ledger.failures).toEqual([
      expect.stringMatching(/pull request #9: .*HTTP 403/s)
    ]);
    expect(
      fake.commands
        .commandLines("gh")
        .some((line) => line.includes(`PATCH ${DEFAULT_REF_PATH}`))
    ).toBe(false);
  });

  it("records a failing default branch reset", async () => {
    const { ledger } = await reclaimRunState([
      {
        tool: "gh",
        match: ["api", COMMITS_PATH],
        respond: { stdout: "e".repeat(40) }
      },
      failing(
        "gh",
        ["api", "--method", "PATCH", DEFAULT_REF_PATH],
        "protected branch"
      )
    ]);

    expect(ledger.failures).toEqual([
      expect.stringMatching(/main reset to .*: .*protected branch/)
    ]);
  });
});
