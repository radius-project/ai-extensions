import { describe, expect, it } from "vitest";
import { compileBrowserEntry } from "./build.js";
import {
  OPERATION_CHIP_ACK_KEY,
  OPERATION_CHIP_ID,
  OPERATION_CHIP_LABEL_ID,
  OPERATION_PANEL_ID,
  OPERATION_POLL_MS,
  OPERATION_STATUS_PATH
} from "./operation-chip.js";
import { resolvePageRegistry } from "./registry.js";
import {
  createFakeBrowserScope,
  FakeElement,
  flushPromises,
  jsonResponse
} from "../../test/support/browser/fakes.js";
import { LEGACY_OPERATION_CHIP_JS } from "../../test/fixtures/legacy-operation-chip-entry.js";
import type { HttpResponse } from "./ports.js";

// Legacy-versus-migrated differential coverage for the Phase 4C operation chip
// move, following the technique established by `heartbeat.differential.test.ts`.
//
// `operation-chip.test.ts` pins every branch of the migrated chip and
// `pages.test.ts` proves the compiled entry is injected exactly once per page.
// Neither can prove the migrated entry still *behaves* like the payload it
// replaced: both were written against the new implementation, and the old
// payload was deleted in the same change, so nothing else compares them. The
// chip renders on every canvas page, so an unnoticed change here is an
// unnoticed change everywhere.
//
// Each scenario therefore runs twice against two independent worlds built from
// the same fakes: once through the deleted payload (frozen in
// `test/fixtures/legacy-operation-chip-entry.ts` at commit ed1a531) and once
// through the *compiled* browser entry that ships in the artifact — not the
// TypeScript module, so the bundling step is inside the comparison rather than
// outside it. Then it compares what each one observably did.
//
// Behavior Phase 4C deliberately changed is not smoothed over. Those cases are
// pinned separately, asserting both sides explicitly, so an intentional
// improvement can never be confused with an accidental regression.

const COMPILED_OPERATION_CHIP = compileBrowserEntry("operation-chip");

type Reply =
  | { readonly kind: "operation"; readonly operation: Record<string, unknown> }
  | { readonly kind: "payload"; readonly body: unknown }
  | { readonly kind: "error" }
  | { readonly kind: "reject" }
  | { readonly kind: "hang" };

type Step =
  | { readonly kind: "poll" }
  | { readonly kind: "click" }
  | { readonly kind: "visibility"; readonly state: string }
  | {
      readonly kind: "panel";
      readonly display: string;
      readonly onScreen: boolean;
    };

interface WorldOptions {
  readonly withChip?: boolean;
  readonly withLabel?: boolean;
  readonly withPanel?: boolean;
  readonly ackedId?: string;
  readonly storageFails?: boolean;
}

interface ChipTrace {
  readonly requests: readonly {
    readonly url: string;
    readonly cache: unknown;
  }[];
  readonly hidden: boolean;
  readonly className: string;
  readonly label: string | null;
  readonly title: string | undefined;
  readonly ariaLabel: string | undefined;
  readonly operationId: string | undefined;
  readonly state: string | undefined;
  readonly ack: string | null;
  readonly intervals: number;
}

function createWorld(replies: readonly Reply[], options: WorldOptions) {
  const browser = createFakeBrowserScope();
  const chip = new FakeElement(OPERATION_CHIP_ID);
  chip.hidden = false;
  if (options.withChip !== false) browser.document.add(chip);
  const label =
    options.withLabel === false ?
      null
    : browser.document.add(new FakeElement(OPERATION_CHIP_LABEL_ID));
  if (options.withPanel === true) {
    browser.document.add(new FakeElement(OPERATION_PANEL_ID));
  }

  // The legacy payload reaches session storage through `window.sessionStorage`
  // while the migrated entry reaches it through the storage port, so both sides
  // are pointed at one shared map to keep acknowledgement observable.
  const stored = new Map<string, string>();
  if (options.ackedId !== undefined) {
    stored.set(OPERATION_CHIP_ACK_KEY, options.ackedId);
  }
  const sessionStorage = {
    getItem: (key: string): string | null => {
      if (options.storageFails === true) throw new Error("storage denied");
      return stored.get(key) ?? null;
    },
    setItem: (key: string, value: string): void => {
      if (options.storageFails === true) throw new Error("storage denied");
      stored.set(key, value);
    }
  };
  browser.scope.sessionStorage = sessionStorage;

  let index = 0;
  browser.net.handle(OPERATION_STATUS_PATH, () => {
    const reply = replies[Math.min(index, replies.length - 1)] ?? {
      kind: "error" as const
    };
    index += 1;
    if (reply.kind === "reject") return Promise.reject(new Error("offline"));
    if (reply.kind === "hang")
      return new Promise<HttpResponse>(() => undefined);
    if (reply.kind === "error") return jsonResponse({}, false, 500);
    if (reply.kind === "payload") return jsonResponse(reply.body);
    return jsonResponse({ operation: reply.operation });
  });

  return { ...browser, chip, label, stored, sessionStorage };
}

type World = ReturnType<typeof createWorld>;

// The legacy payload closes over bare globals, so it is handed the same fake
// document, network, clock and session storage the compiled entry resolves
// through its ports. Both sides therefore observe one identical substrate.
function startLegacy(world: World): void {
  new Function(
    "document",
    "window",
    "fetch",
    "setInterval",
    LEGACY_OPERATION_CHIP_JS
  )(
    world.document,
    { sessionStorage: world.sessionStorage },
    (url: string, init?: Record<string, unknown>) => world.net.fetch(url, init),
    (handler: () => void, intervalMs: number) =>
      world.clock.setInterval(handler, intervalMs)
  );
}

function startMigrated(world: World): void {
  new Function("globalThis", COMPILED_OPERATION_CHIP)(world.scope);
}

async function drive(world: World, steps: readonly Step[]): Promise<void> {
  for (const step of steps) {
    switch (step.kind) {
      case "poll":
        world.clock.tick(OPERATION_POLL_MS);
        break;
      case "click":
        world.chip.dispatch("click");
        break;
      case "visibility":
        world.document.visibilityState = step.state;
        world.document.dispatch("visibilitychange");
        break;
      case "panel": {
        const panel = world.document.getElementById(
          OPERATION_PANEL_ID
        ) as FakeElement | null;
        if (panel) {
          panel.style.display = step.display;
          panel.offsetParent = step.onScreen ? {} : null;
        }
        break;
      }
    }
    await flushPromises();
  }
}

function captureTrace(world: World): ChipTrace {
  return {
    requests: world.net.calls.map((call) => ({
      url: call.url,
      cache: call.init?.cache
    })),
    hidden: world.chip.hidden,
    className: world.chip.className,
    label: world.label ? world.label.textContent : null,
    title: world.chip.attributes.get("title"),
    ariaLabel: world.chip.attributes.get("aria-label"),
    operationId: world.chip.dataset.operationId,
    state: world.chip.dataset.state,
    ack: world.stored.get(OPERATION_CHIP_ACK_KEY) ?? null,
    intervals: world.clock.intervals
  };
}

async function compare(
  replies: readonly Reply[],
  steps: readonly Step[],
  options: WorldOptions = {}
): Promise<{ legacy: ChipTrace; migrated: ChipTrace }> {
  const legacyWorld = createWorld(replies, options);
  startLegacy(legacyWorld);
  await flushPromises();
  await drive(legacyWorld, steps);
  const legacy = captureTrace(legacyWorld);

  const migratedWorld = createWorld(replies, options);
  startMigrated(migratedWorld);
  await flushPromises();
  await drive(migratedWorld, steps);
  const migrated = captureTrace(migratedWorld);
  resolvePageRegistry(migratedWorld.scope).teardownAll();

  return { legacy, migrated };
}

function polls(count: number) {
  return Array.from({ length: count }, () => ({
    url: OPERATION_STATUS_PATH,
    cache: "no-store"
  }));
}

const running = {
  kind: "operation" as const,
  operation: {
    operationId: "op-1",
    state: "running",
    environment: "az-test",
    summary: "Creating the environment"
  }
};
const succeeded = {
  kind: "operation" as const,
  operation: {
    operationId: "op-1",
    state: "succeeded",
    environment: "az-test",
    summary: ""
  }
};

interface EquivalentCase {
  readonly name: string;
  readonly replies: readonly Reply[];
  readonly steps: readonly Step[];
  readonly options?: WorldOptions;
  readonly expected: Partial<ChipTrace>;
}

const EQUIVALENT_CASES: readonly EquivalentCase[] = [
  {
    name: "a running operation shows the chip on first poll",
    replies: [running],
    steps: [],
    expected: {
      requests: polls(1),
      hidden: false,
      className: "rad-opchip rad-opchip--running",
      label: "Setting up az-test…",
      title: "Creating the environment",
      ariaLabel: "Creating the environment",
      operationId: "op-1",
      state: "running",
      intervals: 1
    }
  },
  {
    name: "a summary-less operation falls back to the label for its tooltip",
    replies: [succeeded],
    steps: [],
    expected: {
      hidden: false,
      className: "rad-opchip rad-opchip--done",
      label: "az-test ready",
      title: "az-test ready",
      ariaLabel: "az-test ready"
    }
  },
  {
    name: "an unnamed environment renders the generic noun",
    replies: [
      { kind: "operation", operation: { state: "running", summary: "" } }
    ],
    steps: [],
    expected: {
      hidden: false,
      label: "Setting up environment…",
      operationId: "",
      state: "running"
    }
  },
  ...(
    [
      [
        "succeeded_with_warnings",
        "rad-opchip--warn",
        "az-test ready · warnings"
      ],
      ["action_required", "rad-opchip--warn", "az-test needs you"],
      ["failed", "rad-opchip--failed", "az-test setup failed"],
      ["failed_partial", "rad-opchip--failed", "az-test setup failed"],
      ["cancelled", "", "az-test setup stopped"]
    ] as const
  ).map(([state, tone, text]) => ({
    name: `renders the ${state} tone and label`,
    replies: [
      {
        kind: "operation" as const,
        operation: {
          operationId: "op-9",
          state,
          environment: "az-test",
          summary: ""
        }
      }
    ],
    steps: [],
    expected: {
      hidden: false,
      className: `rad-opchip ${tone}`,
      label: text,
      state
    }
  })),
  {
    name: "an unknown state hides the chip",
    replies: [
      {
        kind: "operation",
        operation: { operationId: "op-1", state: "queued", environment: "e" }
      }
    ],
    steps: [],
    expected: { hidden: true, className: "", label: "", state: undefined }
  },
  {
    name: "a stateless operation hides the chip",
    replies: [{ kind: "operation", operation: { operationId: "op-1" } }],
    steps: [],
    expected: { hidden: true, state: undefined }
  },
  {
    name: "a response without an operation hides the chip",
    replies: [{ kind: "payload", body: {} }],
    steps: [],
    expected: { requests: polls(1), hidden: true }
  },
  {
    name: "a non-200 response hides the chip",
    replies: [{ kind: "error" }],
    steps: [],
    expected: { requests: polls(1), hidden: true }
  },
  {
    name: "a rejected request leaves the chip untouched",
    replies: [{ kind: "reject" }],
    steps: [],
    expected: { requests: polls(1), hidden: false, className: "" }
  },
  {
    name: "an already acknowledged terminal operation stays hidden",
    replies: [succeeded],
    steps: [],
    options: { ackedId: "op-1" },
    expected: { hidden: true, ack: "op-1" }
  },
  {
    name: "an acknowledged id does not suppress a still-running operation",
    replies: [running],
    steps: [],
    options: { ackedId: "op-1" },
    expected: { hidden: false, state: "running" }
  },
  {
    name: "clicking the chip acknowledges the rendered operation",
    replies: [succeeded],
    steps: [{ kind: "click" }],
    expected: { hidden: false, ack: "op-1" }
  },
  {
    name: "clicking an empty chip acknowledges nothing",
    replies: [{ kind: "payload", body: {} }],
    steps: [{ kind: "click" }],
    expected: { hidden: true, ack: null }
  },
  {
    name: "acknowledging then repolling hides a terminal operation",
    replies: [succeeded],
    steps: [{ kind: "click" }, { kind: "poll" }],
    expected: { requests: polls(2), hidden: true, ack: "op-1" }
  },
  {
    name: "an on-screen progress panel suppresses the chip",
    replies: [running],
    steps: [
      { kind: "panel", display: "block", onScreen: true },
      { kind: "poll" }
    ],
    options: { withPanel: true },
    expected: { requests: polls(2), hidden: true }
  },
  {
    name: "a hidden progress panel does not suppress the chip",
    replies: [running],
    steps: [
      { kind: "panel", display: "none", onScreen: true },
      { kind: "poll" }
    ],
    options: { withPanel: true },
    expected: { requests: polls(2), hidden: false, state: "running" }
  },
  {
    name: "a detached progress panel does not suppress the chip",
    replies: [running],
    steps: [
      { kind: "panel", display: "block", onScreen: false },
      { kind: "poll" }
    ],
    options: { withPanel: true },
    expected: { requests: polls(2), hidden: false, state: "running" }
  },
  {
    name: "the poll interval keeps requesting status",
    replies: [running],
    steps: [{ kind: "poll" }, { kind: "poll" }],
    expected: { requests: polls(3), intervals: 1 }
  },
  {
    name: "becoming visible polls immediately",
    replies: [running],
    steps: [{ kind: "visibility", state: "visible" }],
    expected: { requests: polls(2) }
  },
  {
    name: "becoming hidden does not poll",
    replies: [running],
    steps: [{ kind: "visibility", state: "hidden" }],
    expected: { requests: polls(1) }
  },
  {
    name: "a missing label element still renders the chip",
    replies: [running],
    steps: [],
    options: { withLabel: false },
    expected: { hidden: false, label: null, title: "Creating the environment" }
  },
  {
    name: "a terminal operation renders when storage cannot be read",
    replies: [succeeded],
    steps: [{ kind: "click" }],
    options: { storageFails: true },
    expected: { hidden: false, state: "succeeded", ack: null }
  }
];

describe("operation chip legacy compatibility", () => {
  it.each(EQUIVALENT_CASES)("$name", async (testCase) => {
    const { legacy, migrated } = await compare(
      testCase.replies,
      testCase.steps,
      testCase.options
    );

    expect(legacy).toMatchObject(testCase.expected);
    expect(migrated).toEqual(legacy);
  });

  it("does nothing at all when the chip is absent", async () => {
    for (const start of [startLegacy, startMigrated]) {
      const world = createWorld([running], { withChip: false });
      start(world);
      await flushPromises();
      expect(world.net.calls).toHaveLength(0);
      expect(world.clock.intervals).toBe(0);
      expect(world.document.listenerCount("visibilitychange")).toBe(0);
    }
  });

  it("registers the same listeners and timer the legacy payload did", async () => {
    const legacyWorld = createWorld([running], {});
    startLegacy(legacyWorld);
    const migratedWorld = createWorld([running], {});
    startMigrated(migratedWorld);
    await flushPromises();

    for (const world of [legacyWorld, migratedWorld]) {
      expect(world.chip.listenerCount("click")).toBe(1);
      expect(world.document.listenerCount("visibilitychange")).toBe(1);
      expect(world.clock.intervals).toBe(1);
    }

    resolvePageRegistry(migratedWorld.scope).teardownAll();
  });
});

describe("operation chip deliberate divergences from the legacy payload", () => {
  it("collapses coincident polls the legacy payload issued three times", async () => {
    const { legacy, migrated } = await compare(
      [{ kind: "hang" }],
      [{ kind: "poll" }, { kind: "visibility", state: "visible" }]
    );

    expect(legacy.requests).toEqual(polls(3));
    expect(migrated.requests).toEqual(polls(2));
  });

  // The legacy payload swallowed every session-storage failure, so a sandboxed
  // host that denies storage silently stopped acknowledging chips. The migrated
  // entry reports it instead of hiding it.
  it("reports a denied acknowledgement the legacy payload swallowed", async () => {
    const legacyWorld = createWorld([succeeded], { storageFails: true });
    startLegacy(legacyWorld);
    const migratedWorld = createWorld([succeeded], { storageFails: true });
    startMigrated(migratedWorld);
    await flushPromises();
    legacyWorld.chip.dispatch("click");
    migratedWorld.chip.dispatch("click");
    await flushPromises();

    expect(legacyWorld.logger.errors).toHaveLength(0);
    expect(migratedWorld.logger.errors.length).toBeGreaterThan(0);
    resolvePageRegistry(migratedWorld.scope).teardownAll();
  });

  it("stops on teardown where the legacy payload could not be stopped", async () => {
    const legacyWorld = createWorld([running], {});
    startLegacy(legacyWorld);
    const migratedWorld = createWorld([running], {});
    startMigrated(migratedWorld);
    await flushPromises();

    resolvePageRegistry(migratedWorld.scope).teardownAll();
    await drive(legacyWorld, [{ kind: "poll" }]);
    await drive(migratedWorld, [{ kind: "poll" }]);

    expect(legacyWorld.net.calls).toHaveLength(2);
    expect(legacyWorld.clock.intervals).toBe(1);
    expect(migratedWorld.net.calls).toHaveLength(1);
    expect(migratedWorld.clock.intervals).toBe(0);
    expect(migratedWorld.chip.listenerCount("click")).toBe(0);
    expect(migratedWorld.document.listenerCount("visibilitychange")).toBe(0);
  });
});
