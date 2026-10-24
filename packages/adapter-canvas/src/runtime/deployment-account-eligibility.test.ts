import { describe, expect, it, vi } from "vitest";
import { SelectedGhIdentityError } from "../gh.js";
import { successfulSelectedGhExecutor } from "../../test/support/server/selected-gh.js";
import { createGitHubAccountCoordinator } from "../server/services/github-account-coordinator.js";
import { createDeploymentAccountEligibility } from "./deployment-account-eligibility.js";
import { createDeploymentAccountResolver } from "./deployment-account.js";

const target = { repo: "fixture/app", environment: "dev" };
const probes = [
  "repos/fixture/app/contents",
  "repos/fixture/app/actions/workflows?per_page=1",
  "repos/fixture/app/environments?per_page=1",
  "repos/fixture/app/deployments?per_page=1"
];
const probeValues = [[], { workflows: [] }, { environments: [] }, []];

function fixture(
  options: {
    login?: string;
    repository?: unknown;
    failPath?: string;
    code?: number;
    stderr?: string;
    stdout?: string;
    thrown?: unknown;
  } = {}
) {
  const login = options.login ?? "writer";
  const run = vi.fn(async (args: string[]) => {
    if (args[0] !== "api") throw new Error("Unexpected non-read command");
    const path = args[1];
    if (path === options.failPath)
      return {
        code: options.code ?? 1,
        stdout: options.stdout ?? "",
        stderr: options.stderr ?? ""
      };
    if (path === "repos/fixture/app")
      return {
        code: 0,
        stdout: JSON.stringify(
          options.repository ?? { permissions: { push: true, admin: false } }
        ),
        stderr: ""
      };
    const index = probes.indexOf(path);
    if (index < 0) throw new Error(`Unexpected probe: ${path}`);
    return { code: 0, stdout: JSON.stringify(probeValues[index]), stderr: "" };
  });
  const executor = successfulSelectedGhExecutor({
    login,
    scopes: [],
    run,
    credentialSource: login.endsWith("[bot]") ? "injected" : "keyring"
  });
  const keyring = vi.fn(async (): Promise<never> => {
    throw new Error("No keyring use permitted");
  });
  const coordinator = createGitHubAccountCoordinator({
    createExecutor: async () => {
      if ("thrown" in options) throw options.thrown;
      return executor;
    },
    getActiveKeyringLogin: keyring,
    switchKeyringAccount: keyring,
    resetIdentityCache: () => {}
  });
  const check = createDeploymentAccountEligibility({
    createExecutor: (selected) => coordinator.createReadOnlyExecutor(selected),
    redactDiagnostic: (value) =>
      value.replaceAll("private-host-value", "[REDACTED]")
  });
  return { check, run, executor, keyring };
}

describe("deployment-only account eligibility", () => {
  it.each([
    { permissions: { push: true, admin: false } },
    { permissions: { admin: true } }
  ])(
    "accepts positive writer/admin evidence without scopes or setup probes: %j",
    async (repository) => {
      const f = fixture({ repository });
      expect(await f.check("writer", target)).toEqual({ state: "eligible" });
      expect(f.run).toHaveBeenCalledExactlyOnceWith(
        ["api", "repos/fixture/app"],
        { timeout: 15000 }
      );
      expect(f.keyring).not.toHaveBeenCalled();
    }
  );

  it.each([
    [{ permissions: { push: false } }, "ineligible"],
    [{}, "unavailable"],
    [{ permissions: {} }, "unavailable"],
    [{ permissions: { push: "true" } }, "unavailable"],
    [{ permissions: [] }, "unavailable"],
    [[], "unavailable"],
    ["not an object", "unavailable"]
  ])("fails closed for repository evidence %j", async (repository, state) => {
    expect(await fixture({ repository }).check("writer", target)).toMatchObject(
      { state }
    );
  });

  it.each([
    ["HTTP 401: Bad credentials", "ineligible"],
    ["HTTP 403: Resource not accessible by integration", "ineligible"],
    ["HTTP 404: Not Found", "ineligible"],
    ["HTTP 500: Server failure", "unavailable"],
    ["request timed out", "unavailable"],
    ["spawn gh ENOENT", "unavailable"],
    ["unclassified failure", "unavailable"]
  ])("classifies repository API refusal %s", async (stderr, state) => {
    const f = fixture({ failPath: "repos/fixture/app", stderr });
    expect(await f.check("writer", target)).toMatchObject({ state });
    expect(f.run).toHaveBeenCalledOnce();
  });

  it("does not accept malformed successful JSON", async () => {
    expect(
      await fixture({
        failPath: "repos/fixture/app",
        code: 0,
        stdout: "{"
      }).check("writer", target)
    ).toMatchObject({
      state: "unavailable",
      message: expect.stringContaining("invalid JSON")
    });
  });

  it.each([
    [new SelectedGhIdentityError("wrong credential", true), "ineligible"],
    [
      new SelectedGhIdentityError("identity transport unavailable", false),
      "unavailable"
    ],
    [new Error("arbitrary failure HTTP 403"), "unavailable"],
    ["private-host-value", "unavailable"]
  ])(
    "uses typed identity evidence, not arbitrary exception text: %j",
    async (thrown, state) => {
      const f = fixture({ thrown });
      const result = await f.check("writer", target);
      expect(result).toMatchObject({ state });
      expect(JSON.stringify(result)).not.toContain("private-host-value");
      expect(f.run).not.toHaveBeenCalled();
    }
  );

  it("rejects an executor for the wrong login", async () => {
    expect(await fixture().check("other", target)).toMatchObject({
      state: "ineligible"
    });
  });

  it("bounds and redacts account-specific diagnostics", async () => {
    const result = await fixture({
      failPath: "repos/fixture/app",
      stderr:
        "HTTP 403: private-host-value client_secret=fixture-value\n" +
        "x".repeat(5000)
    }).check("writer", target);
    if (result.state === "eligible") throw new Error("Expected denial");
    expect(result.message).toHaveLength(4000);
    expect(result.message).not.toMatch(/private-host-value|fixture-value/);
  });

  it("accepts an installation without user permissions/scopes only after deployment read probes", async () => {
    const f = fixture({ login: "fixture[bot]", repository: {} });
    expect(await f.check("fixture[bot]", target)).toEqual({
      state: "eligible"
    });
    expect(f.run.mock.calls.map(([args]) => args[1])).toEqual([
      "repos/fixture/app",
      ...probes
    ]);
    expect(f.keyring).not.toHaveBeenCalled();
  });

  it.each(probes)(
    "stops on installation read denial at %s",
    async (failPath) => {
      const f = fixture({
        login: "fixture[bot]",
        repository: {},
        failPath,
        stderr: "HTTP 403: Resource not accessible by integration"
      });
      expect(await f.check("fixture[bot]", target)).toMatchObject({
        state: "ineligible"
      });
      expect(f.run.mock.calls.at(-1)?.[0][1]).toBe(failPath);
    }
  );

  it.each(probes)(
    "rejects malformed installation evidence at %s",
    async (failPath) => {
      const f = fixture({
        login: "fixture[bot]",
        repository: {},
        failPath,
        code: 0,
        stdout: "null"
      });
      expect(await f.check("fixture[bot]", target)).toMatchObject({
        state: "unavailable"
      });
    }
  );

  it.each([
    ["HTTP 404: Not Found", "selected"],
    ["request timed out", "unavailable"]
  ])(
    "discovery continues only after account-specific refusal (%s)",
    async (stderr, state) => {
      const first = fixture({
        login: "first",
        failPath: "repos/fixture/app",
        stderr
      });
      const second = fixture();
      const check = vi.fn(async (login: string) =>
        (login === "first" ? first : second).check(login, target)
      );
      const resolver = createDeploymentAccountResolver({
        readIdentity: async () => ({
          accounts: ["first", "writer"].map((login) => ({
            login,
            hasWorkflow: false,
            hasPackages: false,
            switchable: true,
            acting: false
          }))
        }),
        check,
        createExecutor: async () => second.executor,
        redactDiagnostic: (value) => value
      });
      expect(await resolver({ target, isCurrent: () => true })).toMatchObject({
        state
      });
      expect(second.run).toHaveBeenCalledTimes(state === "selected" ? 2 : 0);
      check.mockClear();
      expect(
        await resolver({ target, savedLogin: "first", isCurrent: () => true })
      ).toMatchObject({
        state: state === "selected" ? "reauthorization-required" : "unavailable"
      });
      expect(check).toHaveBeenCalledOnce();
    }
  );
});
