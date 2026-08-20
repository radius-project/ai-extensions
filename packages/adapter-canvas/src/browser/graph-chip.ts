// ─── Graph build chip ────────────────────────────────────────────────────────
// The ambient tier of graph progress, and the sibling of the operation chip.
//
// A graph build outlives the page that started it. The wait for Copilot to
// author .radius/app.bicep runs entirely outside the panel and can take minutes,
// and the user is free to walk away from the page in the meantime. Without an
// ambient surface they would have no way to tell whether anything was still
// happening, and coming back to a page that quietly restarted its clock reads
// as nothing having happened at all.
//
// Like the operation chip, this is the quietest thing that closes that gap: it
// never takes focus, never navigates on its own, never moves the page, and it
// says only what the server actually reported plus how long it has been going.
// It stands down entirely when the page's own progress panel is on screen,
// because two widgets narrating the same build is noise, not redundancy.

import { beginEntry, NOOP_TEARDOWN } from "./lifecycle.js";
import { isRecord, readNumber, readString } from "./json.js";
import { GRAPH_STAGE_LABELS } from "./graph/progress.js";
import { formatElapsed } from "./progress-format.js";
import type { GraphBuildStage } from "./graph/progress.js";
import type { BrowserTeardown } from "./lifecycle.js";
import type { BrowserContext, DomElement } from "./ports.js";

export const GRAPH_CHIP_ENTRY_KEY = "graph-chip";
export const GRAPH_CHIP_ID = "rad-graphchip";
export const GRAPH_CHIP_LABEL_ID = "rad-graphchip-label";
export const GRAPH_PROGRESS_PATH = "/api/progress";
export const GRAPH_CHIP_POLL_MS = 5000;
export const GRAPH_CHIP_TICK_MS = 1000;

// Every host a graph page mounts its own progress panel into. The chip defers
// to any of them, so whichever graph page the user is on wins.
export const GRAPH_PANEL_IDS: readonly string[] = [
  "progress-steps",
  "diff-progress-steps"
];

const VIEW_PAGES: Readonly<Record<string, string>> = {
  graph: "graph",
  planned: "planned",
  diff: "graph-diff"
};

export interface GraphBuildStatus {
  active: boolean;
  view: string;
  elapsedMs: number;
  stage: string;
  detail: string;
}

// Read the build record off a progress payload. Only a record that says it is
// active and names a stage can be reported: the chip claims a build is running,
// so anything less than that is not enough to make the claim.
export function parseGraphBuildStatus(
  payload: unknown
): GraphBuildStatus | null {
  if (!isRecord(payload)) return null;
  if (payload.active !== true) return null;
  const events = Array.isArray(payload.events) ? payload.events : [];
  const latest = events.filter(isRecord).at(-1);
  if (!latest) return null;
  const stage = readString(latest, "stage");
  if (stage === "") return null;
  const elapsedMs = readNumber(payload, "elapsedMs");
  return {
    active: true,
    view: readString(payload, "view"),
    elapsedMs:
      typeof elapsedMs === "number" && Number.isFinite(elapsedMs) ?
        Math.max(0, elapsedMs)
      : 0,
    stage,
    detail: readString(latest, "detail")
  };
}

export function graphChipStageLabel(stage: string): string {
  return GRAPH_STAGE_LABELS[stage as GraphBuildStage] ?? "";
}

// The chip states the stage and the time spent on it, and nothing else. No
// percentage, no estimate, no count of steps remaining — the server does not
// know any of those, so neither does this.
export function graphChipLabel(
  status: GraphBuildStatus,
  elapsedMs: number
): string {
  const stage = graphChipStageLabel(status.stage);
  if (stage === "") return "";
  return `${stage} · ${formatElapsed(elapsedMs)}`;
}

export function graphChipHref(view: string): string {
  return `/?page=${VIEW_PAGES[view] ?? "graph"}`;
}

function panelIsOnScreen(panel: DomElement | null): boolean {
  return (
    panel !== null &&
    panel.style.display !== "none" &&
    panel.offsetParent !== null
  );
}

export interface GraphChipOptions {
  pollMs?: number;
  tickMs?: number;
}

export function initializeGraphChip(
  context: BrowserContext,
  options: GraphChipOptions = {}
): BrowserTeardown {
  const chip = context.dom.byId(GRAPH_CHIP_ID);
  if (!chip) return NOOP_TEARDOWN;
  const scope = beginEntry(context, GRAPH_CHIP_ENTRY_KEY);
  if (!scope) return NOOP_TEARDOWN;

  const pollMs = options.pollMs ?? GRAPH_CHIP_POLL_MS;
  const tickMs = options.tickMs ?? GRAPH_CHIP_TICK_MS;
  const label = context.dom.byId(GRAPH_CHIP_LABEL_ID);
  let issued = 0;
  let applied = 0;
  let outstanding = 0;
  // The server owns the build's age; between polls the chip advances it from
  // the last measurement it was given rather than counting from its own mount.
  let status: GraphBuildStatus | null = null;
  let baselineElapsedMs = 0;
  let baselineAtMs = context.clock.now();

  const hide = (): void => {
    chip.hidden = true;
  };

  const elapsedNow = (): number =>
    baselineElapsedMs + (context.clock.now() - baselineAtMs);

  const paint = (): void => {
    // The page's own panel is the better surface whenever it is on screen.
    const onScreen = GRAPH_PANEL_IDS.some((id) =>
      panelIsOnScreen(context.dom.byId(id))
    );
    if (onScreen || !status) return hide();
    const text = graphChipLabel(status, elapsedNow());
    if (text === "") return hide();
    chip.className = "rad-opchip rad-opchip--running";
    if (label) label.textContent = text;
    // The stage's own narration goes in the tooltip and the accessible name, so
    // the short chip is never the only thing on offer.
    chip.setAttribute("title", status.detail || text);
    chip.setAttribute("aria-label", status.detail || text);
    chip.setAttribute("href", graphChipHref(status.view));
    chip.hidden = false;
    chip.dataset.view = status.view;
    chip.dataset.stage = status.stage;
  };

  const apply = (next: GraphBuildStatus | null): void => {
    status = next;
    if (next) {
      baselineElapsedMs = next.elapsedMs;
      baselineAtMs = context.clock.now();
    }
    paint();
  };

  const poll = (force = false): Promise<void> => {
    if (!force && outstanding > 0) return Promise.resolve();
    outstanding += 1;
    const token = ++issued;
    return context.net
      .fetch(GRAPH_PROGRESS_PATH, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (payload) => {
          if (!scope.active || token <= applied) return;
          applied = token;
          apply(parseGraphBuildStatus(payload));
        },
        // A dropped poll means the server is idle or restarting. Leaving the
        // chip as it was is more honest than inventing a failure state for it.
        () => {}
      )
      .then(() => {
        outstanding -= 1;
      });
  };

  scope.on(context.dom.document, "visibilitychange", () => {
    if (context.dom.document.visibilityState === "visible") void poll(true);
  });
  scope.every(tickMs, () => {
    if (status) paint();
  });
  scope.every(pollMs, () => {
    void poll();
  });
  void poll();

  return () => {
    scope.teardown();
  };
}
