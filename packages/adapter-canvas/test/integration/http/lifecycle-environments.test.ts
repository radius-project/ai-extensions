import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { remediationView } from "@radius-project/core";
import { readObject } from "@radius-project/adapter-shared";
import { createRequestContext } from "../../../src/server/request-context.js";
import { handleVerifyAzureLogin } from "../../../src/server/routes/identity-auth.js";
import { parseOperationResponse } from "../../../src/browser/environment/operations.js";
import { createEnvironmentHttpFixture } from "../../support/lifecycle-environment-http.js";

async function acceptance(response: Response) {
  expect(response.status).toBe(202);
  const value: unknown = await response.json();
  if (
    !readObject(value) ||
    typeof value.operationId !== "string" ||
    typeof value.statusUrl !== "string"
  )
    throw new Error("Invalid operation acceptance.");
  return { operationId: value.operationId, statusUrl: value.statusUrl };
}
async function operation(response: Response) {
  const value = parseOperationResponse(await response.json());
  if (!value) throw new Error("Missing operation view.");
  return value;
}
async function action(response: Response) {
  const value = (await operation(response)).actions[0];
  if (!value) throw new Error("Missing outstanding configuration action.");
  return value;
}

it("keeps legacy Azure inspection read-only across a real HTTP request", async () => {
  const subscriptionId = "33333333-3333-3333-3333-333333333333";
  const tenantId = "11111111-1111-1111-1111-111111111111";
  const calls: string[][] = [];
  const authenticate = vi.fn(async (): Promise<never> => {
    throw new Error("Inspection must not authenticate");
  });
  const server = createServer((request, response) => {
    void handleVerifyAzureLogin(
      createRequestContext(request, response, "panel", new Map()),
      {
        azureCredentialIdValidationError: () => "",
        azureLoginRequiredResponse: ({ tenantId: tenant }) => ({
          error: "Authentication required.",
          code: "az-login-required",
          tenantId: tenant,
          remediation: remediationView("azure-cli-login", { tenantId: tenant })
        }),
        isCliCommandMissing: () => false,
        isUuid: () => true,
        buildAzureCliAssistMessage: () => {
          throw new Error("Inspection must not create a prompt");
        },
        runSessionPrompt: authenticate,
        runCommand: async (command, args) => {
          calls.push([command, ...args]);
          if (command !== "az") throw new Error("Unexpected external command");
          return JSON.stringify({
            tenantId,
            id: subscriptionId,
            name: "Fixture Subscription",
            user: { name: "fixture-user" }
          });
        },
        errorMessage: () => "Controlled failure."
      }
    ).catch(() => {
      response.statusCode = 500;
      response.end("Unexpected handler failure.");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing HTTP address");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/verify-azure-login`,
      { method: "POST", body: JSON.stringify({ tenantId, subscriptionId }) }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toMatchObject({
      success: true,
      tenantId,
      subscriptionId
    });
    expect(calls).toEqual([
      ["az", "account", "show", "--subscription", subscriptionId, "-o", "json"]
    ]);
    expect(authenticate).not.toHaveBeenCalled();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

it("reports an unavailable canonical host instead of starting legacy setup", async () => {
  const fixture = await createEnvironmentHttpFixture("azure", {
    lifecycleAvailable: false
  });
  try {
    const before = [...fixture.state.calls];
    const response = await fixture.post("/api/operations", {
      ...fixture.target,
      configuration: fixture.configuration
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE"
    });
    expect(fixture.state.calls).toEqual(before);
  } finally {
    await fixture.close();
  }
});

it("does not hide legacy setup controls when a canonical operation also exists", async () => {
  const fixture = await createEnvironmentHttpFixture();
  try {
    const accepted = await acceptance(
      await fixture.post("/api/operations", {
        ...fixture.target,
        configuration: fixture.configuration
      })
    );
    fixture.state.legacyOperations.push({
      operationId: "legacy",
      family: "environment",
      owner: "legacy",
      needsControl: true
    });
    const before = [...fixture.state.calls];
    const latest = await fetch(
      `${fixture.url}/api/operations?repo=${fixture.target.repo}`
    );
    expect(latest.status).toBe(200);
    expect(await latest.json()).toEqual({ operation: null });
    expect(
      (await operation(await fetch(`${fixture.url}${accepted.statusUrl}`)))
        .operationId
    ).toBe(accepted.operationId);
    expect(fixture.state.calls).toEqual(before);
  } finally {
    await fixture.close();
  }
});

it("does not consume a configuration action when continuation JSON is malformed", async () => {
  const fixture = await createEnvironmentHttpFixture();
  try {
    const accepted = await acceptance(
      await fixture.post("/api/operations", {
        ...fixture.target,
        configuration: fixture.configuration
      })
    );
    const required = await action(
      await fetch(`${fixture.url}${accepted.statusUrl}`)
    );
    const response = await fetch(`${fixture.url}${required.path}`, {
      method: "POST",
      headers: fixture.headers,
      body: "{"
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid-json" });
    expect(fixture.state.exists).toBe(false);
    expect(
      (
        await fixture.post(required.path, {
          actionId: required.id,
          choice: "continue"
        })
      ).status
    ).toBe(202);
  } finally {
    await fixture.close();
  }
});

it("keeps selected identity intent and untrusted approval claims explicit across HTTP", async () => {
  const fixture = await createEnvironmentHttpFixture();
  try {
    const identity = await acceptance(
      await fixture.post("/api/operations", {
        repo: fixture.target.repo,
        provider: "azure",
        credentialIntent: "select_identity",
        identityRef: fixture.identityRef
      })
    );
    const identityAction = await action(
      await fetch(`${fixture.url}${identity.statusUrl}`)
    );
    expect(
      (
        await fixture.post(identityAction.path, {
          actionId: identityAction.id,
          choice: "continue"
        })
      ).status
    ).toBe(202);
    expect(fixture.state.exists).toBe(false);
    const environment = await acceptance(
      await fixture.post("/api/operations", {
        ...fixture.target,
        configuration: fixture.configuration,
        approvalRef: "requested-approval"
      })
    );
    const environmentAction = await action(
      await fetch(`${fixture.url}${environment.statusUrl}`)
    );
    const before = [...fixture.state.calls];
    expect(
      (
        await fixture.post(environmentAction.path, {
          actionId: environmentAction.id,
          choice: "continue",
          approvalRef: "untrusted-claim"
        })
      ).status
    ).toBe(403);
    expect(fixture.state.calls).toEqual(before);
    expect(fixture.state.exists).toBe(false);
  } finally {
    await fixture.close();
  }
});

it.each(["azure", "aws"] as const)(
  "creates and configures %s through the owning HTTP routes without deploying",
  async (provider) => {
    const fixture = await createEnvironmentHttpFixture(provider);
    try {
      const started = await fixture.post("/api/operations", {
        ...fixture.target,
        configuration: fixture.configuration
      });
      const accepted = await acceptance(started);
      expect(started.headers.get("location")).toBe(accepted.statusUrl);
      const pending = await fetch(`${fixture.url}${accepted.statusUrl}`);
      expect(pending.headers.get("cache-control")).toBe("no-store");
      const required = await action(pending);
      expect(fixture.state.exists).toBe(false);
      const completed = await fixture.post(required.path, {
        actionId: required.id,
        choice: "continue"
      });
      expect(completed.status).toBe(202);
      expect(await completed.json()).toMatchObject({
        operation: {
          state: "succeeded",
          summary: expect.stringContaining("No application deployment")
        }
      });
      const mutations = [...fixture.state.calls];
      for (let read = 0; read < 100; read++) {
        expect(
          await (await fetch(`${fixture.url}${accepted.statusUrl}`)).json()
        ).toMatchObject({ operation: { state: "succeeded" } });
      }
      expect(fixture.state.calls).toEqual(mutations);
      const patch =
        provider === "azure" ?
          { provider, settings: { location: "eastus" } }
        : { provider, settings: { region: "us-west-2" } };
      fixture.state.variables.set("KUBERNETES_NAMESPACE", "retained-namespace");
      const change = await acceptance(
        await fixture.post("/api/operations", { ...fixture.target, patch })
      );
      const next = await action(
        await fetch(`${fixture.url}${change.statusUrl}`)
      );
      expect(
        (
          await fixture.post(next.path, {
            actionId: next.id,
            choice: "continue"
          })
        ).status
      ).toBe(202);
      expect(
        fixture.state.variables.get(
          provider === "azure" ? "AZURE_LOCATION" : "AWS_REGION"
        )
      ).toBe(provider === "azure" ? "eastus" : "us-west-2");
      expect(fixture.state.variables.get("KUBERNETES_NAMESPACE")).toBe(
        "retained-namespace"
      );
      expect(fixture.state.protections).toEqual({
        requiredReviewers: true,
        waitTimerMinutes: 5,
        branchPolicy: "protected"
      });
    } finally {
      await fixture.close();
    }
  }
);
it("resumes the same outstanding action after a fresh page/status request and rejects duplicate responses", async () => {
  const fixture = await createEnvironmentHttpFixture();
  try {
    const accepted = await acceptance(
      await fixture.post("/api/operations", {
        ...fixture.target,
        configuration: fixture.configuration
      })
    );
    const resumed = await operation(
      await fetch(`${fixture.url}/api/operations?repo=owner%2Frepo`)
    );
    expect(resumed.operationId).toBe(accepted.operationId);
    const required = resumed.actions[0];
    const responses = await Promise.all([
      fixture.post(required.path, {
        actionId: required.id,
        choice: "continue"
      }),
      fixture.post(required.path, { actionId: required.id, choice: "continue" })
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      202, 409
    ]);
    expect(
      fixture.state.calls.filter((call) => call === "github.ensure")
    ).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});
it("surfaces partial publishing failure without losing the created environment", async () => {
  const fixture = await createEnvironmentHttpFixture();
  try {
    fixture.state.failure = "workflows";
    const accepted = await acceptance(
      await fixture.post("/api/operations", {
        ...fixture.target,
        configuration: fixture.configuration
      })
    );
    const required = await action(
      await fetch(`${fixture.url}${accepted.statusUrl}`)
    );
    const completed = await fixture.post(required.path, {
      actionId: required.id,
      choice: "continue"
    });
    expect(await completed.json()).toMatchObject({
      operation: {
        state: "failed_partial",
        stages: expect.arrayContaining([
          expect.objectContaining({ key: "environment", state: "succeeded" }),
          expect.objectContaining({ key: "workflows", state: "failed" })
        ])
      }
    });
    expect(fixture.state.exists).toBe(true);
    expect(fixture.state.calls).not.toContain("recipes");
  } finally {
    await fixture.close();
  }
});
it("configures credentials only after explicit continuation and verifies them through the actual adapter", async () => {
  const fixture = await createEnvironmentHttpFixture();
  try {
    fixture.state.authenticated = false;
    const accepted = await acceptance(
      await fixture.post("/api/operations", {
        ...fixture.target,
        provider: "azure",
        credentialIntent: "authenticate"
      })
    );
    const required = await action(
      await fetch(`${fixture.url}${accepted.statusUrl}`)
    );
    expect(required.label).toBe("Authenticate and verify");
    expect(fixture.state.calls).not.toContain("authenticate");
    expect(
      (
        await fixture.post(required.path, {
          actionId: required.id,
          choice: "continue"
        })
      ).status
    ).toBe(202);
    expect(
      fixture.state.calls.filter((call) => call === "authenticate")
    ).toHaveLength(1);
    expect(fixture.state.exists).toBe(false);
  } finally {
    await fixture.close();
  }
});
it("rejects malformed and mixed configuration payloads without legacy fallback", async () => {
  const fixture = await createEnvironmentHttpFixture();
  try {
    const malformed = await fetch(`${fixture.url}/api/operations`, {
      method: "POST",
      headers: fixture.headers,
      body: "{"
    });
    expect(malformed.status).toBe(400);
    const mixed = await fixture.post("/api/operations", {
      ...fixture.target,
      configuration: fixture.configuration,
      patch: { provider: "azure", settings: { location: "eastus" } }
    });
    expect(mixed.status).toBe(400);
    expect(fixture.binding.registry.knownOperations()).toHaveLength(0);
    expect(fixture.state.exists).toBe(false);
  } finally {
    await fixture.close();
  }
});
