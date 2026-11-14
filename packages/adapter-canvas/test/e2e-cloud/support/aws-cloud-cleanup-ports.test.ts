import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPLICATION_DELETE_TIMEOUT_MS,
  createAwsCleanupAccessRemoval,
  createGhCleanupGitHub,
  createKubectlCleanupKubernetes,
  ghJsonRunner,
  ghNamespaceClaims,
  httpStatus,
  runCommand,
  temporaryDirectory,
  type CommandResult
} from "./aws-cloud-cleanup-ports.js";

const REPO = "octo/fixture";
const OK = (value: unknown): CommandResult => ({
  code: 0,
  stdout: JSON.stringify(value),
  stderr: ""
});
const HTTP = (status: number): CommandResult => ({
  code: 1,
  stdout: "",
  stderr: `gh: Something (HTTP ${status})`
});

type Answer = CommandResult | ((args: readonly string[]) => CommandResult);

// A scripted `gh`: each rule answers the first call whose argv starts with
// its words, in order, and refuses anything it wasn't told about.
function scriptedGh(rules: Array<[string, Answer]>) {
  const calls: Array<{ args: string[]; packages: boolean }> = [];
  const gh = async (args: readonly string[], packages = false) => {
    calls.push({ args: [...args], packages });
    const line = args.join(" ");
    const index = rules.findIndex(([prefix]) => line.startsWith(prefix));
    if (index < 0) throw new Error(`unexpected gh ${line}`);
    const [, answer] = rules[index]!;
    return typeof answer === "function" ? answer(args) : answer;
  };
  return { gh, calls };
}

function github(rules: Array<[string, Answer]>, clock = { now: 0 }) {
  const scripted = scriptedGh(rules);
  return {
    ...scripted,
    clock,
    port: createGhCleanupGitHub({
      repository: REPO,
      defaultBranch: "main",
      gh: scripted.gh,
      sleep: async (milliseconds) => {
        clock.now += milliseconds;
      },
      now: () => clock.now
    })
  };
}

// Answers in turn, repeating the last one.
function sequence(...answers: CommandResult[]): () => CommandResult {
  let index = 0;
  return () => answers[Math.min(index++, answers.length - 1)]!;
}

describe("httpStatus", () => {
  it("reads the status gh reports, in either form", () => {
    expect(httpStatus(HTTP(404))).toBe(404);
    expect(
      httpStatus({ code: 1, stdout: "", stderr: "HTTP 422: Unprocessable" })
    ).toBe(422);
    expect(httpStatus({ code: 1, stdout: "", stderr: "timeout" })).toBeNull();
  });
});

describe("createGhCleanupGitHub", () => {
  it("lists environments, deployments, and packages through paginated gh api", async () => {
    const { port, calls } = github([
      [
        "api --paginate --slurp repos/octo/fixture/environments",
        OK([{ environments: [] }])
      ],
      ["api --paginate --slurp repos/octo/fixture/deployments", OK([[]])],
      ["api users/octo", OK({ type: "Organization" })],
      ["api --paginate --slurp orgs/octo/packages", OK([[]])]
    ]);
    expect(await port.listEnvironments()).toEqual([{ environments: [] }]);
    expect(await port.listDeployments()).toEqual([[]]);
    expect(await port.listPackages()).toEqual([[]]);
    expect(calls.map((call) => [call.args.at(-1), call.packages])).toEqual([
      ["repos/octo/fixture/environments?per_page=100", false],
      ["repos/octo/fixture/deployments?per_page=100", false],
      ["users/octo", true],
      ["orgs/octo/packages?package_type=container", true]
    ]);
  });

  it("uses a user account's package path for a fork owned by a person", async () => {
    const { port } = github([
      ["api users/octo", OK({ type: "User" })],
      ["api --paginate --slurp users/octo/packages", OK([[]])]
    ]);
    expect(await port.listPackages()).toEqual([[]]);
  });

  it("reports a failed read with its command", async () => {
    const { port } = github([["api", HTTP(401)]]);
    await expect(port.listEnvironments()).rejects.toThrow(
      "Listing environments in octo/fixture: gh: Something (HTTP 401)"
    );
    const bad = github([["api", { code: 0, stdout: "<html>", stderr: "" }]]);
    await expect(bad.port.listDeployments()).rejects.toThrow(
      "did not return JSON"
    );
  });

  it("reads every page of an environment's variables", async () => {
    const { port, calls } = github([
      [
        "api --paginate --slurp repos/octo/fixture/environments/radtest%2Faws/variables",
        OK([
          {
            variables: [
              { name: "A", value: "1" },
              { name: "B" },
              { value: "x" }
            ]
          },
          { variables: [{ name: "C", value: "3" }] }
        ])
      ]
    ]);
    expect(await port.readEnvironmentVariables("radtest/aws")).toEqual({
      A: "1",
      B: "",
      C: "3"
    });
    expect(calls).toHaveLength(1);
    const broken = github([["api", OK([{ total_count: 0 }])]]);
    await expect(broken.port.readEnvironmentVariables("e")).rejects.toThrow(
      "GitHub returned no variables list for e."
    );
  });

  it("dispatches delete-application.yml, finds its run, and waits for success", async () => {
    const runs = sequence(
      OK([{ databaseId: 1 }]),
      OK([{ databaseId: 1 }]),
      OK([{ databaseId: 1 }, { databaseId: 2 }])
    );
    const view = sequence(
      OK({ status: "in_progress", conclusion: "" }),
      OK({ status: "completed", conclusion: "success" })
    );
    const { port, calls, clock } = github([
      ["run list", runs],
      ["workflow run delete-application.yml", OK("")],
      ["run view 2", view]
    ]);
    await port.deleteApplication("radtest-aws-x", "cloud-e2e");
    expect(calls.find((call) => call.args[0] === "workflow")?.args).toEqual([
      "workflow",
      "run",
      "delete-application.yml",
      "--repo",
      REPO,
      "--ref",
      "main",
      "-f",
      "environment=radtest-aws-x",
      "-f",
      "application=cloud-e2e"
    ]);
    expect(clock.now).toBeGreaterThan(0);
  });

  it.each([
    [
      "the dispatch fails",
      [
        ["run list", OK([])],
        ["workflow run", HTTP(422)]
      ],
      "Could not dispatch delete-application.yml (gh: Something (HTTP 422)). Check that it exists on main."
    ],
    [
      "the run never appears",
      [
        ["run list", OK([])],
        ["workflow run", OK("")]
      ],
      "The delete-application.yml run never appeared."
    ],
    [
      "the run fails",
      [
        ["run list", sequence(OK([]), OK([{ databaseId: 5 }]))],
        ["workflow run", OK("")],
        ["run view 5", OK({ status: "completed", conclusion: "failure" })]
      ],
      "delete-application.yml run 5 ended failure."
    ],
    [
      "the run can't be read",
      [
        ["run list", sequence(OK([]), OK([{ databaseId: 5 }]))],
        ["workflow run", OK("")],
        ["run view 5", HTTP(500)]
      ],
      "Reading run 5: gh: Something (HTTP 500)"
    ],
    [
      "the runs can't be listed",
      [["run list", HTTP(403)]],
      "Listing delete-application.yml runs: gh: Something (HTTP 403)"
    ]
  ] as Array<[string, Array<[string, Answer]>, string]>)(
    "fails the app delete when %s",
    async (_case, rules, message) => {
      const { port } = github(rules);
      await expect(port.deleteApplication("e", "a")).rejects.toThrow(message);
    }
  );

  it("gives up on a run that outlives the app delete timeout", async () => {
    const { port, clock } = github([
      ["run list", sequence(OK([]), OK([{ databaseId: 5 }]))],
      ["workflow run", OK("")],
      ["run view 5", OK({ status: "queued" })]
    ]);
    await expect(port.deleteApplication("e", "a")).rejects.toThrow(
      "delete-application.yml run 5 did not finish in time."
    );
    expect(clock.now).toBeGreaterThanOrEqual(APPLICATION_DELETE_TIMEOUT_MS);
  });

  it("deactivates, deletes, and confirms a deployment record is gone", async () => {
    const { port, calls } = github([
      ["api --method POST repos/octo/fixture/deployments/9/statuses", OK({})],
      ["api --method DELETE repos/octo/fixture/deployments/9", OK("")],
      [
        "api repos/octo/fixture/deployments/9",
        sequence(OK({ id: 9 }), HTTP(404))
      ]
    ]);
    await port.deleteDeployment(9);
    expect(calls.map((call) => call.args.slice(0, 3).join(" "))).toEqual([
      "api --method POST",
      "api --method DELETE",
      "api repos/octo/fixture/deployments/9",
      "api repos/octo/fixture/deployments/9"
    ]);
    const gone = github([
      ["api --method POST", HTTP(404)],
      ["api --method DELETE", HTTP(404)],
      ["api repos", HTTP(404)]
    ]);
    await gone.port.deleteDeployment(9);
  });

  it.each([
    [
      [["api --method POST", HTTP(403)]],
      "Deactivating deployment 9: gh: Something (HTTP 403)"
    ],
    [
      [
        ["api --method POST", OK({})],
        ["api --method DELETE", HTTP(422)]
      ],
      "Deleting deployment 9: gh: Something (HTTP 422)"
    ],
    [
      [
        ["api --method", OK({})],
        ["api repos", HTTP(500)]
      ],
      "Checking that Deployment 9 is gone: gh: Something (HTTP 500)"
    ],
    [
      [
        ["api --method", OK({})],
        ["api repos", OK({ id: 9 })]
      ],
      "Deployment 9 is still there after it was deleted."
    ]
  ] as Array<[Array<[string, Answer]>, string]>)(
    "fails a deployment delete it can't finish (%#)",
    async (rules, message) => {
      await expect(github(rules).port.deleteDeployment(9)).rejects.toThrow(
        message
      );
    }
  );

  it("deletes only a private package linked to the fixture, and confirms it is gone", async () => {
    const path = "orgs/octo/packages/container/state-1";
    const { port, calls } = github([
      ["api users/octo", OK({ type: "Organization" })],
      [`api --method DELETE ${path}`, OK("")],
      [
        `api ${path}`,
        sequence(
          OK({
            visibility: "private",
            repository: { full_name: "Octo/Fixture" }
          }),
          HTTP(404)
        )
      ]
    ]);
    expect(await port.deletePackage("state-1")).toBe("deleted");
    expect(calls.every((call) => call.packages)).toBe(true);
    const absent = github([
      ["api users/octo", OK({ type: "Organization" })],
      ["api orgs", HTTP(404)]
    ]);
    expect(await absent.port.deletePackage("state-1")).toBe("absent");
  });

  it.each([
    [
      OK({ visibility: "public" }),
      "Refusing GHCR package p, whose visibility is public."
    ],
    [OK({}), "Refusing GHCR package p, whose visibility is unknown."],
    [
      OK({ visibility: "internal", repository: { full_name: "octo/other" } }),
      "Refusing GHCR package p, linked to octo/other."
    ],
    [HTTP(500), "Reading GHCR package p: gh: Something (HTTP 500)"]
  ])("refuses package %#", async (answer, message) => {
    const { port, calls } = github([
      ["api users/octo", OK({ type: "Organization" })],
      ["api orgs", answer]
    ]);
    await expect(port.deletePackage("p")).rejects.toThrow(message);
    expect(calls.some((call) => call.args.includes("DELETE"))).toBe(false);
  });

  it("fails a package delete GitHub refuses", async () => {
    const { port } = github([
      ["api users/octo", OK({ type: "Organization" })],
      ["api --method DELETE", HTTP(403)],
      ["api orgs", OK({ visibility: "private" })]
    ]);
    await expect(port.deletePackage("p")).rejects.toThrow(
      "Deleting GHCR package p: gh: Something (HTTP 403)"
    );
  });

  it("deletes an environment and confirms it is gone, accepting one already gone", async () => {
    const { port } = github([
      [
        "api --method DELETE repos/octo/fixture/environments/radtest-aws-x",
        HTTP(404)
      ],
      ["api repos/octo/fixture/environments/radtest-aws-x", HTTP(404)]
    ]);
    await port.deleteEnvironment("radtest-aws-x");
    const refused = github([["api --method DELETE", HTTP(403)]]);
    await expect(refused.port.deleteEnvironment("e")).rejects.toThrow(
      "Deleting GitHub environment e: gh: Something (HTTP 403)"
    );
  });
});

describe("createKubectlCleanupKubernetes", () => {
  const CLUSTER = { region: "us-east-2", name: "main" };

  function kubectl(answers: Record<string, CommandResult>) {
    const calls: string[][] = [];
    const port = createKubectlCleanupKubernetes({
      run: async (command, args) => {
        calls.push([command, ...args]);
        const answer =
          answers[
            `${command} ${args.find((arg) => !arg.startsWith("-") && !arg.includes("/tmp"))}`
          ];
        return answer ?? OK({});
      },
      directory: async () => "/tmp/kube"
    });
    return { port, calls };
  }

  it("signs in once per cluster and reads labelled workloads, including probe Jobs", async () => {
    const { port, calls } = kubectl({ "kubectl get": OK({ items: [] }) });
    expect(await port.listWorkloads(CLUSTER)).toEqual({ items: [] });
    await port.listWorkloads(CLUSTER);
    expect(calls[0]).toEqual([
      "aws",
      "eks",
      "update-kubeconfig",
      "--region",
      "us-east-2",
      "--name",
      "main",
      "--kubeconfig",
      "/tmp/kube/us-east-2-main.kubeconfig"
    ]);
    expect(calls.filter((call) => call[0] === "aws")).toHaveLength(1);
    expect(calls[1]).toEqual([
      "kubectl",
      "--kubeconfig",
      "/tmp/kube/us-east-2-main.kubeconfig",
      "get",
      "deployments,statefulsets,daemonsets,jobs,services,horizontalpodautoscalers",
      "--all-namespaces",
      "--selector",
      "radapp.io/environment",
      "--request-timeout=60s",
      "--output",
      "json"
    ]);
  });

  it("tries the sign-in again after it fails", async () => {
    let attempts = 0;
    const port = createKubectlCleanupKubernetes({
      run: async (command) => {
        if (command === "aws" && (attempts += 1) === 1) return HTTP(500);
        return OK({ items: [] });
      },
      directory: async () => "/tmp/kube"
    });
    await expect(port.listWorkloads(CLUSTER)).rejects.toThrow(
      "Could not sign in to cluster main"
    );
    expect(await port.listWorkloads(CLUSTER)).toEqual({ items: [] });
  });

  it("deletes a workload by kind and namespace, and a namespace without waiting", async () => {
    const { port, calls } = kubectl({});
    await port.deleteWorkload(CLUSTER, {
      kind: "Deployment",
      name: "web",
      namespace: "ns",
      environment: "e"
    });
    await port.deleteNamespace(CLUSTER, "ns");
    expect(calls.slice(1).map((call) => call.slice(3))).toEqual([
      [
        "delete",
        "deployment/web",
        "--namespace",
        "ns",
        "--ignore-not-found",
        "--request-timeout=60s"
      ],
      [
        "delete",
        "namespace",
        "ns",
        "--ignore-not-found",
        "--wait=false",
        "--request-timeout=60s"
      ]
    ]);
  });

  it("reads whether a namespace exists", async () => {
    const present = kubectl({
      "kubectl get": { code: 0, stdout: "namespace/ns\n", stderr: "" }
    });
    expect(await present.port.namespaceExists(CLUSTER, "ns")).toBe(true);
    const absent = kubectl({
      "kubectl get": { code: 0, stdout: "", stderr: "" }
    });
    expect(await absent.port.namespaceExists(CLUSTER, "ns")).toBe(false);
  });

  it.each([
    "listWorkloads",
    "namespaceExists",
    "deleteWorkload",
    "deleteNamespace"
  ] as const)("reports a kubectl failure from %s", async (method) => {
    const port = createKubectlCleanupKubernetes({
      run: async (command) => (command === "aws" ? OK({}) : HTTP(403)),
      directory: async () => "/tmp/kube"
    });
    const call =
      method === "deleteWorkload" ?
        port.deleteWorkload(CLUSTER, {
          kind: "Job",
          name: "j",
          namespace: "n",
          environment: "e"
        })
      : method === "listWorkloads" ? port.listWorkloads(CLUSTER)
      : port[method](CLUSTER, "ns");
    await expect(call).rejects.toThrow("HTTP 403");
  });
});

describe("ghJsonRunner", () => {
  it("reads a GitHub API path with the pinned API version", async () => {
    const { gh, calls } = scriptedGh([
      ["api repos/octo/fixture", OK({ id: 3 })]
    ]);
    expect(await ghJsonRunner(gh)("/repos/octo/fixture")).toEqual({
      ok: true,
      status: 200,
      json: { id: 3 },
      stderr: ""
    });
    expect(calls[0]?.args.slice(2)).toEqual([
      "-H",
      expect.stringMatching(/^X-GitHub-Api-Version: \d{4}-\d{2}-\d{2}$/)
    ]);
  });

  it("answers a failure with its status", async () => {
    const { gh } = scriptedGh([["api", HTTP(404)]]);
    expect(await ghJsonRunner(gh)("/repos/octo/gone")).toEqual({
      ok: false,
      status: 404,
      json: null,
      stderr: "gh: Something (HTTP 404)"
    });
  });
});

describe("ghNamespaceClaims", () => {
  it("reads the repository's environments through gh", async () => {
    const { gh } = scriptedGh([["api", OK({ environments: [] })]]);
    const claims = ghNamespaceClaims(gh);
    expect(await claims.listEnvironmentNames(REPO)).toMatchObject({ ok: true });
  });
});

describe("createAwsCleanupAccessRemoval", () => {
  it("refuses to remove anything when the repository's ID can't be read, and reads it again next time", async () => {
    let reads = 0;
    const remove = createAwsCleanupAccessRemoval({
      repository: REPO,
      runAws: async () => {
        throw new Error("no AWS call is expected");
      },
      runGitHubJson: async () => {
        reads += 1;
        return { ok: false, status: 500, json: null, stderr: "" };
      },
      environments: ghNamespaceClaims(scriptedGh([]).gh),
      sleep: async () => {},
      now: () => 0
    });
    const request = {
      environment: "e",
      roleArn: "arn:aws:iam::123456789012:role/r",
      region: "us-east-2",
      cluster: "c",
      trustSubjects: [],
      operationId: "op",
      waiting: async () => {},
      whileLocked: async () => {}
    };
    await expect(remove(request)).rejects.toThrow(
      "Could not read the ID of octo/fixture (HTTP 500)."
    );
    await expect(remove(request)).rejects.toThrow("Could not read the ID");
    expect(reads).toBe(2);
  });
});

describe("runCommand", () => {
  it("runs an argv without a shell and reports exit codes and spawn failures", async () => {
    const node = process.execPath;
    expect(
      await runCommand(node, [
        "-e",
        "process.stdout.write(process.argv[1])",
        "$(echo hi); rm -rf /"
      ])
    ).toEqual({ code: 0, stdout: "$(echo hi); rm -rf /", stderr: "" });
    expect(
      await runCommand(
        node,
        ["-e", "process.stderr.write(process.env.X); process.exit(3)"],
        {
          env: { X: "from env" }
        }
      )
    ).toEqual({ code: 3, stdout: "", stderr: "from env" });
    const missing = await runCommand("definitely-not-a-command-here", []);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("ENOENT");
  });
});

describe("temporaryDirectory", () => {
  it("makes one directory and reuses it", async () => {
    const directory = temporaryDirectory("aws-cleanup-test-");
    const first = await directory();
    try {
      expect(await directory()).toBe(first);
      expect(path.dirname(first)).toBe(path.resolve(tmpdir()));
      expect((await stat(first)).isDirectory()).toBe(true);
    } finally {
      await rm(first, { recursive: true, force: true });
    }
  });
});
