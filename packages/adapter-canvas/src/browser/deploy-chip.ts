import { beginEntry, NOOP_TEARDOWN } from "./lifecycle.js";
import { isRecord, readBoolean, readNumber, readString } from "./json.js";
import { safeExternalUrl } from "./external-url.js";
import type { BrowserTeardown } from "./lifecycle.js";
import type { BrowserContext, DomElement } from "./ports.js";

// ─── Deploy notification chip ────────────────────────────────────────────────
// The third ambient chip, and the deployment sibling of the operation and graph
// chips.
//
// A deploy runs as a GitHub Actions job for minutes, and the only surface that
// narrates it is the progress modal on the Deployments page. A user who goes to
// look at the app graph while it runs has, until now, had no way to learn that
// it finished: the modal auto-hides on success and the deployments table only
// updates on the page they left. Success in particular was silent.
//
// Like its siblings this is the quietest thing that closes that gap. It never
// takes focus, never navigates on its own, never moves the page, and it stands
// down entirely while the Deployments page's own modal is on screen, because two
// widgets narrating the same deploy is noise rather than redundancy.

export const DEPLOY_CHIP_ENTRY_KEY = "deploy-chip";
export const DEPLOY_CHIP_ID = "rad-deploychip";
export const DEPLOY_CHIP_LABEL_ID = "rad-deploychip-label";
export const DEPLOY_PROGRESS_MODAL_ID = "deploy-progress-modal";
export const DEPLOY_CHIP_ACK_KEY = "radiusDeployChipAck";
export const DEPLOY_NOTIFICATION_PATH = "/api/deploy-notification";
export const DEPLOY_CHIP_POLL_MS = 5000;
export const DEPLOY_CHIP_HREF = "/?page=deploying";

export interface DeployJobStatus {
  attemptId: string;
  generation: number;
  runId: string;
  status: string;
  application: string;
  environment: string;
  error: string;
  runUrl: string;
  repairing: boolean;
  finishedAt: number;
}

// A deploy that has never run in this canvas reports "pending", which is not an
// event and must not light the chip. Anything else is a real job the user
// started, so it is reportable even if its state is one this chip has no label
// for — `deployChipLabel` makes that final call.
export function parseDeployJobStatus(payload: unknown): DeployJobStatus | null {
  if (!isRecord(payload)) return null;
  const status = readString(payload, "status");
  if (status === "" || status === "pending") return null;
  const finishedAt = readNumber(payload, "finishedAt");
  const generation = readNumber(payload, "generation");
  return {
    attemptId: readString(payload, "attemptId"),
    generation:
      generation !== null && generation > 0 ? Math.floor(generation) : 0,
    runId: readString(payload, "runId"),
    status,
    application: readString(payload, "application"),
    environment: readString(payload, "environment"),
    error: readString(payload, "error"),
    // Refused here rather than at the click, so a non-https value never reaches
    // the anchor's href either.
    runUrl: safeExternalUrl(readString(payload, "runUrl")),
    repairing: readBoolean(payload, "repairing"),
    finishedAt: finishedAt !== null ? Math.max(0, finishedAt) : 0
  };
}

// The reported status is authoritative for terminality, and `repairing` never
// overrides it. `deployRepairing` is ownership, not activity: it is set when a
// failure is handed to the agent and is never cleared when the repair's
// redeploy settles (server.ts sets it at attempt start and on handoff delivery;
// no terminal path clears it). Letting it veto terminality would leave a
// successfully repaired deploy stuck on "Repairing…" forever, and permanently
// undismissable.
export function deployChipTerminal(status: DeployJobStatus): boolean {
  return (
    status.status === "success" ||
    status.status === "complete" ||
    status.status === "failed"
  );
}

export function deployChipLabel(status: DeployJobStatus): string {
  const application = status.application || "application";
  // Only a redeploy that is actually in flight is "repairing". A failed deploy
  // the agent has merely taken ownership of still reads as failed, because it
  // did fail — and the repair's own outcome is announced under its own key.
  if (status.repairing && status.status === "in_progress") {
    return `Repairing ${application} deploy…`;
  }
  switch (status.status) {
    case "in_progress":
      return `Deploying ${application}…`;
    case "success":
    case "complete":
      return status.environment ?
          `${application} deployed to ${status.environment}`
        : `${application} deployed`;
    case "failed":
      return `${application} deploy failed`;
    default:
      return "";
  }
}

export function deployChipTone(status: DeployJobStatus): string {
  if (status.status === "in_progress") return "rad-opchip--running";
  if (status.status === "success" || status.status === "complete") {
    return "rad-opchip--done";
  }
  if (status.status === "failed") return "rad-opchip--failed";
  return "";
}

// The dismissal identity of one *outcome*, not one attempt. A repair loop
// deliberately reuses its attempt id across redeploys (server.ts), so keying on
// the attempt alone would let an acknowledged failure silently swallow the
// repair's result — the one thing the user is waiting for.
//
// The generation is what actually separates one deploy invocation from the
// next: it advances in `beginDeployAttempt` for every deploy, including a
// redeploy that fails before dispatch, where the attempt id is reused, no run
// id exists and the finish time is never rewritten. The run id and finish time
// additionally separate outcomes *within* one invocation. Together they stay
// stable across the repeated polls of a single outcome.
//
// Non-terminal states are deliberately unkeyed: a running deploy has no outcome
// to dismiss, and acknowledging one would hide its own completion.
export function deployChipKey(status: DeployJobStatus): string {
  if (!deployChipTerminal(status)) return "";
  // Nothing that distinguishes this outcome from the next one. Better an
  // undismissable chip than a key a later, genuinely new failure collides with.
  if (
    status.generation === 0 &&
    status.attemptId === "" &&
    status.runId === "" &&
    status.finishedAt === 0
  ) {
    return "";
  }
  return [
    status.attemptId,
    String(status.generation),
    status.runId,
    status.status,
    String(status.finishedAt)
  ].join(":");
}

// Where the chip points. Only a failure sends the user out to GitHub, because
// that is where the error actually lives. Everything else stays in the canvas:
// `deployRunUrl` is populated as soon as a run is tracked, not just when one
// fails, so keying the link on its presence would send a perfectly successful
// deploy out of the panel — and take its dismissal, which depends on the
// in-canvas navigation, with it.
export function deployChipRunLink(status: DeployJobStatus): string {
  return status.status === "failed" ? status.runUrl : "";
}

function modalIsOnScreen(modal: DomElement | null): boolean {
  return (
    modal !== null &&
    modal.style.display !== "none" &&
    modal.offsetParent !== null
  );
}

export interface DeployChipOptions {
  pollMs?: number;
}

export function initializeDeployChip(
  context: BrowserContext,
  options: DeployChipOptions = {}
): BrowserTeardown {
  const chip = context.dom.byId(DEPLOY_CHIP_ID);
  if (!chip) return NOOP_TEARDOWN;
  const scope = beginEntry(context, DEPLOY_CHIP_ENTRY_KEY);
  if (!scope) return NOOP_TEARDOWN;

  const pollMs = options.pollMs ?? DEPLOY_CHIP_POLL_MS;
  const label = context.dom.byId(DEPLOY_CHIP_LABEL_ID);
  let issued = 0;
  let applied = 0;
  let outstanding = 0;
  // What the chip currently says, so an unchanged poll can leave the DOM alone.
  let painted = "";

  const hide = (): void => {
    chip.hidden = true;
    // A hidden chip has no painted state to match against, so the next thing
    // worth showing repaints in full.
    painted = "";
  };

  // A terminal chip is dismissed once, per outcome, for the life of the canvas
  // session — the storage port is backed by sessionStorage, so the panel's own
  // lifetime is the retention window. Without this the chip would keep
  // announcing the same finished deploy on every page the user visits next.
  const acknowledge = (key: string | undefined): void => {
    if (!key) return;
    try {
      context.storage.set(DEPLOY_CHIP_ACK_KEY, key);
    } catch (error) {
      context.logger.error(
        "Radius could not persist the deployment acknowledgement.",
        error
      );
    }
  };

  // Only ever called with a non-empty key: `render` refuses to consult a
  // dismissal for an outcome that has no identity.
  const acknowledged = (key: string): boolean => {
    try {
      return context.storage.get(DEPLOY_CHIP_ACK_KEY) === key;
    } catch (error) {
      context.logger.error(
        "Radius could not read the deployment acknowledgement.",
        error
      );
      return false;
    }
  };

  const render = (status: DeployJobStatus | null): void => {
    // The Deployments page's own modal is the better surface whenever it is up.
    if (modalIsOnScreen(context.dom.byId(DEPLOY_PROGRESS_MODAL_ID))) {
      return hide();
    }
    if (!status) return hide();
    const text = deployChipLabel(status);
    if (text === "") return hide();
    const key = deployChipKey(status);
    if (key !== "" && acknowledged(key)) return hide();
    // The failure's own message goes in the tooltip and the accessible name, so
    // the three-word chip is never the only thing on offer.
    const summary = status.error || text;
    // A failed run points at the job on GitHub, which is where the error
    // actually lives; everything else points back at the Deployments page. The
    // run URL is also the href so the chip stays a real, copyable link.
    const runLink = deployChipRunLink(status);
    const tone = deployChipTone(status);
    // Nothing below changes between polls of the same unchanged deploy, and the
    // chip sits in an aria-live region: rewriting identical text and labels
    // every few seconds replaces the label's text node each time, which reads
    // to assistive technology as a fresh announcement. A deploy runs for
    // minutes, so that is the same sentence spoken over and over.
    const signature = [text, summary, runLink, tone, key, status.status].join(
      "\u0000"
    );
    if (signature === painted) {
      chip.hidden = false;
      return;
    }
    painted = signature;
    chip.className = `rad-opchip ${tone}`;
    if (label) label.textContent = text;
    chip.setAttribute("title", summary);
    chip.setAttribute("aria-label", summary);
    chip.setAttribute("href", runLink || DEPLOY_CHIP_HREF);
    chip.hidden = false;
    chip.dataset.deployKey = key;
    chip.dataset.status = status.status;
    chip.dataset.runUrl = runLink;
  };

  const poll = (force = false): Promise<void> => {
    if (!force && outstanding > 0) return Promise.resolve();
    outstanding += 1;
    const token = ++issued;
    return context.net
      .fetch(DEPLOY_NOTIFICATION_PATH, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (payload) => {
          if (!scope.active || token <= applied) return;
          applied = token;
          render(parseDeployJobStatus(payload));
        },
        // A dropped poll means the server is idle or restarting, which the
        // heartbeat already handles. Leaving the chip as it was is more honest
        // than inventing a failure state for it.
        () => {}
      )
      .then(() => {
        outstanding -= 1;
      });
  };

  scope.on(chip, "click", (event) => {
    acknowledge(chip.dataset.deployKey);
    // An external run URL must not navigate the panel away from the canvas, so
    // it is handed to the host opener the way a target="_blank" anchor would be.
    const runUrl = chip.dataset.runUrl;
    if (runUrl) {
      event.preventDefault();
      // The document-level pane navigator treats every `.rad-opchip` as a pane
      // trigger, so this click would otherwise keep bubbling and be re-handled
      // as in-canvas navigation to an external URL: it fetches the GitHub page
      // as a pane, fails, and falls back to assigning it to the location —
      // destroying the canvas. Only the Applications page hides that, because
      // there the navigator's own "already on this pane" guard happens to match
      // an external URL's default pane id.
      event.stopPropagation();
      context.external.open(runUrl);
    }
  });
  scope.on(context.dom.document, "visibilitychange", () => {
    if (context.dom.document.visibilityState === "visible") void poll(true);
  });
  scope.every(pollMs, () => {
    void poll();
  });
  void poll();

  return () => {
    scope.teardown();
  };
}
