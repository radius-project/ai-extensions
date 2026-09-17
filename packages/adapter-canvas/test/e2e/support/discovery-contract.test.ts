import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createLegacyDiscoveryReader } from "../../../src/server/services/discovery-reader.js";
import {
  defaultFakeCliScenario,
  fakeCliArgsMatch,
  REPOSITORY,
  WORKTREE_BRANCH
} from "./canvas-harness.js";

it("does not turn unmodeled discovery requests into successful fixture responses", () => {
  const scenario = defaultFakeCliScenario();
  for (const [method, path] of [
    ["POST", `/repos/${REPOSITORY}`],
    ["GET", "/repos/other/repo"],
    ["GET", `/repos/${REPOSITORY}/environments?per_page=100&page=2`],
    ["GET", `/repos/${REPOSITORY}/commits/unmodeled-branch`]
  ]) {
    const args = ["api", "--hostname", "github.com", "--method", method, path];
    expect(
      scenario.commands.find(
        (command) => command.tool === "gh" && fakeCliArgsMatch(command, args)
      )
    ).toBeUndefined();
  }
});

it.each(["radius-project/radius", "radius-project/ai-extensions"])(
  "models absent legacy workflow templates from %s without permitting publication",
  (repo) => {
    const scenario = defaultFakeCliScenario();
    for (const file of [
      "verify-azure.yml",
      "run-rad-commands.yml",
      "run-rad-commands-azure.yml",
      "delete-application.yml",
      "delete-azure.yml"
    ]) {
      const args = [
        "api",
        `/repos/${repo}/contents/.github/extension/${file}?ref=main`,
        "--jq",
        ".content"
      ];
      const matches = scenario.commands.filter(
        (command) => command.tool === "gh" && fakeCliArgsMatch(command, args)
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({
        exitCode: 1,
        stderr: expect.stringContaining("404")
      });
    }
  }
);

it.each(["ok", "variables-forbidden"] as const)(
  "models canonical %s reads through the browser's exact CLI scenario",
  async (mode) => {
    const root = await mkdtemp(resolve(".test-browser-discovery-"));
    const scenario = defaultFakeCliScenario();
    if (mode === "variables-forbidden") {
      const variables = scenario.commands.find(
        (command) =>
          command.args?.[5] ===
          `/repos/${REPOSITORY}/environments/fixture-environment/variables?per_page=100`
      );
      if (!variables) throw new Error("Canonical variables command missing");
      variables.exitCode = 1;
      variables.stdout = "";
      variables.stderr = "HTTP 403";
    }
    const unmatched: string[][] = [];
    let sequence = 0;
    const reader = createLegacyDiscoveryReader({
      storageRoot: join(root, "snapshots"),
      clock: { now: () => "2026-09-15T00:00:00Z" },
      ids: { next: () => `request-${++sequence}` },
      identity: async () => ({ actingLogin: "acting-user" }),
      workspace: async () => {
        throw new Error("Explicit Git read must not resolve a workspace");
      },
      git: async () => {
        throw new Error("Explicit Git read must not invoke Git");
      },
      executor: async (login) => ({
        login,
        run: async (args) => {
          const command = scenario.commands.find(
            (candidate) =>
              candidate.tool === "gh" && fakeCliArgsMatch(candidate, args)
          );
          if (!command) {
            unmatched.push(args);
            throw new Error(`Unmodeled command: ${args.join(" ")}`);
          }
          return {
            code: command.exitCode ?? 0,
            stdout: command.stdout ?? "",
            stderr: command.stderr ?? ""
          };
        }
      })
    });
    try {
      const opened = await reader.open(REPOSITORY, "browser");
      expect(unmatched).toEqual([]);
      if (opened.status !== "ok")
        throw new Error(`Reader failed: ${JSON.stringify(opened)}`);
      try {
        const applications = await opened.value.applications(WORKTREE_BRANCH);
        const environments = await opened.value.environments();
        expect(unmatched).toEqual([]);
        expect(applications).toMatchObject({
          status: "ok",
          value: { items: [{ target: { application: "radius-app" } }] }
        });
        if (mode === "variables-forbidden")
          expect(environments).toMatchObject({
            status: "ok",
            value: { entries: [], error: { code: "FORBIDDEN" } }
          });
        else
          expect(environments).toMatchObject({
            status: "ok",
            value: {
              entries: [
                {
                  inspection: {
                    target: { environment: "fixture-environment" },
                    configuration: { provider: "azure" }
                  },
                  metadata: { variables: { RADIUS_MANAGED: "true" } }
                }
              ]
            }
          });

        expect(
          await opened.value.run([
            "api",
            `/repos/${REPOSITORY}/actions/workflows/radius-verify-credentials.yml/runs?per_page=100`,
            "--jq",
            '.workflow_runs[] | (.id|tostring) + "\\t" + (.status // "") + "\\t" + (.conclusion // "")'
          ])
        ).toEqual({ ok: true, stdout: "" });
        expect(unmatched).toEqual([]);
      } finally {
        await opened.value.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
