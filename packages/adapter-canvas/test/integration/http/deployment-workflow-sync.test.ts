import * as childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createTestCanvasServerRuntime } from "../../support/server/production-runtime.js";
import { createEnvironmentExecutionOwner } from "../../../src/runtime/environment-execution-owner.js";
import { configureOperationStore } from "../../../src/operations.js";
import { disabledOperationStore } from "../../../src/operation-store.js";

const ghExecutable = process.platform === "win32" ? "gh.exe" : "gh";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  execFile: vi.fn()
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["template-unavailable", "update-denied"] as const)(
  "refuses production HTTP deployment with stale workflows and %s",
  async (failure) => {
    await configureOperationStore(disabledOperationStore());
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    const calls: string[][] = [];
    const writes: Array<{ branch: string; content: string }> = [];
    const unexpected: string[][] = [];
    vi.mocked(childProcess.execFile).mockImplementation(
      (file, args, _options, callback) => {
        if (!Array.isArray(args) || typeof callback !== "function")
          throw new Error("Unexpected process invocation shape.");
        const argv = args.map(String);
        calls.push([file, ...argv]);
        const child = new childProcess.ChildProcess();
        let input = "";
        child.stdin = new Writable({
          write(chunk, _encoding, done) {
            input += String(chunk);
            done();
          }
        });
        queueMicrotask(() => {
          let stdout = "";
          let stderr = "";
          const api = argv.find((arg) => arg.startsWith("/repos/"));
          if (file !== ghExecutable) {
            unexpected.push([file, ...argv]);
            stderr = "Unexpected non-GitHub command.";
          } else if (argv[0] === "workflow") {
            stderr =
              "Dispatch must not be reached after workflow update failure.";
          } else if (argv[0] === "run" && argv[1] === "list") {
            stdout = "[]";
          } else if (argv.includes("PUT")) {
            writes.push(JSON.parse(input));
            stderr = "HTTP 403: protected branch";
          } else if (
            api?.startsWith(
              "/repos/radius-project/ai-extensions/contents/.github/extension/"
            )
          ) {
            if (
              failure === "template-unavailable" &&
              api.includes("/run-rad-commands")
            ) {
              callback(
                Object.assign(new Error("HTTP 503: template unavailable"), {
                  code: 1
                }),
                "",
                "HTTP 503: template unavailable"
              );
              return;
            }
            const name = api.split("/").pop()?.split("?")[0];
            stdout = Buffer.from(
              readFileSync(
                new URL(
                  `../../../../../.github/extension/${name}`,
                  import.meta.url
                )
              )
            ).toString("base64");
          } else if (api === "/repos/fixture/app") {
            stdout = "main";
          } else if (api?.includes("/git/ref/heads/")) {
            stdout = "a".repeat(40);
          } else if (api?.includes("/contents/.github/workflows/")) {
            stdout =
              argv.includes(".sha") ?
                "b".repeat(40)
              : Buffer.from(
                  "name: stale\non: workflow_dispatch\njobs: {}\n"
                ).toString("base64");
          } else if (api?.includes("/contents/.radius/app.bicep")) {
            stdout = Buffer.from("param location string = 'westus'\n").toString(
              "base64"
            );
          } else if (
            api?.includes("/deployments?") ||
            api?.includes("/variables?")
          ) {
            stdout = "";
          } else {
            unexpected.push([file, ...argv]);
            stderr = "Unspecified external operation.";
          }
          callback(
            stderr ? Object.assign(new Error(stderr), { code: 1 }) : null,
            stdout,
            stderr
          );
        });
        return child;
      }
    );
    const owner = createEnvironmentExecutionOwner();
    const runtime = createTestCanvasServerRuntime({ executionOwner: owner });
    const entry = await runtime.getOrCreateServer("workflow-sync", "deploying");
    Object.assign(entry.state, {
      plannedResources: [{ id: "fixture", name: "fixture" }]
    });
    try {
      const response = await fetch(`${entry.baseUrl}/api/deploy`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: entry.baseUrl,
          "Sec-Fetch-Site": "same-origin",
          "X-Radius-Mutation-Nonce": String(entry.state.browserMutationNonce)
        },
        body: JSON.stringify({
          targetRepo: "fixture/app",
          environment: "Preview East",
          branch: "feature/model&review=1",
          provider: "aws"
        })
      });
      expect(response.status).toBe(200);
      await vi.waitFor(() => {
        expect(entry.state.deployStatus).toBe("failed");
        expect(entry.state.deploymentMutation).toBeUndefined();
      });
      expect(unexpected).toEqual([]);
      expect(writes.map(({ branch }) => branch)).toEqual(
        failure === "template-unavailable" ?
          []
        : ["main", "main", "feature/model&review=1", "feature/model&review=1"]
      );
      expect(entry.state.deployError).toContain(
        "Could not prepare deployment workflows"
      );
      expect(entry.state.deployDispatchEvidence).toBe("refused");
      const status = await fetch(`${entry.baseUrl}/api/deploy-status`);
      expect(status.status).toBe(200);
      const body = await status.json();
      expect(body).toMatchObject({
        status: "failed",
        error: expect.stringContaining("Could not prepare deployment workflows")
      });
      expect(body).not.toHaveProperty("generationFailures");
      expect(body).not.toHaveProperty("synchronized");
      expect(calls.filter(([, command]) => command === "workflow")).toEqual([]);
      expect(calls.some(([, command]) => command === "auth")).toBe(false);
      expect(
        calls.filter(([, , target]) =>
          target?.includes("/contents/.radius/app.bicep")
        )
      ).toEqual([
        [
          ghExecutable,
          "api",
          "/repos/fixture/app/contents/.radius/app.bicep?ref=feature/model&review=1",
          "--jq",
          ".content"
        ]
      ]);
    } finally {
      owner.shutdown();
      await runtime.stopServer("workflow-sync", true);
    }
  }
);
