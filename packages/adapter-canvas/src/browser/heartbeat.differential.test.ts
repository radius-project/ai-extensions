import { describe, expect, it } from "vitest";
import { compileBrowserEntry } from "./build.js";
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_OVERLAY_ID,
  HEARTBEAT_PING_PATH,
  HEARTBEAT_REQUEST_TIMEOUT_MS
} from "./heartbeat.js";
import { resolvePageRegistry } from "./registry.js";
import {
  createFakeBrowserScope,
  FakeElement,
  flushPromises,
  jsonResponse
} from "../../test/support/browser/fakes.js";
import { LEGACY_HEARTBEAT_JS } from "../../test/fixtures/legacy-heartbeat-entry.js";
import type { HttpRequestInit, HttpResponse } from "./ports.js";

// Legacy-versus-migrated differential coverage for the Phase 4A heartbeat move.
//
// `heartbeat.test.ts` pins every rung of the migrated watchdog, and
// `build.test.ts` proves the compiled bytes are deterministic and
// self-contained. Neither can prove the migrated entry still *behaves* like the
// payload it replaced: both were written against the new implementation, and
// the old payload was deleted in the same change, so nothing else compares
// them. The Phase 3 compatibility oracle used to hold that line with a SHA-256
// digest of the old source string; Phase 4A necessarily retires that digest
// because the payload is rewritten by design.
//
// So each scenario runs twice against two independent worlds built from the
// same fakes: once through the deleted payload (frozen in
// `test/fixtures/legacy-heartbeat-entry.ts` at commit e26a030) and once through
// the *compiled* browser entry that ships in the artifact — not the TypeScript
// module, so the bundling step is inside the comparison rather than outside it.
// Then it compares what each one observably did.
//
// Behavior that Phase 4A deliberately changed is not smoothed over. Those cases
// are pinned separately, asserting both sides explicitly, so an intentional
// improvement can never be confused with an accidental regression.

const COMPILED_HEARTBEAT = compileBrowserEntry("heartbeat");

type PingOutcome = "ok" | "error" | "reject" | "hang";

type Step =
  | { readonly kind: "beat" }
  | { readonly kind: "focus" }
  | { readonly kind: "visibility"; readonly state: string }
  | { readonly kind: "advance"; readonly ms: number };

interface CompareOptions {
  readonly abortSupported?: boolean;
  readonly blockFirstReload?: boolean;
}

interface HeartbeatTrace {
  readonly requests: readonly {
    readonly url: string;
    readonly cache: unknown;
    readonly signalled: boolean;
  }[];
  readonly aborts: number;
  readonly reloads: number;
  readonly overlay: string;
  readonly intervals: number;
  readonly timeouts: number;
  readonly errors: number;
}

function createWorld(
  outcomes: readonly PingOutcome[],
  options: CompareOptions
) {
  const browser = createFakeBrowserScope();
  const overlay = new FakeElement(HEARTBEAT_OVERLAY_ID);
  overlay.style.display = "none";
  browser.document.add(overlay);
  if (options.abortSupported === false) {
    delete browser.scope.AbortController;
  }

  let index = 0;
  browser.net.handle(HEARTBEAT_PING_PATH, () => {
    const outcome = outcomes[Math.min(index, outcomes.length - 1)] ?? "ok";
    index += 1;
    if (outcome === "reject") return Promise.reject(new Error("offline"));
    if (outcome === "hang") return new Promise<HttpResponse>(() => undefined);
    if (outcome === "error") return jsonResponse({}, false, 500);
    return jsonResponse({});
  });

  if (options.blockFirstReload === true) {
    let blocked = false;
    browser.location.reload = () => {
      if (!blocked) {
        blocked = true;
        throw new Error("reload blocked");
      }
      browser.nav.reload();
    };
  }

  return { ...browser, overlay };
}

type World = ReturnType<typeof createWorld>;

// The legacy payload closes over bare globals, so it is handed the same fake
// document, network, clock and location the compiled entry resolves through its
// ports. Both sides therefore observe one identical substrate.
function startLegacy(world: World, options: CompareOptions): void {
  const legacyWindow = {
    addEventListener: world.page.addEventListener.bind(world.page),
    removeEventListener: world.page.removeEventListener.bind(world.page),
    location: world.location
  };
  new Function(
    "document",
    "window",
    "fetch",
    "AbortController",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    LEGACY_HEARTBEAT_JS
  )(
    world.document,
    legacyWindow,
    (url: string, init?: HttpRequestInit) => world.net.fetch(url, init),
    options.abortSupported === false ? undefined : world.scope.AbortController,
    (handler: () => void, timeoutMs: number) =>
      world.clock.setTimeout(handler, timeoutMs),
    (handle: number) => world.clock.clearTimeout(handle),
    (handler: () => void, intervalMs: number) =>
      world.clock.setInterval(handler, intervalMs)
  );
}

function startMigrated(world: World): void {
  new Function("globalThis", COMPILED_HEARTBEAT)(world.scope);
}

async function drive(world: World, steps: readonly Step[]): Promise<void> {
  for (const step of steps) {
    switch (step.kind) {
      case "beat":
        world.clock.tick(HEARTBEAT_INTERVAL_MS);
        break;
      case "advance":
        world.clock.tick(step.ms);
        break;
      case "focus":
        world.page.dispatch("focus");
        break;
      case "visibility":
        world.document.visibilityState = step.state;
        world.document.dispatch("visibilitychange");
        break;
    }
    await flushPromises();
  }
}

function captureTrace(world: World): HeartbeatTrace {
  return {
    requests: world.net.calls.map((call) => ({
      url: call.url,
      cache: call.init?.cache,
      signalled: call.init?.signal !== undefined
    })),
    aborts: world.net.aborted,
    reloads: world.nav.reloads,
    overlay: world.overlay.style.display,
    intervals: world.clock.intervals,
    timeouts: world.clock.timeouts,
    errors: world.logger.errors.length
  };
}

async function compare(
  outcomes: readonly PingOutcome[],
  steps: readonly Step[],
  options: CompareOptions = {}
): Promise<{ legacy: HeartbeatTrace; migrated: HeartbeatTrace }> {
  const legacyWorld = createWorld(outcomes, options);
  startLegacy(legacyWorld, options);
  await drive(legacyWorld, steps);
  const legacy = captureTrace(legacyWorld);

  const migratedWorld = createWorld(outcomes, options);
  startMigrated(migratedWorld);
  await drive(migratedWorld, steps);
  const migrated = captureTrace(migratedWorld);
  resolvePageRegistry(migratedWorld.scope).teardownAll();

  return { legacy, migrated };
}

function pings(count: number, signalled = true) {
  return Array.from({ length: count }, () => ({
    url: HEARTBEAT_PING_PATH,
    cache: "no-store",
    signalled
  }));
}

const beat: Step = { kind: "beat" };
const focus: Step = { kind: "focus" };
const hidden: Step = { kind: "visibility", state: "hidden" };
const visible: Step = { kind: "visibility", state: "visible" };

interface EquivalentCase {
  readonly name: string;
  readonly outcomes: readonly PingOutcome[];
  readonly steps: readonly Step[];
  readonly options?: CompareOptions;
  readonly expected: Partial<HeartbeatTrace>;
}

const EQUIVALENT_CASES: readonly EquivalentCase[] = [
  {
    name: "a healthy ping leaves the overlay hidden",
    outcomes: ["ok"],
    steps: [beat],
    expected: {
      requests: pings(1),
      aborts: 0,
      reloads: 0,
      overlay: "none",
      intervals: 1,
      timeouts: 0,
      errors: 0
    }
  },
  {
    name: "one dropped ping is not an outage",
    outcomes: ["reject", "ok"],
    steps: [beat, beat],
    expected: { requests: pings(2), overlay: "none", reloads: 0, timeouts: 0 }
  },
  {
    name: "two consecutive dropped pings raise the overlay",
    outcomes: ["reject", "reject"],
    steps: [beat, beat],
    expected: { requests: pings(2), overlay: "flex", reloads: 0, errors: 0 }
  },
  {
    name: "a non-200 response counts as a miss",
    outcomes: ["error", "error"],
    steps: [beat, beat],
    expected: { requests: pings(2), overlay: "flex", reloads: 0, errors: 0 }
  },
  {
    name: "a recovered ping resets the miss count",
    outcomes: ["reject", "ok", "reject"],
    steps: [beat, beat, beat],
    expected: { requests: pings(3), overlay: "none", reloads: 0 }
  },
  {
    name: "recovery after an outage reloads the page",
    outcomes: ["reject", "reject", "ok"],
    steps: [beat, beat, beat],
    expected: { requests: pings(3), overlay: "flex", reloads: 1 }
  },
  {
    name: "a focus probe pings immediately",
    outcomes: ["ok"],
    steps: [focus],
    expected: { requests: pings(1), intervals: 1, reloads: 0 }
  },
  {
    name: "a hidden document does not probe",
    outcomes: ["ok"],
    steps: [hidden],
    expected: { requests: [], intervals: 1, reloads: 0 }
  },
  {
    name: "becoming visible probes once",
    outcomes: ["ok"],
    steps: [hidden, visible],
    expected: { requests: pings(1), reloads: 0 }
  },
  {
    name: "a hung ping is aborted at the request deadline",
    outcomes: ["hang"],
    steps: [beat, { kind: "advance", ms: HEARTBEAT_REQUEST_TIMEOUT_MS }],
    expected: { requests: pings(1), aborts: 1, timeouts: 0, overlay: "none" }
  },
  {
    name: "no deadline is armed when AbortController is unavailable",
    outcomes: ["hang"],
    steps: [beat],
    options: { abortSupported: false },
    expected: { requests: pings(1, false), aborts: 0, timeouts: 0 }
  }
];

describe("heartbeat legacy compatibility", () => {
  it.each(EQUIVALENT_CASES)("$name", async (testCase) => {
    const { legacy, migrated } = await compare(
      testCase.outcomes,
      testCase.steps,
      testCase.options
    );

    expect(legacy).toMatchObject(testCase.expected);
    expect(migrated).toEqual(legacy);
  });

  it("registers the same listeners the legacy payload did", async () => {
    const options: CompareOptions = {};
    const legacyWorld = createWorld(["ok"], options);
    startLegacy(legacyWorld, options);
    const migratedWorld = createWorld(["ok"], options);
    startMigrated(migratedWorld);

    for (const world of [legacyWorld, migratedWorld]) {
      expect(world.document.listenerCount("visibilitychange")).toBe(1);
      expect(world.page.listenerCount("focus")).toBe(1);
      expect(world.clock.intervals).toBe(1);
    }

    resolvePageRegistry(migratedWorld.scope).teardownAll();
    await flushPromises();
  });
});

describe("heartbeat deliberate divergences from the legacy payload", () => {
  it("collapses coincident probes the legacy payload issued three times", async () => {
    const { legacy, migrated } = await compare(
      ["hang"],
      [beat, focus, visible]
    );

    expect(legacy.requests).toEqual(pings(3));
    expect(legacy.timeouts).toBe(3);
    expect(migrated.requests).toEqual(pings(1));
    expect(migrated.timeouts).toBe(1);
  });

  // The legacy payload reloaded on every healthy beat once an outage was
  // observed. The migrated entry throttles that to one reload per retry window,
  // which still recovers when a host accepts a reload without navigating.
  it("throttles the recovery reloads the legacy payload issued on every beat", async () => {
    const { legacy, migrated } = await compare(
      ["reject", "reject", "ok", "ok"],
      [beat, beat, beat, beat, beat, beat]
    );

    expect(legacy.reloads).toBe(4);
    expect(migrated.reloads).toBe(2);
  });

  // The legacy payload routed a throwing reload into its own miss handler, so a
  // blocked recovery was silently counted as another outage sample. The
  // migrated entry reports it and retries on the next healthy beat instead.
  it("reports a blocked recovery instead of silently counting a miss", async () => {
    const { legacy, migrated } = await compare(
      ["reject", "reject", "ok", "ok"],
      [beat, beat, beat, beat],
      { blockFirstReload: true }
    );

    expect(legacy.errors).toBe(0);
    expect(legacy.reloads).toBe(1);
    expect(migrated.errors).toBe(1);
    expect(migrated.reloads).toBe(1);
  });

  it("stops on teardown where the legacy payload could not be stopped", async () => {
    const options: CompareOptions = {};
    const legacyWorld = createWorld(["ok"], options);
    startLegacy(legacyWorld, options);
    const migratedWorld = createWorld(["ok"], options);
    startMigrated(migratedWorld);

    resolvePageRegistry(migratedWorld.scope).teardownAll();
    await drive(legacyWorld, [beat]);
    await drive(migratedWorld, [beat]);

    expect(legacyWorld.net.calls).toHaveLength(1);
    expect(legacyWorld.clock.intervals).toBe(1);
    expect(migratedWorld.net.calls).toHaveLength(0);
    expect(migratedWorld.clock.intervals).toBe(0);
    expect(migratedWorld.document.listenerCount("visibilitychange")).toBe(0);
    expect(migratedWorld.page.listenerCount("focus")).toBe(0);
  });
});
