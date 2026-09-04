import { describe, expect, it } from "vitest";
import {
  createCloudFixture,
  radiusPurgeCreationTime,
  type CloudFixture,
  type CloudFixtureOptions
} from "./cloud-fixture.js";
import {
  createFakeFixturePorts,
  type FakeCommandStub,
  type FakeFixturePorts
} from "./fake-cloud-commands.js";

const SUBSCRIPTION = "11111111-2222-3333-4444-555555555555";
const REPOSITORY = "fixture-owner/fixture-repo";
const BRANCH = "main";
const BASELINE = "a".repeat(40);
const UNIQUE_ID = "run0000000a";
const WORKSPACE = "/tmp/radtest-workspace";
const NOW = new Date("2026-08-29T12:34:56.000Z");

const RESOURCE_GROUP = `radtest-canvas-${UNIQUE_ID}`;
const CLUSTER = `aks-${UNIQUE_ID}`;
const ENVIRONMENT = `radtest-${UNIQUE_ID}`;
const SCOPE = `/subscriptions/${SUBSCRIPTION}/resourceGroups/${RESOURCE_GROUP}`;
const APP_NAME = "radius-deploy-fixture-owner-fixture-repo";

// Spelled out rather than rebuilt from the fixture's own helpers, so a change to
// the paths it queries surfaces as an unstubbed command instead of silently
// following the test along.
const ENVIRONMENT_PATH = `repos/${REPOSITORY}/environments/${ENVIRONMENT}`;
const COMMITS_PATH = `repos/${REPOSITORY}/commits/${BRANCH}`;
const MATCHING_REFS_PATH = `repos/${REPOSITORY}/git/matching-refs/heads/radius/setup-`;
const PULLS_PATH = `repos/${REPOSITORY}/pulls?state=open&per_page=100`;
const DEFAULT_REF_PATH = `repos/${REPOSITORY}/git/refs/heads/${BRANCH}`;

const pullPages = (...pages: readonly unknown[][]): string =>
  JSON.stringify(pages);

const NOT_FOUND = {
  code: 1,
  stderr: "gh: Not Found (HTTP 404)"
} as const;

const EXACT_NAME_FILTER = `displayName eq '${APP_NAME}'`;
const APP_LIST: readonly string[] = [
  "ad",
  "app",
  "list",
  "--filter",
  EXACT_NAME_FILTER
];
const SP_LIST: readonly string[] = [
  "ad",
  "sp",
  "list",
  "--filter",
  EXACT_NAME_FILTER
];
const FIC_LIST: readonly string[] = [
  "ad",
  "app",
  "federated-credential",
  "list"
];
const ROLE_LIST: readonly string[] = ["role", "assignment", "list"];

/**
 * Every command a healthy run issues, all answering "clean".
 *
 * Tests prepend a stub to override one of these; `createFakeCloudCommands`
 * resolves the first match, so a prepended stub shadows its baseline.
 */
function baselineStubs(): FakeCommandStub[] {
  return [
    { tool: "az", match: ["group", "create"], respond: {} },
    { tool: "az", match: ["aks", "create"], respond: {} },
    { tool: "az", match: ["group", "delete"], respond: {} },
    { tool: "gh", match: ["repo", "clone"], respond: {} },
    { tool: "git", match: ["reset", "--hard"], respond: {} },
    { tool: "az", match: APP_LIST, respond: { stdout: "[]" } },
    { tool: "az", match: SP_LIST, respond: { stdout: "[]" } },
    { tool: "az", match: FIC_LIST, respond: { stdout: "[]" } },
    { tool: "az", match: ROLE_LIST, respond: { stdout: "[]" } },
    { tool: "gh", match: ["api", ENVIRONMENT_PATH], respond: NOT_FOUND },
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
  readonly fixture: CloudFixture;
  readonly fake: FakeFixturePorts;
}

async function createHarness(
  overrides: readonly FakeCommandStub[] = [],
  portOptions: Parameters<typeof createFakeFixturePorts>[0] = {},
  fixtureOptions: Partial<CloudFixtureOptions> = {}
): Promise<Harness> {
  const fake = createFakeFixturePorts({
    uniqueId: UNIQUE_ID,
    workspaceDir: WORKSPACE,
    now: NOW,
    ...portOptions,
    stubs: [...overrides, ...baselineStubs()]
  });
  const fixture = await createCloudFixture({
    ...fixtureOptions,
    subscriptionId: SUBSCRIPTION,
    repository: REPOSITORY,
    defaultBranch: BRANCH,
    baselineSha: BASELINE,
    ports: fake.ports
  });
  return { fixture, fake };
}

function expectConstructionToFail(
  overrides: readonly FakeCommandStub[],
  portOptions: Parameters<typeof createFakeFixturePorts>[0] = {}
): { fake: FakeFixturePorts; attempt: Promise<CloudFixture> } {
  const fake = createFakeFixturePorts({
    uniqueId: UNIQUE_ID,
    workspaceDir: WORKSPACE,
    now: NOW,
    ...portOptions,
    stubs: [...overrides, ...baselineStubs()]
  });
  const attempt = createCloudFixture({
    subscriptionId: SUBSCRIPTION,
    repository: REPOSITORY,
    defaultBranch: BRANCH,
    baselineSha: BASELINE,
    ports: fake.ports
  });
  return { fake, attempt };
}

const failing = (
  tool: FakeCommandStub["tool"],
  match: readonly string[],
  stderr: string
): FakeCommandStub => ({ tool, match, respond: { code: 2, stderr } });

/** Awaits a rejection and returns it, failing when the work unexpectedly succeeds. */
async function captureError(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (cause) {
    return cause instanceof Error ? cause : new Error(String(cause));
  }
  throw new Error("Expected the operation to fail, but it resolved.");
}

describe("createCloudFixture", () => {
  describe("construction", () => {
    it.each([
      ["zero timeout", { assertionTimeoutMs: 0 }, "Assertion timeout"],
      [
        "non-finite timeout",
        { assertionTimeoutMs: Number.POSITIVE_INFINITY },
        "Assertion timeout"
      ],
      [
        "zero poll interval",
        { assertionPollIntervalMs: 0 },
        "Assertion poll interval"
      ],
      [
        "non-finite poll interval",
        { assertionPollIntervalMs: Number.NaN },
        "Assertion poll interval"
      ]
    ] as const)(
      "rejects a %s before issuing an external command",
      async (_label, fixtureOptions, expectedMessage) => {
        const fake = createFakeFixturePorts({ stubs: baselineStubs() });

        await expect(
          createCloudFixture({
            subscriptionId: SUBSCRIPTION,
            repository: REPOSITORY,
            defaultBranch: BRANCH,
            baselineSha: BASELINE,
            ports: fake.ports,
            ...fixtureOptions
          })
        ).rejects.toThrow(
          `${expectedMessage} must be a positive finite number.`
        );
        expect(fake.commands.calls).toEqual([]);
      }
    );

    it("provisions the run's resource group, cluster, and pinned clone", async () => {
      const { fixture, fake } = await createHarness();

      expect(fixture.uniqueId).toBe(UNIQUE_ID);
      expect(fixture.resourceGroup).toBe(RESOURCE_GROUP);
      expect(fixture.clusterName).toBe(CLUSTER);
      expect(fixture.environmentName).toBe(ENVIRONMENT);
      expect(fixture.workspacePath).toBe(WORKSPACE);
      expect(fixture.subscriptionId).toBe(SUBSCRIPTION);
      expect(fixture.location).toBe("westus3");
      expect(fixture.repository).toBe(REPOSITORY);
      expect(fixture.defaultBranch).toBe(BRANCH);
      expect(fixture.baselineSha).toBe(BASELINE);

      expect(fake.commands.commandLines("az")).toEqual([
        `group create --name ${RESOURCE_GROUP} --location westus3 --subscription ${SUBSCRIPTION} ` +
          `--tags creationTime=${radiusPurgeCreationTime(NOW)} radius-canvas-e2e=true --output none`,
        `aks create --resource-group ${RESOURCE_GROUP} --name ${CLUSTER} --subscription ${SUBSCRIPTION} ` +
          "--node-count 1 --node-vm-size Standard_B2s --generate-ssh-keys --output none"
      ]);
      expect(fake.commands.commandLines("gh")).toEqual([
        `repo clone ${REPOSITORY} ${WORKSPACE}`
      ]);
      expect(fake.commands.calls.at(-1)).toEqual({
        tool: "git",
        args: ["reset", "--hard", BASELINE],
        cwd: WORKSPACE
      });
    });

    it("tags the group so scheduled cleanup can identify a crashed run's group", async () => {
      const { fake } = await createHarness();

      const create = fake.commands.calls[0];
      const creationTime = create.args.find((arg) =>
        arg.startsWith("creationTime=")
      );
      expect(creationTime).toBe(`creationTime=${radiusPurgeCreationTime(NOW)}`);
      expect(Number.isInteger(Number(creationTime?.split("=")[1]))).toBe(true);
      expect(create.args).toContain(RESOURCE_GROUP);
      expect(RESOURCE_GROUP.startsWith("radtest-")).toBe(true);
    });

    it("formats creation time for cleanup's integer comparison", () => {
      const sixHoursAgo = Math.floor(NOW.getTime() / 1_000) - 6 * 60 * 60;
      const creationTime = radiusPurgeCreationTime(
        new Date(NOW.getTime() - 7 * 60 * 60 * 1_000)
      );

      expect(Number(creationTime)).toBeLessThan(sixHoursAgo);
      expect(creationTime).toMatch(/^\d+$/);
    });

    it("rejects an invalid creation time instead of writing an unusable purge tag", () => {
      expect(() => radiusPurgeCreationTime(new Date("invalid"))).toThrow(
        "must be a valid date"
      );
    });

    it("creates nothing the product is responsible for creating", async () => {
      const { fake } = await createHarness();

      const issued = fake.commands.calls.map(
        (call) => `${call.tool} ${call.args.join(" ")}`
      );
      for (const forbidden of [
        "ad app create",
        "ad sp create",
        "federated-credential create",
        "role assignment create",
        "--method PUT",
        "--method POST"
      ])
        expect(issued.some((line) => line.includes(forbidden))).toBe(false);
    });

    it("honours location and node count overrides", async () => {
      const fake = createFakeFixturePorts({
        uniqueId: UNIQUE_ID,
        workspaceDir: WORKSPACE,
        now: NOW,
        stubs: baselineStubs()
      });
      const fixture = await createCloudFixture({
        subscriptionId: SUBSCRIPTION,
        repository: REPOSITORY,
        defaultBranch: BRANCH,
        baselineSha: BASELINE,
        location: "northeurope",
        nodeCount: 3,
        ports: fake.ports
      });

      expect(fixture.location).toBe("northeurope");
      expect(fake.commands.commandLines("az")[1]).toContain("--node-count 3");
      expect(fake.commands.commandLines("az")[0]).toContain(
        "--location northeurope"
      );
    });

    it("falls back to the pinned fixture repository constants", async () => {
      const fake = createFakeFixturePorts({
        uniqueId: UNIQUE_ID,
        workspaceDir: WORKSPACE,
        stubs: baselineStubs()
      });
      const fixture = await createCloudFixture({
        subscriptionId: SUBSCRIPTION,
        ports: fake.ports
      });

      expect(fixture.repository).toBe("TODO-owner/TODO-repo");
      expect(fixture.defaultBranch).toBe("main");
      expect(fixture.baselineSha).toBe("0".repeat(40));
    });

    it("rejects a blank subscription id before issuing any command", async () => {
      const fake = createFakeFixturePorts({ stubs: baselineStubs() });

      await expect(
        createCloudFixture({ subscriptionId: "  ", ports: fake.ports })
      ).rejects.toThrow(/subscription id is required/i);
      expect(fake.commands.calls).toEqual([]);
    });

    it("fails fast when the resource group cannot be created", async () => {
      const { fake, attempt } = expectConstructionToFail([
        failing("az", ["group", "create"], "quota exceeded")
      ]);

      await expect(attempt).rejects.toThrow(
        /az group create .* failed with exit code 2: quota exceeded/
      );
      // Nothing was created, so nothing may be torn down.
      expect(fake.commands.commandLines("az")).toEqual([
        expect.stringContaining("group create")
      ]);
      expect(fake.removed).toEqual([]);
    });

    it("tears down the resource group when the cluster cannot be created", async () => {
      const { fake, attempt } = expectConstructionToFail([
        failing("az", ["aks", "create"], "SkuNotAvailable")
      ]);

      await expect(attempt).rejects.toThrow(/SkuNotAvailable/);
      expect(fake.commands.commandLines("az").at(-1)).toContain(
        `group delete --name ${RESOURCE_GROUP}`
      );
      expect(fake.removed).toEqual([]);
    });

    it("tears down the resource group when the workspace directory cannot be made", async () => {
      const { fake, attempt } = expectConstructionToFail([], {
        makeWorkspaceDir: () => Promise.reject(new Error("ENOSPC"))
      });

      await expect(attempt).rejects.toThrow("ENOSPC");
      expect(fake.commands.commandLines("az").at(-1)).toContain("group delete");
      expect(fake.removed).toEqual([]);
    });

    it("removes the workspace and the resource group when the clone fails", async () => {
      const { fake, attempt } = expectConstructionToFail([
        failing("gh", ["repo", "clone"], "repository not found")
      ]);

      await expect(attempt).rejects.toThrow(/repository not found/);
      expect(fake.removed).toEqual([WORKSPACE]);
      expect(fake.commands.commandLines("az").at(-1)).toContain("group delete");
    });

    it("removes the workspace and the resource group when the baseline reset fails", async () => {
      const { fake, attempt } = expectConstructionToFail([
        failing("git", ["reset", "--hard"], "unknown revision")
      ]);

      await expect(attempt).rejects.toThrow(/unknown revision/);
      expect(fake.removed).toEqual([WORKSPACE]);
      expect(fake.commands.commandLines("az").at(-1)).toContain("group delete");
    });

    it("reports the original failure and every failed construction unwind", async () => {
      const { attempt } = expectConstructionToFail(
        [
          failing("git", ["reset", "--hard"], "unknown revision"),
          failing("az", ["group", "delete"], "group is locked")
        ],
        { removeDir: () => Promise.reject(new Error("EBUSY")) }
      );

      const error = await captureError(attempt);
      expect(error.message).toContain("unknown revision");
      expect(error.message).toContain(`remove workspace ${WORKSPACE}`);
      expect(error.message).toContain("EBUSY");
      expect(error.message).toContain(
        `delete resource group ${RESOURCE_GROUP}`
      );
      expect(error.message).toContain("group is locked");
    });
  });

  describe("assertCleanSlate", () => {
    it("resolves when every product-created artifact is absent", async () => {
      const { fixture } = await createHarness();
      await expect(fixture.assertCleanSlate()).resolves.toBeUndefined();
    });

    it("queries the exact app and service-principal name the product would choose", async () => {
      const { fixture, fake } = await createHarness();
      await fixture.assertCleanSlate();

      const lines = fake.commands.commandLines("az");
      expect(lines).toContain(
        `ad app list --filter ${EXACT_NAME_FILTER} --query [].{appId:appId,id:id,displayName:displayName} -o json`
      );
      expect(lines).toContain(
        `ad sp list --filter ${EXACT_NAME_FILTER} --query [].{id:id} -o json`
      );
      expect(lines.some((line) => line.includes("--display-name"))).toBe(false);
      expect(lines.some((line) => line.includes(`--scope ${SCOPE}`))).toBe(
        true
      );
      expect(fake.commands.commandLines("gh")).toContain(
        `api --paginate --slurp ${PULLS_PATH}`
      );
    });

    it("reports a leaked app registration", async () => {
      const { fixture } = await createHarness([
        {
          tool: "az",
          match: APP_LIST,
          respond: {
            stdout: JSON.stringify([
              { appId: "app-1", id: "obj-1", displayName: APP_NAME }
            ])
          }
        }
      ]);

      await expect(fixture.assertCleanSlate()).rejects.toThrow(
        /app registration "radius-deploy-fixture-owner-fixture-repo" \(appId app-1, object obj-1\)/
      );
    });

    it("names leaked state as a previous run rather than a product regression", async () => {
      const { fixture } = await createHarness([
        { tool: "az", match: SP_LIST, respond: { stdout: '[{"id":"sp-1"}]' } }
      ]);

      await expect(fixture.assertCleanSlate()).rejects.toThrow(
        /Leaked state from a previous run, not a product regression/
      );
    });

    it("reports a leaked service principal", async () => {
      const { fixture } = await createHarness([
        { tool: "az", match: SP_LIST, respond: { stdout: '[{"id":"sp-9"}]' } }
      ]);

      await expect(fixture.assertCleanSlate()).rejects.toThrow(
        /service principal sp-9 for "radius-deploy-fixture-owner-fixture-repo"/
      );
    });

    it("reports a leaked federated credential on a surviving app registration", async () => {
      const { fixture } = await createHarness([
        {
          tool: "az",
          match: APP_LIST,
          respond: {
            stdout: JSON.stringify([
              { appId: "app-1", id: "obj-1", displayName: APP_NAME }
            ])
          }
        },
        {
          tool: "az",
          match: FIC_LIST,
          respond: {
            stdout: JSON.stringify([
              {
                name: "gh-main",
                subject: "repo:owner/repo:ref:refs/heads/main"
              }
            ])
          }
        }
      ]);

      await expect(fixture.assertCleanSlate()).rejects.toThrow(
        /federated credential "gh-main" \(subject "repo:owner\/repo:ref:refs\/heads\/main"\) on app app-1/
      );
    });

    it("does not probe federated credentials when no app registration survived", async () => {
      const { fixture, fake } = await createHarness();
      await fixture.assertCleanSlate();

      expect(
        fake.commands
          .commandLines("az")
          .some((line) => line.includes("federated-credential"))
      ).toBe(false);
    });

    it("reports a leaked role assignment inside the run's resource group", async () => {
      const { fixture } = await createHarness([
        {
          tool: "az",
          match: ROLE_LIST,
          respond: {
            stdout: JSON.stringify([
              { principalId: "sp-1", roleDefinitionName: "Contributor" }
            ])
          }
        }
      ]);

      await expect(fixture.assertCleanSlate()).rejects.toThrow(
        new RegExp(
          `role assignment "Contributor" for principal sp-1 at ${SCOPE.replace(
            /\//g,
            "\\/"
          )}`
        )
      );
    });

    it("names an unnamed role definition rather than failing to report it", async () => {
      const { fixture } = await createHarness([
        {
          tool: "az",
          match: ROLE_LIST,
          respond: { stdout: JSON.stringify([{ principalId: "sp-1" }]) }
        }
      ]);

      await expect(fixture.assertCleanSlate()).rejects.toThrow(
        /role assignment "\(unnamed role\)" for principal sp-1/
      );
    });

    it("reports a leaked GitHub environment", async () => {
      const { fixture } = await createHarness([
        {
          tool: "gh",
          match: ["api", ENVIRONMENT_PATH],
          respond: { stdout: '{"name":"radtest"}' }
        }
      ]);

      await expect(fixture.assertCleanSlate()).rejects.toThrow(
        new RegExp(`GitHub environment "${ENVIRONMENT}" in ${REPOSITORY}`)
      );
    });

    it("refuses to read a non-404 environment probe failure as absence", async () => {
      const { fixture } = await createHarness([
        {
          tool: "gh",
          match: ["api", ENVIRONMENT_PATH],
          respond: { code: 1, stderr: "HTTP 401: Bad credentials" }
        }
      ]);

      await expect(fixture.assertCleanSlate()).rejects.toThrow(
        /Could not probe GitHub environment .* gh exited 1: HTTP 401: Bad credentials/
      );
    });

    it("refuses to read execFile's empty-stream failure message as absence", async () => {
      const { fixture } = await createHarness([
        {
          tool: "gh",
          match: ["api", ENVIRONMENT_PATH],
          respond: {
            code: 1,
            stderr: `Command failed: gh api ${ENVIRONMENT_PATH}\n`
          }
        }
      ]);

      await expect(fixture.assertCleanSlate()).rejects.toThrow(
        /Could not probe GitHub environment .* Command failed: gh api repos\//
      );
    });

    it("reports an environment probe failure that gh wrote to stdout", async () => {
      const { fixture } = await createHarness([
        {
          tool: "gh",
          match: ["api", ENVIRONMENT_PATH],
          respond: { code: 1, stdout: '{"message":"Server Error"}' }
        }
      ]);

      await expect(fixture.assertCleanSlate()).rejects.toThrow(
        /Could not probe GitHub environment .* gh exited 1: \{"message":"Server Error"\}/
      );
    });

    it("reports a default branch that has moved off the pinned baseline", async () => {
      const { fixture } = await createHarness([
        {
          tool: "gh",
          match: ["api", COMMITS_PATH],
          respond: { stdout: `${"b".repeat(40)}\n` }
        }
      ]);

      await expect(fixture.assertCleanSlate()).rejects.toThrow(
        new RegExp(
          `${REPOSITORY}@${BRANCH} is at ${"b".repeat(40)}, not the pinned baseline ${BASELINE}`
        )
      );
    });

    it("accepts a default branch head that differs only by casing or whitespace", async () => {
      const { fixture } = await createHarness([
        {
          tool: "gh",
          match: ["api", COMMITS_PATH],
          respond: { stdout: `  ${BASELINE.toUpperCase()}\n` }
        }
      ]);

      await expect(fixture.assertCleanSlate()).resolves.toBeUndefined();
    });

    it("fails when the default branch head cannot be read at all", async () => {
      const { fixture } = await createHarness([
        { tool: "gh", match: ["api", COMMITS_PATH], respond: { stdout: "  " } }
      ]);

      await expect(fixture.assertCleanSlate()).rejects.toThrow(
        /returned no commit SHA/
      );
    });

    // The product falls back to a pull request when its token lacks `workflow`
    // scope, which leaves the default branch pristine. Without these two probes
    // that path reports a clean slate while leaking a branch and a pull request.
    it("reports a leaked workflow fallback branch even though the default branch is clean", async () => {
      const { fixture } = await createHarness([
        {
          tool: "gh",
          match: ["api", MATCHING_REFS_PATH],
          respond: {
            stdout: JSON.stringify([
              { ref: "refs/heads/radius/setup-radtest-abc-workflows-1a2b" }
            ])
          }
        }
      ]);

      await expect(fixture.assertCleanSlate()).rejects.toThrow(
        /workflow fallback branch "radius\/setup-radtest-abc-workflows-1a2b"/
      );
    });

    it("reports a leaked open pull request", async () => {
      const { fixture } = await createHarness([
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
      ]);

      const error = await captureError(fixture.assertCleanSlate());
      expect(error.message).toMatch(
        /open pull request #7 \("Add Radius workflows", head "radius\/setup-radtest-abc-workflows-1a2b"\)/
      );
      expect(error.message).toMatch(
        /open pull request #8 \("Second page", head "radius\/setup-second"\)/
      );
    });

    it("reports placeholders when an open pull request omits optional details", async () => {
      const { fixture } = await createHarness([
        {
          tool: "gh",
          match: ["api", PULLS_PATH],
          respond: { stdout: pullPages([{ number: 7 }]) }
        }
      ]);

      await expect(fixture.assertCleanSlate()).rejects.toThrow(
        /open pull request #7 \("\(untitled\)", head "\(unknown\)"\)/
      );
    });

    it.each([
      ["a missing number", undefined],
      ["a non-integer number", 1.5],
      ["a non-positive number", 0]
    ])("rejects an open pull request with %s", async (_label, number) => {
      const { fixture } = await createHarness([
        {
          tool: "gh",
          match: ["api", PULLS_PATH],
          respond: { stdout: pullPages([{ number }]) }
        }
      ]);

      await expect(fixture.assertCleanSlate()).rejects.toThrow(
        /open pull requests .* no usable "number"/
      );
    });

    it("rejects an empty successful pull-request response", async () => {
      const { fixture } = await createHarness([
        {
          tool: "gh",
          match: ["api", PULLS_PATH],
          respond: { stdout: "" }
        }
      ]);

      await expect(fixture.assertCleanSlate()).rejects.toThrow(
        /open pull requests .* empty response instead of JSON/
      );
    });

    it("rejects a paginated pull-request response whose page is not an array", async () => {
      const { fixture } = await createHarness([
        {
          tool: "gh",
          match: ["api", PULLS_PATH],
          respond: { stdout: JSON.stringify([{ number: 7 }]) }
        }
      ]);

      await expect(fixture.assertCleanSlate()).rejects.toThrow(
        /open pull requests .* page 0 with JSON type "object"/
      );
    });

    it("collects every finding instead of stopping at the first", async () => {
      const { fixture } = await createHarness([
        {
          tool: "az",
          match: APP_LIST,
          respond: {
            stdout: JSON.stringify([
              { appId: "app-1", id: "obj-1", displayName: APP_NAME }
            ])
          }
        },
        { tool: "az", match: SP_LIST, respond: { stdout: '[{"id":"sp-1"}]' } },
        {
          tool: "az",
          match: FIC_LIST,
          respond: { stdout: '[{"name":"gh","subject":"repo:x:ref:y"}]' }
        },
        {
          tool: "az",
          match: ROLE_LIST,
          respond: {
            stdout:
              '[{"principalId":"sp-1","roleDefinitionName":"Contributor"}]'
          }
        },
        {
          tool: "gh",
          match: ["api", ENVIRONMENT_PATH],
          respond: { stdout: "{}" }
        },
        {
          tool: "gh",
          match: ["api", COMMITS_PATH],
          respond: { stdout: "c".repeat(40) }
        },
        {
          tool: "gh",
          match: ["api", MATCHING_REFS_PATH],
          respond: { stdout: '[{"ref":"refs/heads/radius/setup-x"}]' }
        },
        {
          tool: "gh",
          match: ["api", PULLS_PATH],
          respond: {
            stdout: pullPages([{ number: 3, title: "t", head: { ref: "r" } }])
          }
        }
      ]);

      const error = await captureError(fixture.assertCleanSlate());

      expect(error.message.split("\n  - ")).toHaveLength(9);
      for (const fragment of [
        "app registration",
        "service principal",
        "federated credential",
        "role assignment",
        "GitHub environment",
        "not the pinned baseline",
        "workflow fallback branch",
        "open pull request"
      ])
        expect(error.message).toContain(fragment);
    });

    it.each([
      ["app registration listing", "az", APP_LIST],
      ["service principal listing", "az", SP_LIST],
      ["role assignment listing", "az", ROLE_LIST]
    ] as const)(
      "propagates a failing %s rather than reading it as absence",
      async (_label, tool, match) => {
        const { fixture } = await createHarness([
          failing(tool, match, "AADSTS700016: token expired")
        ]);

        await expect(fixture.assertCleanSlate()).rejects.toThrow(
          /failed with exit code 2: AADSTS700016: token expired/
        );
      }
    );

    it.each([
      ["az", APP_LIST],
      ["az", SP_LIST],
      ["az", ROLE_LIST]
    ] as const)("rejects malformed JSON from %s %s", async (tool, match) => {
      const { fixture } = await createHarness([
        { tool, match, respond: { stdout: "{not json" } }
      ]);

      await expect(fixture.assertCleanSlate()).rejects.toThrow(
        /returned output that is not valid JSON/
      );
    });

    it("rejects a JSON payload that is not an array", async () => {
      const { fixture } = await createHarness([
        { tool: "az", match: APP_LIST, respond: { stdout: '{"appId":"x"}' } }
      ]);

      await expect(fixture.assertCleanSlate()).rejects.toThrow(
        /returned a JSON object where a JSON array was expected/
      );
    });

    it("rejects a JSON null payload", async () => {
      const { fixture } = await createHarness([
        { tool: "az", match: APP_LIST, respond: { stdout: "null" } }
      ]);

      await expect(fixture.assertCleanSlate()).rejects.toThrow(
        /returned null where a JSON array was expected/
      );
    });

    it("rejects a non-object entry inside an otherwise valid array", async () => {
      const { fixture } = await createHarness([
        { tool: "az", match: APP_LIST, respond: { stdout: '["app-1"]' } }
      ]);

      await expect(fixture.assertCleanSlate()).rejects.toThrow(
        /returned a non-object entry at index 0/
      );
    });

    it("rejects an entry missing the identifier the assertion depends on", async () => {
      const { fixture } = await createHarness([
        {
          tool: "az",
          match: APP_LIST,
          respond: { stdout: '[{"appId":"app-1","displayName":"x"}]' }
        }
      ]);

      await expect(fixture.assertCleanSlate()).rejects.toThrow(
        /entry at index 0 with no usable "id"/
      );
    });

    it("treats empty command output as an empty result", async () => {
      const { fixture } = await createHarness([
        { tool: "az", match: APP_LIST, respond: { stdout: "" } }
      ]);

      await expect(fixture.assertCleanSlate()).resolves.toBeUndefined();
    });
  });

  describe("assertAppRegistrationExists", () => {
    it("returns the app id and object id the later assertions need", async () => {
      const { fixture } = await createHarness([
        {
          tool: "az",
          match: APP_LIST,
          respond: {
            stdout: JSON.stringify([
              { appId: "app-1", id: "obj-1", displayName: APP_NAME }
            ])
          }
        }
      ]);

      await expect(fixture.assertAppRegistrationExists()).resolves.toEqual({
        appId: "app-1",
        objectId: "obj-1",
        displayName: APP_NAME
      });
    });

    it("fails when the product created no app registration", async () => {
      const { fixture } = await createHarness();

      await expect(fixture.assertAppRegistrationExists()).rejects.toThrow(
        new RegExp(
          `Timed out after 30000ms.*app registration named "${APP_NAME}"`
        )
      );
    });

    it("polls until the app registration becomes visible", async () => {
      const { fixture, fake } = await createHarness([
        { tool: "az", match: APP_LIST, respond: { stdout: "[]" }, times: 1 },
        {
          tool: "az",
          match: APP_LIST,
          respond: {
            stdout: JSON.stringify([
              { appId: "app-1", id: "obj-1", displayName: APP_NAME }
            ])
          }
        }
      ]);

      await expect(
        fixture.assertAppRegistrationExists()
      ).resolves.toMatchObject({ appId: "app-1" });
      expect(fake.waits).toEqual([1000]);
    });

    it("uses the remaining timeout for the final poll interval", async () => {
      const { fixture, fake } = await createHarness(
        [],
        {},
        { assertionTimeoutMs: 1500, assertionPollIntervalMs: 1000 }
      );

      await expect(fixture.assertAppRegistrationExists()).rejects.toThrow(
        /Timed out after 1500ms/
      );
      expect(fake.waits).toEqual([1000, 500]);
    });

    it("blames a concurrent run when the repository-scoped name is duplicated", async () => {
      const { fixture } = await createHarness([
        {
          tool: "az",
          match: APP_LIST,
          respond: {
            stdout: JSON.stringify([
              { appId: "app-1", id: "obj-1", displayName: APP_NAME },
              { appId: "app-2", id: "obj-2", displayName: APP_NAME }
            ])
          }
        }
      ]);

      await expect(fixture.assertAppRegistrationExists()).rejects.toThrow(
        /found 2 \(app-1, app-2\).*concurrent run against the same fixture repository/s
      );
    });

    it("propagates a failing lookup", async () => {
      const { fixture, fake } = await createHarness([
        failing("az", APP_LIST, "not logged in")
      ]);

      await expect(fixture.assertAppRegistrationExists()).rejects.toThrow(
        /not logged in/
      );
      expect(fake.waits).toEqual([]);
    });
  });

  describe("assertFederatedCredentialExists", () => {
    const withApp = (fic: FakeCommandStub["respond"]): FakeCommandStub[] => [
      {
        tool: "az",
        match: APP_LIST,
        respond: {
          stdout: JSON.stringify([
            { appId: "app-1", id: "obj-1", displayName: APP_NAME }
          ])
        }
      },
      { tool: "az", match: FIC_LIST, respond: fic }
    ];

    const SUBJECT = "repo:fixture-owner/fixture-repo:environment:radtest-run";

    it("resolves when the expected subject is present", async () => {
      const { fixture, fake } = await createHarness(
        withApp({
          stdout: JSON.stringify([
            { name: "other", subject: "repo:x:ref:refs/heads/main" },
            { name: "env", subject: SUBJECT }
          ])
        })
      );

      await expect(
        fixture.assertFederatedCredentialExists(SUBJECT)
      ).resolves.toBeUndefined();
      expect(
        fake.commands
          .commandLines("az")
          .some((line) => line.includes("federated-credential list --id obj-1"))
      ).toBe(true);
    });

    it("polls until the federated credential becomes visible", async () => {
      const { fixture, fake } = await createHarness([
        {
          tool: "az",
          match: APP_LIST,
          respond: {
            stdout: JSON.stringify([
              { appId: "app-1", id: "obj-1", displayName: APP_NAME }
            ])
          }
        },
        { tool: "az", match: FIC_LIST, respond: { stdout: "[]" }, times: 1 },
        {
          tool: "az",
          match: FIC_LIST,
          respond: {
            stdout: JSON.stringify([{ name: "env", subject: SUBJECT }])
          }
        }
      ]);

      await expect(
        fixture.assertFederatedCredentialExists(SUBJECT)
      ).resolves.toBeUndefined();
      expect(fake.waits).toEqual([1000]);
    });

    it("reports the subjects that do exist when the expected one does not", async () => {
      const { fixture } = await createHarness(
        withApp({ stdout: '[{"name":"other","subject":"repo:x:ref:y"}]' })
      );

      await expect(
        fixture.assertFederatedCredentialExists(SUBJECT)
      ).rejects.toThrow(/Existing subjects: "repo:x:ref:y"\./);
    });

    it("refuses to accept a subject that differs only by letter casing", async () => {
      const { fixture } = await createHarness(
        withApp({
          stdout: JSON.stringify([
            { name: "env", subject: SUBJECT.toUpperCase() }
          ])
        })
      );

      await expect(
        fixture.assertFederatedCredentialExists(SUBJECT)
      ).rejects.toThrow(
        /differing only by letter casing exists .* Entra would reject a token/s
      );
    });

    it("says so plainly when the app carries no credentials at all", async () => {
      const { fixture } = await createHarness(withApp({ stdout: "[]" }));

      await expect(
        fixture.assertFederatedCredentialExists(SUBJECT)
      ).rejects.toThrow(/carries no federated credentials at all/);
    });

    it("tolerates a flexible credential that reports no subject", async () => {
      const { fixture } = await createHarness(
        withApp({ stdout: '[{"name":"flexible"}]' })
      );

      await expect(
        fixture.assertFederatedCredentialExists(SUBJECT)
      ).rejects.toThrow(/Existing subjects: ""\./);
    });

    it("propagates the missing app registration rather than reporting a missing credential", async () => {
      const { fixture } = await createHarness();

      await expect(
        fixture.assertFederatedCredentialExists(SUBJECT)
      ).rejects.toThrow(/Timed out after 30000ms.*app registration named/s);
    });
  });

  describe("assertRoleAssignmentExists", () => {
    it("resolves when the principal holds an assignment in the group", async () => {
      const { fixture } = await createHarness([
        {
          tool: "az",
          match: ROLE_LIST,
          respond: {
            stdout: JSON.stringify([
              { principalId: "SP-1", roleDefinitionName: "Contributor" }
            ])
          }
        }
      ]);

      await expect(
        fixture.assertRoleAssignmentExists("sp-1")
      ).resolves.toBeUndefined();
    });

    it("polls until the role assignment becomes visible", async () => {
      const { fixture, fake } = await createHarness([
        { tool: "az", match: ROLE_LIST, respond: { stdout: "[]" }, times: 1 },
        {
          tool: "az",
          match: ROLE_LIST,
          respond: {
            stdout: JSON.stringify([
              { principalId: "sp-1", roleDefinitionName: "Contributor" }
            ])
          }
        }
      ]);

      await expect(
        fixture.assertRoleAssignmentExists("sp-1")
      ).resolves.toBeUndefined();
      expect(fake.waits).toEqual([1000]);
    });

    it("fails plainly when the group carries no assignments", async () => {
      const { fixture } = await createHarness();

      await expect(fixture.assertRoleAssignmentExists("sp-1")).rejects.toThrow(
        /found no role assignments at all/
      );
    });

    it("lists the principals that do hold assignments", async () => {
      const { fixture } = await createHarness([
        {
          tool: "az",
          match: ROLE_LIST,
          respond: {
            stdout: JSON.stringify([
              { principalId: "sp-2", roleDefinitionName: "Contributor" },
              { principalId: "sp-2", roleDefinitionName: "AKS RBAC Admin" }
            ])
          }
        }
      ]);

      await expect(fixture.assertRoleAssignmentExists("sp-1")).rejects.toThrow(
        /only assignments for sp-2\./
      );
    });

    it("propagates a failing lookup", async () => {
      const { fixture } = await createHarness([
        failing("az", ROLE_LIST, "AuthorizationFailed")
      ]);

      await expect(fixture.assertRoleAssignmentExists("sp-1")).rejects.toThrow(
        /AuthorizationFailed/
      );
    });
  });

  describe("assertGitHubEnvironmentExists", () => {
    it("resolves when the environment exists", async () => {
      const { fixture } = await createHarness([
        {
          tool: "gh",
          match: ["api", ENVIRONMENT_PATH],
          respond: { stdout: '{"name":"radtest"}' }
        }
      ]);

      await expect(
        fixture.assertGitHubEnvironmentExists()
      ).resolves.toBeUndefined();
    });

    it("polls until the GitHub Environment becomes visible", async () => {
      const { fixture, fake } = await createHarness([
        {
          tool: "gh",
          match: ["api", ENVIRONMENT_PATH],
          respond: NOT_FOUND,
          times: 1
        },
        {
          tool: "gh",
          match: ["api", ENVIRONMENT_PATH],
          respond: { stdout: '{"name":"radtest"}' }
        }
      ]);

      await expect(
        fixture.assertGitHubEnvironmentExists()
      ).resolves.toBeUndefined();
      expect(fake.waits).toEqual([1000]);
    });

    it("fails when the environment is genuinely absent", async () => {
      const { fixture } = await createHarness();

      await expect(fixture.assertGitHubEnvironmentExists()).rejects.toThrow(
        new RegExp(
          `Timed out after 30000ms.*GitHub Environment "${ENVIRONMENT}"`
        )
      );
    });

    it("distinguishes an unreadable answer from an absent environment", async () => {
      const { fixture } = await createHarness([
        {
          tool: "gh",
          match: ["api", ENVIRONMENT_PATH],
          respond: { code: 1, stdout: "rate limit exceeded" }
        }
      ]);

      await expect(fixture.assertGitHubEnvironmentExists()).rejects.toThrow(
        /Could not determine whether GitHub Environment .* gh exited 1: rate limit exceeded/
      );
    });
  });

  describe("absence assertions", () => {
    const SUBJECT = "repo:fixture-owner/fixture-repo:environment:radtest-run";
    const APP_LIST_RESULT = JSON.stringify([
      { appId: "app-1", id: "obj-1", displayName: APP_NAME }
    ]);

    async function observedHarness(stubs: FakeCommandStub[] = []) {
      const harness = await createHarness([
        {
          tool: "az",
          match: APP_LIST,
          respond: { stdout: APP_LIST_RESULT },
          times: 1
        },
        {
          tool: "gh",
          match: ["api", ENVIRONMENT_PATH],
          respond: { stdout: '{"name":"radtest"}' },
          times: 1
        },
        {
          tool: "az",
          match: ROLE_LIST,
          respond: {
            stdout: JSON.stringify([
              { principalId: "sp-1", roleDefinitionName: "Contributor" }
            ])
          },
          times: 1
        },
        {
          tool: "az",
          match: FIC_LIST,
          respond: {
            stdout: JSON.stringify([{ name: "fc", subject: SUBJECT }])
          },
          times: 1
        },
        ...stubs
      ]);
      await harness.fixture.assertGitHubEnvironmentExists();
      await harness.fixture.assertRoleAssignmentExists("sp-1");
      await harness.fixture.assertFederatedCredentialExists(SUBJECT);
      return harness;
    }

    describe("refuses to answer before presence was established", () => {
      it.each([
        [
          "the GitHub Environment",
          (fixture: CloudFixture) => fixture.assertGitHubEnvironmentAbsent(),
          new RegExp(`GitHub Environment "${ENVIRONMENT}"`)
        ],
        [
          "the app registration",
          (fixture: CloudFixture) => fixture.assertAppRegistrationAbsent(),
          new RegExp(`app registration "${APP_NAME}"`)
        ],
        [
          "a federated credential",
          (fixture: CloudFixture) =>
            fixture.assertFederatedCredentialAbsent(SUBJECT),
          /federated credential for subject/
        ],
        [
          "a role assignment",
          (fixture: CloudFixture) => fixture.assertRoleAssignmentAbsent("sp-1"),
          /role assignment for principal sp-1/
        ]
      ])(
        "for %s, because a product that never created it would pass too",
        async (_label, assertAbsent, subject) => {
          const { fixture } = await createHarness();

          const error = await captureError(assertAbsent(fixture));
          expect(error.message).toMatch(/never observed it present/);
          expect(error.message).toMatch(subject);
        }
      );
    });

    describe("assertGitHubEnvironmentAbsent", () => {
      it("resolves once the environment is gone", async () => {
        const { fixture } = await observedHarness([
          { tool: "gh", match: ["api", ENVIRONMENT_PATH], respond: NOT_FOUND }
        ]);

        await expect(
          fixture.assertGitHubEnvironmentAbsent()
        ).resolves.toBeUndefined();
      });

      it("polls until the deletion becomes visible", async () => {
        const { fixture, fake } = await observedHarness([
          {
            tool: "gh",
            match: ["api", ENVIRONMENT_PATH],
            respond: { stdout: '{"name":"radtest"}' },
            times: 1
          },
          { tool: "gh", match: ["api", ENVIRONMENT_PATH], respond: NOT_FOUND }
        ]);

        await expect(
          fixture.assertGitHubEnvironmentAbsent()
        ).resolves.toBeUndefined();
        expect(fake.waits).toEqual([1000]);
      });

      it("fails when the product left the environment standing", async () => {
        const { fixture } = await observedHarness([
          {
            tool: "gh",
            match: ["api", ENVIRONMENT_PATH],
            respond: { stdout: '{"name":"radtest"}' }
          }
        ]);

        await expect(fixture.assertGitHubEnvironmentAbsent()).rejects.toThrow(
          /waiting for the product to delete GitHub Environment .* it still exists\./
        );
      });

      it("distinguishes an unreadable answer from a deleted environment", async () => {
        const { fixture } = await observedHarness([
          {
            tool: "gh",
            match: ["api", ENVIRONMENT_PATH],
            respond: { code: 1, stdout: "rate limit exceeded" }
          }
        ]);

        await expect(fixture.assertGitHubEnvironmentAbsent()).rejects.toThrow(
          /Could not determine whether GitHub Environment .* still exists .* gh exited 1: rate limit exceeded/
        );
      });

      it("does not read an unrelated Not Found phrase as deletion", async () => {
        const { fixture } = await observedHarness([
          {
            tool: "gh",
            match: ["api", ENVIRONMENT_PATH],
            respond: {
              code: 1,
              stderr: "Not Found while resolving the configured GitHub host"
            }
          }
        ]);

        await expect(fixture.assertGitHubEnvironmentAbsent()).rejects.toThrow(
          /Could not determine whether GitHub Environment .* still exists .* gh exited 1: Not Found while resolving/
        );
      });
    });

    describe("assertAppRegistrationAbsent", () => {
      it("resolves once no registration with the product's name remains", async () => {
        const { fixture } = await observedHarness([
          { tool: "az", match: APP_LIST, respond: { stdout: "[]" } }
        ]);

        await expect(
          fixture.assertAppRegistrationAbsent()
        ).resolves.toBeUndefined();
      });

      it("names the registrations still standing when the wait expires", async () => {
        const { fixture } = await observedHarness([
          { tool: "az", match: APP_LIST, respond: { stdout: APP_LIST_RESULT } }
        ]);

        await expect(fixture.assertAppRegistrationAbsent()).rejects.toThrow(
          /to be deleted; 1 still exist\(s\) \(app-1\)\./
        );
      });

      it("propagates a failing lookup rather than reading it as absence", async () => {
        const { fixture } = await observedHarness([
          failing("az", APP_LIST, "AADSTS700016")
        ]);

        await expect(fixture.assertAppRegistrationAbsent()).rejects.toThrow(
          /AADSTS700016/
        );
      });
    });

    describe("assertFederatedCredentialAbsent", () => {
      it("queries the exact observed registration and resolves once the credential is gone", async () => {
        const { fixture, fake } = await observedHarness([
          { tool: "az", match: FIC_LIST, respond: { stdout: "[]" } }
        ]);

        await expect(
          fixture.assertFederatedCredentialAbsent(SUBJECT)
        ).resolves.toBeUndefined();
        expect(
          fake.commands
            .commandLines("az")
            .filter((line) => line.includes("ad app list"))
        ).toHaveLength(1);
        expect(fake.commands.commandLines("az")).toContain(
          "ad app federated-credential list --id obj-1 --query [].{name:name,subject:subject} -o json"
        );
      });

      it("polls the exact observed registration until the credential is gone", async () => {
        const { fixture, fake } = await observedHarness([
          {
            tool: "az",
            match: FIC_LIST,
            respond: {
              stdout: JSON.stringify([{ name: "fc", subject: SUBJECT }])
            },
            times: 1
          },
          { tool: "az", match: FIC_LIST, respond: { stdout: "[]" } }
        ]);

        await expect(
          fixture.assertFederatedCredentialAbsent(SUBJECT)
        ).resolves.toBeUndefined();
        expect(fake.waits).toEqual([1000]);
      });

      it("fails closed when the exact observed registration cannot be queried", async () => {
        const { fixture } = await observedHarness([
          failing("az", FIC_LIST, "Microsoft Graph is unavailable")
        ]);

        await expect(
          fixture.assertFederatedCredentialAbsent(SUBJECT)
        ).rejects.toThrow(/Microsoft Graph is unavailable/);
      });

      it("reports a credential the product failed to remove", async () => {
        const { fixture } = await observedHarness([
          {
            tool: "az",
            match: FIC_LIST,
            respond: {
              stdout: JSON.stringify([{ name: "fc", subject: SUBJECT }])
            }
          }
        ]);

        await expect(
          fixture.assertFederatedCredentialAbsent(SUBJECT)
        ).rejects.toThrow(/still carries 1 credential\(s\)\./);
      });
    });

    describe("assertRoleAssignmentAbsent", () => {
      it("resolves once the principal holds nothing in scope", async () => {
        const { fixture } = await observedHarness([
          { tool: "az", match: ROLE_LIST, respond: { stdout: "[]" } }
        ]);

        await expect(
          fixture.assertRoleAssignmentAbsent("sp-1")
        ).resolves.toBeUndefined();
      });

      it("ignores assignments belonging to other principals", async () => {
        const { fixture } = await observedHarness([
          {
            tool: "az",
            match: ROLE_LIST,
            respond: {
              stdout: JSON.stringify([
                { principalId: "sp-2", roleDefinitionName: "Contributor" }
              ])
            }
          }
        ]);

        await expect(
          fixture.assertRoleAssignmentAbsent("sp-1")
        ).resolves.toBeUndefined();
      });

      it("reports assignments the product failed to remove, matching case-insensitively", async () => {
        const { fixture } = await observedHarness([
          {
            tool: "az",
            match: ROLE_LIST,
            respond: {
              stdout: JSON.stringify([
                { principalId: "SP-1", roleDefinitionName: "Contributor" }
              ])
            }
          }
        ]);

        await expect(
          fixture.assertRoleAssignmentAbsent("sp-1")
        ).rejects.toThrow(/to be removed; 1 remain\(s\)\./);
      });
    });
  });

  describe("reclaimLeakedProductArtifacts", () => {
    it("reclaims nothing when the world is already clean", async () => {
      const { fixture, fake } = await createHarness();

      await expect(fixture.reclaimLeakedProductArtifacts()).resolves.toEqual(
        []
      );
      expect(
        fake.commands.calls.some((call) => call.args.includes("DELETE"))
      ).toBe(false);
      expect(
        fake.commands.calls.some((call) => call.args.includes("PATCH"))
      ).toBe(false);
    });

    it("deletes every leaked artifact and names what it reclaimed", async () => {
      const { fixture, fake } = await createHarness([
        {
          tool: "az",
          match: SP_LIST,
          respond: { stdout: '[{"id":"sp-1"}]' }
        },
        { tool: "az", match: ["ad", "sp", "delete"], respond: {} },
        {
          tool: "az",
          match: APP_LIST,
          respond: {
            stdout: JSON.stringify([
              { appId: "app-1", id: "obj-1", displayName: APP_NAME }
            ])
          }
        },
        { tool: "az", match: ["ad", "app", "delete"], respond: {} },
        {
          tool: "gh",
          match: ["api", ENVIRONMENT_PATH],
          respond: { stdout: "{}" }
        },
        {
          tool: "gh",
          match: ["api", MATCHING_REFS_PATH],
          respond: { stdout: '[{"ref":"refs/heads/radius/setup-a"}]' }
        },
        {
          tool: "gh",
          match: ["api", COMMITS_PATH],
          respond: { stdout: "d".repeat(40) }
        },
        {
          tool: "gh",
          match: ["api", PULLS_PATH],
          respond: {
            stdout: pullPages([
              {
                number: 7,
                title: "Add Radius workflows",
                head: { ref: "radius/setup-a" }
              }
            ])
          }
        },
        { tool: "gh", match: ["api", "--method", "DELETE"], respond: {} },
        { tool: "gh", match: ["api", "--method", "PATCH"], respond: {} }
      ]);

      await expect(fixture.reclaimLeakedProductArtifacts()).resolves.toEqual([
        "service principal sp-1",
        "app registration app-1",
        `GitHub environment ${ENVIRONMENT}`,
        "pull request #7",
        "branch radius/setup-a",
        `${BRANCH} reset to ${BASELINE}`
      ]);

      const lines = fake.commands.commandLines("gh");
      expect(lines).toContain(`api --method DELETE ${ENVIRONMENT_PATH}`);
      expect(lines).toContain(
        `api --method DELETE repos/${REPOSITORY}/git/refs/heads/radius/setup-a`
      );
      expect(lines).toContain(
        `api --method PATCH repos/${REPOSITORY}/pulls/7 -f state=closed`
      );
      expect(lines).toContain(
        `api --method PATCH ${DEFAULT_REF_PATH} -f sha=${BASELINE} -F force=true`
      );
      expect(
        lines.indexOf(
          `api --method PATCH repos/${REPOSITORY}/pulls/7 -f state=closed`
        )
      ).toBeLessThan(
        lines.indexOf(
          `api --method DELETE repos/${REPOSITORY}/git/refs/heads/radius/setup-a`
        )
      );
      // Service principals are removed explicitly so an orphan cannot survive
      // after its application is already gone.
      expect(fake.commands.commandLines("az")).toContain(
        "ad sp delete --id sp-1 --output none"
      );
      expect(fake.commands.commandLines("az")).toContain(
        "ad app delete --id obj-1 --output none"
      );
    });

    it("reclaims an orphaned service principal when no application remains", async () => {
      const { fixture, fake } = await createHarness([
        {
          tool: "az",
          match: SP_LIST,
          respond: { stdout: '[{"id":"orphan-sp"}]' }
        },
        { tool: "az", match: ["ad", "sp", "delete"], respond: {} }
      ]);

      await expect(fixture.reclaimLeakedProductArtifacts()).resolves.toEqual([
        "service principal orphan-sp"
      ]);
      expect(fake.commands.commandLines("az")).toContain(
        "ad sp delete --id orphan-sp --output none"
      );
    });

    it("closes an open pull request even when its branch is already gone", async () => {
      const { fixture, fake } = await createHarness([
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
        {
          tool: "gh",
          match: ["api", "--method", "PATCH", `repos/${REPOSITORY}/pulls/9`],
          respond: {}
        }
      ]);

      await expect(fixture.reclaimLeakedProductArtifacts()).resolves.toEqual([
        "pull request #9"
      ]);
      expect(fake.commands.commandLines("gh")).toContain(
        `api --method PATCH repos/${REPOSITORY}/pulls/9 -f state=closed`
      );
    });

    it("does not close an open pull request the product did not create", async () => {
      const { fixture, fake } = await createHarness([
        {
          tool: "gh",
          match: ["api", PULLS_PATH],
          respond: {
            stdout: pullPages([
              {
                number: 10,
                title: "Human change",
                head: { ref: "feature/human" }
              }
            ])
          }
        }
      ]);

      await expect(fixture.reclaimLeakedProductArtifacts()).resolves.toEqual(
        []
      );
      expect(
        fake.commands
          .commandLines("gh")
          .some((line) => line.includes("pulls/10"))
      ).toBe(false);
    });

    it("leaves a default branch already at the baseline alone", async () => {
      const { fixture, fake } = await createHarness();

      await fixture.reclaimLeakedProductArtifacts();
      expect(
        fake.commands.commandLines("gh").some((line) => line.includes("PATCH"))
      ).toBe(false);
    });

    it("continues past one stuck artifact and then reports every failure", async () => {
      const { fixture } = await createHarness([
        {
          tool: "az",
          match: APP_LIST,
          respond: {
            stdout: JSON.stringify([
              { appId: "app-1", id: "obj-1", displayName: APP_NAME },
              { appId: "app-2", id: "obj-2", displayName: APP_NAME }
            ])
          }
        },
        {
          tool: "az",
          match: ["ad", "app", "delete", "--id", "obj-1"],
          respond: { code: 3, stderr: "Insufficient privileges" }
        },
        { tool: "az", match: ["ad", "app", "delete"], respond: {} },
        {
          tool: "gh",
          match: ["api", MATCHING_REFS_PATH],
          respond: { stdout: '[{"ref":"refs/heads/radius/setup-a"}]' }
        },
        {
          tool: "gh",
          match: ["api", "--method", "DELETE"],
          respond: { code: 1, stderr: "Reference does not exist" }
        }
      ]);

      const error = await captureError(fixture.reclaimLeakedProductArtifacts());

      expect(error.message).toContain("app registration app-1");
      expect(error.message).toContain("Insufficient privileges");
      expect(error.message).toContain("branch radius/setup-a");
      expect(error.message).toContain("Reference does not exist");
      // The second application was still deleted despite the first failing.
      expect(error.message).toContain(
        "Reclaimed before failing: app registration app-2."
      );
    });

    it("records a failing app registration listing without abandoning the rest", async () => {
      const { fixture, fake } = await createHarness([
        failing("az", APP_LIST, "Graph unavailable"),
        {
          tool: "gh",
          match: ["api", MATCHING_REFS_PATH],
          respond: { stdout: '[{"ref":"refs/heads/radius/setup-a"}]' }
        },
        { tool: "gh", match: ["api", "--method", "DELETE"], respond: {} }
      ]);

      await expect(fixture.reclaimLeakedProductArtifacts()).rejects.toThrow(
        /list app registrations: .*Graph unavailable/
      );
      expect(fake.commands.commandLines("gh")).toContain(
        `api --method DELETE repos/${REPOSITORY}/git/refs/heads/radius/setup-a`
      );
    });

    it("records a failing service-principal listing without abandoning the rest", async () => {
      const { fixture, fake } = await createHarness([
        failing("az", SP_LIST, "Graph unavailable"),
        {
          tool: "gh",
          match: ["api", MATCHING_REFS_PATH],
          respond: { stdout: '[{"ref":"refs/heads/radius/setup-a"}]' }
        },
        { tool: "gh", match: ["api", "--method", "DELETE"], respond: {} }
      ]);

      await expect(fixture.reclaimLeakedProductArtifacts()).rejects.toThrow(
        /list service principals: .*Graph unavailable/
      );
      expect(fake.commands.commandLines("gh")).toContain(
        `api --method DELETE repos/${REPOSITORY}/git/refs/heads/radius/setup-a`
      );
    });

    it("records a stuck service principal and continues reclaiming applications", async () => {
      const { fixture } = await createHarness([
        {
          tool: "az",
          match: SP_LIST,
          respond: { stdout: '[{"id":"sp-1"}]' }
        },
        failing("az", ["ad", "sp", "delete"], "principal is locked"),
        {
          tool: "az",
          match: APP_LIST,
          respond: {
            stdout: JSON.stringify([
              { appId: "app-1", id: "obj-1", displayName: APP_NAME }
            ])
          }
        },
        { tool: "az", match: ["ad", "app", "delete"], respond: {} }
      ]);

      await expect(fixture.reclaimLeakedProductArtifacts()).rejects.toThrow(
        /service principal sp-1: .*principal is locked.*Reclaimed before failing: app registration app-1/s
      );
    });

    it("records an unreadable environment probe instead of silently skipping it", async () => {
      const { fixture } = await createHarness([
        {
          tool: "gh",
          match: ["api", ENVIRONMENT_PATH],
          respond: { code: 1, stderr: "HTTP 403: Forbidden" }
        }
      ]);

      await expect(fixture.reclaimLeakedProductArtifacts()).rejects.toThrow(
        /probe GitHub environment .* gh exited 1: HTTP 403: Forbidden/
      );
    });

    it("records an unreadable environment probe reported on stdout", async () => {
      const { fixture } = await createHarness([
        {
          tool: "gh",
          match: ["api", ENVIRONMENT_PATH],
          respond: { code: 1, stdout: '{"message":"Bad gateway"}' }
        }
      ]);

      await expect(fixture.reclaimLeakedProductArtifacts()).rejects.toThrow(
        /probe GitHub environment .* gh exited 1: \{"message":"Bad gateway"\}/
      );
    });

    it("records a failing branch listing", async () => {
      const { fixture } = await createHarness([
        failing("gh", ["api", MATCHING_REFS_PATH], "HTTP 500")
      ]);

      await expect(fixture.reclaimLeakedProductArtifacts()).rejects.toThrow(
        /list workflow fallback branches: .*HTTP 500/
      );
    });

    it("records a failing pull-request listing", async () => {
      const { fixture } = await createHarness([
        failing("gh", ["api", PULLS_PATH], "HTTP 500")
      ]);

      await expect(fixture.reclaimLeakedProductArtifacts()).rejects.toThrow(
        /list open pull requests: .*HTTP 500/
      );
    });

    it("records a failing pull-request close and continues cleanup", async () => {
      const { fixture } = await createHarness([
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
        {
          tool: "gh",
          match: ["api", "--method", "PATCH", `repos/${REPOSITORY}/pulls/9`],
          respond: { code: 1, stderr: "HTTP 403" }
        },
        {
          tool: "gh",
          match: ["api", COMMITS_PATH],
          respond: { stdout: "e".repeat(40) }
        },
        { tool: "gh", match: ["api", "--method", "PATCH"], respond: {} }
      ]);

      await expect(fixture.reclaimLeakedProductArtifacts()).rejects.toThrow(
        /pull request #9: .*HTTP 403.*Reclaimed before failing: main reset/s
      );
    });

    it("records a failing default branch read", async () => {
      const { fixture } = await createHarness([
        failing("gh", ["api", COMMITS_PATH], "HTTP 502")
      ]);

      await expect(fixture.reclaimLeakedProductArtifacts()).rejects.toThrow(
        new RegExp(`read ${BRANCH} head: .*HTTP 502`)
      );
    });

    it("records a failing environment deletion", async () => {
      const { fixture } = await createHarness([
        {
          tool: "gh",
          match: ["api", ENVIRONMENT_PATH],
          respond: { stdout: "{}" },
          times: 1
        },
        {
          tool: "gh",
          match: ["api", "--method", "DELETE"],
          respond: { code: 1, stderr: "HTTP 403" }
        }
      ]);

      await expect(fixture.reclaimLeakedProductArtifacts()).rejects.toThrow(
        new RegExp(`GitHub environment ${ENVIRONMENT}: .*HTTP 403`)
      );
    });

    it("records a failing default branch reset", async () => {
      const { fixture } = await createHarness([
        {
          tool: "gh",
          match: ["api", COMMITS_PATH],
          respond: { stdout: "e".repeat(40) }
        },
        {
          tool: "gh",
          match: ["api", "--method", "PATCH"],
          respond: { code: 1, stderr: "protected branch" }
        }
      ]);

      await expect(fixture.reclaimLeakedProductArtifacts()).rejects.toThrow(
        /main reset to .*: .*protected branch/
      );
    });
  });

  describe("dispose", () => {
    it("removes only what the fixture created, innermost first", async () => {
      const { fixture, fake } = await createHarness();
      const before = fake.commands.calls.length;

      await expect(fixture.dispose()).resolves.toBeUndefined();

      expect(fake.removed).toEqual([WORKSPACE]);
      expect(
        fake.commands.calls.slice(before).map((call) => call.args)
      ).toEqual([
        [
          "group",
          "delete",
          "--name",
          RESOURCE_GROUP,
          "--subscription",
          SUBSCRIPTION,
          "--yes",
          "--no-wait",
          "--output",
          "none"
        ]
      ]);
    });

    it("never deletes an artifact the product created", async () => {
      const { fixture, fake } = await createHarness();
      const before = fake.commands.calls.length;

      await fixture.dispose();

      const issued = fake.commands.calls
        .slice(before)
        .map((call) => `${call.tool} ${call.args.join(" ")}`);
      expect(issued.some((line) => line.includes("ad app delete"))).toBe(false);
      expect(issued.some((line) => line.includes("DELETE"))).toBe(false);
      expect(issued.some((line) => line.includes("PATCH"))).toBe(false);
    });

    it("is idempotent", async () => {
      const { fixture, fake } = await createHarness();

      await fixture.dispose();
      const after = fake.commands.calls.length;
      await expect(fixture.dispose()).resolves.toBeUndefined();

      expect(fake.commands.calls).toHaveLength(after);
      expect(fake.removed).toEqual([WORKSPACE]);
    });

    it("reports every teardown failure rather than only the first", async () => {
      const { fixture } = await createHarness(
        [failing("az", ["group", "delete"], "group is locked")],
        { removeDir: () => Promise.reject(new Error("EBUSY: directory busy")) }
      );

      const error = await captureError(fixture.dispose());

      expect(error.message).toContain(
        `Cloud fixture teardown for ${RESOURCE_GROUP} did not complete`
      );
      expect(error.message).toContain(`remove workspace ${WORKSPACE}`);
      expect(error.message).toContain("EBUSY: directory busy");
      expect(error.message).toContain(
        `delete resource group ${RESOURCE_GROUP}`
      );
      expect(error.message).toContain("group is locked");
    });

    it("does not retry a failed teardown on a second call", async () => {
      const { fixture, fake } = await createHarness([
        failing("az", ["group", "delete"], "group is locked")
      ]);

      await expect(fixture.dispose()).rejects.toThrow(/group is locked/);
      const after = fake.commands.calls.length;
      await expect(fixture.dispose()).resolves.toBeUndefined();
      expect(fake.commands.calls).toHaveLength(after);
    });

    it("stringifies a non-Error teardown rejection", async () => {
      const { fixture } = await createHarness([], {
        removeDir: () => Promise.reject("directory vanished")
      });

      await expect(fixture.dispose()).rejects.toThrow(/directory vanished/);
    });
  });
});
