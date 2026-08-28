import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  buildRemediation,
  remediationSessionMessage
} from "@radius-project/core";
import type { RemediationSessionMessage } from "@radius-project/core";
import { createRequestContext } from "../request-context.js";
import {
  RUN_REMEDIATION_PATH,
  createRemediationRoutes,
  handleRunRemediation,
  productionRemediationDependencies,
  type RemediationDependencies,
  type SessionPromptOutcome
} from "./remediations.js";
import type { CanvasServerEntry } from "../types.js";

interface Recording {
  status: number;
  body: string;
  contentType: string;
}

function recorder() {
  const recording: Recording = { status: 0, body: "", contentType: "" };
  const target = {
    setHeader(name: string, value: string) {
      if (name === "Content-Type") recording.contentType = value;
      return this;
    },
    writeHead(status: number) {
      recording.status = status;
      return this;
    },
    end(value = "") {
      recording.body += value;
      return this;
    }
  };
  return {
    recording,
    response: target as unknown as ServerResponse<IncomingMessage>
  };
}

function request(body: string): IncomingMessage {
  return Object.assign(Readable.from(body ? [body] : []), {
    url: RUN_REMEDIATION_PATH,
    method: "POST",
    headers: {}
  }) as unknown as IncomingMessage;
}

const BRANCH = "feature/add-cache";
const LOGIN = "octocat";

interface FakeOptions {
  outcome?: SessionPromptOutcome;
  errorMessage?: (error: unknown) => string;
}

function fakeDependencies(options: FakeOptions = {}) {
  const sent: RemediationSessionMessage[] = [];
  const dependencies: RemediationDependencies = {
    buildRemediation,
    remediationSessionMessage,
    async runSessionPrompt(message) {
      sent.push(message);
      return options.outcome ?? { status: 200 };
    },
    errorMessage:
      options.errorMessage ??
      ((error) => (error instanceof Error ? error.message : String(error)))
  };
  return { dependencies, sent };
}

async function run(body: string, options: FakeOptions = {}) {
  const { recording, response } = recorder();
  const { dependencies, sent } = fakeDependencies(options);
  const incoming = request(body);
  const context = createRequestContext(
    incoming,
    response,
    "instance-1",
    new Map<string, CanvasServerEntry>()
  );
  await handleRunRemediation(context, dependencies);
  return {
    recording,
    sent,
    payload: JSON.parse(recording.body || "{}") as Record<string, unknown>
  };
}

describe("handleRunRemediation", () => {
  it("hands a low-impact remediation to the session without confirmation", async () => {
    const { recording, sent, payload } = await run(
      JSON.stringify({ id: "aws-cli-login" })
    );

    expect(recording.status).toBe(200);
    expect(recording.contentType).toBe("application/json");
    expect(payload.success).toBe(true);
    expect(payload.id).toBe("aws-cli-login");
    expect(payload.command).toBe("aws sso login");
    expect(payload.message).toContain("Asked Copilot to run `aws sso login`.");
    expect(sent).toHaveLength(1);
    expect(sent[0].prompt).toContain("aws sso login");
  });

  it("rebuilds the command from the registry and ignores client-supplied text", async () => {
    const { payload, sent } = await run(
      JSON.stringify({
        id: "aws-cli-login",
        command: "rm -rf /",
        displayCommand: "rm -rf /",
        argv: [["rm", "-rf", "/"]]
      })
    );

    expect(payload.command).toBe("aws sso login");
    expect(sent[0].prompt).not.toContain("rm -rf");
  });

  it("normalizes parameters into the rebuilt command", async () => {
    const { payload } = await run(
      JSON.stringify({
        id: "git-push-branch",
        params: { branch: BRANCH },
        confirmed: true
      })
    );

    expect(payload.command).toBe(`git push -u origin ${BRANCH}`);
  });

  it("reports the follow-up step alongside the hand-off", async () => {
    const { payload } = await run(JSON.stringify({ id: "azure-cli-login" }));

    expect(payload.message).toContain("Verify Credentials");
  });

  it.each([
    ["an unknown id", { id: "shutdown-the-cluster" }],
    ["a missing id", {}],
    ["a non-string id", { id: 7 }],
    [
      "an invalid parameter",
      { id: "azure-subscription-set", params: { subscriptionId: "not-a-guid" } }
    ],
    [
      "an unsafe branch",
      { id: "git-push-branch", params: { branch: "../evil" }, confirmed: true }
    ],
    [
      "an unsafe login",
      {
        id: "github-packages-scope",
        params: { login: "bad login" },
        confirmed: true
      }
    ]
  ])("answers 400 for %s", async (_label, body) => {
    const { recording, payload, sent } = await run(JSON.stringify(body));

    expect(recording.status).toBe(400);
    expect(payload.code).toBe("remediation-unavailable");
    expect(typeof payload.error).toBe("string");
    expect(payload.error).not.toBe("");
    expect(sent).toHaveLength(0);
  });

  it("answers 400 when the body is not JSON", async () => {
    const { recording, payload, sent } = await run("{ not json");

    expect(recording.status).toBe(400);
    expect(typeof payload.error).toBe("string");
    expect(payload.error).not.toBe("");
    expect(sent).toHaveLength(0);
  });

  it("falls back to a generic message when the parse error has no detail", async () => {
    const { recording, payload } = await run("{ not json", {
      errorMessage: () => ""
    });

    expect(recording.status).toBe(400);
    expect(payload.error).toBe("Bad request.");
  });

  it("treats an empty body as an empty object", async () => {
    const { recording, payload } = await run("");

    expect(recording.status).toBe(400);
    expect(payload.code).toBe("remediation-unavailable");
  });

  it.each([
    ["a JSON array", "[]"],
    ["a JSON string", '"aws-cli-login"'],
    ["JSON null", "null"]
  ])("rejects %s as a body", async (_label, body) => {
    const { recording, payload } = await run(body);

    expect(recording.status).toBe(400);
    expect(payload.code).toBe("remediation-unavailable");
  });

  it.each([
    ["git-push-branch", { branch: BRANCH }],
    ["github-packages-scope", { login: LOGIN }],
    ["github-workflow-scope", {}],
    ["github-cli-login", {}]
  ])(
    "refuses high-impact %s without an explicit confirmation",
    async (id, params) => {
      const { recording, payload, sent } = await run(
        JSON.stringify({ id, params })
      );

      const built = buildRemediation(id, params);
      if (!built.ok) throw new Error(`fixture ${id} must build`);

      expect(recording.status).toBe(409);
      expect(payload.code).toBe("confirmation-required");
      expect(payload.command).toBe(built.remediation.displayCommand);
      expect(payload.error).toContain("explicit confirmation");
      expect(sent).toHaveLength(0);
    }
  );

  it.each([
    ["false", false],
    ["a truthy string", "yes"],
    ["one", 1],
    ["absent", undefined]
  ])("treats confirmed=%s as unconfirmed", async (_label, confirmed) => {
    const { recording, sent } = await run(
      JSON.stringify({
        id: "git-push-branch",
        params: { branch: BRANCH },
        confirmed
      })
    );

    expect(recording.status).toBe(409);
    expect(sent).toHaveLength(0);
  });

  it("runs a high-impact remediation once confirmed", async () => {
    const { recording, payload, sent } = await run(
      JSON.stringify({
        id: "github-packages-scope",
        params: { login: LOGIN },
        confirmed: true
      })
    );

    expect(recording.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it.each([
    ["no session hook is registered", 503, "No Copilot session is available."],
    ["the session rejected the prompt", 502, "Session prompt failed."]
  ])("passes through the %s status", async (_label, status, error) => {
    const { recording, payload } = await run(
      JSON.stringify({ id: "aws-cli-login" }),
      { outcome: { status, error } }
    );

    expect(recording.status).toBe(status);
    expect(payload.error).toBe(error);
    expect(payload.success).toBeUndefined();
  });
});

describe("createRemediationRoutes", () => {
  it("registers exactly the declared POST route", () => {
    const { dependencies } = fakeDependencies();

    expect(Object.keys(createRemediationRoutes(dependencies))).toEqual([
      `POST ${RUN_REMEDIATION_PATH}`
    ]);
  });

  it("dispatches through the registered handler", async () => {
    const { recording, response } = recorder();
    const { dependencies, sent } = fakeDependencies();
    const routes = createRemediationRoutes(dependencies);
    const context = createRequestContext(
      request(JSON.stringify({ id: "aws-cli-login" })),
      response,
      "instance-1",
      new Map<string, CanvasServerEntry>()
    );

    await routes[`POST ${RUN_REMEDIATION_PATH}`](context);

    expect(recording.status).toBe(200);
    expect(sent).toHaveLength(1);
  });
});

describe("productionRemediationDependencies", () => {
  it("binds the core registry to the injected session seams", async () => {
    const sent: RemediationSessionMessage[] = [];
    const dependencies = productionRemediationDependencies({
      runSessionPrompt: async (message) => {
        sent.push(message);
        return { status: 200 };
      },
      errorMessage: () => "formatted"
    });

    const result = dependencies.buildRemediation("aws-cli-login", {});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a runnable remediation");
    expect(dependencies.remediationSessionMessage(result.remediation)).toEqual(
      remediationSessionMessage(result.remediation)
    );
    expect(
      await dependencies.runSessionPrompt({
        prompt: "p",
        displayPrompt: "d"
      })
    ).toEqual({ status: 200 });
    expect(sent).toHaveLength(1);
    expect(dependencies.errorMessage(new Error("boom"))).toBe("formatted");
  });
});
