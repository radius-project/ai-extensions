import { expect, it } from "vitest";
import {
  createLifecycleControls,
  lifecycleControlRequest
} from "./lifecycle-controls.js";
import {
  createFakeBrowser,
  createFakeElement,
  createFakeInput,
  flushPromises,
  jsonResponse,
  createDeferred
} from "../../test/support/browser/fakes.js";
import type { HttpResponse } from "./ports.js";

function fixture() {
  const browser = createFakeBrowser();
  const panel = createFakeElement("lifecycle-controls");
  const status = createFakeElement("lifecycle-control-status");
  const repair = createFakeInput("lifecycle-repair");
  const cancel = createFakeInput("lifecycle-cancel");
  for (const element of [panel, status, repair, cancel])
    browser.document.add(element);
  const view = (operationId = "operation", kind = "repair") => ({
    operation: {
      operationId,
      summary: "Known execution evidence.",
      actions: [
        {
          id: "action",
          kind: `lifecycle.${kind}`,
          path: `/api/operations/${operationId}/${kind === "repair" ? "retry/repair" : "cancel-workflow"}`
        }
      ]
    }
  });
  return { ...browser, panel, status, repair, cancel, view };
}
it.each([
  [
    "lifecycle.repair",
    "retry/repair",
    { repairPolicy: { mode: "manual", maxAttempts: 5 } }
  ],
  ["lifecycle.cancel", "cancel-workflow", {}],
  [
    "lifecycle.authenticate",
    "continue",
    { actionId: "action", choice: "continue" }
  ],
  [
    "lifecycle.configure",
    "continue",
    { actionId: "action", choice: "continue" }
  ]
])(
  "builds explicit %s intent without user-supplied authority",
  (kind, suffix, body) => {
    const path = `/api/operations/operation/${suffix}`;
    expect(
      lifecycleControlRequest("operation", {
        id: "action",
        kind: String(kind),
        path
      })
    ).toEqual({ path, body: JSON.stringify(body) });
  }
);
it.each([
  [
    "../escape",
    "lifecycle.cancel",
    "action",
    "/api/operations/operation/cancel-workflow"
  ],
  ["operation", "unknown", "action", "/api/operations/operation/continue"],
  [
    "operation",
    "lifecycle.cancel",
    "",
    "/api/operations/operation/cancel-workflow"
  ],
  [
    "operation",
    "lifecycle.cancel",
    "action",
    "/api/operations/other/cancel-workflow"
  ]
])(
  "rejects a foreign or malformed operation/action path",
  (operationId, kind, id, path) => {
    expect(lifecycleControlRequest(operationId, { id, kind, path })).toBeNull();
  }
);
it("fences a completed POST after teardown when AbortController is unavailable", async () => {
  const f = fixture();
  const pending = createDeferred<HttpResponse>();
  f.net.handle("/api/operations/operation", () => jsonResponse(f.view()));
  f.net.handle("/api/operations/operation/retry/repair", () => pending.promise);
  const controls = createLifecycleControls(
    {
      ...f.context,
      net: {
        fetch: (...args) => f.context.net.fetch(...args),
        createAbort: () => null
      }
    },
    ""
  );
  controls.observe("operation");
  await flushPromises();
  f.repair.dispatch("click");
  controls.teardown();
  const message = f.status.textContent;
  pending.resolve(jsonResponse({ operationId: "linked" }));
  await flushPromises();
  expect(f.status.textContent).toBe(message);
  expect(f.net.calls).toHaveLength(2);
});
it("requires an explicit click, follows the linked repair identity and never deploys", async () => {
  const f = fixture();
  f.net.handle("/api/operations/operation", () => jsonResponse(f.view()));
  f.net.handle("/api/operations/operation/retry/repair", () =>
    jsonResponse({ operationId: "repair" })
  );
  f.net.handle("/api/operations/repair", () =>
    jsonResponse(f.view("repair", "cancel"))
  );
  const controls = createLifecycleControls(f.context, "fixture-nonce");
  controls.observe("operation");
  await flushPromises();
  expect(f.net.calls).toHaveLength(1);
  f.repair.dispatch("click");
  f.repair.dispatch("click");
  expect(f.repair.disabled).toBe(true);
  await flushPromises();
  expect(f.net.calls.map((call) => call.url)).toEqual([
    "/api/operations/operation",
    "/api/operations/operation/retry/repair",
    "/api/operations/repair"
  ]);
  expect(f.net.calls[1]?.init?.headers).toMatchObject({
    "X-Radius-Mutation-Nonce": "fixture-nonce"
  });
  expect(f.cancel.style.display).toBe("");
  controls.teardown();
});
it("fences late observation after panel close without sending remote cancellation", async () => {
  const f = fixture();
  const deferred = createDeferred<HttpResponse>();
  f.net.handle("/api/operations/operation", () => deferred.promise);
  const controls = createLifecycleControls(f.context, "");
  controls.observe("operation");
  controls.teardown();
  deferred.resolve(jsonResponse(f.view()));
  await flushPromises();
  expect(f.status.textContent).toBe("");
  expect(f.net.calls).toHaveLength(1);
});
it("shows unavailable evidence and hides unsafe controls", async () => {
  const f = fixture();
  f.net.handle("/api/operations/operation", () =>
    jsonResponse({ error: "Unavailable" }, false, 503)
  );
  const controls = createLifecycleControls(f.context, "");
  controls.observe("operation");
  await flushPromises();
  expect(f.status.textContent).toContain("unavailable");
  expect(f.repair.style.display).toBe("none");
  controls.teardown();
});

it.each([
  "lifecycle-controls",
  "lifecycle-control-status",
  "lifecycle-repair",
  "lifecycle-cancel"
])("is inert without %s markup", (id) => {
  const f = fixture();
  f.document.remove(id);
  const controls = createLifecycleControls(f.context, "");
  controls.observe("operation", "failed");
  controls.teardown();
  expect(f.net.calls).toEqual([]);
});
it("does not bind a second controller to the same panel", async () => {
  const f = fixture();
  f.net.handle("/api/operations/operation", () => jsonResponse(f.view()));
  const controls = createLifecycleControls(f.context, "");
  const duplicate = createLifecycleControls(f.context, "");
  duplicate.observe("operation");
  duplicate.teardown();
  controls.observe("operation");
  await flushPromises();
  expect(f.net.calls).toHaveLength(1);
  controls.teardown();
});
it.each([null, { operation: { operationId: "other" } }])(
  "rejects mismatched observed evidence",
  async (payload) => {
    const f = fixture();
    f.net.supportsAbort = false;
    f.net.handle("/api/operations/operation", () => jsonResponse(payload));
    const controls = createLifecycleControls(f.context, "");
    controls.observe("operation");
    controls.observe("operation");
    controls.observe("../other");
    await flushPromises();
    expect(f.status.textContent).toContain("unavailable");
    expect(f.net.calls).toHaveLength(1);
    controls.teardown();
  }
);
it.each([
  undefined,
  [
    null,
    {},
    {
      id: "foreign",
      kind: "lifecycle.cancel",
      path: "/api/operations/other/cancel-workflow"
    },
    {
      id: "decision",
      kind: "lifecycle.configure",
      path: "/api/operations/operation/continue"
    }
  ]
])("hides absent, malformed and non-control actions", async (actions) => {
  const f = fixture();
  f.net.handle("/api/operations/operation", () =>
    jsonResponse({ operation: { operationId: "operation", actions } })
  );
  const controls = createLifecycleControls(f.context, "");
  f.repair.dispatch("click");
  controls.observe("operation");
  await flushPromises();
  f.repair.dispatch("click");
  f.cancel.dispatch("click");
  expect(f.repair.style.display).toBe("none");
  expect(f.cancel.style.display).toBe("none");
  expect(f.net.calls).toHaveLength(1);
  controls.teardown();
});
it("requests cancellation once, retaining the same operation identity", async () => {
  const f = fixture();
  f.net.handle("/api/operations/operation", () =>
    jsonResponse(f.view("operation", "cancel"))
  );
  f.net.handle("/api/operations/operation/cancel-workflow", () =>
    jsonResponse({ operationId: "operation" })
  );
  const controls = createLifecycleControls(f.context, "");
  controls.observe("operation");
  await flushPromises();
  f.cancel.dispatch("click");
  await flushPromises();
  expect(
    f.net.calls.filter((call) => call.init?.method === "POST")
  ).toHaveLength(1);
  expect(f.net.calls[1]?.init?.body).toBe("{}");
  controls.teardown();
});
it.each(["refused", "missing-id", "invalid-id"] as const)(
  "discloses %s acceptance without inventing a new identity",
  async (mode) => {
    const f = fixture();
    f.net.handle("/api/operations/operation", () => jsonResponse(f.view()));
    f.net.handle("/api/operations/operation/retry/repair", () =>
      jsonResponse(
        mode === "missing-id" ? {} : { operationId: "../foreign" },
        mode !== "refused",
        mode === "refused" ? 409 : 202
      )
    );
    const controls = createLifecycleControls(f.context, "");
    controls.observe("operation");
    await flushPromises();
    f.repair.dispatch("click");
    await flushPromises();
    expect(f.status.textContent).toContain("could not be confirmed");
    expect(f.cancel.disabled).toBe(true);
    expect(f.net.calls).toHaveLength(2);
    controls.teardown();
  }
);
it.each([true, false])(
  "fences a late control settlement after panel close (fulfilled=%s)",
  async (fulfilled) => {
    const f = fixture();
    const deferred = createDeferred<HttpResponse>();
    f.net.handle("/api/operations/operation", () => jsonResponse(f.view()));
    f.net.handle(
      "/api/operations/operation/retry/repair",
      () => deferred.promise
    );
    const controls = createLifecycleControls(f.context, "");
    controls.observe("operation");
    await flushPromises();
    f.repair.dispatch("click");
    controls.observe("other");
    controls.teardown();
    if (fulfilled) deferred.resolve(jsonResponse({ operationId: "linked" }));
    else deferred.reject(new Error("Late request failure"));
    await flushPromises();
    expect(f.net.calls).toHaveLength(2);
    expect(f.status.textContent).toContain("Requesting approved");
  }
);
it("follows changed observation state but ignores a superseded failed parent after repair", async () => {
  const f = fixture();
  f.net.handle("/api/operations/operation", () => jsonResponse(f.view()));
  f.net.handle("/api/operations/operation/retry/repair", () =>
    jsonResponse({ operationId: "linked" })
  );
  f.net.handle("/api/operations/linked", () =>
    jsonResponse(f.view("linked", "cancel"))
  );
  const controls = createLifecycleControls(f.context, "");
  controls.observe("operation", "running");
  await flushPromises();
  controls.observe("operation", "failed");
  await flushPromises();
  f.repair.dispatch("click");
  await flushPromises();
  controls.observe("operation", "failed");
  expect(f.net.calls).toHaveLength(4);
  controls.teardown();
});
it.each([true, false])(
  "fences superseded observation settlement (fulfilled=%s)",
  async (fulfilled) => {
    const f = fixture();
    const deferred = createDeferred<HttpResponse>();
    f.net.handle("/api/operations/operation", () => deferred.promise);
    f.net.handle("/api/operations/other", () =>
      jsonResponse(f.view("other", "cancel"))
    );
    const controls = createLifecycleControls(f.context, "");
    controls.observe("operation");
    controls.observe("other");
    await flushPromises();
    if (fulfilled) deferred.resolve(jsonResponse(f.view()));
    else deferred.reject(new Error("Superseded read failure"));
    await flushPromises();
    expect(f.cancel.style.display).toBe("");
    controls.teardown();
  }
);

it.each([
  "REPAIR_LIMIT_REACHED",
  "FORBIDDEN",
  "SOURCE_CHANGED",
  "EVIDENCE_MISMATCH"
])(
  "announces bounded %s failure without rendering raw diagnostics",
  async (code) => {
    const f = fixture();
    f.net.handle("/api/operations/operation", () => jsonResponse(f.view()));
    f.net.handle("/api/operations/operation/retry/repair", () =>
      jsonResponse({ code, error: "untrusted transport detail" }, false, 409)
    );
    const controls = createLifecycleControls(f.context, "");
    controls.observe("operation");
    await flushPromises();
    f.repair.dispatch("click");
    await flushPromises();
    expect(f.status.textContent).not.toContain("untrusted transport detail");
    expect(f.status.textContent).toContain(
      code === "REPAIR_LIMIT_REACHED" ? "budget is exhausted"
      : code === "FORBIDDEN" ? "fresh approval"
      : "evidence changed"
    );
    if (code === "REPAIR_LIMIT_REACHED") {
      f.repair.dispatch("click");
      expect(f.repair.style.display).toBe("none");
    }
    expect(
      f.net.calls.filter((call) => call.init?.method === "POST")
    ).toHaveLength(1);
    controls.teardown();
  }
);
