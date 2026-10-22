import { describe, expect, it, vi } from "vitest";
import { createDeploymentAccountResolver } from "../../../src/runtime/deployment-account.js";
import { bindDeploymentExecutor } from "../../../src/runtime/deployment-executor.js";
import { githubAccountChoice } from "../../../src/runtime/github-account-choice.js";
import { createGitHubAccountCoordinator } from "../../../src/server/services/github-account-coordinator.js";
import { createGitHubAccountReadinessService } from "../../../src/server/services/github-account-readiness.js";
import { writeSelectedRepositoryFile } from "../../../src/selected-repository-write.js";
import { successfulSelectedGhExecutor } from "../../support/server/selected-gh.js";
import type { SelectedGhExecutor } from "../../../src/gh.js";

const TARGET = { repo: "fixture/app", environment: "dev" };

function fixture() {
  let activeLogin = "original";
  let current = true;
  const scopes = new Map([
    ["injected", ["repo", "workflow", "write:packages"]],
    ["stored", ["repo", "workflow", "write:packages"]]
  ]);
  const commands: { login: string; args: string[]; stdin?: string }[] = [];
  const createExecutor = vi.fn(async (login: string) => {
    const accountScopes = scopes.get(login);
    if (!accountScopes) throw new Error(`Account ${login} is unavailable.`);
    const run: SelectedGhExecutor["run"] = async (args, options) => {
      commands.push({ login, args, stdin: options?.stdin });
      if (args[0] !== "api") throw new Error("Unexpected command");
      if (args[1] === `repos/${TARGET.repo}`)
        return {
          code: 0,
          stdout: JSON.stringify({ permissions: { admin: true } }),
          stderr: ""
        };
      if (
        args[1] ===
        "/repos/fixture/app/contents/app.bicep?ref=feature%2Fmodel%26review%3D1"
      )
        return { code: 1, stdout: "", stderr: "HTTP 404" };
      if (
        args.join(" ") ===
        "api --method PUT /repos/fixture/app/contents/app.bicep --input -"
      )
        return { code: 0, stdout: "{}", stderr: "" };
      throw new Error(`Unexpected API request: ${args.join(" ")}`);
    };
    return successfulSelectedGhExecutor({
      login,
      scopes: accountScopes,
      credentialSource: login === "injected" ? "injected" : "keyring",
      requiresKeyringSwitch: login !== "injected",
      run
    });
  });
  const switchAccount = vi.fn(async (login: string) => {
    activeLogin = login;
    return { ok: true };
  });
  const coordinator = createGitHubAccountCoordinator({
    createExecutor,
    getActiveKeyringLogin: async () => activeLogin,
    switchKeyringAccount: switchAccount,
    resetIdentityCache: () => {}
  });
  const probePackageAccess = vi.fn(async () => ({
    ok: true,
    detail: "Synthetic package access verified."
  }));
  const readiness = createGitHubAccountReadinessService(coordinator, {
    ownerKey: "fixture-runtime",
    ports: { probePackageAccess }
  });
  const select = vi.fn(async (): Promise<string | null> => "stored");
  const readIdentity = vi.fn(async () => ({
    accounts: [...scopes.keys()].map((login) => ({
      login,
      hasWorkflow: true,
      hasPackages: true,
      switchable: true,
      acting: login === "injected"
    }))
  }));
  const resolve = createDeploymentAccountResolver({
    readIdentity,
    readiness,
    createExecutor: (login) => coordinator.createReadOnlyExecutor(login),
    choose: githubAccountChoice({
      capabilities: { ui: { elicitation: true } },
      ui: { select }
    }),
    redactDiagnostic: (value) =>
      value.replaceAll("private-fixture-detail", "[REDACTED]")
  });
  return {
    resolve,
    scopes,
    readIdentity,
    createExecutor,
    select,
    switchAccount,
    probePackageAccess,
    commands,
    activeLogin: () => activeLogin,
    isCurrent: () => current,
    stop: () => {
      current = false;
    }
  };
}

describe("account and repository prerequisite composition", () => {
  it("rechecks the host choice, restores the keyring, and writes only with the chosen executor and exact branch", async () => {
    const f = fixture();
    const selected = await f.resolve({
      target: TARGET,
      isCurrent: f.isCurrent
    });
    expect(selected.state).toBe("selected");
    if (selected.state !== "selected") throw new Error("Expected selection");
    expect(selected.login).toBe("stored");
    expect(f.select).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("fixture/app, environment dev"),
      ["injected", "stored"]
    );
    expect(f.switchAccount.mock.calls).toEqual([
      ["stored"],
      ["original"],
      ["stored"],
      ["original"]
    ]);
    expect(f.activeLogin()).toBe("original");

    const executor = bindDeploymentExecutor(selected.executor, f.isCurrent);
    await expect(
      writeSelectedRepositoryFile(executor, {
        ...TARGET,
        path: "app.bicep",
        branch: "feature/model&review=1",
        content: "synthetic model",
        message: "Update model"
      })
    ).resolves.toBe(true);
    const writes = f.commands.filter(({ stdin }) => stdin !== undefined);
    expect(writes).toHaveLength(1);
    expect(writes[0].login).toBe("stored");
    expect(JSON.parse(writes[0].stdin || "")).toMatchObject({
      branch: "feature/model&review=1"
    });
    f.stop();
    await expect(
      executor.run(["api", "repos/fixture/app"])
    ).rejects.toMatchObject({
      reason: "cancelled"
    });
    expect(f.commands.at(-1)).toBe(writes[0]);
  });

  it("excludes an injected identity missing workflow scope rather than bypassing readiness", async () => {
    const f = fixture();
    f.scopes.set("injected", ["repo", "write:packages"]);
    expect(
      await f.resolve({ target: TARGET, isCurrent: f.isCurrent })
    ).toMatchObject({ state: "selected", login: "stored" });
    expect(f.select).not.toHaveBeenCalled();
    expect(f.probePackageAccess).toHaveBeenCalledTimes(2);
    expect(f.activeLogin()).toBe("original");
  });

  it("refuses a missing saved account without discovering, choosing, or writing with a replacement", async () => {
    const f = fixture();
    expect(
      await f.resolve({
        target: TARGET,
        savedLogin: "missing",
        isCurrent: f.isCurrent
      })
    ).toMatchObject({
      state: "unavailable",
      message: expect.stringContaining("Account missing is unavailable")
    });
    expect(f.readIdentity).not.toHaveBeenCalled();
    expect(f.select).not.toHaveBeenCalled();
    expect(f.createExecutor).toHaveBeenCalledExactlyOnceWith("missing");
    expect(f.commands).toEqual([]);
  });

  it.each(["stale", "callback-failure"] as const)(
    "does not acquire a work executor after %s in the host dialog",
    async (boundary) => {
      const f = fixture();
      f.select.mockImplementation(async () => {
        if (boundary === "callback-failure")
          throw new Error("private-fixture-detail");
        f.stop();
        return "stored";
      });
      const result = await f.resolve({
        target: TARGET,
        isCurrent: f.isCurrent
      });
      expect(result).toEqual(
        boundary === "stale" ?
          { state: "stopped" }
        : { state: "unavailable", message: "[REDACTED]" }
      );
      expect(f.createExecutor.mock.calls).toEqual([["injected"], ["stored"]]);
      expect(f.activeLogin()).toBe("original");
      expect(f.commands.every(({ stdin }) => stdin === undefined)).toBe(true);
    }
  );
});
