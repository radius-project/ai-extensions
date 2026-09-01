import { describe, expect, it } from "vitest";
import {
  DEPLOY_CHIP_ACK_KEY,
  DEPLOY_CHIP_HREF,
  DEPLOY_CHIP_ID,
  DEPLOY_CHIP_LABEL_ID,
  DEPLOY_CHIP_POLL_MS,
  DEPLOY_NOTIFICATION_PATH,
  DEPLOY_PROGRESS_MODAL_ID,
  deployChipKey,
  deployChipLabel,
  deployChipRunLink,
  deployChipTerminal,
  deployChipTone,
  initializeDeployChip,
  parseDeployJobStatus
} from "./deploy-chip.js";
import {
  createDeferred,
  createFakeBrowser,
  createFakeElement,
  flushPromises,
  jsonResponse
} from "../../test/support/browser/fakes.js";
import type { DeployJobStatus } from "./deploy-chip.js";
import type { BrowserContext, HttpResponse, StoragePort } from "./ports.js";

const RUN_URL = "https://github.com/o/r/actions/runs/9";

function setup() {
  const browser = createFakeBrowser();
  const chip = createFakeElement(DEPLOY_CHIP_ID);
  chip.hidden = true;
  const label = createFakeElement(DEPLOY_CHIP_LABEL_ID);
  browser.document.add(chip);
  browser.document.add(label);
  return { ...browser, chip, label };
}

function notification(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: "attempt-1",
    generation: 1,
    runId: "101",
    status: "in_progress",
    application: "storefront",
    environment: "dev",
    error: "",
    runUrl: "",
    repairing: false,
    finishedAt: 0,
    ...overrides
  };
}

function status(overrides: Partial<DeployJobStatus> = {}): DeployJobStatus {
  return {
    attemptId: "attempt-1",
    generation: 1,
    runId: "101",
    status: "in_progress",
    application: "storefront",
    environment: "dev",
    error: "",
    runUrl: "",
    repairing: false,
    finishedAt: 0,
    ...overrides
  };
}

async function poll(clock: { tick(ms: number): void }, beats = 1) {
  for (let index = 0; index < beats; index++) {
    clock.tick(DEPLOY_CHIP_POLL_MS);
    await flushPromises();
  }
}

describe("deploy notification payload parsing", () => {
  it.each([
    ["null", null],
    ["a string", "success"],
    ["an array", []],
    ["an empty envelope", {}],
    ["a non-string status", { status: 7 }],
    ["a deploy that never ran", { status: "pending" }]
  ])("reads %s as nothing to announce", (_name, payload) => {
    expect(parseDeployJobStatus(payload)).toBeNull();
  });

  it("keeps only rendered fields and defaults malformed optional values", () => {
    expect(
      parseDeployJobStatus({
        status: "success",
        attemptId: 12,
        extra: "ignored"
      })
    ).toEqual({
      attemptId: "",
      generation: 0,
      runId: "",
      status: "success",
      application: "",
      environment: "",
      error: "",
      runUrl: "",
      repairing: false,
      finishedAt: 0
    });
  });

  it("reads a complete failure payload", () => {
    expect(
      parseDeployJobStatus(
        notification({
          status: "failed",
          error: "Bicep template failed to compile",
          runUrl: RUN_URL,
          repairing: true,
          finishedAt: 1700
        })
      )
    ).toEqual({
      attemptId: "attempt-1",
      generation: 1,
      runId: "101",
      status: "failed",
      application: "storefront",
      environment: "dev",
      error: "Bicep template failed to compile",
      runUrl: RUN_URL,
      repairing: true,
      finishedAt: 1700
    });
  });

  it.each([
    ["a non-https run URL", "http://github.com/o/r/actions/runs/9"],
    ["a javascript URL", "javascript:alert(1)"],
    ["a relative URL", "/actions/runs/9"]
  ])("refuses %s", (_name, runUrl) => {
    expect(parseDeployJobStatus(notification({ runUrl }))?.runUrl).toBe("");
  });

  it.each([
    ["a negative timestamp", -5, 0],
    ["a non-numeric timestamp", "later", 0],
    ["an infinite timestamp", Number.POSITIVE_INFINITY, 0],
    ["a real timestamp", 42, 42]
  ])("normalizes %s", (_name, finishedAt, expected) => {
    expect(parseDeployJobStatus(notification({ finishedAt }))?.finishedAt).toBe(
      expected
    );
  });

  it.each([
    ["a negative generation", -3, 0],
    ["a non-numeric generation", "third", 0],
    ["an infinite generation", Number.POSITIVE_INFINITY, 0],
    ["a fractional generation", 2.7, 2],
    ["a real generation", 4, 4]
  ])("normalizes %s", (_name, generation, expected) => {
    expect(parseDeployJobStatus(notification({ generation }))?.generation).toBe(
      expected
    );
  });
});

describe("deploy chip labelling", () => {
  it.each([
    ["in_progress", status(), "Deploying storefront…"],
    ["success", status({ status: "success" }), "storefront deployed to dev"],
    [
      "success without an environment",
      status({ status: "success", environment: "" }),
      "storefront deployed"
    ],
    ["complete", status({ status: "complete" }), "storefront deployed to dev"],
    ["failed", status({ status: "failed" }), "storefront deploy failed"],
    [
      "a repair redeploy in flight",
      status({ status: "in_progress", repairing: true }),
      "Repairing storefront deploy…"
    ],
    ["an unknown state", status({ status: "sideways" }), ""]
  ])("labels %s", (_name, value, expected) => {
    expect(deployChipLabel(value)).toBe(expected);
  });

  // `deployRepairing` is ownership, not activity, and no terminal path clears
  // it. If it outranked the status, a repaired deploy would read "Repairing…"
  // for the life of the panel.
  it.each([
    [
      "a failure the agent has taken ownership of",
      status({ status: "failed", repairing: true }),
      "storefront deploy failed"
    ],
    [
      "a deploy that succeeded after a repair",
      status({ status: "complete", repairing: true }),
      "storefront deployed to dev"
    ]
  ])(
    "lets the status outrank a stale repairing flag for %s",
    (_name, value, expected) => {
      expect(deployChipLabel(value)).toBe(expected);
      expect(deployChipTerminal(value)).toBe(true);
    }
  );

  it("falls back to a generic application name", () => {
    expect(deployChipLabel(status({ application: "" }))).toBe(
      "Deploying application…"
    );
  });

  it.each([
    ["in_progress", status(), "rad-opchip--running"],
    [
      "a repair redeploy in flight",
      status({ status: "in_progress", repairing: true }),
      "rad-opchip--running"
    ],
    ["success", status({ status: "success" }), "rad-opchip--done"],
    ["complete", status({ status: "complete" }), "rad-opchip--done"],
    ["failed", status({ status: "failed" }), "rad-opchip--failed"],
    [
      "a failure under repair ownership",
      status({ status: "failed", repairing: true }),
      "rad-opchip--failed"
    ],
    ["an unknown state", status({ status: "sideways" }), ""]
  ])("tones %s", (_name, value, expected) => {
    expect(deployChipTone(value)).toBe(expected);
  });
});

describe("deploy chip outcome identity", () => {
  it.each([
    ["success", status({ status: "success" }), true],
    ["complete", status({ status: "complete" }), true],
    ["failed", status({ status: "failed" }), true],
    [
      "failed under repair ownership",
      status({ status: "failed", repairing: true }),
      true
    ],
    ["in_progress", status(), false],
    [
      "a repair redeploy in flight",
      status({ status: "in_progress", repairing: true }),
      false
    ],
    ["an unknown state", status({ status: "sideways" }), false]
  ])("treats %s terminality correctly", (_name, value, expected) => {
    expect(deployChipTerminal(value)).toBe(expected);
  });

  it("keys a terminal outcome on the attempt, generation, run, status and time", () => {
    expect(deployChipKey(status({ status: "failed", finishedAt: 42 }))).toBe(
      "attempt-1:1:101:failed:42"
    );
  });

  it.each([
    ["a running deploy", status()],
    [
      "a repair redeploy in flight",
      status({ status: "in_progress", repairing: true })
    ],
    [
      "an outcome with nothing to distinguish it",
      status({
        status: "failed",
        attemptId: "",
        generation: 0,
        runId: "",
        finishedAt: 0
      })
    ]
  ])("refuses to key %s", (_name, value) => {
    expect(deployChipKey(value)).toBe("");
  });

  // The repair loop deliberately reuses its attempt id across redeploys, so the
  // attempt alone cannot separate one outcome from the next.
  it("separates outcomes that share an attempt id", () => {
    const failure = status({
      status: "failed",
      generation: 1,
      runId: "101",
      finishedAt: 10
    });
    const repaired = status({
      status: "complete",
      generation: 2,
      runId: "102",
      finishedAt: 20,
      repairing: true
    });

    expect(deployChipKey(failure)).not.toBe(deployChipKey(repaired));
  });

  // Two deploys that both failed before dispatch: the repair loop reuses the
  // attempt id, `beginDeployAttempt` clears the run id, and `deployFinishedAt`
  // is only written when a run concludes — so the generation is the only thing
  // that tells them apart. Without it the second failure would arrive already
  // dismissed.
  it("separates repeated pre-dispatch failures in one repair loop", () => {
    const first = status({
      status: "failed",
      generation: 3,
      runId: "",
      finishedAt: 900
    });
    const second = status({
      status: "failed",
      generation: 4,
      runId: "",
      finishedAt: 900
    });

    expect(deployChipKey(first)).not.toBe(deployChipKey(second));
  });

  it("keys a pre-dispatch failure on its generation alone when nothing else is known", () => {
    expect(
      deployChipKey(
        status({
          status: "failed",
          attemptId: "",
          generation: 7,
          runId: "",
          finishedAt: 0
        })
      )
    ).toBe(":7::failed:0");
  });

  it("keeps one outcome's key stable across repeated polls", () => {
    const first = status({ status: "complete", finishedAt: 10 });
    const second = status({ status: "complete", finishedAt: 10 });

    expect(deployChipKey(first)).toBe(deployChipKey(second));
  });
});

describe("deploy chip run link", () => {
  it("sends a failure out to its GitHub job", () => {
    expect(
      deployChipRunLink(status({ status: "failed", runUrl: RUN_URL }))
    ).toBe(RUN_URL);
  });

  it.each([
    ["success", "success"],
    ["complete", "complete"],
    ["in_progress", "in_progress"],
    ["an unknown state", "sideways"]
  ])(
    "keeps %s in the canvas despite a published run URL",
    (_name, deployStatus) => {
      expect(
        deployChipRunLink(status({ status: deployStatus, runUrl: RUN_URL }))
      ).toBe("");
    }
  );

  it("has nothing to offer a failure with no run", () => {
    expect(deployChipRunLink(status({ status: "failed", runUrl: "" }))).toBe(
      ""
    );
  });
});

describe("deploy chip polling", () => {
  it("does nothing when the page has no chip", async () => {
    const browser = createFakeBrowser();
    const teardown = initializeDeployChip(browser.context);
    await flushPromises();

    expect(browser.net.calls).toHaveLength(0);
    expect(browser.clock.pending).toBe(0);
    teardown();
  });

  it("polls once on load and then on the interval", async () => {
    const browser = setup();
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () =>
      jsonResponse(notification())
    );

    initializeDeployChip(browser.context);
    await flushPromises();
    expect(browser.net.calls).toHaveLength(1);
    expect(browser.net.calls[0].init?.cache).toBe("no-store");

    await poll(browser.clock, 2);
    expect(browser.net.calls).toHaveLength(3);
    expect(browser.clock.intervals).toBe(1);
  });

  it("renders a running deploy with an accessible name and identity", async () => {
    const browser = setup();
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () =>
      jsonResponse(notification())
    );

    initializeDeployChip(browser.context);
    await flushPromises();

    expect(browser.chip.hidden).toBe(false);
    expect(browser.chip.className).toBe("rad-opchip rad-opchip--running");
    expect(browser.label.textContent).toBe("Deploying storefront…");
    expect(browser.chip.getAttribute("aria-label")).toBe(
      "Deploying storefront…"
    );
    expect(browser.chip.getAttribute("title")).toBe("Deploying storefront…");
    expect(browser.chip.getAttribute("href")).toBe(DEPLOY_CHIP_HREF);
    expect(browser.chip.dataset.status).toBe("in_progress");
    // A running deploy has no outcome to dismiss.
    expect(browser.chip.dataset.deployKey).toBe("");
  });

  it("announces a completed deploy the user never watched", async () => {
    const browser = setup();
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () =>
      jsonResponse(notification({ status: "success", finishedAt: 99 }))
    );

    initializeDeployChip(browser.context);
    await flushPromises();

    expect(browser.chip.hidden).toBe(false);
    expect(browser.chip.className).toBe("rad-opchip rad-opchip--done");
    expect(browser.label.textContent).toBe("storefront deployed to dev");
    expect(browser.chip.getAttribute("href")).toBe(DEPLOY_CHIP_HREF);
    expect(browser.chip.dataset.deployKey).toBe("attempt-1:1:101:success:99");
  });

  it("points a failed deploy at its job and explains why it failed", async () => {
    const browser = setup();
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () =>
      jsonResponse(
        notification({
          status: "failed",
          error: "Bicep template failed to compile",
          runUrl: RUN_URL
        })
      )
    );

    initializeDeployChip(browser.context);
    await flushPromises();

    expect(browser.chip.className).toBe("rad-opchip rad-opchip--failed");
    expect(browser.label.textContent).toBe("storefront deploy failed");
    expect(browser.chip.getAttribute("aria-label")).toBe(
      "Bicep template failed to compile"
    );
    expect(browser.chip.getAttribute("href")).toBe(RUN_URL);
    expect(browser.chip.dataset.runUrl).toBe(RUN_URL);
  });

  it("falls back to the deployments page when no run URL is known", async () => {
    const browser = setup();
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () =>
      jsonResponse(notification({ status: "failed" }))
    );

    initializeDeployChip(browser.context);
    await flushPromises();

    expect(browser.chip.getAttribute("href")).toBe(DEPLOY_CHIP_HREF);
    expect(browser.chip.dataset.runUrl).toBe("");
  });

  // A run URL is published as soon as the run is tracked, so every dispatched
  // deploy carries one. Only a failure may follow it out of the canvas.
  it.each([
    ["a successful deploy", "success"],
    ["a completed deploy", "complete"],
    ["a running deploy", "in_progress"]
  ])(
    "keeps %s in the canvas even though it has a run URL",
    async (_name, deployStatus) => {
      const browser = setup();
      browser.net.handle(DEPLOY_NOTIFICATION_PATH, () =>
        jsonResponse(
          notification({
            status: deployStatus,
            runUrl: RUN_URL,
            finishedAt: 99
          })
        )
      );

      initializeDeployChip(browser.context);
      await flushPromises();

      expect(browser.chip.getAttribute("href")).toBe(DEPLOY_CHIP_HREF);
      expect(browser.chip.dataset.runUrl).toBe("");

      let prevented = false;
      browser.chip.dispatch("click", {
        preventDefault: () => {
          prevented = true;
        }
      });

      // The in-canvas navigation must happen: the dismissal has to survive it.
      expect(prevented).toBe(false);
      expect(browser.external.opened).toEqual([]);
    }
  );

  it("renders without a label element on a trimmed page", async () => {
    const browser = createFakeBrowser();
    const chip = createFakeElement(DEPLOY_CHIP_ID);
    chip.hidden = true;
    browser.document.add(chip);
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () =>
      jsonResponse(notification())
    );

    initializeDeployChip(browser.context);
    await flushPromises();

    expect(chip.hidden).toBe(false);
    expect(chip.getAttribute("aria-label")).toBe("Deploying storefront…");
  });

  it("stays hidden while the deploy progress modal is on screen", async () => {
    const browser = setup();
    const modal = createFakeElement(DEPLOY_PROGRESS_MODAL_ID);
    browser.document.add(modal);
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () =>
      jsonResponse(notification())
    );

    initializeDeployChip(browser.context);
    await flushPromises();
    expect(browser.chip.hidden).toBe(true);

    modal.style.display = "none";
    await poll(browser.clock);
    expect(browser.chip.hidden).toBe(false);
  });

  it("treats a detached progress modal as not on screen", async () => {
    const browser = setup();
    const modal = createFakeElement(DEPLOY_PROGRESS_MODAL_ID);
    modal.offsetParent = null;
    browser.document.add(modal);
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () =>
      jsonResponse(notification())
    );

    initializeDeployChip(browser.context);
    await flushPromises();

    expect(browser.chip.hidden).toBe(false);
  });

  it.each([
    ["an unknown state", notification({ status: "sideways" })],
    ["a deploy that never ran", notification({ status: "pending" })]
  ])("hides the chip for %s", async (_name, payload) => {
    const browser = setup();
    browser.chip.hidden = false;
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () => jsonResponse(payload));

    initializeDeployChip(browser.context);
    await flushPromises();

    expect(browser.chip.hidden).toBe(true);
  });

  it("dismisses a finished deploy once it is acknowledged", async () => {
    const browser = setup();
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () =>
      jsonResponse(notification({ status: "success", finishedAt: 99 }))
    );

    initializeDeployChip(browser.context);
    await flushPromises();
    expect(browser.chip.hidden).toBe(false);

    browser.chip.dispatch("click");
    expect(browser.storage.get(DEPLOY_CHIP_ACK_KEY)).toBe(
      "attempt-1:1:101:success:99"
    );

    await poll(browser.clock);
    expect(browser.chip.hidden).toBe(true);
  });

  // Regression: acknowledging on a running chip stored the attempt id, and the
  // completion that followed was silently suppressed — the notification the
  // whole feature exists to deliver.
  it("still announces the completion of a deploy whose running chip was clicked", async () => {
    const browser = setup();
    let current = notification();
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () => jsonResponse(current));

    initializeDeployChip(browser.context);
    await flushPromises();
    browser.chip.dispatch("click");
    expect(browser.storage.get(DEPLOY_CHIP_ACK_KEY)).toBeNull();

    current = notification({ status: "success", finishedAt: 99 });
    await poll(browser.clock);

    expect(browser.chip.hidden).toBe(false);
    expect(browser.label.textContent).toBe("storefront deployed to dev");
  });

  // Regression: a repair loop reuses its attempt id, so keying dismissal on the
  // attempt let an acknowledged failure hide the repair's success.
  it("announces a repaired success even after its failure was dismissed", async () => {
    const browser = setup();
    let current = notification({
      status: "failed",
      runId: "101",
      finishedAt: 10,
      runUrl: RUN_URL
    });
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () => jsonResponse(current));

    initializeDeployChip(browser.context);
    await flushPromises();
    browser.chip.dispatch("click");
    await poll(browser.clock);
    expect(browser.chip.hidden).toBe(true);

    // The agent takes ownership and redeploys under the same attempt id.
    current = notification({ status: "in_progress", repairing: true });
    await poll(browser.clock);
    expect(browser.chip.hidden).toBe(false);
    expect(browser.label.textContent).toBe("Repairing storefront deploy…");

    current = notification({
      status: "complete",
      runId: "102",
      finishedAt: 20,
      repairing: true
    });
    await poll(browser.clock);
    expect(browser.chip.hidden).toBe(false);
    expect(browser.label.textContent).toBe("storefront deployed to dev");
  });

  it("keeps showing a still-running deploy after a click", async () => {
    const browser = setup();
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () =>
      jsonResponse(notification())
    );

    initializeDeployChip(browser.context);
    await flushPromises();
    browser.chip.dispatch("click");
    await poll(browser.clock);

    expect(browser.chip.hidden).toBe(false);
  });

  it("keeps showing a repair redeploy after a click", async () => {
    const browser = setup();
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () =>
      jsonResponse(notification({ status: "in_progress", repairing: true }))
    );

    initializeDeployChip(browser.context);
    await flushPromises();
    browser.chip.dispatch("click");
    await poll(browser.clock);

    expect(browser.chip.hidden).toBe(false);
    expect(browser.label.textContent).toBe("Repairing storefront deploy…");
  });

  it("opens the job externally instead of navigating the panel away", async () => {
    const browser = setup();
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () =>
      jsonResponse(notification({ status: "failed", runUrl: RUN_URL }))
    );

    initializeDeployChip(browser.context);
    await flushPromises();
    let prevented = false;
    let stopped = false;
    browser.chip.dispatch("click", {
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {
        stopped = true;
      }
    });

    expect(prevented).toBe(true);
    // The document-level pane navigator treats every .rad-opchip as a pane
    // trigger. Letting this click reach it would load the GitHub URL as a pane
    // and, on failure, assign it to the location — destroying the canvas.
    expect(stopped).toBe(true);
    expect(browser.external.opened).toEqual([RUN_URL]);
  });

  it("lets an in-canvas chip navigate normally", async () => {
    const browser = setup();
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () =>
      jsonResponse(notification({ status: "success" }))
    );

    initializeDeployChip(browser.context);
    await flushPromises();
    let prevented = false;
    let stopped = false;
    browser.chip.dispatch("click", {
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {
        stopped = true;
      }
    });

    expect(prevented).toBe(false);
    // The in-canvas branch must keep bubbling: the pane navigator is what
    // performs the navigation the dismissal has to survive.
    expect(stopped).toBe(false);
    expect(browser.external.opened).toEqual([]);
  });

  // Two deploys that failed before dispatch inside one repair loop: same
  // attempt id, no run id, and a finish time that is never rewritten. Only the
  // generation separates them, so without it the second failure would arrive
  // already dismissed and the user would never learn the repair failed again.
  it("announces a second pre-dispatch failure in the same repair loop", async () => {
    const browser = setup();
    let current = notification({
      status: "failed",
      generation: 3,
      runId: "",
      finishedAt: 900,
      error: "The branch is not on the remote."
    });
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () => jsonResponse(current));

    initializeDeployChip(browser.context);
    await flushPromises();
    expect(browser.chip.hidden).toBe(false);
    browser.chip.dispatch("click");
    await poll(browser.clock);
    expect(browser.chip.hidden).toBe(true);

    current = notification({
      status: "failed",
      generation: 4,
      runId: "",
      finishedAt: 900,
      error: "The branch is still not on the remote."
    });
    await poll(browser.clock);

    expect(browser.chip.hidden).toBe(false);
    expect(browser.chip.dataset.deployKey).toBe("attempt-1:4::failed:900");
  });

  it("shows the next deploy after an acknowledgement", async () => {
    const browser = setup();
    let current = notification({
      status: "success",
      attemptId: "attempt-1",
      finishedAt: 10
    });
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () => jsonResponse(current));

    initializeDeployChip(browser.context);
    await flushPromises();
    browser.chip.dispatch("click");
    await poll(browser.clock);
    expect(browser.chip.hidden).toBe(true);

    current = notification({
      status: "failed",
      attemptId: "attempt-2",
      finishedAt: 20
    });
    await poll(browser.clock);
    expect(browser.chip.hidden).toBe(false);
    expect(browser.chip.dataset.deployKey).toBe("attempt-2:1:101:failed:20");
  });

  it("keeps showing the chip when storage refuses acknowledgement", async () => {
    const browser = setup();
    const storage: StoragePort = {
      available: true,
      get() {
        throw new Error("storage denied");
      },
      set() {
        throw new Error("storage denied");
      }
    };
    const context: BrowserContext = { ...browser.context, storage };
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () =>
      jsonResponse(notification({ status: "success", finishedAt: 99 }))
    );

    initializeDeployChip(context);
    await flushPromises();
    browser.chip.dispatch("click");
    await poll(browser.clock);

    expect(browser.chip.hidden).toBe(false);
    expect(browser.logger.errors.length).toBeGreaterThan(0);
  });

  it("ignores a click when the outcome has nothing to identify it", async () => {
    const browser = setup();
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () =>
      jsonResponse(
        notification({
          status: "success",
          attemptId: "",
          generation: 0,
          runId: "",
          finishedAt: 0
        })
      )
    );

    initializeDeployChip(browser.context);
    await flushPromises();
    browser.chip.dispatch("click");

    expect(browser.storage.get(DEPLOY_CHIP_ACK_KEY)).toBeNull();
    await poll(browser.clock);
    expect(browser.chip.hidden).toBe(false);
  });

  it("ignores a stale response that lands after a newer one", async () => {
    const browser = setup();
    const first = createDeferred<HttpResponse>();
    const second = createDeferred<HttpResponse>();
    const queue = [first, second];
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () => {
      const next = queue.shift();
      if (!next) throw new Error("unexpected third poll");
      return next.promise;
    });

    initializeDeployChip(browser.context);
    await flushPromises();
    browser.document.dispatch("visibilitychange");
    await flushPromises();
    expect(browser.net.calls).toHaveLength(2);

    second.resolve(jsonResponse(notification({ status: "success" })));
    await flushPromises();
    first.resolve(jsonResponse(notification({ status: "in_progress" })));
    await flushPromises();

    expect(browser.chip.dataset.status).toBe("success");
  });

  it("does not overlap scheduled polls while one is outstanding", async () => {
    const browser = setup();
    const pending = createDeferred<HttpResponse>();
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () => pending.promise);

    initializeDeployChip(browser.context);
    await flushPromises();
    await poll(browser.clock, 3);

    expect(browser.net.calls).toHaveLength(1);
    pending.resolve(jsonResponse(notification()));
    await flushPromises();
    await poll(browser.clock);
    expect(browser.net.calls).toHaveLength(2);
  });

  it("leaves state intact on rejection and hides on an error response", async () => {
    const browser = setup();
    let mode: "ok" | "error" | "reject" = "ok";
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () => {
      if (mode === "reject") return Promise.reject(new Error("offline"));
      if (mode === "error") return jsonResponse({}, false, 500);
      return jsonResponse(notification());
    });

    initializeDeployChip(browser.context);
    await flushPromises();
    expect(browser.chip.hidden).toBe(false);

    mode = "reject";
    await poll(browser.clock);
    expect(browser.chip.hidden).toBe(false);
    expect(browser.chip.dataset.status).toBe("in_progress");

    mode = "error";
    await poll(browser.clock);
    expect(browser.chip.hidden).toBe(true);
  });

  it("polls when visible again without adding a timer", async () => {
    const browser = setup();
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () =>
      jsonResponse(notification())
    );

    initializeDeployChip(browser.context);
    await flushPromises();

    browser.document.visibilityState = "hidden";
    browser.document.dispatch("visibilitychange");
    await flushPromises();
    expect(browser.net.calls).toHaveLength(1);

    browser.document.visibilityState = "visible";
    browser.document.dispatch("visibilitychange");
    await flushPromises();
    expect(browser.net.calls).toHaveLength(2);
    expect(browser.clock.intervals).toBe(1);
  });

  it("leaves the DOM alone while an unchanged deploy keeps polling", async () => {
    // The chip lives in an aria-live region, so rewriting identical text every
    // poll would re-announce the same sentence for the whole deploy.
    const browser = setup();
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () =>
      jsonResponse(notification())
    );

    initializeDeployChip(browser.context);
    await flushPromises();
    let writes = 0;
    Object.defineProperty(browser.label, "textContent", {
      configurable: true,
      get: () => "Deploying storefront…",
      set: () => {
        writes += 1;
      }
    });

    await poll(browser.clock, 3);

    expect(browser.net.calls).toHaveLength(4);
    expect(writes).toBe(0);
    expect(browser.chip.hidden).toBe(false);
  });

  it("repaints when the deploy actually changes", async () => {
    const browser = setup();
    let current = notification();
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () => jsonResponse(current));

    initializeDeployChip(browser.context);
    await flushPromises();
    await poll(browser.clock, 2);
    expect(browser.label.textContent).toBe("Deploying storefront…");

    current = notification({ status: "complete", finishedAt: 99 });
    await poll(browser.clock);

    expect(browser.label.textContent).toBe("storefront deployed to dev");
    expect(browser.chip.className).toBe("rad-opchip rad-opchip--done");
  });

  it("repaints after the chip has been hidden and becomes relevant again", async () => {
    const browser = setup();
    const modal = createFakeElement(DEPLOY_PROGRESS_MODAL_ID);
    browser.document.add(modal);
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () =>
      jsonResponse(notification())
    );

    initializeDeployChip(browser.context);
    await flushPromises();
    expect(browser.chip.hidden).toBe(true);

    modal.style.display = "none";
    await poll(browser.clock);

    expect(browser.chip.hidden).toBe(false);
    expect(browser.label.textContent).toBe("Deploying storefront…");
    expect(browser.chip.getAttribute("aria-label")).toBe(
      "Deploying storefront…"
    );
  });

  it("honors a caller-supplied poll interval", async () => {
    const browser = setup();
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () =>
      jsonResponse(notification())
    );

    initializeDeployChip(browser.context, { pollMs: 1000 });
    await flushPromises();
    browser.clock.tick(1000);
    await flushPromises();

    expect(browser.net.calls).toHaveLength(2);
  });

  it("stops polling once torn down", async () => {
    const browser = setup();
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () =>
      jsonResponse(notification())
    );

    const teardown = initializeDeployChip(browser.context);
    await flushPromises();
    teardown();
    await poll(browser.clock, 2);

    expect(browser.net.calls).toHaveLength(1);
    expect(browser.clock.pending).toBe(0);
    expect(browser.chip.listenerCount()).toBe(0);
  });

  it("refuses a second binding on the same document", async () => {
    const browser = setup();
    browser.net.handle(DEPLOY_NOTIFICATION_PATH, () =>
      jsonResponse(notification())
    );

    initializeDeployChip(browser.context);
    const second = initializeDeployChip(browser.context);
    await flushPromises();

    expect(browser.chip.listenerCount("click")).toBe(1);
    expect(browser.clock.intervals).toBe(1);
    second();
  });
});
