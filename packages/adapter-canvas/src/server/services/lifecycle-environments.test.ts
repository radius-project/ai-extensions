import { afterEach, expect, it } from "vitest";
import { createEnvironmentFixture } from "../../../test/support/lifecycle-environments.js";
import {
  createLifecycleEnvironmentHttp,
  isLifecycleSetupInput,
  lifecycleSetupOperation
} from "./lifecycle-environments.js";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});
async function setup() {
  const fixture = await createEnvironmentFixture();
  disposals.push(fixture.close);
  return { ...fixture, http: createLifecycleEnvironmentHttp(fixture.binding) };
}

it.each([null, [], "configuration", { repo: "owner/repo" }])(
  "does not mistake %j for a setup intent",
  (input) => {
    expect(isLifecycleSetupInput(input)).toBe(false);
  }
);
it.each(["configuration", "patch", "credentialIntent"])(
  "recognizes explicit %s even when malformed",
  (key) => {
    expect(isLifecycleSetupInput({ [key]: null })).toBe(true);
  }
);
it.each([
  null,
  {},
  { repo: 1, configuration: {} },
  { repo: "owner/repo", configuration: {}, deploy: true },
  { repo: "owner/repo", configuration: {}, patch: {} },
  { repo: "owner/repo", configuration: {}, identityRef: "identity" },
  { repo: "owner/repo", configuration: {}, provider: "aws" },
  { repo: "owner/repo", configuration: null, provider: "aws" },
  {
    repo: "owner/repo",
    credentialIntent: "authenticate",
    approvalRef: "public-reference"
  },
  {
    repo: "owner/repo",
    provider: "unsupported",
    credentialIntent: "authenticate"
  }
])(
  "rejects an invalid setup shape without legacy mutation: %j",
  async (input) => {
    const fixture = await setup();
    const calls = [...fixture.state.calls];
    expect(await fixture.http.start(input)).toMatchObject({ status: 400 });
    expect(fixture.binding.registry.knownOperations()).toEqual([]);
    expect(fixture.state.calls).toEqual(calls);
  }
);
it.each([
  null,
  {},
  { actionId: 1, choice: "continue" },
  { actionId: "action", choice: "cancel" },
  { actionId: "action", choice: "continue", extra: true }
])("rejects invalid continuation data: %j", async (input) => {
  const fixture = await setup();
  expect(await fixture.http.respond("missing", input)).toMatchObject({
    status: 400
  });
});
it("distinguishes unknown records from a rejected scoped observation", async () => {
  const fixture = await setup();
  expect(await fixture.http.status("missing")).toMatchObject({ status: 404 });
  expect(
    await fixture.http.respond("missing", {
      actionId: "action",
      choice: "continue"
    })
  ).toMatchObject({ status: 404 });
  expect(
    await fixture.http.start({
      ...fixture.target,
      configuration: fixture.configuration
    })
  ).toMatchObject({ status: 202 });
  const known = lifecycleSetupOperation(
    fixture.binding,
    undefined,
    fixture.target.repo
  );
  if (!known) throw new Error("Missing accepted operation");
  expect(
    lifecycleSetupOperation(fixture.binding, undefined, "other/repo")
  ).toBeUndefined();
  fixture.state.trusted = false;
  expect(await fixture.http.status(known.operationId)).toMatchObject({
    status: 403
  });
  expect(fixture.state.exists).toBe(false);
});
it("does not fall through to legacy setup after canonical routing rollback", async () => {
  const fixture = await setup();
  fixture.binding.routing.transition("environment", {
    writer: "legacy",
    readers: ["legacy", "lifecycle"],
    controllers: ["legacy", "lifecycle"]
  });
  expect(
    await fixture.http.start({
      ...fixture.target,
      configuration: fixture.configuration
    })
  ).toMatchObject({ status: 503 });
  expect(fixture.state.exists).toBe(false);
});
it("preserves the same observable record on one-time continuation", async () => {
  const fixture = await setup();
  await fixture.http.start({
    ...fixture.target,
    provider: "azure",
    configuration: fixture.configuration,
    approvalRef: "public-reference"
  });
  const known = lifecycleSetupOperation(fixture.binding);
  if (!known) throw new Error("Missing accepted operation");
  expect(await fixture.http.status(known.operationId)).toMatchObject({
    status: 200,
    body: {
      operation: { operationId: known.operationId, state: "action_required" }
    }
  });
  const input = { actionId: known.actions[0].actionId, choice: "continue" };
  expect(await fixture.http.respond(known.operationId, input)).toMatchObject({
    status: 202,
    body: { operation: { state: "succeeded" } }
  });
  expect(await fixture.http.respond(known.operationId, input)).toMatchObject({
    status: 409
  });
});
