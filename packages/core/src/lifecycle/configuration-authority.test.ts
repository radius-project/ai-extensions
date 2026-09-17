import { expect, it } from "vitest";
import {
  authorizeConfiguration,
  configurationAuthorizationIntent
} from "./configuration-authority.js";
import { portForbidden, portSuccess } from "./errors.js";
import type {
  AuthorizationRequest,
  AuthorizedScope,
  IdentityPort,
  LifecycleOperation,
  LifecycleRequestFor,
  PortResult
} from "./index.js";

function fixture() {
  const caller = {
    principalRef: "principal",
    sessionRef: "session",
    identityRef: "github:fixture",
    responder: "user" as const
  };
  const cancellation = { aborted: false, onAbort: () => () => {} };
  const control = { requestId: "request", cancellation };
  const request: LifecycleRequestFor<"environment.create"> = {
    apiVersion: "github-radius/v1",
    requestId: "request",
    operation: "environment.create",
    target: { repo: "owner/repo", environment: "dev" },
    input: {
      approvalRef: "review",
      configuration: {
        provider: "azure",
        identityRef: "profile",
        settings: {
          subscriptionId: "subscription",
          resourceGroup: "group",
          location: "westus"
        },
        recipes: []
      }
    }
  };
  const state = {
    forbidden: false,
    abort: false,
    calls: 0,
    alter: <O extends LifecycleOperation>(
      scope: AuthorizedScope<O>
    ): AuthorizedScope<O> => scope
  };
  const authorize: IdentityPort["authorize"] = async <
    O extends LifecycleOperation
  >(
    input: AuthorizationRequest<O>
  ): Promise<PortResult<AuthorizedScope<O>>> => {
    state.calls += 1;
    if (state.abort) cancellation.aborted = true;
    if (state.forbidden) return portForbidden();
    const scope: AuthorizedScope = {
      ...input,
      authorizationRef: "authority",
      principalRef: input.caller.principalRef
    };
    return portSuccess(state.alter(scope as AuthorizedScope<O>));
  };
  return {
    caller,
    cancellation,
    control,
    request,
    state,
    authorize,
    invoke: () =>
      authorizeConfiguration(
        { authorize },
        caller,
        request,
        "operation",
        control
      )
  };
}

it("binds the exact reviewed configuration and current operation to authority", async () => {
  const f = fixture();
  expect(await f.invoke()).toMatchObject({
    status: "ok",
    value: {
      operationId: "operation",
      configuration: {
        operation: "environment.create",
        configuration: f.request.input.configuration
      },
      approvalRef: "review"
    }
  });
  expect(f.state.calls).toBe(1);
});
it.each([
  "empty grant",
  "other principal",
  "other operation",
  "other scope",
  "other approval",
  "missing reviewed configuration"
])("rejects authority for %s", async (name) => {
  const f = fixture();
  f.state.alter = (scope) => {
    if (name === "empty grant") return { ...scope, authorizationRef: "" };
    if (name === "other principal") return { ...scope, principalRef: "other" };
    if (name === "other operation") return { ...scope, operationId: "other" };
    if (name === "other scope")
      return { ...scope, target: { ...scope.target, repo: "other/repo" } };
    if (name === "other approval") return { ...scope, approvalRef: "other" };
    return { ...scope, configuration: undefined };
  };
  expect(await f.invoke()).toMatchObject({ status: "forbidden" });
});
it("preserves authority refusal", async () => {
  const f = fixture();
  f.state.forbidden = true;
  expect(await f.invoke()).toMatchObject({ status: "forbidden" });
});
it.each(["before", "after"])(
  "cancels %s authorization without accepting a late grant",
  async (when) => {
    const f = fixture();
    f.cancellation.aborted = when === "before";
    f.state.abort = when === "after";
    expect(await f.invoke()).toMatchObject({ status: "cancelled" });
    expect(f.state.calls).toBe(when === "before" ? 0 : 1);
  }
);
it("does not manufacture configuration intent for inspection", () => {
  expect(
    configurationAuthorizationIntent({
      apiVersion: "github-radius/v1",
      requestId: "request",
      operation: "credentials.inspect",
      target: { repo: "owner/repo" },
      input: {}
    })
  ).toBeUndefined();
});
