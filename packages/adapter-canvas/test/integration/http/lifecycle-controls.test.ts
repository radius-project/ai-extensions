import { expect, it, vi } from "vitest";
import { portSuccess } from "@radius-project/core/lifecycle";
import { createLifecycleValidators } from "@radius-project/adapter-shared";
import {
  createAuthoringBoundaryFixture,
  authorDefinition
} from "../../support/lifecycle-authoring.js";
import { createLifecycleHttpServer } from "../../support/lifecycle-environment-http.js";

it("controls the exact canonical operation through existing route owners without legacy execution", async () => {
  const fixture = await createAuthoringBoundaryFixture({ trustedHost: true });
  const server = await createLifecycleHttpServer(fixture.binding);
  try {
    const response = createLifecycleValidators().validateResponse(
      await fixture.binding.execute({
        operation: "definition.author",
        target: { repo: "owner/repo", definition: authorDefinition },
        input: { intent: "Model application", provider: "azure" }
      })
    );
    if (
      !response.valid ||
      !("operation" in response.value) ||
      response.value.operation !== "definition.author" ||
      response.value.result.state !== "action_required"
    )
      throw new Error(JSON.stringify(response));
    const { operationId, requiredAction } = response.value.result;
    const path = `/api/operations/${operationId}`;
    expect((await fetch(`${server.url}${path}`)).status).toBe(200);
    expect(
      (
        await fetch(`${server.url}${path}/continue`, {
          method: "POST",
          headers: server.headers,
          body: "{"
        })
      ).status
    ).toBe(400);
    expect(
      (
        await server.post(`${path}/continue`, {
          actionId: requiredAction.actionId,
          response: {
            kind: "agent.outcome",
            status: "failed",
            diagnostics: []
          },
          choice: "approve"
        })
      ).status
    ).toBe(400);
    expect(
      (
        await server.post(`${path}/continue`, {
          actionId: "stale-action",
          response: { kind: "agent.outcome", status: "failed", diagnostics: [] }
        })
      ).status
    ).toBe(409);
    expect((await server.post(`${path}/rollback`, {})).status).toBe(409);
    expect(
      (
        await server.post(`${path}/continue`, {
          actionId: requiredAction.actionId,
          choice: "continue"
        })
      ).status
    ).toBe(409);
    fixture.attest(requiredAction.actionId, {
      kind: "agent.outcome",
      status: "failed",
      diagnostics: []
    });

    const outcome = fixture.response(requiredAction.actionId).input.response;
    expect(
      (
        await server.post(`${path}/continue`, {
          actionId: requiredAction.actionId,
          response: outcome
        })
      ).status
    ).toBe(202);
    expect(
      (
        await server.post(`${path}/continue`, {
          actionId: requiredAction.actionId,
          response: outcome
        })
      ).status
    ).toBe(409);
    expect(
      (
        await server.post(`${path}/retry/repair`, {
          repairPolicy: { mode: "manual", maxAttempts: 5 }
        })
      ).status
    ).toBe(202);
    for (let i = 0; i < 100; i++)
      expect((await fetch(`${server.url}${path}`)).status).toBe(200);
    expect(fixture.assignments).toHaveLength(2);
    expect(fixture.forbidden).toEqual([]);
  } finally {
    await server.close();
    await fixture.close();
  }
});

it("keeps requested cancellation observable and rejects a revoked responder through real HTTP", async () => {
  const fixture = await createAuthoringBoundaryFixture({ trustedHost: true });
  const server = await createLifecycleHttpServer(fixture.binding);
  try {
    await fixture.binding.execute({
      operation: "definition.author",
      target: { repo: "owner/repo", definition: authorDefinition },
      input: { intent: "Model application", provider: "azure" }
    });
    const assignment = fixture.assignments[0];
    if (!assignment) throw new Error("Missing assignment");
    const path = `/api/operations/${assignment.action.operationId}`;
    vi.mocked(fixture.host.cancel).mockResolvedValue(
      portSuccess({
        status: "requested",
        requestedAt: "2026-09-17T19:00:00Z",
        observation: {
          quality: "unknown",
          completeness: "partial",
          evidence: "session"
        }
      })
    );
    const cancelled = await server.post(`${path}/cancel-workflow`, {});
    expect(cancelled.status).toBe(202);
    expect(await cancelled.json()).toMatchObject({
      cancellation: { status: "requested" },
      operation: { summary: expect.stringContaining("independently observed") }
    });
    expect((await server.post(`${path}/cancel-workflow`, {})).status).toBe(202);
    for (let index = 0; index < 100; index++)
      expect((await fetch(`${server.url}${path}`)).status).toBe(200);
    expect(fixture.host.cancel).toHaveBeenCalledOnce();
    expect(fixture.assignments).toHaveLength(1);
    fixture.revokeApproval();
    const response = fixture.response(assignment.action.actionId).input
      .response;
    expect(
      (
        await server.post(`${path}/continue`, {
          actionId: assignment.action.actionId,
          response
        })
      ).status
    ).toBe(403);
    expect(fixture.forbidden).toEqual([]);
  } finally {
    await server.close();
    await fixture.close();
  }
});
